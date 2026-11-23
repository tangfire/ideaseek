/**
 * 本地投影器（F1.2 / F1.4 / F1.9 / F1.14 / F1.15）。
 *
 * 唯一数据源是 WorkflowDb 的 run 与 run_event（NFR-14：不遍历目录，文件类信息
 * 只走已入库的记录）。M1 的 Function 只实装 `runs|stages|events`，其余集合
 * 非空即 501（`web/functions/ingest.ts:20`），所以这一层现在连 artifact 表都不读。
 *
 * 三步的顺序是刻意的：
 *
 * 1. **挑字段**——白名单式，本地多出来的东西（config 全文、payload、temp 路径）
 *    一个都不带；契约里没有的键写不出去，因为 `additionalProperties:false`。
 * 2. **闸门**（`assertProjectionSafe`）——放在 schema 校验**之前**：ajv 的报错会带
 *    instancePath 与上下文，谁也不想让一份含密钥的正文因为另一个字段不合格而被
 *    回显出来。闸门看的就是即将出网的那份字节。
 * 3. **契约校验**（`cloud-projection-v1`）——本地先按同一份 schema 判一次，
 *    不把"云端会不会收"留给运气。
 *
 * 这里**不用** `core/redact.ts` 洗凭据：那是展示层的兜底，而投影层的契约是
 * "命中即整批拒绝"（NFR-15 / WS-13）。把 `sk-...` 悄悄改成 `sk-***` 再上传，
 * 等于用一次改写换掉一次拒绝——事件内容被损坏，用户还以为同步成功了。
 *
 * 这里不扫目录、不读 `.env`、不碰 `papers/`：新增数据源时守住这一点，
 * 投影过程一旦产生目录枚举就是 NFR-14 / R9 的回归。
 */
import { IdeaseekError } from '../core/errors.js';
import { sha256OfJson } from '../core/hash.js';
import { newId } from '../core/ids.js';
import { assertAgainstSchema } from '../core/schema/index.js';
import type { WorkflowDb } from '../workflow/db.js';
import { BLOCKED_RUN_STATUSES } from '../workflow/types.js';
import type { RunEvent, RunRecord } from '../workflow/types.js';
import { assertProjectionSafe } from './secret-gate.js';

type Rec = Record<string, unknown>;

/** Function 侧真正落库的集合；空数组不算携带（`ingest.ts` 的 `present()` 只看非空）。 */
export const CLOUD_IMPLEMENTED_COLLECTIONS = ['runs', 'stages', 'events'] as const;
export type CloudCollection = (typeof CLOUD_IMPLEMENTED_COLLECTIONS)[number];

/**
 * 与 `web/functions/views.ts:233` 同源的阶段表（DIAGRAMS.md §2.5）。
 * 不在表里的 phase 不丢掉，而是 `stage_known:false` 照样上报——控制台要显示
 * "未识别的步骤"，而不是让投影层替引擎圆场。
 */
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

/** 契约上限（`cloud-projection-v1.json`），不是这里随手定的数。 */
const CAP = {
  summary: 400,
  question: 2000,
  reason: 400,
  title: 200,
  tag: 64,
  role: 64,
  objectId: 128,
} as const;

const LOCAL_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const STRATEGIES = new Set(['starter', 'standard', 'research']);
const AUTONOMIES = new Set(['guided', 'autonomous', 'review-only']);

/** 一次批次的硬上限：事件数取契约 maxItems，字节数取实测安全上限的 3/4（PLAN.md §3 S4）。 */
export const BATCH_LIMITS = {
  maxEvents: 5000,
  maxRuns: 2000,
  maxStages: 2000,
  maxBytes: 6 * 1024 * 1024,
} as const;

