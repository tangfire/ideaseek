/**
 * 反向通道：Web → 命令队列 → 本地 Agent。
 *
 * 三条不可让的边界，都写在代码里而不是文档里：
 *
 * 1. **云端不执行任何东西**（F6.5）。这里只排队，跑的是用户自己机器上的 Agent，
 *    用它自己的 sync token 领取。所以本文件没有任何"在云上跑 git/CLI"的实现空间。
 * 2. **写权限只有 Owner**（Q1/§4）。`Viewer` 只有 `ownerId / grantedProjectIds /
 *    shareProjectId` 三样东西，被邀读者与 share 链接是**读**授权，不存在第三档
 *    "editor"；早期草稿里那个 `viewer.role === 'viewer'` 闸门读的字段根本不存在，
 *    等于没有闸门。现在按 `project.owner_id === viewer.ownerId` 判。
 * 3. **投影表不由浏览器写**。cloud_project/cloud_run 是只读投影，下一次 `cloud push`
 *    会覆盖任何云上直改的值——写它等于给用户一个"改成功了、下次同步又变回去"的
 *      假象。改标题、改可见性、改策略统统排成命令，由本地引擎改完再投影回来。
 *
 * 命令的幂等键是 Web 侧生成的 `external_command_id`（NFR-06）：同一个键重复提交
 * 返回同一行，不排第二个命令。一次前端超时重试变成两次 `ideaseek run` 是不可接受的。
 */
import type { BackendErrorLike, Db } from './deps.ts';
import { rows } from './deps.ts';
import type { Viewer } from './views.ts';
import { byExternalId, canRead, deniesAsAbsent, readLevel } from './views.ts';
import type { SyncPrincipal } from './token.ts';
import { assertProjectAllowed } from './token.ts';

/** 云端支持的命令类型；不在表里的一律 400。 */
export const COMMAND_TYPES = [
  'project_create',
  'project_settings',
  'project_archive',
  'run_start',
  'run_pause',
  'run_resume',
  'run_continue',
  'run_cancel',
] as const;

export type CommandType = (typeof COMMAND_TYPES)[number];

/** Agent 心跳超过这个窗口没来，界面就不再说"在线"。 */
export const ONLINE_WINDOW_MS = 90_000;
/** 领取后没有结果回写这么久 = 租约过期，重新排队由人工决定，这里只标 expired。 */
const LEASE_MS = 15 * 60_000;
const MAX_CLAIM_PER_HEARTBEAT = 5;
const TEXT_CAP = 500;
const MAX_FILE_NODES = 2_000;

const TERMINAL = new Set(['succeeded', 'failed', 'expired', 'canceled']);

interface CommandRow {
  id: string;
  project_id: string | null;
  external_command_id: string;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  created_by: string;
  created_at: string;
  claimed_at: string | null;
  heartbeat_at: string | null;
  finished_at: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
}

interface AgentRow {
  id: string;
  owner_id: string;
  agent_version: string | null;
  local_projects: unknown;
  last_seen_at: string;
  active_commands: number;
}

// ---------------------------------------------------------------------------
// 载荷校验：平台只钉机械不变量（长度、路径形状、必填字段），语义判断交给 Agent。
// ---------------------------------------------------------------------------

/** 相对路径、不含 `..`、不是绝对路径、不带 Windows 盘符与 `~`。 */
function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return false;
  if (value.startsWith('/') || value.startsWith('\\') || value.startsWith('~')) return false;
  if (/^[a-zA-Z]:/.test(value)) return false;
  if (value.includes('\\')) return false;
  return !value.split('/').some((segment) => segment === '..' || segment === '');
}

/**
 * git ref 名的机械不变量（Phase 7）。这里只管"能不能安全拼进 argv"，不管分支该不该
 * 存在——后者是 Agent 的语义判断（判断归 Agent，边界归平台）。
 * 以 `-` 开头会被 git 当成开关，`@{`/`~`/`^` 是 rev-parse 语法，`..` 是范围：
 * 全部拒掉，不给"分支名顺带带了个开关"留路径。
 */
function isSafeRef(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 80) return false;
  if (value.startsWith('-') || value.startsWith('/') || value.startsWith('.')) return false;
  if (value.endsWith('/') || value.endsWith('.') || value.endsWith('.lock')) return false;
  if (/[\s~^:?*[\\@{}]/.test(value)) return false;
  if (value.includes('..')) return false;
  return !value.split('/').some((segment) => segment === '' || segment === '.');
}

/** 删除保护：主分支不在云端可删的集合里，需要的人在自己终端上做。 */
const PROTECTED_BRANCHES = new Set(['main', 'master']);

/** 分支清单：只留 ref 名与领先/落后读数，形状不对的条目直接丢掉而不是报错。 */
function sanitizeBranches(value: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value)) return null;
  const out: Array<Record<string, unknown>> = [];
  for (const item of value.slice(0, 200)) {
    const entry = item as { name?: unknown; current?: unknown; ahead?: unknown; behind?: unknown };
    if (!isSafeRef(entry.name)) continue;
    out.push({ name: entry.name, current: entry.current === true, ahead: integer(entry.ahead), behind: integer(entry.behind) });
  }
  return out;
}

/** 冲突：只有路径。三栏 diff 需要正文，正文不进云（0004 头注）。 */
function sanitizeConflicts(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter(isSafeRelativePath).slice(0, 200);
}

/** remote 只留名字：URL 可能内嵌凭据（`https://user:token@host`），一律不落库。 */
function sanitizeRemotes(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value.slice(0, 20)) {
    const name = typeof item === 'string' ? item : (item as { name?: unknown })?.name;
    if (isSafeRef(name)) out.push(name);
  }
  return out;
}

function text(value: unknown, cap = TEXT_CAP): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > cap) return null;
  // 凭据形状的字符串不进队列：命令载荷会被 Agent 原样拼进 argv，也会被日志抄走。
  if (/(api[_-]?key|secret|passw(?:or)?d|token)\s*[:=]\s*\S/i.test(trimmed)) return null;
  return trimmed;
}

function integer(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) return null;
  return value;
}

