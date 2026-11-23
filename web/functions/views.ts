/**
 * 读路径。可见性判定**只能在这里**：平台不让我们在库里写策略
 * （`function_backend` 生成固定私有策略，SPIKE §5），所以"谁能看哪一列"
 * 是 SQL 谓词 + 列挑选，不是 RLS。
 *
 * 三级可见性（Q1）的语义是递进的两个动作：
 *   private —— 只有 Owner 与被邀 grant 的邮箱/账号可读；
 *   link    —— 持有未记名 share token 的人可读该项目；
 *   listed  —— 额外允许出现在公开列表里（F5.9：这是独立第二次确认的结果）。
 * 因此"在列表里出现"和"能读详情"是两条不同的判定，不能合成一个布尔。
 */
import type { BackendErrorLike, Db } from './deps.ts';
import { rows } from './deps.ts';
import { ContractError } from './contract.ts';

export interface Viewer {
  ownerId: string | null;
  /** 系统匿名 Owner ID：匿名用户创建的项目都归到这个 owner 下 */
  anonymousOwnerId: string | null;
  /** 来自 cloud_grant：被邀读者（Q8），role=reviewer，读到 L1（full）。 */
  grantedProjectIds: string[];
  /** role=viewer 的授权：能打开项目，但只到 L2——邀请时选了"只读降级"的人。 */
  limitedProjectIds: string[];
  /** 来自未记名 share token（`?share=`）；只在 link/listed 项目上生效。 */
  shareProjectId: string | null;
}

export function isOwner(viewer: Viewer): boolean {
  return viewer.ownerId !== null;
}

export interface ProjectRow {
  id: string;
  owner_id: string;
  external_id: string;
  title: string;
  question: string | null;
  strategy: string | null;
  autonomy: string | null;
  visibility: string;
  last_sync_at: string | null;
  archived_at: string | null;
}

export async function resolveViewer(
  request: Request,
  db: Db,
  user: { id: string } | null,
  BackendError: BackendErrorLike,
): Promise<Viewer> {
  // 查找系统匿名 Owner ID（用于匿名用户创建的项目）
  const ANONYMOUS_EMAIL = '__anonymous__@system';
  const anonymousOwner = rows<{ id: string }>(
    await db.from<{ id: string }>('cloud_owner').select('id').eq('email', ANONYMOUS_EMAIL).limit(1),
    BackendError,
  )[0];
  const anonymousOwnerId = anonymousOwner?.id ?? null;

  if (!user) {
    const share = new URL(request.url).searchParams.get('share');
    if (!share) return { ownerId: null, anonymousOwnerId, grantedProjectIds: [], limitedProjectIds: [], shareProjectId: null };
    // share token 只存哈希；撤销即失效（revoked_at 非空就当不存在）。
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(share));
    const hash = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const found = rows<{ project_id: string; revoked_at: string | null }>(
      await db.from<{ project_id: string; revoked_at: string | null }>('cloud_share_token').select('project_id,revoked_at').eq('token_hash', hash).limit(1),
      BackendError,
    );
    const active = found.find((row) => !row.revoked_at);
    return { ownerId: null, anonymousOwnerId, grantedProjectIds: [], limitedProjectIds: [], shareProjectId: active ? active.project_id : null };
  }

  // 网关注入的 user_id 映射到 cloud_owner：Owner 首次登录时按需建行。
  const owner = rows<{ id: string }>(
    await db.from<{ id: string }>('cloud_owner').select('id').eq('email', user.id).limit(1),
    BackendError,
  );
  let ownerId = owner[0]?.id;
  if (!ownerId) {
    const created = rows<{ id: string }>(
      await db.from<{ id: string }>('cloud_owner').insert({ email: user.id, display_name: null }).select('id'),
      BackendError,
    );
    ownerId = created[0]?.id;
  }
  if (!ownerId) throw new BackendError('write_failed', 500);

  // 撤销过的 grant 不再给读权限：SDK 的 null 谓词没在本地验证过，所以在这里过滤，
  // 不靠 `.eq(col, null)` 的平台语义（share token 同一处理方式）。
  //
  // 两条匹配路径（Phase 9.2）：`owner_id` 是对方已经登录过、行已建好的情形；
  // `email` 覆盖"先邀请、后来才第一次登录"的情形——登录时才按需建行，只按
  // owner_id 查会让那条邀请永远不生效，界面却显示"已邀请"。
  const grants = [
    ...rows<GrantRow>(await db.from<GrantRow>('cloud_grant').select('project_id,role,revoked_at').eq('owner_id', ownerId), BackendError),
    ...rows<GrantRow>(await db.from<GrantRow>('cloud_grant').select('project_id,role,revoked_at').eq('email', user.id), BackendError),
  ];
  const active = grants.filter((grant) => !grant.revoked_at);
  return {
    ownerId,
    anonymousOwnerId,
    grantedProjectIds: active.filter((grant) => grant.role !== 'viewer').map((grant) => grant.project_id),
    limitedProjectIds: active.filter((grant) => grant.role === 'viewer').map((grant) => grant.project_id),
    shareProjectId: null,
  };
}

