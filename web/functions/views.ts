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
  /** 来自 cloud_grant：被邀读者（Q8）。 */
  grantedProjectIds: string[];
  /** 来自未记名 share token（`?share=`）；只在 link/listed 项目上生效。 */
  shareProjectId: string | null;
}

export function isOwner(viewer: Viewer): boolean {
  return viewer.ownerId !== null;
}

interface ProjectRow {
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
  if (!user) {
    const share = new URL(request.url).searchParams.get('share');
    if (!share) return { ownerId: null, grantedProjectIds: [], shareProjectId: null };
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
    return { ownerId: null, grantedProjectIds: [], shareProjectId: active ? active.project_id : null };
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
  const grants = rows<{ project_id: string; revoked_at: string | null }>(
    await db.from<{ project_id: string; revoked_at: string | null }>('cloud_grant').select('project_id,revoked_at').eq('owner_id', ownerId),
    BackendError,
  );
  return { ownerId, grantedProjectIds: grants.filter((g) => !g.revoked_at).map((g) => g.project_id), shareProjectId: null };
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
  if (viewer.grantedProjectIds.includes(project.id)) return true;
  // `listed` 的项目必须能打开：F2.1 让匿名访客在列表里看到它，点了却 403/404
  // 是一次破闭环（UC-03、F7.3 演示项目就落在这条路径上）。
  if (project.visibility === 'listed') return true;
  if (viewer.shareProjectId === project.id && project.visibility !== 'private') return true;
  return false;
}

export function readLevel(viewer: Viewer, project: ProjectRow): ReadLevel {
  if (viewer.ownerId && viewer.ownerId === project.owner_id) return 'full';
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
  return viewer.ownerId === null && viewer.shareProjectId === null && viewer.grantedProjectIds.length === 0;
}

async function byExternalId(db: Db, externalId: string, BackendError: BackendErrorLike): Promise<ProjectRow | undefined> {
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
    // 列表页只列 Owner 自己的、被邀的，以及公开 listed 的。
    return viewer.ownerId === project.owner_id || viewer.grantedProjectIds.includes(project.id) || project.visibility === 'listed';
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