/**
 * 可选文本字段的两态语义：**没填**（undefined / null / 纯空白）→ `null`；
 * **填了** → 走 `text()` 清洗，清洗不过（凭据形状、超长、非字符串）才算非法。
 *
 * 界面上"研究问题可以留空"，而前端始终把 `question` 字段带上，空串必须等价于
 * 没填——按非法输入拒掉的话，不写问题就建不了项目。
 */
function optionalText(value: unknown, cap: number, field: string, fail: (field: string) => never): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.trim().length === 0) return null;
  return text(value, cap) ?? fail(field);
}

/**
 * 每种命令一张最小形状表。返回的是**清洗过的**载荷——未列出的字段一律丢弃，
 * 不做透传：透传等于把任意 JSON 交给 Agent 的解释器。
 */
export function validatePayload(
  type: string,
  body: Record<string, unknown>,
  BackendError: BackendErrorLike,
): Record<string, unknown> {
  const fail = (field: string): never => {
    throw new BackendError(`invalid_input:${type}.${field}`, 400);
  };

  switch (type) {
    case 'project_create': {
      const name = text(body.name, 80) ?? fail('name');
      const question = optionalText(body.question, TEXT_CAP, 'question', fail);
      const strategy = body.strategy ?? 'standard';
      if (strategy !== 'starter' && strategy !== 'standard' && strategy !== 'research') fail('strategy');
      const autonomy = body.autonomy ?? 'guided';
      if (autonomy !== 'guided' && autonomy !== 'autonomous' && autonomy !== 'review-only') fail('autonomy');
      return { name, question, strategy, autonomy };
    }
    case 'project_settings': {
      const patch: Record<string, unknown> = {};
      if (body.title !== undefined) patch.title = text(body.title, 200) ?? fail('title');
      // 空串 = 清空研究问题，与 project_create 同一条语义。
      if (body.question !== undefined) patch.question = optionalText(body.question, TEXT_CAP, 'question', fail);
      if (body.strategy !== undefined) {
        if (!['starter', 'standard', 'research'].includes(String(body.strategy))) fail('strategy');
        patch.strategy = body.strategy;
      }
      if (body.autonomy !== undefined) {
        if (!['guided', 'autonomous', 'review-only'].includes(String(body.autonomy))) fail('autonomy');
        patch.autonomy = body.autonomy;
      }
      if (body.visibility !== undefined) {
        // Q1 三档；listed 是"对外公开列表"，改这一档必须在界面上二次确认，
        // 但那道确认是前端动作，这里只保证进来的值合法。
        if (!['private', 'link', 'listed'].includes(String(body.visibility))) fail('visibility');
        patch.visibility = body.visibility;
      }
      if (Object.keys(patch).length === 0) fail('empty_patch');
      return patch;
    }
    case 'project_archive':
      return {};
    case 'run_start': {
      const question = text(body.question, TEXT_CAP) ?? fail('question');
      const out: Record<string, unknown> = { question };
      if (body.harness !== undefined) {
        if (!['fake', 'dsh'].includes(String(body.harness))) fail('harness');
        out.harness = body.harness;
      }
      if (body.enqueue_only === true) out.enqueue_only = true;
      return out;
    }
    case 'run_pause': {
      const out: Record<string, unknown> = {};
      if (body.run !== undefined) out.run = text(body.run, 64) ?? fail('run');
      if (body.hard === true) out.hard = true;
      return out;
    }
    case 'run_resume':
    case 'run_continue':
    case 'run_cancel': {
      const out: Record<string, unknown> = {};
      if (body.run !== undefined) out.run = text(body.run, 64) ?? fail('run');
      return out;
    }
    default:
      throw new BackendError(`invalid_input:unknown_type`, 400);
  }
}

// ---------------------------------------------------------------------------
// Web 侧：排队与读数
// ---------------------------------------------------------------------------

function commandCard(row: CommandRow, full: boolean) {
  const base = {
    command_id: row.external_command_id,
    type: row.type,
    status: row.status,
    created_at: row.created_at,
    claimed_at: row.claimed_at,
    finished_at: row.finished_at,
  };
  if (!full) return { ...base, projection_level: 'l2' as const };
  return {
    ...base,
    projection_level: 'full' as const,
    payload: row.payload,
    result: row.result,
    // 错误原文可能带本地路径：只给截断后的首行，不整段回显。
    error: row.error ? row.error.split('\n')[0]!.slice(0, 200) : null,
  };
}

/** 把 external_id 换成内部 uuid；找不到按调用方的语义决定 404/403。 */
async function resolveProject(
  db: Db,
  externalId: string,
  BackendError: BackendErrorLike,
): Promise<{ id: string; owner_id: string; visibility: string }> {
  const project = await byExternalId(db, externalId, BackendError);
  if (!project) throw new BackendError('not_found', 404);
  return { id: project.id, owner_id: project.owner_id, visibility: project.visibility };
}

/**
 * 提交一条命令。返回的永远是"已排队"而不是"已完成"——这一条就是 R2 的同一原则
 * 用在执行面上：云端没有执行能力，界面就不许写成执行结果。
 */
/**
 * 获取或创建匿名 Owner——用于未登录状态下的 project_create。
 * 所有匿名用户共享同一个 owner 行，避免为每次请求创建新记录。
 */
async function getOrCreateAnonymousOwner(db: Db, BackendError: BackendErrorLike): Promise<string> {
  const ANONYMOUS_EMAIL = '__anonymous__@system';
  const existing = rows<{ id: string }>(
    await db.from<{ id: string }>('cloud_owner').select('id').eq('email', ANONYMOUS_EMAIL).limit(1),
    BackendError,
  )[0];
  if (existing) return existing.id;
  
  const created = rows<{ id: string }>(
    await db
      .from<{ id: string; email: string; display_name: string }>('cloud_owner')
      .insert({ email: ANONYMOUS_EMAIL, display_name: 'Anonymous User' })
      .select('id'),
    BackendError,
  )[0];
  return created.id;
}