interface GrantRow {
  project_id: string;
  role: string | null;
  revoked_at: string | null;
}

/**
 * 谁能读哪一级（REQUIREMENTS.md §4 的 L0/L1/L2）：
 *
 * - **full**：Owner 本人和被邀读者（`cloud_grant`）——库里存的 L1 字段原样给出。
 * - **l2**：`listed` 的匿名访客与持有未记名 share token 的人——只给 L2 allowlist，
 *   其余字段**在 Function 里就不选**，不是前端隐藏（F5.2）。平台侧 `function_backend`
 *   生成的是固定私有策略，写不了列级 RLS（SPIKE §5），所以列级判定只能落在这里。
 *
 * L2 allowlist 逐字取 REQUIREMENTS.md:110：项目标题、研究问题、阶段进度、结论标签、
 * 聚合指标、idea 标题与机制摘要。run 状态、事件摘要、成本、假设全文都是 L1
 * （`:109`），匿名与未记名链接都拿不到；`hypothesis` 的二次放开是 F5.4 的独立动作。
 */
export type ReadLevel = 'full' | 'l2';

export function canRead(viewer: Viewer, project: ProjectRow): boolean {
  if (viewer.ownerId && viewer.ownerId === project.owner_id) return true;
  // 匿名用户可以看自己创建的项目（归在系统匿名 Owner 下）
  if (!viewer.ownerId && viewer.anonymousOwnerId && viewer.anonymousOwnerId === project.owner_id) return true;
  if (viewer.grantedProjectIds.includes(project.id)) return true;
  if (viewer.limitedProjectIds.includes(project.id)) return true;
  // `listed` 的项目必须能打开：F2.1 让匿名访客在列表里看到它，点了却 403/404
  // 是一次破闭环（UC-03、F7.3 演示项目就落在这条路径上）。
  if (project.visibility === 'listed') return true;
  if (viewer.shareProjectId === project.id && project.visibility !== 'private') return true;
  return false;
}

export function readLevel(viewer: Viewer, project: ProjectRow): ReadLevel {
  if (viewer.ownerId && viewer.ownerId === project.owner_id) return 'full';
  // 匿名用户对自己创建的项目有 full 权限
  if (!viewer.ownerId && viewer.anonymousOwnerId && viewer.anonymousOwnerId === project.owner_id) return 'full';
  return viewer.grantedProjectIds.includes(project.id) ? 'full' : 'l2';
}

/** 降级说明写进响应，让前端能诚实标注"这是 L2 投影"而不是"数据就是空的"。 */
const L2_REDACTED = [
  'run.status',
  'run.block_reason',
  'run.budget_usd_micro',
  'run.spent_usd_micro',
  'run.summary',
  'event.summary',
  'stage.gate_note',
  'stage.blocker_code',
  'project.strategy',
  'project.autonomy',
  'unsynced',
] as const;

/**
 * 匿名读者被拒时应当**当作项目不存在**，而不是收到 403。
 *
 * 403 等于承认"这个 external_id 有一个私有项目"，而 external_id 就是本地目录名，
 * 猜中得到。F5.5 的"撤销后立刻 404"是同一条理由的推广：没有身份就没有存在性。
 * 有身份（Owner 自己打错、被邀读者、失效 share）才保留 403，因为那种情况下
 * 用户本来就知道它存在，报错要能指方向。
 */
export function deniesAsAbsent(viewer: Viewer): boolean {
  return viewer.ownerId === null && viewer.shareProjectId === null && viewer.grantedProjectIds.length === 0 && viewer.limitedProjectIds.length === 0;
}

export async function byExternalId(db: Db, externalId: string, BackendError: BackendErrorLike): Promise<ProjectRow | undefined> {
  return rows<ProjectRow>(
    await db.from<ProjectRow>('cloud_project').select('*').eq('external_id', externalId).limit(1),
    BackendError,
  )[0];
}

interface RunRow {
  external_run_id: string;
  status: string;
  phase_tag: string;
  question: string | null;
  block_reason: string | null;
  started_at: string | null;
  finished_at: string | null;
  heartbeat_at: string | null;
  budget_usd_micro: number;
  spent_usd_micro: number;
  summary: string | null;
}

