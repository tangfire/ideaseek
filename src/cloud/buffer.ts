/**
 * 离线缓冲：投影批次在本地排队、按退避重放（F1.12 / F1.13 / NFR-05 / NFR-06）。
 *
 * 存的是**整个批次**（含 `external_batch_id` 和该批的游标增量），不是事件原文。
 * 理由有二：批次一旦成形，重放出去的字节与当初算出的哈希同源，云端 `(run_id, seq)`
 * 唯一键保证重复投递不落双份；而若只存游标、下次重新投影，脱敏闸门可能因为本地
 * 状态变化给出**不同**的批次，那时"补发"就变成"改写历史"。
 *
 * 三条纪律：
 * 1. **闸门命中即不入队**（F1.13）：调用方在 `projectBatches` 抛 `SECRET_GATE_BLOCKED`
 *    时根本走不到这里，所以这里收到的批次必然是过了 L0 的。
 * 2. **游标只在 accepted / replay 之后推进**（NFR-05）：队列里的批次自带它落地后
 *    应该到的游标，`push` 成功后才写进 `state.json`。
 * 3. **滞留超期只丢缓冲，不动游标**（F1.12）：游标停在最后确认处，下次投影从那里
 *    重读——补发的是同一批事件，不是凭空造的新数据。
 *
 * 目录结构（`.research/cloud/`）：
 *   state.json            游标、停止原因、上次成功时间
 *   pending/<seq>-<id>.json  待投批次，文件名即顺序
 *   dropped/<seq>-<id>.json  超期丢弃的批次留档，只保留本地（永不出网）
 */
import { readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../core/atomic.js';
import { newId } from '../core/ids.js';

/** 一条排队中的批次。 */
export interface QueuedBatch {
  seq: number;
  batchId: string;
  file: string;
  batch: Record<string, unknown>;
  /** 这批全部落库后各 run 应推进到的事件序号。 */
  cursorByRun: Record<string, number>;
  queuedAt: number;
  attempts: number;
  /** 最近一次真实尝试的时刻；退避从这里数，而不是从入队时刻数。 */
  lastAttemptAt: number | null;
  lastError: string | null;
}

export interface StopInfo {
  kind: string;
  detail: string;
  at: number;
  /** 同类熔断累计次数；换成另一种原因就从 1 重新数。 */
  attempts: number;
}

export interface CloudState {
  /** run id → 已确认的事件序号。 */
  cursors: Record<string, number>;
  lastOkAt: number | null;
  stop: StopInfo | null;
}

export interface CloudDirs {
  root: string;
  pending: string;
  dropped: string;
}

/** 排队重试退避：1 分钟起翻倍，封顶 1 小时。单客户端不需要抖动。 */
export const BACKOFF = { baseMs: 60_000, capMs: 3_600_000, maxAttempts: 12 } as const;
/** 同类熔断（版本/集合不支持）累计到这次数就丢弃缓冲，给人一个明确的失败。 */
export const STOP_DISCARD_AFTER = 5;
/** 批次在本地最多滞留 14 天，超期进 `dropped/`；游标不动。 */
export const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

export const EMPTY_STATE: CloudState = { cursors: {}, lastOkAt: null, stop: null };

export function cloudDirs(researchDir: string): CloudDirs {
  return {
    root: join(researchDir, 'cloud'),
    pending: join(researchDir, 'cloud', 'pending'),
    dropped: join(researchDir, 'cloud', 'dropped'),
  };
}

const STATE_FILE = 'state.json';

export async function loadState(dirs: CloudDirs): Promise<CloudState> {
  let raw: string;
  try {
    raw = await readFile(join(dirs.root, STATE_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY_STATE, cursors: {} };
    throw error;
  }
  // 坏的状态文件不静默当空状态：那等于把已确认游标清零、整段历史重推一遍。
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as CloudState).cursors !== 'object') {
    throw new Error(`cloud 状态文件形状不合法：${join(dirs.root, STATE_FILE)}`);
  }
  const state = parsed as CloudState;
  return { cursors: state.cursors, lastOkAt: state.lastOkAt ?? null, stop: state.stop ?? null };
}