export async function enqueueCommand(
  db: Db,
  viewer: Viewer,
  type: string,
  body: Record<string, unknown>,
  BackendError: BackendErrorLike,
): Promise<Response> {
  if (!COMMAND_TYPES.includes(type as CommandType)) throw new BackendError('not_found', 404);
  
  // project_create 允许匿名：未登录时自动分配系统匿名 Owner
  let effectiveOwnerId = viewer.ownerId;
  if (!effectiveOwnerId && type === 'project_create') {
    effectiveOwnerId = await getOrCreateAnonymousOwner(db, BackendError);
  }
  if (!effectiveOwnerId) throw new BackendError('login_required', 401);

  const payload = validatePayload(type, body, BackendError);
  const externalCommandId = text(body.command_id, 64) ?? crypto.randomUUID();

  // 幂等回放：同一个 command_id 已经存在就原样返回，不再插行、不再改变状态。
  const existing = rows<CommandRow>(
    await db.from<CommandRow>('cloud_command').select('*').eq('external_command_id', externalCommandId).limit(1),
    BackendError,
  )[0];
  if (existing) {
    if (existing.created_by !== effectiveOwnerId) throw new BackendError('no_access', 403);
    // 幂等键撞车但载荷不同：客户端把同一个 id 用在了两件事上。仍然只返回原记录
    // （不插第二行、不改状态），但必须把 mismatch 说出来——静默回放会让界面显示一条
    // 用户其实没打算排的动作。
    const mismatch = JSON.stringify(existing.payload ?? null) !== JSON.stringify(payload);
    return Response.json({
      ok: true,
      replayed: true,
      payload_mismatch: mismatch,
      command: commandCard(existing, true),
      message: mismatch
        ? '同一个 command_id 已经排过一条不同载荷的命令：返回原记录，没有排第二条'
        : '命令已存在，返回原记录（未重复排队）',
    });
  }

  let projectId: string | null = null;
  if (type !== 'project_create') {
    const externalId = text(body.external_id, 64);
    if (!externalId) throw new BackendError('invalid_input:external_id', 400);
    const project = await resolveProject(db, externalId, BackendError);
    if (project.owner_id !== effectiveOwnerId) {
      // 不是 Owner：对外按"不存在"处理（deniesAsAbsent 的同一条理由——external_id
      // 就是本地目录名，403 等于承认它存在）。
      throw new BackendError(deniesAsAbsent(viewer) ? 'not_found' : 'no_access', deniesAsAbsent(viewer) ? 404 : 403);
    }
    projectId = project.id;
  }

  const created = rows<CommandRow>(
    await db
      .from<CommandRow>('cloud_command')
      .insert({
        project_id: projectId,
        external_command_id: externalCommandId,
        type,
        payload,
        status: 'queued',
        created_by: effectiveOwnerId,
        created_at: new Date().toISOString(),
      })
      .select('*'),
    BackendError,
  );
  const row = created[0];
  if (!row) throw new BackendError('write_failed', 500);

  return Response.json({
    ok: true,
    command: commandCard(row, true),
    message: projectId === null ? '创建请求已排队，等待本地 Agent 执行' : '命令已排队，等待本地 Agent 执行',
  });
}

/**
 * 撤回一条还在排队的命令（Phase 10.1，UC-08 的取消路径）。
 *
 * 这是云端队列自己的动作，不是投影写：queued 的命令在本机还没有任何副作用，撤掉它
 * 只是"不再下发"。claimed/running 的不在这里改——中断一个正在跑的进程是本地的事，
 * Web 面能排的是 `run_cancel`；把撤回做成强制中断，等于云端撒谎说它停下了一个其实
 * 还在跑的东西，而界面上的"已取消"就是那条假读数。
 */
export async function cancelCommand(
  db: Db,
  viewer: Viewer,
  body: Record<string, unknown>,
  BackendError: BackendErrorLike,
): Promise<Response> {
  if (!viewer.ownerId) throw new BackendError('login_required', 401);
  const externalId = text(body.external_id, 64);
  const commandId = text(body.command_id, 64);
  if (!externalId) throw new BackendError('invalid_input:external_id', 400);
  if (!commandId) throw new BackendError('invalid_input:command_id', 400);
  const project = await resolveProject(db, externalId, BackendError);
  if (project.owner_id !== viewer.ownerId) {
    throw new BackendError(deniesAsAbsent(viewer) ? 'not_found' : 'no_access', deniesAsAbsent(viewer) ? 404 : 403);
  }

  const row = rows<CommandRow>(
    await db
      .from<CommandRow>('cloud_command')
      .select('*')
      .eq('external_command_id', commandId)
      .eq('project_id', project.id)
      .limit(1),
    BackendError,
  )[0];
  if (!row) throw new BackendError('not_found', 404);

  if (row.status !== 'queued') {
    // 交出去之后就不在云端手里了：回 200 + ignored，让界面能说清按钮为什么没改变状态，
    // 而不是把"已经有人在执行"报成一次失败。
    return Response.json({
      ok: true,
      ignored: 'already_claimed',
      command: commandCard(row, true),
      message: '这条命令已被本地 Agent 领取，云端不中断正在执行的命令；要停止运行请排队"取消运行"',
    });
  }

  const stamp = new Date().toISOString();
  const updated = rows<CommandRow>(
    await db.from<CommandRow>('cloud_command').update({ status: 'canceled', finished_at: stamp }).eq('id', row.id).select('*'),
    BackendError,
  )[0];
  if (!updated) throw new BackendError('write_failed', 500);
  return Response.json({ ok: true, command: commandCard(updated, true), message: '命令已撤回，本地不会执行' });
}

/**
 * Owner 的全局待创建队列：`external_id` 为空时用它。
 *
 * 首页在项目还没落地之前就需要看到"排队中的创建请求"和本机是否在线，而那些命令
 * 根本没有 project_id，按项目查是查不到的。这里只返回 Owner 自己的行——匿名没有
 * Owner 身份，直接 401，不返回一个看起来像"没有待创建"的空列表。
 */