interface StageRow {
  stage: string;
  state: string;
  stage_known: boolean;
  gate_note: string | null;
  blocker_code: string | null;
}

interface EventRow {
  seq: number;
  ts: string;
  phase_tag: string | null;
  type: string;
  summary: string;
  truncated: boolean;
  level: string;
}

function gapBefore(ordered: { seq: number }[]): number[] {
  // 缺口来自 per-run 序号：云端少了 N 条就是本地还有 N 条没投递，必须显示出来，
  // 不能安静地给出一条更短的时间线。
  return ordered.map((row, index) => (index === 0 ? 0 : Math.max(0, row.seq - ordered[index - 1]!.seq - 1)));
}

export async function projectIndex(db: Db, viewer: Viewer, BackendError: BackendErrorLike): Promise<Response> {
  const visible = rows<ProjectRow>(
    await db
      .from<ProjectRow>('cloud_project')
      .select('*')
      .order('last_sync_at', { ascending: false })
      .limit(200),
    BackendError,
  ).filter((project) => {
    if (project.archived_at) return false;
    // 列表页只列 Owner 自己的、被邀的、公开 listed 的，以及匿名用户自己创建的。
    return viewer.ownerId === project.owner_id 
      || (!viewer.ownerId && viewer.anonymousOwnerId === project.owner_id)  // 匿名用户看自己创建的
      || viewer.grantedProjectIds.includes(project.id) 
      || viewer.limitedProjectIds.includes(project.id) 
      || project.visibility === 'listed';
  });

  const projects = [];
  for (const project of visible) {
    const runs = rows<RunRow>(
      await db
        .from<RunRow>('cloud_run')
        .select('external_run_id,status,phase_tag,question,block_reason,started_at,finished_at,heartbeat_at,budget_usd_micro,spent_usd_micro,summary')
        .eq('project_id', project.id)
        .order('started_at', { ascending: false })
        .limit(1),
      BackendError,
    );
    // 列表页也分级：状态、花费、摘要是 L1（REQUIREMENTS.md:109），匿名列表项只留阶段。
    const full = readLevel(viewer, project) === 'full';
    const latest = runs[0];
    projects.push({
      external_id: project.external_id,
      title: project.title,
      visibility: project.visibility,
      last_sync_at: project.last_sync_at,
      projection_level: full ? 'full' : 'l2',
      latest_run: latest
        ? full
          ? { ...latest, stage_known: STAGE_KNOWN.has(latest.phase_tag) }
          : { phase_tag: latest.phase_tag, started_at: latest.started_at, finished_at: latest.finished_at, stage_known: STAGE_KNOWN.has(latest.phase_tag) }
        : null,
    });
  }
  return Response.json({ ok: true, generated_at: new Date().toISOString(), projects });
}

/** 与 DIAGRAMS.md §2.5 同源；不在表里的 phase 一律标成未上报。 */
const STAGE_KNOWN = new Set([
  'INIT',
  'INPUT_READY',
  'CALIBRATING',
  'PAPER_ANALYSIS',
  'DATA_READY',
  'PROTOCOL_PROPOSED',
  'PROTOCOL_REVIEW',
  'COMPARISON_DISCOVERY',
  'COMPARISON_REPRODUCTION',
  'BASELINE_VALIDATED',
  'IDEA_GENERATION',
  'IDEA_SCREENING',
  'EXPERIMENTING',
  'IDEA_REVIEW',
  'COMPLETED',
]);