export async function saveState(dirs: CloudDirs, state: CloudState): Promise<void> {
  await writeFileAtomic(join(dirs.root, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * 入队。文件名里的序号取自现有文件的最大值 +1——顺序是目录本身的事实，
 * 不需要再维护一个会与实际文件漂移的计数器。
 */
export async function enqueue(
  dirs: CloudDirs,
  batch: Record<string, unknown>,
  cursorByRun: Record<string, number>,
  queuedAt = Date.now(),
): Promise<QueuedBatch> {
  const { items } = await listQueued(dirs);
  const nextSeq = items.reduce((max, item) => Math.max(max, item.seq), 0) + 1;
  const batchId = newId('bat');
  const file = join(dirs.pending, `${String(nextSeq).padStart(6, '0')}-${batchId}.json`);
  const record: Omit<QueuedBatch, 'file'> = {
    seq: nextSeq,
    batchId,
    batch,
    cursorByRun,
    queuedAt,
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
  };
  await writeFileAtomic(file, `${JSON.stringify(record)}\n`);
  return { ...record, file };
}

const QUEUE_FILE = /^(\d+)-([a-z0-9-]+)\.json$/;

export interface UnreadableQueueFile {
  file: string;
  error: string;
}

/**
 * 读出全部排队批次（按顺序）。读不懂的文件不静默跳过，而是原样报告：
 * 缓冲里有一条坏文件，就意味着时间线上有一段永远不会出网的事件，必须让人看见。
 */
export async function listQueued(
  dirs: CloudDirs,
): Promise<{ items: QueuedBatch[]; unreadable: UnreadableQueueFile[] }> {
  let names: string[];
  try {
    names = await readdir(dirs.pending);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { items: [], unreadable: [] };
    throw error;
  }
  const items: QueuedBatch[] = [];
  const unreadable: UnreadableQueueFile[] = [];
  for (const name of names.filter((n) => QUEUE_FILE.test(n)).sort()) {
    const file = join(dirs.pending, name);
    let record: QueuedBatch;
    try {
      record = JSON.parse(await readFile(file, 'utf8')) as QueuedBatch;
      if (
        !record ||
        typeof record !== 'object' ||
        !record.batch ||
        typeof record.batch !== 'object'
      )
        throw new Error('缺少 batch');
    } catch (error) {
      unreadable.push({ file: name, error: (error as Error).message.slice(0, 200) });
      continue;
    }
    items.push({
      ...record,
      seq: Number(QUEUE_FILE.exec(name)![1]),
      batchId: QUEUE_FILE.exec(name)![2]!,
      file,
    });
  }
  return { items, unreadable };
}

/** 记一次真实失败的尝试：次数与时刻一起写回批次文件。 */
export async function markAttempt(
  queued: QueuedBatch,
  errorKind: string,
  at = Date.now(),
): Promise<void> {
  const updated: QueuedBatch = {
    ...queued,
    attempts: queued.attempts + 1,
    lastAttemptAt: at,
    lastError: errorKind.slice(0, 200),
  };
  await writeFileAtomic(queued.file, `${JSON.stringify(withoutFile(updated))}\n`);
}

function withoutFile(queued: QueuedBatch): Omit<QueuedBatch, 'file'> {
  const { file: _file, ...rest } = queued;
  return rest;
}

/** 投递成功：删掉批次文件（回执已经由云端给出，本地不再留副本）。 */
export async function complete(queued: QueuedBatch): Promise<void> {
  await rm(queued.file, { force: true });
}

/**
 * 退避到点没有？返回 `null` 表示现在可投，返回毫秒数表示还要等多久。
 * 计时起点是最近一次尝试：一条在缓冲里躺了三天的批次，若从入队时刻数，
 * 每次 `push` 都会立刻再试一次，等于把退避变成轮询。
 *
 * 超过 `maxAttempts` 仍留在队列里的是可用性失败——那正是缓冲存在的意义，
 * 所以这里不丢弃，只是把间隔拉到上限。
 */
export function retryDelayMs(queued: QueuedBatch, nowMs: number): number | null {
  if (queued.attempts === 0) return null;
  const delay = Math.min(BACKOFF.capMs, BACKOFF.baseMs * 2 ** (queued.attempts - 1));
  const since = queued.lastAttemptAt ?? queued.queuedAt;
  const next = since + delay;
  return next > nowMs ? next - nowMs : null;
}

/**
 * 超期批次移入 `dropped/`。返回移动的条数；调用方必须同时报告"游标未推进"，
 * 否则人会把 `dropped` 误读成"这些数据云端已经有了"。
 */
export async function expireOldest(
  dirs: CloudDirs,
  nowMs: number,
  retentionMs = RETENTION_MS,
): Promise<number> {
  const { items } = await listQueued(dirs);
  let moved = 0;
  for (const item of items) {
    if (item.queuedAt + retentionMs > nowMs) continue;
    await writeFileAtomic(
      join(dirs.dropped, item.file.split(/[\\/]/).pop()!),
      `${JSON.stringify({ ...withoutFile(item), droppedAt: nowMs })}\n`,
    );
    await rm(item.file, { force: true });
    moved += 1;
  }
  return moved;
}

/** 同类熔断累计；返回累计后的次数（换原因即重置为 1）。 */
export function bumpStop(
  state: CloudState,
  kind: string,
  detail: string,
  nowMs: number,
): CloudState {
  const same = state.stop && state.stop.kind === kind;
  return {
    ...state,
    stop: {
      kind,
      detail: detail.slice(0, 200),
      at: nowMs,
      attempts: same ? state.stop!.attempts + 1 : 1,
    },
  };
}

/**
 * 丢弃全部缓冲并清空游标（熔断到上限之后的恢复动作）。
 *
 * 清空游标是故意的：下次投影从 0 重读，把这段时间线**完整重放**一遍。缓冲里的
 * 批次本来就没出过网，留着只会让人以为云端已经有数据。
 */
export async function discardQueue(
  dirs: CloudDirs,
): Promise<{ discarded: number; droppedDir: string }> {
  const { items, unreadable } = await listQueued(dirs);
  for (const item of items) {
    const name = item.file.split(/[\\/]/).pop()!;
    await writeFileAtomic(
      join(dirs.dropped, name),
      `${JSON.stringify({ ...withoutFile(item), droppedAt: Date.now() })}\n`,
    );
    await rm(item.file, { force: true });
  }
  for (const bad of unreadable) {
    await rename(
      join(dirs.pending, bad.file),
      join(dirs.dropped, `${bad.file}.bad-${Date.now()}`),
    ).catch(() => undefined);
  }
  return { discarded: items.length + unreadable.length, droppedDir: dirs.dropped };
}