async function ownerProvisioningOnly(db: Db, viewer: Viewer, BackendError: BackendErrorLike): Promise<Response> {
  if (!viewer.ownerId) throw new BackendError('login_required', 401);
  const rowsFound = rows<CommandRow>(
    await db.from<CommandRow>('cloud_command').select('*').eq('type', 'project_create').order('created_at', { ascending: false }).limit(20),
    BackendError,
  ).filter((row) => row.created_by === viewer.ownerId && row.project_id === null);

  // 操作台账（Phase 9.4）：谁排的、什么时候、排了什么、结果如何。这里不新造一张
  // 审计表——命令行本身就是那条记录，再造一份等于给同一个事实两个真相。
  const projects = rows<{ id: string; external_id: string }>(
    await db.from<{ id: string; external_id: string }>('cloud_project').select('id,external_id').limit(500),
    BackendError,
  );
  const externalOf = new Map(projects.map((project) => [project.id, project.external_id]));
  const mine = rows<CommandRow>(
    await db.from<CommandRow>('cloud_command').select('*').eq('created_by', viewer.ownerId).order('created_at', { ascending: false }).limit(50),
    BackendError,
  );

  return Response.json({
    ok: true,
    generated_at: new Date().toISOString(),
    projection_level: 'full',
    writable: true,
    commands: [],
    audit: mine.map((row) => ({
      command_id: row.external_command_id,
      type: row.type,
      status: row.status,
      created_at: row.created_at,
      finished_at: row.finished_at,
      project: row.project_id ? (externalOf.get(row.project_id) ?? null) : null,
      // 结果与错误只给首行摘要：台账要能指路，不需要把本地输出搬进浏览器。
      error: row.error ? row.error.split('\n')[0]!.slice(0, 200) : null,
    })),
    provisioning: rowsFound.map((row) => ({
      command_id: row.external_command_id,
      status: row.status,
      created_at: row.created_at,
      name: (row.payload as { name?: unknown })?.name ?? null,
    })),
  });
}

/** 命令列表 + 尚未落到投影的排队创建请求；`externalId` 为空 = Owner 的全局待创建。 */
export async function commandView(
  db: Db,
  viewer: Viewer,
  externalId: string,
  BackendError: BackendErrorLike,
): Promise<Response> {
  if (externalId === '') return ownerProvisioningOnly(db, viewer, BackendError);
  const project = await byExternalId(db, externalId, BackendError);
  if (!project) throw new BackendError('not_found', 404);
  if (!canRead(viewer, project)) throw new BackendError(deniesAsAbsent(viewer) ? 'not_found' : 'no_access', deniesAsAbsent(viewer) ? 404 : 403);
  const full = readLevel(viewer, project) === 'full';

  const found = rows<CommandRow>(
    await db.from<CommandRow>('cloud_command').select('*').eq('project_id', project.id).order('created_at', { ascending: false }).limit(30),
    BackendError,
  );

  // Owner 的"待创建"请求没有 project_id，只能按 created_by 捞。
  const provisioning = full
    ? rows<CommandRow>(
        await db.from<CommandRow>('cloud_command').select('*').eq('type', 'project_create').order('created_at', { ascending: false }).limit(20),
        BackendError,
      ).filter((row) => row.created_by === viewer.ownerId && row.project_id === null)
    : [];

  return Response.json({
    ok: true,
    generated_at: new Date().toISOString(),
    projection_level: full ? 'full' : 'l2',
    writable: viewer.ownerId === project.owner_id,
    commands: found.map((row) => commandCard(row, full)),
    provisioning: provisioning.map((row) => ({
      command_id: row.external_command_id,
      status: row.status,
      created_at: row.created_at,
      name: (row.payload as { name?: unknown })?.name ?? null,
    })),
  });
}

/** 项目设置/可见性/归档只能排成命令，所以这里不提供任何直接写投影的入口。 */
export async function projectCreateView(
  db: Db,
  viewer: Viewer,
  body: Record<string, unknown>,
  BackendError: BackendErrorLike,
): Promise<Response> {
  // 云原生模式：直接在 Function 内执行，不排队（M0 起 local-agent 已删除）
  return executeInCloud(db, viewer, 'project_create', body, BackendError);
}

/**
 * 云端执行器：在 Function 内直接执行命令（M0.3 起为真执行，不再是演示桩）。
 * 只支持白名单操作，不执行任意代码。
 */
async function executeInCloud(
  db: Db,
  viewer: Viewer,
  type: string,
  body: Record<string, unknown>,
  BackendError: BackendErrorLike,
): Promise<Response> {
  // 云端执行只允许安全操作
  const CLOUD_ALLOWED_TYPES = ['project_create'];
  if (!CLOUD_ALLOWED_TYPES.includes(type)) {
    throw new BackendError('cloud_execution_not_allowed', 403);
  }

  if (type === 'project_create') {
    return createProjectInCloud(db, viewer, body, BackendError);
  }

  // 未来扩展：run_start / run_pause / etc. 各走自己的 handler
  throw new BackendError('cloud_execution_not_allowed', 403);
}

/**
 * 真实创建项目：写 cloud_project + cloud_run + cloud_stage + cloud_event + live_outbox，
 * 再把 cloud_command 的 project_id 与 status 更新为 succeeded。
 * 任何一步失败 → command 标 failed，不返回假成功。
 */