export async function projectView(
  db: Db,
  viewer: Viewer,
  externalId: string,
  BackendError: BackendErrorLike,
): Promise<Response> {
  const project = await byExternalId(db, externalId, BackendError);
  if (!project) throw new BackendError('not_found', 404);
  if (!canRead(viewer, project)) {
    throw new BackendError(deniesAsAbsent(viewer) ? 'not_found' : 'no_access', deniesAsAbsent(viewer) ? 404 : 403);
  }

  const level = readLevel(viewer, project);
  // 降级不是"读出来再删字段"：L1 列在 L2 路径上根本不进 SELECT 列表，
  // 事件表根本不查。这样"前端忘了过滤"就不可能变成泄漏。
  const runColumns =
    level === 'full'
      ? 'external_run_id,status,phase_tag,question,block_reason,started_at,finished_at,heartbeat_at,budget_usd_micro,spent_usd_micro,summary'
      : 'external_run_id,phase_tag,started_at,finished_at';
  const runs = rows<RunRow>(
    await db
      .from<RunRow>('cloud_run')
      .select(runColumns)
      .eq('project_id', project.id)
      .order('started_at', { ascending: false })
      .limit(20),
    BackendError,
  );
  const latest = runs[0];
  const stageColumns = level === 'full' ? 'stage,state,stage_known,gate_note,blocker_code' : 'stage,state,stage_known';
  const stages = latest
    ? rows<StageRow>(
        await db
          .from<StageRow>('cloud_stage_progress')
          .select(stageColumns)
          .eq('run_id', await runId(db, project.id, latest.external_run_id, BackendError)),
        BackendError,
      )
    : [];
  const eventRows =
    level === 'full' && latest
      ? rows<EventRow>(
          await db
            .from<EventRow>('cloud_run_event')
            .select('seq,ts,phase_tag,type,summary,truncated,level')
            .eq('run_id', await runId(db, project.id, latest.external_run_id, BackendError))
            .order('seq', { ascending: false })
            .limit(80),
          BackendError,
        ).reverse()
      : [];

  const pending =
    level === 'full'
      ? rows<{ id: string }>(
          await db.from<{ id: string }>('cloud_sync_batch').select('id').eq('project_id', project.id).eq('status', 'accepted').limit(500),
          BackendError,
        )
      : [];

  // L2 的输出是**逐字段构造**的，不是"少选了列"：以后有人给 full 分支加字段，
  // 不会顺手漏进公开投影里。
  const shaped =
    level === 'full'
      ? runs.map((run) => ({ ...run, stage_known: STAGE_KNOWN.has(run.phase_tag) }))
      : runs.map((run) => ({
          external_run_id: run.external_run_id,
          phase_tag: run.phase_tag,
          started_at: run.started_at,
          finished_at: run.finished_at,
          stage_known: STAGE_KNOWN.has(run.phase_tag),
        }));
  const shapedStages =
    level === 'full' ? stages : stages.map((stage) => ({ stage: stage.stage, state: stage.state, stage_known: stage.stage_known }));

  return Response.json({
    ok: true,
    generated_at: new Date().toISOString(),
    visibility: project.visibility,
    projection_level: level,
    // 反向通道的写权限只认 Owner（commands.ts 第 2 条）。前端要按这个决定按钮是
    // 禁用还是消失，所以读数必须来自 Function，不能让前端用别的字段猜。
    writable: viewer.ownerId !== null && viewer.ownerId === project.owner_id,
    ...(level === 'full' ? {} : { redacted_fields: L2_REDACTED }),
    project: {
      external_id: project.external_id,
      title: project.title,
      question: project.question,
      ...(level === 'full' ? { strategy: project.strategy, autonomy: project.autonomy } : {}),
      last_sync_at: project.last_sync_at,
    },
    // L2 路径上 `shaped` 本身就只有 phase_tag/时间戳，状态与花费没被查出来。
    runs: shaped,
    stages: shapedStages,
    events: eventRows.map((event, index) => ({ ...event, gap_before: gapBefore(eventRows)[index] ?? 0 })),
    unsynced: { pending_batches: pending.length, dropped_events: 0 },
  });
}

async function runId(db: Db, projectId: string, externalRunId: string, BackendError: BackendErrorLike): Promise<string> {
  const found = rows<{ id: string }>(
    await db.from<{ id: string }>('cloud_run').select('id').eq('project_id', projectId).eq('external_run_id', externalRunId).limit(1),
    BackendError,
  );
  if (!found[0]) throw new ContractError(`运行不存在：${externalRunId}`, 404);
  return found[0].id;
}

// ---------------------------------------------------------------------------
// M6: 审批信箱 / 成本 / 外发 / Token 管理
// ---------------------------------------------------------------------------

