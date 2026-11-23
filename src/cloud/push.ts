/**
 * 同步编排：把"读本地 → 投影 → 排队 → 投递 → 记游标"这条链固定成一个顺序。
 *
 * 顺序本身就是语义，几处不可交换：
 *
 * 1. `projectBatches` 在入队之前。脱敏闸门在这里，命中就抛 `SECRET_GATE_BLOCKED`，
 *    于是既没有队列文件也没有请求——不是"发出去再回撤"（F1.13 / WS-13）。
 * 2. **队列排空之后才投影下一段**。只要缓冲里还有没投出去的批次，游标就还没推进到
 *    那批事件之后；此时再投影会把**同样**的事件算成**另一个** `external_batch_id`，
 *    云端虽然靠 `(run_id, seq)` 不会落双份，本地队列却会无界增长，"按批次顺序投递"
 *    也变成一句空话。
 * 3. 游标只在 `accepted` / `replay` 之后推进（NFR-05）。`unavailable` 保持原地，
 *    同一批次以同一 `external_batch_id` 重放；`rejected` / `version-unsupported` /
 *    `collections-unsupported` 写进 `state.stop` 并停止发送，不再刷网络。
 * 4. 熔断累计 `STOP_DISCARD_AFTER` 次后丢弃缓冲、清空游标，把"一直在重试"变成一次
 *    明确的失败；下次 `push` 从 0 重读本地历史完整重放。
 *
 * `dryRun` 只做第 1 步的一半：投影、算体积、取样字段，然后停手，什么都不写也不发。
 */
import { readdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import type { ProjectRuntime } from '../workflow/runtime.js';
import { projectPaths } from '../config/paths.js';
import { sha256Of } from '../core/hash.js';
import { IdeaseekError, isIdeaseekError } from '../core/errors.js';
import {
  BATCH_LIMITS,
  collectRuns,
  projectBatches,
  type ProjectedBatch,
  type ProjectionRequest,
} from './projector.js';
import { sendBatch, type FetchLike, type SendOutcome } from './client.js';
import {
  BACKOFF,
  RETENTION_MS,
  STOP_DISCARD_AFTER,
  bumpStop,
  cloudDirs,
  complete,
  discardQueue,
  enqueue,
  expireOldest,
  listQueued,
  loadState,
  markAttempt,
  retryDelayMs,
  saveState,
  type CloudDirs,
  type QueuedBatch,
  type StopInfo,
} from './buffer.js';

/** 项目里云端目标，来自 `research.yaml` 的 `cloud:` 段。 */
export interface CloudTarget {
  site: string;
  /** user config 里的凭据引用，形如 `env:IDEASEEK_CLOUD_SYNC_TOKEN`。 */
  tokenRef: string;
}

export interface PushReport {
  projected: number;
  enqueued: number;
  sent: number;
  accepted: number;
  replayed: number;
  queuedRemaining: number;
  bytesSent: number;
  eventsSent: number;
  cursors: Record<string, number>;
  dryRun: boolean;
  /** 停在队列头部没发出去的原因；`null` 表示这一轮跑到干净。 */
  stopped: StopInfo | null;
  skipped: { waiting: number; tooLarge: number };
  expired: number;
}

/** 熔断类结局：重试同一段字节不会得到不同结果。 */
const TERMINAL_KINDS = new Set(['version-unsupported', 'collections-unsupported', 'rejected']);

/**
 * F1.4：出网的机器标识只能是主机名的稳定哈希，不能是主机名本身——机器名连上目录名
 * 足以定位到人。同一台机器每次给出同一个 `host-<12 hex>`。
 */
export function hostTag(): string {
  return `host-${sha256Of(hostname()).slice('sha256:'.length, 'sha256:'.length + 12)}`;
}

function summarize(outcome: SendOutcome): string {
  switch (outcome.kind) {
    case 'unauthorized':
      return `unauthorized(${outcome.code ?? outcome.status})`;
    case 'version-unsupported':
      return `version-unsupported(${outcome.message})`;
    case 'collections-unsupported':
      return `collections-unsupported(${outcome.collections.join(',')})`;
    case 'rejected':
      return `rejected(${outcome.status} ${outcome.code ?? ''} ${outcome.message})`;
    case 'unavailable':
      return `unavailable(${outcome.reason} ${outcome.status ?? '-'})`;
    default:
      return outcome.kind;
  }
}

function eventsOf(queued: QueuedBatch): number {
  const entities = (queued.batch as { entities?: { events?: unknown[] } }).entities;
  return Array.isArray(entities?.events) ? entities.events.length : 0;
}

function mergeCursors(
  current: Record<string, number>,
  added: Record<string, number>,
): Record<string, number> {
  const next = { ...current };
  for (const [runId, seq] of Object.entries(added)) {
    if (!Number.isInteger(seq))
      throw new IdeaseekError('INTERNAL', `队列批次里的游标不是整数：${runId}`);
    next[runId] = Math.max(next[runId] ?? 0, seq);
  }
  return next;
}

export interface PushOptions {
  site: string;
  token: string;
  fetch?: FetchLike;
  /** 注入时钟：退避与滞留判定都要能被测试固定住。 */
  now?: () => number;
  dryRun?: boolean;
  /** 单次调用最多投几批，避免一条命令挂住终端。 */
  maxSends?: number;
  maxRuns?: number;
  title?: string;
  question?: string | null;
  strategy?: string | null;
  autonomy?: string | null;
  sourceHost?: string;
}

export async function pushProject(
  runtime: ProjectRuntime,
  target: CloudTarget,
  opts: PushOptions,
): Promise<PushReport> {
  const dirs = cloudDirs(projectPaths(runtime.project.root).researchDir);
  const now = opts.now ?? (() => Date.now());
  let state = await loadState(dirs);
  const dryRun = opts.dryRun === true;
  const report: PushReport = {
    projected: 0,
    enqueued: 0,
    sent: 0,
    accepted: 0,
    replayed: 0,
    queuedRemaining: 0,
    bytesSent: 0,
    eventsSent: 0,
    cursors: state.cursors,
    dryRun,
    stopped: state.stop,
    skipped: { waiting: 0, tooLarge: 0 },
    expired: 0,
  };

  const sizeOf = (batch: Record<string, unknown>): number =>
    Buffer.byteLength(JSON.stringify(batch), 'utf8');

  /**
   * 队首之后还要发几批。只数读得出来的批次：坏文件没有游标增量，既推进不了队列，
   * 也不该把后面的投影堵死——它由 `cloud status` 单独报告。
   */
  const pendingCount = async (): Promise<number> => (await listQueued(dirs)).items.length;

  /** 投一批，返回 false 表示链条在这里停了（熔断或退避未到）。 */
  const sendOne = async (next: QueuedBatch): Promise<boolean> => {
    const size = sizeOf(next.batch);
    if (size > BATCH_LIMITS.maxBytes) {
      // 投影器本来就拦在预算内；出现在队列里说明文件被改过，绝不出网。
      report.skipped.tooLarge += 1;
      state = bumpStop(state, 'rejected', `本地批次文件 ${size} 字节超过上限，未发送`, now());
      report.stopped = state.stop;
      await saveState(dirs, state);
      return false;
    }
    const outcome = await sendBatch(next.batch, {
      site: opts.site,
      token: opts.token,
      fetch: opts.fetch,
    });
    report.sent += 1;

    if (outcome.kind === 'accepted' || outcome.kind === 'replay') {
      report.accepted += outcome.kind === 'accepted' ? 1 : 0;
      report.replayed += outcome.kind === 'replay' ? 1 : 0;
      report.bytesSent += size;
      report.eventsSent += eventsOf(next);
      state.cursors = mergeCursors(state.cursors, next.cursorByRun);
      state.lastOkAt = now();
      state.stop = null;
      report.cursors = state.cursors;
      report.stopped = null;
      await saveState(dirs, state);
      await complete(next);
      return true;
    }

    await markAttempt(next, summarize(outcome), now());
    if (outcome.kind === 'unavailable') {
      // 结果未知：批次留在队首，退避到点后按同一 `external_batch_id` 重放。
      return false;
    }

    state = bumpStop(state, outcome.kind, summarize(outcome), now());
    const attempts = state.stop!.attempts;
    if (attempts >= STOP_DISCARD_AFTER) {
      const cleared = await discardQueue(dirs);
      state.cursors = {};
      report.cursors = {};
      state.stop = {
        kind: 'discarded',
        detail: `${outcome.kind} 连续 ${attempts} 次：缓冲丢弃 ${cleared.discarded} 批，下次从 0 重放`,
        at: now(),
        attempts,
      };
    }
    report.stopped = state.stop;
    await saveState(dirs, state);
    return false;
  };

  /** 把队列从头部排空，直到空、退避未到、或熔断。 */
  const drain = async (): Promise<void> => {
    let sends = 0;
    for (;;) {
      if (sends >= (opts.maxSends ?? 12)) return;
      const { items } = await listQueued(dirs);
      if (items.length === 0) return;
      const next = items[0]!;
      if (retryDelayMs(next, now()) !== null) return;
      if (!(await sendOne(next))) return;
      sends += 1;
    }
  };

  /** 投影当前游标之后的新事件；`queue` 为假时只算不写（F1.3 的 dry-run）。 */
  const projectNew = async (queue: boolean): Promise<ProjectedBatch[]> => {
    const collected = await collectRuns(runtime.db, {
      projectId: runtime.project.id,
      sinceSeqByRun: state.cursors,
      maxRuns: opts.maxRuns,
    });
    // 只带 run 外壳、一条新事件都没有的批次不发（F1.9）。引擎里状态与阶段的变化总是
    // 伴随一条事件（`INIT`→…→`COMPLETED` 每一步都落事件），所以"没新事件"就等于
    // "没有新信息"；发出去只会让云端反复 upsert 同一行，并把排空循环变成死循环。
    const moved = collected.runs.filter((pair) => pair.events.length > 0);
    if (moved.length === 0) return [];
    const request: ProjectionRequest = {
      project: {
        externalId: runtime.project.id,
        title: opts.title ?? runtime.project.name,
        question: opts.question ?? moved[0]!.run.question ?? null,
        sourceHost: opts.sourceHost ?? hostTag(),
        ...(opts.strategy ? { strategy: opts.strategy } : {}),
        ...(opts.autonomy ? { autonomy: opts.autonomy } : {}),
      },
      runs: moved,
      generatedAt: now(),
      localSchemaVersion: collected.localSchemaVersion,
    };
    const batches = await projectBatches(request);
    report.projected += batches.length;
    if (queue) {
      for (const batch of batches) {
        await enqueue(dirs, batch.batch, batch.cursorByRun);
        report.enqueued += 1;
      }
    }
    return batches;
  };

  if (dryRun) {
    const queued = await pendingCount();
    const batches = await projectNew(false);
    report.bytesSent = batches.reduce((sum, b) => sum + b.bytes, 0);
    report.eventsSent = batches.reduce((sum, b) => sum + b.counts.events, 0);
    report.queuedRemaining = queued;
    // 投影出来的批次只在这段代码的内存里存在过：没写队列文件，也没碰网络。
    return report;
  }

  if (state.stop && TERMINAL_KINDS.has(state.stop.kind)) {
    if (now() - state.stop.at < BACKOFF.capMs) {
      // 刚刚熔断：一条都不发，先把原因交回给人。恢复要么等满一个退避上限，要么显式 `cloud reset`。
      report.queuedRemaining = await pendingCount();
      return report;
    }
    // 熔断之后每满一个退避上限只放队首那一批过去试探：还是同样的拒绝就累计次数，
    // 累计到 STOP_DISCARD_AFTER 丢弃缓冲；试探成功则说明云端已经能收，接着排空剩下的。
    const head = (await listQueued(dirs)).items[0];
    if (head && !(await sendOne(head))) {
      report.queuedRemaining = await pendingCount();
      return report;
    }
  }

  report.expired = await expireOldest(dirs, now(), RETENTION_MS);

  for (let round = 0; round < 8; round += 1) {
    await drain();
    if (report.stopped) break;
    if ((await pendingCount()) > 0) break; // 退避未到，剩下的留到下次
    if ((await projectNew(true)).length === 0) break;
  }

  report.queuedRemaining = await pendingCount();
  const { items } = await listQueued(dirs);
  report.skipped.waiting = items.filter((q) => retryDelayMs(q, now()) !== null).length;
  return report;
}

/** `cloud status` 的读数：本地游标、队列、退避与熔断状态，一个字节都不出网。 */
export interface StatusReport {
  linked: boolean;
  site: string | null;
  tokenRef: string | null;
  tokenPresent: boolean;
  cursors: Record<string, number>;
  queued: number;
  unreadable: number;
  oldestKinds: {
    batchId: string;
    attempts: number;
    waitingMs: number | null;
    lastError: string | null;
  }[];
  lastOkAt: number | null;
  stop: StopInfo | null;
  dropped: number;
  backoff: { baseMs: number; capMs: number; maxAttempts: number };
  retentionMs: number;
}

export async function readStatus(
  researchDir: string,
  linked: { site: string | null; tokenRef: string | null },
  tokenPresent: boolean,
  opts: { now?: () => number } = {},
): Promise<StatusReport> {
  const dirs: CloudDirs = cloudDirs(researchDir);
  const now = opts.now ?? (() => Date.now());
  const state = await loadState(dirs);
  const { items, unreadable } = await listQueued(dirs);
  // 丢弃档只做计数：里面是曾经入队、后来超期的批次，本地留着，永不出网。
  let dropped = 0;
  try {
    dropped = (await readdir(dirs.dropped)).length;
  } catch {
    dropped = 0;
  }
  return {
    linked: Boolean(linked.site && linked.tokenRef),
    site: linked.site,
    tokenRef: linked.tokenRef,
    tokenPresent,
    cursors: state.cursors,
    queued: items.length,
    unreadable: unreadable.length,
    oldestKinds: items.slice(0, 5).map((q) => ({
      batchId: q.batchId,
      attempts: q.attempts,
      waitingMs: retryDelayMs(q, now()),
      lastError: q.lastError,
    })),
    lastOkAt: state.lastOkAt,
    stop: state.stop,
    dropped,
    backoff: BACKOFF,
    retentionMs: RETENTION_MS,
  };
}

export function unwrapGateError(error: unknown): { code: string; message: string } {
  if (isIdeaseekError(error)) return { code: error.code, message: error.message };
  return { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) };
}