async function createProjectInCloud(
  db: Db,
  viewer: Viewer,
  body: Record<string, unknown>,
  BackendError: BackendErrorLike,
): Promise<Response> {
  const effectiveOwnerId = viewer.ownerId ?? (await getOrCreateAnonymousOwner(db, BackendError));
  const externalCommandId = text(body.command_id, 64) ?? crypto.randomUUID();

  // 幂等回放：同一个 command_id 已存在 → 返回原记录
  const existingCommand = rows<CommandRow>(
    await db.from<CommandRow>('cloud_command').select('*').eq('external_command_id', externalCommandId).limit(1),
    BackendError,
  )[0];
  if (existingCommand) {
    if (existingCommand.created_by !== effectiveOwnerId) throw new BackendError('no_access', 403);
    const mismatch = JSON.stringify(existingCommand.payload ?? null) !== JSON.stringify(validatePayload('project_create', body, BackendError));
    return Response.json({
      ok: true,
      replayed: true,
      payload_mismatch: mismatch,
      command: commandCard(existingCommand, true),
      cloud_executed: existingCommand.status === 'succeeded',
      message: mismatch
        ? '同一个 command_id 已执行过一条不同载荷的命令：返回原记录'
        : '命令已执行过，返回原记录（未重复创建）',
    });
  }

  const payload = validatePayload('project_create', body, BackendError);
  const externalProjectId = `proj-${crypto.randomUUID().slice(0, 12)}`;
  const externalRunId = `run-${crypto.randomUUID().slice(0, 12)}`;
  const now = new Date().toISOString();

  // 1. 创建命令记录（status=running，先占位）
  const commandCreated = rows<CommandRow>(
    await db
      .from<CommandRow>('cloud_command')
      .insert({
        project_id: null,
        external_command_id: externalCommandId,
        type: 'project_create',
        payload,
        status: 'running',
        created_by: effectiveOwnerId,
        created_at: now,
        claimed_at: now,
      })
      .select('*'),
    BackendError,
  );
  const commandRow = commandCreated[0];
  if (!commandRow) throw new BackendError('write_failed', 500);

  try {
    // 2. 创建项目
    const projectCreated = rows<{ id: string }>(
      await db
        .from<{ id: string }>('cloud_project')
        .insert({
          owner_id: effectiveOwnerId,
          external_id: externalProjectId,
          title: String(payload.name),
          question: payload.question ?? null,
          strategy: String(payload.strategy),
          autonomy: String(payload.autonomy),
          visibility: 'private',
          source_host: null,
          schema_version: 1,
          last_sync_at: now,
          archived_at: null,
          created_at: now,
        })
        .select('id'),
      BackendError,
    );
    const projectId = projectCreated[0]?.id;
    if (!projectId) throw new Error('project write returned no id');

    // 3. 创建运行
    const runCreated = rows<{ id: string }>(
      await db
        .from<{ id: string }>('cloud_run')
        .insert({
          project_id: projectId,
          external_run_id: externalRunId,
          status: 'created',
          phase_tag: 'INIT',
          question: payload.question ?? null,
          block_reason: null,
          error_class: null,
          summary: 'Project created in cloud',
          started_at: now,
          finished_at: null,
          heartbeat_at: now,
          config_hash: null,
          budget_usd_micro: 0,
          spent_usd_micro: 0,
          synced_at: now,
        })
        .select('id'),
      BackendError,
    );
    const runId = runCreated[0]?.id;
    if (!runId) throw new Error('run write returned no id');

    // 4. 创建初始阶段（INIT 阶段 active）
    rows(
      await db
        .from('cloud_stage_progress')
        .insert({
          run_id: runId,
          stage: 'INIT',
          state: 'active',
          stage_known: true,
          gate_note: 'Project created, awaiting input',
          blocker_code: null,
          entered_at: now,
          exited_at: null,
        })
        .select('id'),
      BackendError,
    );

    // 5. 创建首条事件
    rows(
      await db
        .from('cloud_run_event')
        .insert({
          run_id: runId,
          seq: 1,
          ts: now,
          phase_tag: 'INIT',
          object_type: 'project',
          object_id: externalProjectId,
          actor_role: 'system',
          type: 'project_created',
          summary: `Project "${payload.name}" created in cloud`,
          truncated: false,
          level: 'info',
          artifact_refs: null,
        })
        .select('id'),
      BackendError,
    );

    // 6. 写 live_outbox 帧（让 UI 立即看到）
    const latestSeq = rows<{ seq: number }>(
      await db
        .from<{ seq: number }>('live_outbox')
        .select('seq')
        .eq('project_id', projectId)
        .order('seq', { ascending: false })
        .limit(1),
      BackendError,
    );
    const nextSeq = (latestSeq[0]?.seq ?? 0) + 1;
    try {
      rows(
        await db
          .from('live_outbox')
          .insert({
            project_id: projectId,
            frame_type: 'state',
            payload: {
              project: { external_id: externalProjectId, title: payload.name, visibility: 'private' },
              run: { external_run_id: externalRunId, status: 'created', phase_tag: 'INIT' },
              event: { seq: 1, type: 'project_created' },
            },
            seq: nextSeq,
          })
          .select('id'),
        BackendError,
      );
    } catch {
      // 广播失败不阻塞主流程，UI 下次轮询会看到
    }

    // 7. 更新命令：成功 + 关联项目（CAS：eq status='running' 防并发重入）
    const updated = rows<CommandRow>(
      await db
        .from<CommandRow>('cloud_command')
        .update({
          project_id: projectId,
          status: 'succeeded',
          finished_at: new Date().toISOString(),
          result: {
            cloud_executed: true,
            project_external_id: externalProjectId,
            run_external_id: externalRunId,
            message: '项目已在云端创建',
          },
        })
        .eq('id', commandRow.id)
        .eq('status', 'running')
        .select('*'),
      BackendError,
    );
    if (!updated[0]) throw new Error('command CAS update failed (status changed or no row)');

    return Response.json({
      ok: true,
      command: commandCard(updated[0], true),
      cloud_executed: true,
      project_external_id: externalProjectId,
      run_external_id: externalRunId,
      message: '项目已在云端创建',
    });
  } catch (error) {
    // 失败：标 command 为 failed
    await db
      .from<CommandRow>('cloud_command')
      .update({
        status: 'failed',
        finished_at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      })
      .eq('id', commandRow.id);

    throw new BackendError('cloud_execution_failed', 500);
  }
}

// ---------------------------------------------------------------------------
// Agent 侧：心跳、回写、领取
// ---------------------------------------------------------------------------

function scopeAllowed(principal: SyncPrincipal, BackendError: BackendErrorLike): void {
  if (!principal.scopes.includes('commands')) throw new BackendError('no_access', 403);
}

async function ownedProjectByExternal(
  db: Db,
  principal: SyncPrincipal,
  externalId: string,
  BackendError: BackendErrorLike,
) {
  // 上报是"多项目一轮心跳"：一个越界项目不能把整次心跳打成 403，否则 Agent 只要
  // 带着一个没登记的项目就永远同步不动。越界的按不存在处理，调用方记进 skipped。
  try {
    assertProjectAllowed(principal, externalId, BackendError);
  } catch {
    return null;
  }
  const project = await byExternalId(db, externalId, BackendError);
  if (!project || project.owner_id !== principal.ownerId) return null;
  return project;
}