interface ApprovalRow {
  id: string;
  run_id: string;
  external_approval_id: string;
  kind: string;
  summary: string;
  options: string[] | null;
  payload_hash: string | null;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

interface IntentRow {
  id: string;
  approval_request_id: string;
  choice: string;
  note: string | null;
  submitted_at: string;
  delivered_at: string | null;
  consumed_at: string | null;
}

/**
 * F11.1: 待确认审批列表——跨所有 Owner 可见项目聚合 pending 状态的审批请求。
 *
 * 只列 Owner 自己的项目上的审批（通过 project.owner_id 过滤），不暴露他人项目的审批。
 * F11.4: 每个审批附带已提交的意向列表，多个审批人可能选不同选项，并列展示不自动合并。
 */
export async function approvalIndex(db: Db, viewer: Viewer, BackendError: BackendErrorLike): Promise<Response> {
  if (!viewer.ownerId) {
    // 匿名访客看不到审批——审批是 Owner 动作，L2 不包含。
    return Response.json({ ok: true, approvals: [] });
  }

  // 先拿 Owner 自己的项目 ID 列表
  const projects = rows<{ id: string }>(
    await db.from<{ id: string }>('cloud_project').select('id').eq('owner_id', viewer.ownerId),
    BackendError,
  );
  const projectIds = projects.map((p) => p.id);
  if (projectIds.length === 0) return Response.json({ ok: true, approvals: [] });

  // 查所有 pending 审批
  const approvalRows: ApprovalRow[] = [];
  for (const pid of projectIds) {
    const runs = rows<{ id: string; external_run_id: string }>(
      await db.from<{ id: string; external_run_id: string }>('cloud_run').select('id,external_run_id').eq('project_id', pid),
      BackendError,
    );
    for (const run of runs) {
      const approvals = rows<ApprovalRow>(
        await db.from<ApprovalRow>('cloud_approval_request')
          .select('id,run_id,external_approval_id,kind,summary,options,payload_hash,status,created_at,resolved_at')
          .eq('run_id', run.id)
          .order('created_at', { ascending: false })
          .limit(100),
        BackendError,
      );
      for (const a of approvals) {
        approvalRows.push({ ...a, run_id: run.id });
      }
    }
  }

  // 为每个审批查意向列表（F11.4: 冲突意向并列）
  const result = [];
  for (const a of approvalRows) {
    const intents = rows<IntentRow>(
      await db.from<IntentRow>('cloud_approval_intent')
        .select('id,approval_request_id,choice,note,submitted_at,delivered_at,consumed_at')
        .eq('approval_request_id', a.id)
        .order('submitted_at', { ascending: false }),
      BackendError,
    );
    // 需要查 run 的 external_run_id
    const runRow = rows<{ external_run_id: string }>(
      await db.from<{ external_run_id: string }>('cloud_run').select('external_run_id').eq('id', a.run_id).limit(1),
      BackendError,
    );
    result.push({
      id: a.id,
      run_external_id: runRow[0]?.external_run_id ?? a.run_id,
      external_approval_id: a.external_approval_id,
      kind: a.kind,
      summary: a.summary,
      options: a.options,
      payload_hash: a.payload_hash,
      status: a.status,
      created_at: a.created_at,
      resolved_at: a.resolved_at,
      intents: intents.map((i) => ({
        id: i.id,
        choice: i.choice,
        note: i.note,
        submitted_at: i.submitted_at,
        delivered_at: i.delivered_at,
        consumed_at: i.consumed_at,
      })),
    });
  }

  return Response.json({ ok: true, generated_at: new Date().toISOString(), approvals: result });
}

/**
 * F11.3: 提交审批意向——Owner 在界面上选择后写入 cloud_approval_intent。
 *
 * 注意：这里只写意向，不触发执行。生效需本地引擎 pull + Owner 二次确认（REQUIREMENTS.md §3.3）。
 * 文案必须说"待本地确认"，UI 永不显示"已批准/已生效"。
 */
export async function submitIntent(
  db: Db,
  viewer: Viewer,
  approvalId: string,
  choice: string,
  note: string | null,
  BackendError: BackendErrorLike,
): Promise<Response> {
  if (!viewer.ownerId) throw new BackendError('no_access', 403);

  // 验证审批存在且属于 Owner 的项目
  const approval = rows<{ id: string; run_id: string; status: string }>(
    await db.from<{ id: string; run_id: string; status: string }>('cloud_approval_request')
      .select('id,run_id,status')
      .eq('id', approvalId)
      .limit(1),
    BackendError,
  );
  if (!approval[0]) throw new BackendError('not_found', 404);
  if (approval[0].status !== 'pending') throw new BackendError('conflict', 409);

  // 验证 run 属于 Owner 的项目
  const run = rows<{ project_id: string }>(
    await db.from<{ project_id: string }>('cloud_run').select('project_id').eq('id', approval[0].run_id).limit(1),
    BackendError,
  );
  if (!run[0]) throw new BackendError('not_found', 404);
  const project = rows<{ owner_id: string }>(
    await db.from<{ owner_id: string }>('cloud_project').select('owner_id').eq('id', run[0].project_id).limit(1),
    BackendError,
  );
  if (!project[0] || project[0].owner_id !== viewer.ownerId) throw new BackendError('no_access', 403);

  // 写入意向
  const created = rows<{ id: string }>(
    await db.from<{ id: string }>('cloud_approval_intent')
      .insert({
        approval_request_id: approvalId,
        owner_id: viewer.ownerId,
        choice,
        note,
        submitted_at: new Date().toISOString(),
        delivered_at: null,
        consumed_at: null,
      })
      .select('id'),
    BackendError,
  );
  if (!created[0]) throw new BackendError('write_failed', 500);

  return Response.json({ ok: true, intent_id: created[0].id, status: 'submitted', message: '待本地确认' });
}

interface CostRow {
  id: string;
  run_id: string;
  external_cost_id: string;
  kind: string;
  model_route: string | null;
  agent_role: string | null;
  usd_micro: number;
  tokens_in: number | null;
  tokens_out: number | null;
  ts: string;
}

/**
 * F12: 成本与额度视图——按 run 聚合花费，含预算进度与重复成本标记。
 *
 * F12.1: 花费汇总——token 数、USD micro、GPU 秒（若可用）。
 * F12.2: 预算进度——spent / budget，接近上限时高亮。
 * F12.3: 重复成本标记——同一 run 内相同 model_route + kind 出现多次可能是重试导致的重复。
 * F12.4: 按模型路由分布——各 route 的花费占比。
 */
export async function costView(
  db: Db,
  viewer: Viewer,
  externalId: string,
  BackendError: BackendErrorLike,
): Promise<Response> {
  const project = await byExternalId(db, externalId, BackendError);
  if (!project) throw new BackendError('not_found', 404);
  if (!canRead(viewer, project)) {
    throw new BackendError(deniesAsAbsent(viewer) ? 'not_found' : 'no_access', deniesAsAbsent(viewer) ? 404 : 403);
  }
  const level = readLevel(viewer, project);
  if (level !== 'full') {
    // 成本是 L1（REQUIREMENTS.md:109），L2 不返回。
    return Response.json({ ok: true, projection_level: 'l2', runs: [], summary: null });
  }

  const runs = rows<{ id: string; external_run_id: string; budget_usd_micro: number; spent_usd_micro: number }>(
    await db.from<{ id: string; external_run_id: string; budget_usd_micro: number; spent_usd_micro: number }>('cloud_run')
      .select('id,external_run_id,budget_usd_micro,spent_usd_micro')
      .eq('project_id', project.id)
      .order('started_at', { ascending: false })
      .limit(20),
    BackendError,
  );

  const runSummaries = [];
  let totalUsdMicro = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  const byRoute: Record<string, number> = {};

  for (const run of runs) {
    const costs = rows<CostRow>(
      await db.from<CostRow>('cloud_cost_entry')
        .select('id,run_id,external_cost_id,kind,model_route,agent_role,usd_micro,tokens_in,tokens_out,ts')
        .eq('run_id', run.id)
        .order('ts', { ascending: false })
        .limit(200),
      BackendError,
    );

    // F12.3: 重复成本标记——同一 run 内相同 model_route + kind 出现多次
    const seen = new Map<string, number>();
    let duplicateCandidates = 0;
    for (const c of costs) {
      const key = `${c.model_route ?? 'unknown'}:${c.kind}`;
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      if (count > 1) duplicateCandidates++;
    }

    // F12.4: 按模型路由分布
    for (const c of costs) {
      const route = c.model_route ?? 'unknown';
      byRoute[route] = (byRoute[route] ?? 0) + c.usd_micro;
    }

    const runTotal = costs.reduce((sum, c) => sum + c.usd_micro, 0);
    const runTokensIn = costs.reduce((sum, c) => sum + (c.tokens_in ?? 0), 0);
    const runTokensOut = costs.reduce((sum, c) => sum + (c.tokens_out ?? 0), 0);
    totalUsdMicro += runTotal;
    totalTokensIn += runTokensIn;
    totalTokensOut += runTokensOut;

    runSummaries.push({
      run_external_id: run.external_run_id,
      total_usd_micro: runTotal,
      total_tokens_in: runTokensIn,
      total_tokens_out: runTokensOut,
      budget_usd_micro: run.budget_usd_micro,
      spent_usd_micro: run.spent_usd_micro,
      duplicate_candidates: duplicateCandidates,
      by_route: Object.fromEntries(
        costs.reduce((map, c) => {
          const route = c.model_route ?? 'unknown';
          map.set(route, (map.get(route) ?? 0) + c.usd_micro);
          return map;
        }, new Map<string, number>()),
      ),
      entries: costs.map((c) => ({
        id: c.id,
        run_external_id: run.external_run_id,
        external_cost_id: c.external_cost_id,
        kind: c.kind,
        model_route: c.model_route,
        agent_role: c.agent_role,
        usd_micro: c.usd_micro,
        tokens_in: c.tokens_in,
        tokens_out: c.tokens_out,
        ts: c.ts,
      })),
    });
  }

  return Response.json({
    ok: true,
    generated_at: new Date().toISOString(),
    projection_level: 'full',
    runs: runSummaries,
    summary: {
      total_usd_micro: totalUsdMicro,
      total_tokens_in: totalTokensIn,
      total_tokens_out: totalTokensOut,
      by_route: byRoute,
    },
  });
}

interface EgressRow {
  id: string;
  run_id: string;
  external_egress_id: string;
  destination_class: string;
  data_class: string | null;
  event_count: number;
  bytes_approx: number | null;
  ts: string;
}

/**
 * F13: 外发透明度台账——按 run 聚合外发汇总。
 *
 * F13.1: 按 run 聚合——channel / target_class / count / bytes。
 * F13.2: 与启动授权对照——显示是否超出用户授权范围。
 * F13.3: 引擎侧计数来源——若引擎未产生数据，台账为空并显式说明。
 *
 * 注意：缺口⑫——只有类别与计数，没有 prompt 字段，也不该将来加一个。
 */
export async function egressView(
  db: Db,
  viewer: Viewer,
  externalId: string,
  BackendError: BackendErrorLike,
): Promise<Response> {
  const project = await byExternalId(db, externalId, BackendError);
  if (!project) throw new BackendError('not_found', 404);
  if (!canRead(viewer, project)) {
    throw new BackendError(deniesAsAbsent(viewer) ? 'not_found' : 'no_access', deniesAsAbsent(viewer) ? 404 : 403);
  }
  const level = readLevel(viewer, project);
  if (level !== 'full') {
    return Response.json({ ok: true, projection_level: 'l2', runs: [] });
  }

  const runs = rows<{ id: string; external_run_id: string }>(
    await db.from<{ id: string; external_run_id: string }>('cloud_run')
      .select('id,external_run_id')
      .eq('project_id', project.id)
      .order('started_at', { ascending: false })
      .limit(20),
    BackendError,
  );

  const runSummaries = [];
  for (const run of runs) {
    const egressRows = rows<EgressRow>(
      await db.from<EgressRow>('cloud_egress_entry')
        .select('id,run_id,external_egress_id,destination_class,data_class,event_count,bytes_approx,ts')
        .eq('run_id', run.id)
        .order('ts', { ascending: false })
        .limit(200),
      BackendError,
    );

    runSummaries.push({
      run_external_id: run.external_run_id,
      entries: egressRows.map((e) => ({
        id: e.id,
        run_external_id: run.external_run_id,
        external_egress_id: e.external_egress_id,
        destination_class: e.destination_class,
        data_class: e.data_class,
        event_count: e.event_count,
        bytes_approx: e.bytes_approx,
        ts: e.ts,
      })),
      total_event_count: egressRows.reduce((sum, e) => sum + e.event_count, 0),
      total_bytes: egressRows.reduce((sum, e) => sum + (e.bytes_approx ?? 0), 0),
    });
  }

  return Response.json({
    ok: true,
    generated_at: new Date().toISOString(),
    projection_level: 'full',
    runs: runSummaries,
  });
}

interface TokenRow {
  id: string;
  label: string | null;
  scopes: string[];
  project_scope: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/**
 * F16.1: Token 管理页——列出 Owner 的所有 sync token。
 *
 * 只存哈希（NFR-02），明文 token 永不入库。这里列出的是 token 的元数据（label, scopes, 状态）。
 */
export async function tokenList(db: Db, viewer: Viewer, BackendError: BackendErrorLike): Promise<Response> {
  if (!viewer.ownerId) {
    return Response.json({ ok: true, tokens: [] });
  }

  const tokenRows = rows<TokenRow>(
    await db.from<TokenRow>('cloud_sync_token')
      .select('id,label,scopes,project_scope,created_at,last_used_at,revoked_at')
      .eq('owner_id', viewer.ownerId)
      .order('created_at', { ascending: false })
      .limit(50),
    BackendError,
  );

  return Response.json({
    ok: true,
    generated_at: new Date().toISOString(),
    tokens: tokenRows.map((t) => ({
      id: t.id,
      label: t.label,
      scopes: t.scopes,
      project_scope: t.project_scope,
      created_at: t.created_at,
      last_used_at: t.last_used_at,
      revoked_at: t.revoked_at,
    })),
  });
}

/**
 * F16.1: 创建 sync token——返回明文 token 给界面显示一次，入库只存哈希（NFR-02）。
 */
export async function tokenCreate(
  db: Db,
  viewer: Viewer,
  label: string | null,
  scopes: string[],
  projectScope: string[],
  BackendError: BackendErrorLike,
): Promise<Response> {
  if (!viewer.ownerId) throw new BackendError('no_access', 403);

  // 生成明文 token（16 hex，与 local newId 形状一致）
  const plainToken = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // 哈希后入库
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plainToken));
  const tokenHash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const created = rows<{ id: string }>(
    await db.from<{ id: string }>('cloud_sync_token')
      .insert({
        owner_id: viewer.ownerId,
        token_hash: tokenHash,
        label,
        scopes,
        project_scope: projectScope,
        created_at: new Date().toISOString(),
        last_used_at: null,
        revoked_at: null,
      })
      .select('id'),
    BackendError,
  );
  if (!created[0]) throw new BackendError('write_failed', 500);