function fits(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/** 摘要是一行话：换行折成空格、再按上限截断，并把截断这件事标出来。 */
function summarize(raw: string, max: number): { value: string; truncated: boolean } {
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return { value: fits(oneLine, max), truncated: oneLine.length > max };
}

/**
 * `object_id` 只保留本地 id 形状或项目内相对引用；绝对路径、盘符、`..` 段
 * 一律置空——泄漏本地路径本身就是一种披露（用户名、挂载布局）。
 */
function safeObjectId(value: string | null): string | null {
  if (!value) return null;
  if (value.length > CAP.objectId) return null;
  if (value.startsWith('/') || value.startsWith('\\')) return null;
  if (/^[a-zA-Z]:[\\/]/.test(value)) return null;
  if (value.split(/[\\/]/).includes('..')) return null;
  return value;
}

function projectRun(run: RunRecord): Promise<Rec> {
  const row: Rec = {
    external_run_id: run.runId,
    status: run.status,
    phase_tag: run.phase,
    started_at: run.createdAt,
    config_hash: null,
  };
  const question = summarize(run.question, CAP.question);
  if (question.value !== '') row.question = question.value;
  if (run.blockReason) row.block_reason = summarize(run.blockReason, CAP.reason).value;
  if (run.finishedAt !== null) row.finished_at = run.finishedAt;
  // 只有还在跑的 run 才有"心跳"这一说；终态 run 的 updated_at 是最后修改时间，
  // 报成 heartbeat 会让控制台把一个早已结束的运行渲染成活着。
  if (run.status === 'RUNNING') row.heartbeat_at = run.updatedAt;
  return sha256OfJson(run.config).then((hash) => {
    row.config_hash = hash;
    return row;
  });
}

function stageState(run: RunRecord, isCurrent: boolean): string {
  if (!isCurrent) return 'passed';
  if (run.status === 'RUNNING') return 'active';
  if (run.status === 'PAUSED' || BLOCKED_RUN_STATUSES.includes(run.status)) return 'blocked';
  if (run.status === 'FAILED' || run.status === 'CANCELED') return 'failed';
  return 'passed';
}

/**
 * 阶段历史来自事件里出现过的 `phase`，再加上 run 的当前 phase。引擎没有独立的
 * 阶段表，这是唯一不编造数据的推法：没跑到的阶段不上报，当前阶段在事件里没出现过
 * 就**不给进入时间**（`entered_at` 省略），而不是拿 run 的创建时间冒充。
 * 控制台按缺位显示"未上报"（DIAGRAMS.md §2.5），也不是投影层替它补一排 pending。
 */
function projectStages(run: RunRecord, events: RunEvent[]): Rec[] {
  const firstSeen = new Map<string, number>();
  for (const event of events) {
    if (!event.phase) continue;
    const seen = firstSeen.get(event.phase);
    if (seen === undefined || event.ts < seen) firstSeen.set(event.phase, event.ts);
  }
  const ordered: [string, number][] = [...firstSeen.entries()];
  if (!firstSeen.has(run.phase)) ordered.push([run.phase, Number.POSITIVE_INFINITY]);
  ordered.sort((a, b) => a[1] - b[1]);

  return ordered.map(([stage, enteredAt], index) => {
    const isCurrent = stage === run.phase;
    const state = stageState(run, isCurrent);
    const row: Rec = {
      run_external_id: run.runId,
      stage: fits(stage, CAP.tag),
      state,
      stage_known: STAGE_KNOWN.has(stage),
    };
    if (Number.isFinite(enteredAt)) row.entered_at = enteredAt;
    const next = ordered[index + 1];
    if (!isCurrent && next && Number.isFinite(next[1])) row.exited_at = next[1];
    if (isCurrent && state === 'blocked') {
      if (run.blockReason) row.gate_note = summarize(run.blockReason, CAP.reason).value;
      row.blocker_code = fits(run.status, CAP.tag);
    }
    return row;
  });
}

function projectEvent(run: RunRecord, event: RunEvent): Rec {
  if (event.eventType.length > CAP.tag) {
    // 截断枚举名等于伪造一个引擎不会发的状态（NFR-12），所以宁可停下报错。
    throw new IdeaseekError('INTERNAL', `事件类型超过契约上限 ${CAP.tag}：${run.runId}`);
  }
  const summary = summarize(event.summary, CAP.summary);
  const row: Rec = {
    run_external_id: run.runId,
    seq: event.seq,
    ts: event.ts,
    event_type: event.eventType,
    summary: summary.value === '' ? '(无摘要)' : summary.value,
    truncated: summary.truncated,
  };
  if (event.phase) row.phase_tag = fits(event.phase, CAP.tag);
  const object = safeObjectId(event.objectId);
  if (object) row.object_id = object;
  if (event.role) row.actor_role = fits(event.role, CAP.role);
  if (event.status) row.status = fits(event.status, CAP.tag);
  const refs = event.artifactRefs.filter((ref) => LOCAL_ID.test(ref));
  if (refs.length > 0) row.artifact_refs = refs;
  return row;
}

export interface ProjectIdentity {
  /** 本地项目 id（`proj-<16 hex>`），云端按它 upsert，可回溯。 */
  externalId: string;
  title: string;
  question?: string | null;
  strategy?: string | null;
  autonomy?: string | null;
  /** 已脱敏的主机标签：调用方负责先哈希，这里只做长度保护。 */
  sourceHost: string;
  /** 默认私有：推送永远不提升可见性（F5.1）。 */
  visibility?: 'private' | 'link' | 'listed';
}

export interface RunProjection {
  run: RunRecord;
  /** 该 run 已选出的事件（已按 seq 升序、已按游标过滤）。 */
  events: RunEvent[];
}

export interface ProjectionRequest {
  project: ProjectIdentity;
  runs: RunProjection[];
  /** 批次生成时刻（传输时钟，不是科研时间戳）。 */
  generatedAt: number;
  /** 本地 workflow 库的迁移版本，让控制台能说是哪个引擎构建产出的视图。 */
  localSchemaVersion: number;
  /** 测试注入用；默认每个批次 `newId('bat')`。 */
  batchIds?: string[];
}

export interface ProjectedBatch {
  external_batch_id: string;
  batch: Rec;
  counts: { runs: number; stages: number; events: number };
  /**
   * 每个 run 实际进入批次的最大 seq。回执 accepted 后才推进本地游标（F1.9），
   * 分片时被切掉的尾部保持未确认，下一次 push 再补。
   */
  cursorByRun: Record<string, number>;
  bytes: number;
}

function byteLen(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function envelope(
  req: ProjectionRequest,
  batchId: string,
  entities: { runs: Rec[]; stages: Rec[]; events: Rec[] },
): Rec {
  const project: Rec = {
    external_id: req.project.externalId,
    title: fits(req.project.title, CAP.title),
    visibility: req.project.visibility ?? 'private',
    source_host: fits(req.project.sourceHost, 64),
  };
  const question = req.project.question ? summarize(req.project.question, CAP.question).value : '';
  if (question !== '') project.question = question;
  // 契约是闭集枚举，本地是自由字符串：不在表里就不带这个键，而不是硬塞一个值。
  if (req.project.strategy && STRATEGIES.has(req.project.strategy)) {
    project.strategy = req.project.strategy;
  }
  if (req.project.autonomy && AUTONOMIES.has(req.project.autonomy)) {
    project.autonomy = req.project.autonomy;
  }
  return {
    schema_version: 1,
    external_batch_id: batchId,
    generated_at: req.generatedAt,
    local_schema_version: req.localSchemaVersion,
    project,
    entities,
  };
}

function finalize(
  req: ProjectionRequest,
  batchId: string,
  entities: { runs: Rec[]; stages: Rec[]; events: Rec[] },
  cursorByRun: Record<string, number>,
): ProjectedBatch {
  const batch = envelope(req, batchId, entities);
  // 闸门先于 schema 校验，理由见文件头。
  assertProjectionSafe(batch);
  assertAgainstSchema('cloud-projection-v1', batch);
  return {
    external_batch_id: batchId,
    batch,
    counts: {
      runs: entities.runs.length,
      stages: entities.stages.length,
      events: entities.events.length,
    },
    cursorByRun,
    bytes: byteLen(batch),
  };
}

/**
 * 组装批次并按契约上限分片。一个 run 的行（run + stages）跟着它的事件一起
 * 出现在每个分片里——Function 要求阶段/事件引用的 run 必须在同批内存在
 * （`ingest.ts:173`），否则整批被拒。
 *
 * 字节账是累加的：信封骨架量一次，之后每加一行加该行自己的长度。分片判断
 * 只需要单调性，不需要每行重算整批。
 */
export async function projectBatches(req: ProjectionRequest): Promise<ProjectedBatch[]> {
  interface Sink {
    runs: Rec[];
    stages: Rec[];
    events: Rec[];
    runIds: Set<string>;
    cursorByRun: Record<string, number>;
    bytes: number;
  }
  const batches: ProjectedBatch[] = [];
  let sequence = 0;
  const emptySink = (): Sink => ({
    runs: [],
    stages: [],
    events: [],
    runIds: new Set(),
    cursorByRun: {},
    bytes: skeletonBytes(req),
  });
  let sink: Sink = emptySink();

  const flush = (): void => {
    if (sink.runs.length === 0 && sink.events.length === 0) return;
    const batchId = req.batchIds?.[sequence] ?? newId('bat');
    sequence += 1;
    batches.push(
      finalize(
        req,
        batchId,
        { runs: sink.runs, stages: sink.stages, events: sink.events },
        sink.cursorByRun,
      ),
    );
    sink = emptySink();
  };

  const rowBytes = (rows: Rec[]): number => rows.reduce((sum, row) => sum + byteLen(row), 0);

  for (const projection of req.runs) {
    const runRow = await projectRun(projection.run);
    const stageRows = projectStages(projection.run, projection.events);
    const eventRows = projection.events.map((event) => projectEvent(projection.run, event));
    const shellBytes = rowBytes([runRow, ...stageRows]);

    /** run 行 + 阶段行放进当前批（已放过就不重复；换批后自动补回）。 */
    const addShell = (): void => {
      if (sink.runIds.has(projection.run.runId)) return;
      if (
        sink.runs.length + 1 > BATCH_LIMITS.maxRuns ||
        sink.stages.length + stageRows.length > BATCH_LIMITS.maxStages
      ) {
        flush();
      }
      sink.runs.push(runRow);
      sink.stages.push(...stageRows);
      sink.runIds.add(projection.run.runId);
      sink.bytes += shellBytes;
    };

    if (eventRows.length === 0) {
      // 没有事件的 run 也要能上报：状态、阶段与阻塞原因是控制台的主体内容。
      addShell();
      sink.cursorByRun[projection.run.runId] ??= 0;
      continue;
    }

    let offset = 0;
    while (offset < eventRows.length) {
      addShell();
      let added = 0;
      let addedBytes = 0;
      while (offset + added < eventRows.length) {
        const candidate = addedBytes + byteLen(eventRows[offset + added]!);
        if (sink.events.length + added + 1 > BATCH_LIMITS.maxEvents) break;
        if (sink.bytes + candidate > BATCH_LIMITS.maxBytes && added > 0) break;
        addedBytes = candidate;
        added += 1;
      }
      if (added === 0) {
        if (sink.runs.length > 1 || sink.events.length > 0) {
          flush();
          continue;
        }
        throw new IdeaseekError('INTERNAL', `单条事件超过批次字节上限：${projection.run.runId}`);
      }
      sink.events.push(...eventRows.slice(offset, offset + added));
      sink.bytes += addedBytes;
      sink.cursorByRun[projection.run.runId] = Number(eventRows[offset + added - 1]!.seq);
      offset += added;
      if (sink.events.length >= BATCH_LIMITS.maxEvents || sink.bytes >= BATCH_LIMITS.maxBytes)
        flush();
    }
  }
  flush();
  return batches;
}

function skeletonBytes(req: ProjectionRequest): number {
  return byteLen(envelope(req, 'bat-0000000000000000', { runs: [], stages: [], events: [] }));
}

export interface CollectOptions {
  projectId: string;
  /** 每个 run 的已确认事件游标（F1.9）；缺省从头取。 */
  sinceSeqByRun?: Record<string, number>;
  maxRuns?: number;
  /** 单 run 单次最多取多少事件，超出的尾部留给下一次 push。 */
  maxEventsPerRun?: number;
}

export interface CollectedRuns {
  runs: RunProjection[];
  localSchemaVersion: number;
}

/**
 * 读取投影输入。整个读取走单个只读事务（F1.15）：WAL 下这一次拿到的是一致性
 * 快照，不会出现"取到 seq=100 的事件、取到更晚的阶段状态"这种撕裂视图。
 * 回调里任何写操作都会被 `PRAGMA query_only` 挡下来。
 */
export async function collectRuns(db: WorkflowDb, opts: CollectOptions): Promise<CollectedRuns> {
  const maxRuns = opts.maxRuns ?? BATCH_LIMITS.maxRuns;
  const maxEventsPerRun = opts.maxEventsPerRun ?? BATCH_LIMITS.maxEvents;
  return db.readSnapshot(async () => {
    const runs = await db.listRuns(opts.projectId, maxRuns);
    const projections: RunProjection[] = [];
    for (const run of runs) {
      const events = await db.listEvents(run.runId, {
        since: opts.sinceSeqByRun?.[run.runId] ?? 0,
        limit: maxEventsPerRun,
      });
      projections.push({ run, events });
    }
    return { runs: projections, localSchemaVersion: db.schemaVersion() };
  });
}