/** 结果回写：只允许从非终态推进到终态，重复回写同一个命令返回 ignored。 */
async function applyResults(
  db: Db,
  principal: SyncPrincipal,
  results: unknown,
  BackendError: BackendErrorLike,
): Promise<Array<{ command_id: string; applied: boolean; reason?: string }>> {
  if (!Array.isArray(results)) return [];
  const outcome: Array<{ command_id: string; applied: boolean; reason?: string }> = [];
  for (const raw of results.slice(0, 20)) {
    const item = raw as { command_id?: unknown; status?: unknown; result?: unknown; error?: unknown };
    const commandId = text(item.command_id, 64);
    const status = String(item.status ?? '');
    if (!commandId || !TERMINAL.has(status)) {
      outcome.push({ command_id: String(item.command_id ?? ''), applied: false, reason: 'bad_shape' });
      continue;
    }
    const row = rows<CommandRow>(
      await db.from<CommandRow>('cloud_command').select('*').eq('external_command_id', commandId).limit(1),
      BackendError,
    )[0];
    if (!row || row.created_by !== principal.ownerId) {
      outcome.push({ command_id: commandId, applied: false, reason: 'not_found' });
      continue;
    }
    if (row.project_id) {
      const project = rows<{ external_id: string }>(
        await db.from<{ external_id: string }>('cloud_project').select('external_id').eq('id', row.project_id).limit(1),
        BackendError,
      )[0];
      if (project) {
        try {
          assertProjectAllowed(principal, project.external_id, BackendError);
        } catch {
          outcome.push({ command_id: commandId, applied: false, reason: 'out_of_scope' });
          continue;
        }
      }
    }
    if (TERMINAL.has(row.status)) {
      outcome.push({ command_id: commandId, applied: false, reason: 'already_terminal' });
      continue;
    }
    // result 是 Agent 侧 CLI 的 --json 输出：整体留在库里但不回显给非 Owner，
    // 这里先钉住大小，超过就只留状态，不静默截断成半条 JSON。
    const serialized = JSON.stringify(item.result ?? null);
    const result = serialized && serialized.length <= 8_000 ? (JSON.parse(serialized) as Record<string, unknown>) : { oversized: true, bytes: serialized?.length ?? 0 };
    rows(
      await db
        .from('cloud_command')
        .update({
          status,
          finished_at: new Date().toISOString(),
          heartbeat_at: new Date().toISOString(),
          result,
          error: typeof item.error === 'string' ? item.error.slice(0, TEXT_CAP) : null,
        })
        .eq('id', row.id)
        .select('id'),
      BackendError,
    );
    outcome.push({ command_id: commandId, applied: true });
  }
  return outcome;
}

async function upsertAgent(
  db: Db,
  principal: SyncPrincipal,
  agentVersion: string | null,
  localProjects: unknown,
  activeCommands: number,
  BackendError: BackendErrorLike,
): Promise<void> {
  const now = new Date().toISOString();
  const existing = rows<AgentRow>(
    await db.from<AgentRow>('cloud_agent').select('*').eq('owner_id', principal.ownerId).limit(1),
    BackendError,
  )[0];
  if (existing) {
    rows(
      await db
        .from('cloud_agent')
        .update({ last_seen_at: now, agent_version: agentVersion, local_projects: localProjects ?? existing.local_projects, active_commands: activeCommands })
        .eq('id', existing.id)
        .select('id'),
      BackendError,
    );
    return;
  }
  rows(
    await db
      .from('cloud_agent')
      .insert({
        owner_id: principal.ownerId,
        agent_version: agentVersion,
        local_projects: localProjects ?? [],
        last_seen_at: now,
        active_commands: activeCommands,
      })
      .select('id'),
    BackendError,
  );
}

async function applyReported(
  db: Db,
  principal: SyncPrincipal,
  reported: Record<string, unknown> | undefined,
  BackendError: BackendErrorLike,
): Promise<{ git: string[]; files: string[]; file_nodes_written: number[]; skipped: string[] }> {
  const applied = { git: [] as string[], files: [] as string[], file_nodes_written: [] as number[], skipped: [] as string[] };
  const now = new Date().toISOString();

  const git = reported?.git as Array<Record<string, unknown>> | undefined;
  for (const entry of Array.isArray(git) ? git.slice(0, 20) : []) {
    const externalId = text(entry.external_id, 64);
    if (!externalId) {
      applied.skipped.push('git:missing_external_id');
      continue;
    }
    const project = await ownedProjectByExternal(db, principal, externalId, BackendError);
    if (!project) {
      applied.skipped.push(`git:${externalId}`);
      continue;
    }
    const patch = {
      branch: text(entry.branch, 80),
      ahead: integer(entry.ahead),
      behind: integer(entry.behind),
      staged: integer(entry.staged),
      unstaged: integer(entry.unstaged),
      untracked: integer(entry.untracked),
      last_commit_hash: text(entry.last_commit_hash, 40),
      last_commit_at: typeof entry.last_commit_at === 'string' ? entry.last_commit_at : null,
      last_commit_text: text(entry.last_commit_text, TEXT_CAP),
      dirty: typeof entry.dirty === 'boolean' ? entry.dirty : null,
      branches: sanitizeBranches(entry.branches),
      conflicts: sanitizeConflicts(entry.conflicts),
      remotes: sanitizeRemotes(entry.remotes),
      reported_at: now,
    };
    const existing = rows<{ id: string }>(
      await db.from<{ id: string }>('cloud_git_state').select('id').eq('project_id', project.id).limit(1),
      BackendError,
    )[0];
    if (existing) rows(await db.from('cloud_git_state').update(patch).eq('id', existing.id).select('id'), BackendError);
    else rows(await db.from('cloud_git_state').insert({ project_id: project.id, ...patch }).select('id'), BackendError);
    applied.git.push(externalId);
  }

  const files = reported?.files as Array<Record<string, unknown>> | undefined;
  for (const entry of Array.isArray(files) ? files.slice(0, 20) : []) {
    const externalId = text(entry.external_id, 64);
    const nodes = Array.isArray(entry.nodes) ? entry.nodes.slice(0, MAX_FILE_NODES) : [];
    if (!externalId) {
      applied.skipped.push('files:missing_external_id');
      continue;
    }
    const project = await ownedProjectByExternal(db, principal, externalId, BackendError);
    if (!project) {
      applied.skipped.push(`files:${externalId}`);
      continue;
    }
    // 不用 delete 清树：受管 SDK 的删除语义没有本地验证过，赌它等于在生产里
    // 押一条没测过的调用。改成每轮心跳给在场节点盖同一个 reported_at，读侧只取
    // 最新一轮——消失的文件不再出现在清单里，代价是库里留着旧行（可整体重建）。
    const existing = new Map(
      rows<{ id: string; path: string }>(
        await db.from<{ id: string; path: string }>('cloud_file_node').select('id,path').eq('project_id', project.id).limit(MAX_FILE_NODES),
        BackendError,
      ).map((row) => [row.path, row.id] as const),
    );
    let written = 0;
    for (const node of nodes) {
      const item = node as { path?: unknown; kind?: unknown; size?: unknown; mime_type?: unknown; updated_at?: unknown };
      if (!isSafeRelativePath(item.path) || typeof item.kind !== 'string') continue;
      const patch = {
        kind: item.kind.slice(0, 20),
        size: integer(item.size),
        mime_type: text(item.mime_type, 80),
        updated_at: typeof item.updated_at === 'string' ? item.updated_at : null,
        reported_at: now,
      };
      const known = existing.get(item.path);
      if (known) rows(await db.from('cloud_file_node').update(patch).eq('id', known).select('id'), BackendError);
      else rows(await db.from('cloud_file_node').insert({ project_id: project.id, path: item.path, ...patch }).select('id'), BackendError);
      written += 1;
    }
    applied.files.push(externalId);
    applied.file_nodes_written.push(written);
  }

  return applied;
}