  // 明文只返回一次，界面显示后不再存储
  return Response.json({
    ok: true,
    token_id: created[0].id,
    plain_token: plainToken,
    message: '请妥善保存此 token，关闭页面后将无法再次查看',
  });
}

/**
 * F16.1: 吊销 sync token——设置 revoked_at，不删除行（审计需要）。
 */
export async function tokenRevoke(
  db: Db,
  viewer: Viewer,
  tokenId: string,
  BackendError: BackendErrorLike,
): Promise<Response> {
  if (!viewer.ownerId) throw new BackendError('no_access', 403);

  // 验证 token 属于 Owner
  const token = rows<{ id: string; revoked_at: string | null }>(
    await db.from<{ id: string; revoked_at: string | null }>('cloud_sync_token')
      .select('id,revoked_at')
      .eq('id', tokenId)
      .eq('owner_id', viewer.ownerId)
      .limit(1),
    BackendError,
  );
  if (!token[0]) throw new BackendError('not_found', 404);
  if (token[0].revoked_at) throw new BackendError('conflict', 409);

  rows(
    await db.from('cloud_sync_token')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', tokenId)
      .select('id'),
    BackendError,
  );

  return Response.json({ ok: true, token_id: tokenId, revoked_at: new Date().toISOString() });
}

interface BatchRow {
  external_batch_id: string;
  status: string;
  requested_at: string;
  rejected_reasons: string[] | null;
}