/**
 * 领取：把本心跳内可见的 queued 命令标成 claimed 并返回。
 *
 * 先扫租约过期（claimed 却 15 分钟没心跳 = Agent 中途死了），再领新命令。过期不自动
 * 重新排队：`run_start` 重放就是一次重复花费，宁可让 Owner 在界面上看到 expired
 * 并显式重试。
 */
async function claimQueued(
  db: Db,
  principal: SyncPrincipal,
  BackendError: BackendErrorLike,
): Promise<{ claimed: CommandRow[]; expired: string[] }> {
  const now = Date.now();
  const open = rows<CommandRow>(
    await db.from<CommandRow>('cloud_command').select('*').eq('status', 'claimed').order('created_at', { ascending: true }).limit(200),
    BackendError,
  ).concat(
    rows<CommandRow>(
      await db.from<CommandRow>('cloud_command').select('*').eq('status', 'running').order('created_at', { ascending: true }).limit(200),
      BackendError,
    ),
  );
  const expired: string[] = [];
  for (const row of open) {
    if (row.created_by !== principal.ownerId) continue;
    const touched = Date.parse(String(row.claimed_at ?? row.created_at));
    if (Number.isFinite(touched) && now - touched > LEASE_MS) {
      rows(
        await db
          .from('cloud_command')
          .update({ status: 'expired', finished_at: new Date().toISOString(), error: 'lease_expired_without_result' })
          .eq('id', row.id)
          .select('id'),
        BackendError,
      );
      expired.push(row.external_command_id);
    }
  }

  const queued = rows<CommandRow>(
    await db.from<CommandRow>('cloud_command').select('*').eq('status', 'queued').order('created_at', { ascending: true }).limit(100),
    BackendError,
  );
  const claimed: CommandRow[] = [];
  for (const row of queued) {
    if (claimed.length >= MAX_CLAIM_PER_HEARTBEAT) break;
    // 命令是 Owner 排给自己机器的：created_by 不等于这个 token 的 Owner 就不下发。
    if (row.created_by !== principal.ownerId) continue;
    if (row.project_id) {
      const project = rows<{ external_id: string }>(
        await db.from<{ external_id: string }>('cloud_project').select('external_id').eq('id', row.project_id).limit(1),
        BackendError,
      )[0];
      if (!project) continue;
      try {
        assertProjectAllowed(principal, project.external_id, BackendError);
      } catch {
        continue;
      }
    }
    const stamp = new Date().toISOString();
    const updated = rows<CommandRow>(
      await db.from<CommandRow>('cloud_command').update({ status: 'claimed', claimed_at: stamp, heartbeat_at: stamp }).eq('id', row.id).select('*'),
      BackendError,
    )[0];
    if (updated) claimed.push({ ...row, status: 'claimed', claimed_at: stamp, heartbeat_at: stamp });
  }
  return { claimed, expired };
}

export interface HeartbeatBody {
  agent_version?: unknown;
  local_projects?: unknown;
  results?: unknown;
  reported?: unknown;
}

/**
 * 一次心跳做完四件事：回写结果、刷新在线状态、收下自报的仓库/文件读数、领走待执行
 * 命令。刻意不做长连接：Edge 运行时对常驻连接没有验收过（SPIKE §9 只验了浏览器侧
 * WS 握手），而轮询的命令通道在断网、重启、租约过期三种情况下都有确定语义。
 */
export async function agentHeartbeat(
  db: Db,
  principal: SyncPrincipal,
  body: HeartbeatBody,
  BackendError: BackendErrorLike,
): Promise<Response> {
  scopeAllowed(principal, BackendError);

  const applied = await applyResults(db, principal, body.results, BackendError);
  const reported = await applyReported(db, principal, body.reported as Record<string, unknown> | undefined, BackendError);

  const localProjects = Array.isArray(body.local_projects)
    ? body.local_projects
        .slice(0, 100)
        .map((item) => {
          const entry = item as { path?: unknown; name?: unknown; external_id?: unknown };
          return {
            path: typeof entry.path === 'string' ? entry.path.slice(0, 200) : null,
            name: typeof entry.name === 'string' ? entry.name.slice(0, 80) : null,
            external_id: text(entry.external_id, 64),
          };
        })
        .filter((entry) => entry.path !== null)
    : [];

  const { claimed, expired } = await claimQueued(db, principal, BackendError);
  await upsertAgent(db, principal, text(body.agent_version, 40), localProjects, claimed.length, BackendError);

  return Response.json({
    ok: true,
    server_time: new Date().toISOString(),
    lease_ms: LEASE_MS,
    applied_results: applied,
    applied_reported: reported,
    expired_commands: expired,
    commands: claimed.map((row) => ({
      command_id: row.external_command_id,
      type: row.type,
      payload: row.payload,
      project_id: row.project_id,
    })),
  });
}