/**
 * F16.2: 同步健康自检——最近批次状态与拒绝原因分布。
 *
 * NFR-10: 自检结果必须能反映真实的同步状态，不安静地给出一条更短的时间线。
 */
export async function syncHealth(
  db: Db,
  viewer: Viewer,
  externalId: string,
  BackendError: BackendErrorLike,
): Promise<Response> {
  const project = await byExternalId(db, externalId, BackendError);
  if (!project) throw new BackendError('not_found', 404);
  if (!canRead(viewer, project)) {
    throw new BackendError(deniesAsAbsent(viewer) ? 'not_found' : 'no_access', deniesAsAbsent(viewer) ? 404 : 403);
  }
  const level = readLevel(viewer, project);
  if (level !== 'full') {
    return Response.json({ ok: true, projection_level: 'l2', health: null });
  }

  // 最近批次
  const latestBatch = rows<BatchRow>(
    await db.from<BatchRow>('cloud_sync_batch')
      .select('external_batch_id,status,requested_at,rejected_reasons')
      .eq('project_id', project.id)
      .order('requested_at', { ascending: false })
      .limit(1),
    BackendError,
  );

  // 待处理批次
  const pendingBatches = rows<{ id: string }>(
    await db.from<{ id: string }>('cloud_sync_batch')
      .select('id')
      .eq('project_id', project.id)
      .eq('status', 'accepted'),
    BackendError,
  );

  // 拒绝原因分布
  const allBatches = rows<BatchRow>(
    await db.from<BatchRow>('cloud_sync_batch')
      .select('external_batch_id,status,requested_at,rejected_reasons')
      .eq('project_id', project.id)
      .order('requested_at', { ascending: false })
      .limit(100),
    BackendError,
  );
  const reasonDist: Record<string, number> = {};
  for (const b of allBatches) {
    if (b.rejected_reasons) {
      for (const reason of b.rejected_reasons) {
        reasonDist[reason] = (reasonDist[reason] ?? 0) + 1;
      }
    }
  }

  return Response.json({
    ok: true,
    generated_at: new Date().toISOString(),
    projection_level: 'full',
    health: {
      latest_batch: latestBatch[0]
        ? {
            external_batch_id: latestBatch[0].external_batch_id,
            status: latestBatch[0].status,
            requested_at: latestBatch[0].requested_at,
            rejected_reasons: latestBatch[0].rejected_reasons,
          }
        : null,
      pending_batches: pendingBatches.length,
      rejected_reason_distribution: reasonDist,
    },
  });
}