/** 长任务中途的心跳：只续租，不领新命令。 */
export async function agentCommandHeartbeat(
  db: Db,
  principal: SyncPrincipal,
  body: { command_id?: unknown; status?: unknown },
  BackendError: BackendErrorLike,
): Promise<Response> {
  scopeAllowed(principal, BackendError);
  const commandId = text(body.command_id, 64);
  if (!commandId) throw new BackendError('invalid_input:command_id', 400);
  if (String(body.status ?? '') !== 'running') throw new BackendError('invalid_input:status', 400);

  const row = rows<CommandRow>(
    await db.from<CommandRow>('cloud_command').select('*').eq('external_command_id', commandId).limit(1),
    BackendError,
  )[0];
  if (!row || row.created_by !== principal.ownerId) throw new BackendError('not_found', 404);
  if (TERMINAL.has(row.status)) return Response.json({ ok: true, ignored: 'already_terminal', status: row.status });

  const stamp = new Date().toISOString();
  rows(await db.from('cloud_command').update({ status: 'running', heartbeat_at: stamp }).eq('id', row.id).select('id'), BackendError);
  return Response.json({ ok: true, command_id: commandId, status: 'running', lease_ms: LEASE_MS, server_time: stamp });
}

// ---------------------------------------------------------------------------
// 仓库/文件/在线状态读数（Web 侧）
//
// 这些表由 Agent 写、由 Owner 读；被邀读者与匿名访客一律拿不到（L1），
// 因为分支名、文件路径和提交摘要都会泄露研究方向。
// ---------------------------------------------------------------------------

async function requireFullRead(db: Db, viewer: Viewer, externalId: string, BackendError: BackendErrorLike) {
  const project = await byExternalId(db, externalId, BackendError);
  if (!project) throw new BackendError('not_found', 404);
  if (!canRead(viewer, project)) throw new BackendError(deniesAsAbsent(viewer) ? 'not_found' : 'no_access', deniesAsAbsent(viewer) ? 404 : 403);
  if (readLevel(viewer, project) !== 'full') throw new BackendError('no_access', 403);
  return project;
}

export async function agentView(db: Db, viewer: Viewer, externalId: string, BackendError: BackendErrorLike): Promise<Response> {
  // 首页没有项目可锚定：`external_id` 为空时按 Owner 自己那行 cloud_agent 报在线。
  if (externalId === '') {
    if (!viewer.ownerId) throw new BackendError('login_required', 401);
    const mine = rows<AgentRow>(
      await db.from<AgentRow>('cloud_agent').select('*').eq('owner_id', viewer.ownerId).limit(1),
      BackendError,
    )[0];
    const mineSeen = mine ? Date.parse(mine.last_seen_at) : Number.NaN;
    return Response.json({
      ok: true,
      generated_at: new Date().toISOString(),
      online: Number.isFinite(mineSeen) && Date.now() - mineSeen < ONLINE_WINDOW_MS,
      writable: true,
      last_seen_at: mine?.last_seen_at ?? null,
      agent_version: mine?.agent_version ?? null,
      active_commands: mine?.active_commands ?? 0,
      local_projects: Array.isArray(mine?.local_projects) ? mine.local_projects : [],
      reported_for_project: false,
    });
  }
  const project = await requireFullRead(db, viewer, externalId, BackendError);
  const agent = rows<AgentRow>(
    await db.from<AgentRow>('cloud_agent').select('*').eq('owner_id', project.owner_id).limit(1),
    BackendError,
  )[0];
  const seenAt = agent ? Date.parse(agent.last_seen_at) : Number.NaN;
  const online = Number.isFinite(seenAt) && Date.now() - seenAt < ONLINE_WINDOW_MS;
  return Response.json({
    ok: true,
    generated_at: new Date().toISOString(),
    online,
    writable: viewer.ownerId === project.owner_id,
    last_seen_at: agent?.last_seen_at ?? null,
    agent_version: agent?.agent_version ?? null,
    active_commands: agent?.active_commands ?? 0,
    local_projects: Array.isArray(agent?.local_projects) ? agent.local_projects : [],
    // 这个项目在本机有没有对应目录：没有它，命令排下去也不会有人执行。
    reported_for_project: Array.isArray(agent?.local_projects)
      ? (agent.local_projects as Array<{ external_id?: string | null }>).some((entry) => entry?.external_id === externalId)
      : false,
  });
}

export async function repoView(db: Db, viewer: Viewer, externalId: string, BackendError: BackendErrorLike): Promise<Response> {
  const project = await requireFullRead(db, viewer, externalId, BackendError);
  const git = rows<Record<string, unknown>>(
    await db.from<Record<string, unknown>>('cloud_git_state').select('*').eq('project_id', project.id).limit(1),
    BackendError,
  )[0];
  const files = rows<Record<string, unknown>>(
    await db.from<Record<string, unknown>>('cloud_file_node').select('path,kind,size,mime_type,updated_at,reported_at').eq('project_id', project.id).limit(MAX_FILE_NODES),
    BackendError,
  );
  // 只承认最新一轮上报：上一轮里已经不存在的文件不该继续出现在浏览器里。
  const newest = files.reduce((max, row) => (String(row.reported_at) > max ? String(row.reported_at) : max), '');
  const current = files
    .filter((row) => String(row.reported_at) === newest)
    .sort((a, b) => String(a.path).localeCompare(String(b.path)));
  return Response.json({
    ok: true,
    generated_at: new Date().toISOString(),
    projection_level: 'full',
    writable: viewer.ownerId === project.owner_id,
    git: git ?? null,
    files: current,
    file_count: current.length,
  });
}
