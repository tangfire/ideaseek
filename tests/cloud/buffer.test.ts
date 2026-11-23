/**
 * 离线缓冲单测（F1.12 / F1.13 / NFR-05 / NFR-06 的本地那一半）。
 *
 * 这里不碰网络也不碰 SQLite：队列只是 `.research/cloud/` 下的一堆 JSON 文件，
 * 要钉住的是文件语义——顺序、退避、超期丢弃、坏文件必须被看见、游标只能由调用方
 * 在拿到回执之后推进。
 */
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BACKOFF,
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
} from '../../src/cloud/buffer.js';

const NOW = 1_700_000_000_000;

let dirs: CloudDirs;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'ideaseek-buffer-'));
  dirs = cloudDirs(join(root, '.research'));
});

function batch(id: string, events = 1): Record<string, unknown> {
  return {
    schema_version: 1,
    external_batch_id: id,
    project: {
      external_id: 'proj-a1b2c3d4e5f60718',
      title: 't',
      visibility: 'private',
      source_host: 'host-3f7868fca315',
    },
    generated_at: NOW,
    local_schema_version: 10,
    entities: {
      runs: [],
      stages: [],
      events: Array.from({ length: events }, (_, i) => ({
        run_external_id: 'run-a1b2c3d4e5f60718',
        seq: i + 1,
        ts: NOW,
        event_type: 'step_finished',
        summary: `第 ${i + 1} 步`,
      })),
    },
  };
}

async function names(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

describe('queue files (F1.12)', () => {
  it('numbers batches by arrival order and keeps the cursor with them', async () => {
    const first = await enqueue(dirs, batch('bat-0000000000000001'), {
      'run-a1b2c3d4e5f60718': 40,
    });
    const second = await enqueue(dirs, batch('bat-0000000000000002'), {
      'run-a1b2c3d4e5f60718': 80,
    });
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(first.batchId).toMatch(/^bat-[0-9a-f]{16}$/);

    const { items, unreadable } = await listQueued(dirs);
    expect(unreadable).toEqual([]);
    expect(items.map((i) => i.seq)).toEqual([1, 2]);
    // 游标跟着批次走：投递成功时才知道该推进到哪，重放时不用重新算。
    expect(items.map((i) => i.cursorByRun['run-a1b2c3d4e5f60718'])).toEqual([40, 80]);
    expect(items[0]!.attempts).toBe(0);
    expect(items[0]!.lastError).toBeNull();
  });

  it('numbers past files that already exist, so a crash-restart does not collide', async () => {
    await enqueue(dirs, batch('bat-0000000000000001'), {});
    const again = await enqueue(dirs, batch('bat-0000000000000002'), {});
    expect(again.seq).toBe(2);
    expect(again.file).toContain('000002-');
  });

  it('records an attempt without touching the bytes that will be replayed', async () => {
    const queued = await enqueue(
      dirs,
      batch('bat-0000000000000001', 3),
      { 'run-a1b2c3d4e5f60718': 3 },
      NOW,
    );
    await markAttempt(queued, 'unavailable(network -)', NOW + 1000);
    const [reloaded] = (await listQueued(dirs)).items;
    expect(reloaded!.attempts).toBe(1);
    // 退避从这一次尝试起算，而不是从入队起算。
    expect(reloaded!.lastAttemptAt).toBe(NOW + 1000);
    expect(reloaded!.lastError).toBe('unavailable(network -)');
    expect(reloaded!.seq).toBe(queued.seq);
    // 重放用的是同一段字节、同一个 `external_batch_id`——这是云端去重的全部依据。
    expect(reloaded!.batch).toEqual(queued.batch);
    await complete(queued);
    expect(await names(dirs.pending)).toEqual([]);
  });

  it('reports a half-written batch file instead of skipping it', async () => {
    await enqueue(dirs, batch('bat-0000000000000001'), {});
    const good = (await names(dirs.pending))[0]!;
    const torn = `000999-bat-ffffffffffffffff.json`;
    await writeFile(join(dirs.pending, torn), '{"batch": {trunc');
    const { items, unreadable } = await listQueued(dirs);
    expect(items.map((i) => i.file.split(/[\\/]/).pop())).toEqual([good]);
    // 静默跳过等于时间线永久缺一块，而且没人知道。
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]!.file).toBe(torn);
    expect(unreadable[0]!.error.length).toBeGreaterThan(0);
  });

  it('ignores stray files that are not batches', async () => {
    await mkdir(dirs.pending, { recursive: true });
    await writeFile(join(dirs.pending, 'notes.txt'), 'not a batch');
    expect((await listQueued(dirs)).items).toHaveLength(0);
    expect((await listQueued(dirs)).unreadable).toHaveLength(0);
  });
});

describe('backoff (NFR-05)', () => {
  it('sends immediately at first, then doubles toward a ceiling', async () => {
    const queued = await enqueue(dirs, batch('bat-0000000000000001'), {});
    expect(retryDelayMs(queued, NOW)).toBeNull();

    const once = { ...queued, queuedAt: NOW, attempts: 1 };
    expect(retryDelayMs(once, NOW)).toBe(BACKOFF.baseMs);
    expect(retryDelayMs({ ...once, attempts: 2 }, NOW)).toBe(BACKOFF.baseMs * 2);
    expect(retryDelayMs({ ...once, attempts: 8 }, NOW)).toBe(60 * 60_000); // 128 分钟折到 1 小时
    expect(retryDelayMs({ ...once, attempts: 40 }, NOW)).toBe(BACKOFF.capMs);
    expect(BACKOFF.capMs).toBeLessThanOrEqual(60 * 60_000);
  });

  it('lets the batch go once the window has passed', () => {
    const queued = {
      seq: 1,
      batchId: 'bat-0000000000000001',
      file: 'x',
      batch: {},
      cursorByRun: {},
      queuedAt: NOW,
      attempts: 3,
      lastError: null,
    };
    expect(retryDelayMs(queued, NOW + BACKOFF.baseMs * 4)).toBeNull();
  });

  it('never burns the ceiling into a permanent retry storm', () => {
    // 上限之外只拉大间隔，不丢数据：断网一整晚之后仍然补得回来。
    const queued = {
      seq: 1,
      batchId: 'bat-0000000000000001',
      file: 'x',
      batch: {},
      cursorByRun: {},
      queuedAt: NOW,
      attempts: BACKOFF.maxAttempts + 6,
      lastError: null,
    };
    expect(retryDelayMs(queued, NOW)).toBe(BACKOFF.capMs);
  });
});

describe('retention (F1.12)', () => {
  it('moves overdue batches to the drop archive and leaves the cursor alone', async () => {
    await enqueue(dirs, batch('bat-0000000000000001'), { 'run-a1b2c3d4e5f60718': 7 }, NOW);
    await enqueue(dirs, batch('bat-0000000000000002'), { 'run-a1b2c3d4e5f60718': 9 }, NOW);
    const state = { cursors: { 'run-a1b2c3d4e5f60718': 3 }, lastOkAt: NOW, stop: null };
    await saveState(dirs, state);

    const moved = await expireOldest(dirs, NOW + 15 * 24 * 60 * 60 * 1000);
    expect(moved).toBe(2);
    expect(await names(dirs.pending)).toEqual([]);
    expect(await names(dirs.dropped)).toHaveLength(2);
    // 丢的是缓冲，不是进度：游标停在最后确认处，下次投影从那里重读。
    expect((await loadState(dirs)).cursors).toEqual({ 'run-a1b2c3d4e5f60718': 3 });

    const archived = JSON.parse(
      await readFile(join(dirs.dropped, (await names(dirs.dropped))[0]!), 'utf8'),
    ) as { droppedAt: number };
    expect(archived.droppedAt).toBe(NOW + 15 * 24 * 60 * 60 * 1000);
  });

  it('keeps batches that are still inside the window', async () => {
    await enqueue(dirs, batch('bat-0000000000000001'), {});
    expect(await expireOldest(dirs, Date.now() + 60_000)).toBe(0);
    expect((await listQueued(dirs)).items).toHaveLength(1);
  });

  it('discards everything on a hard stop, archive included', async () => {
    await enqueue(dirs, batch('bat-0000000000000001'), {});
    const pending = (await names(dirs.pending))[0]!;
    await writeFile(join(dirs.pending, '00777-bat-eeeeeeeeeeeeeeee.json'), '{oops');
    const cleared = await discardQueue(dirs);
    expect(cleared.discarded).toBe(2);
    expect(await names(dirs.pending)).toEqual([]);
    expect(await names(dirs.dropped)).toEqual(expect.arrayContaining([pending]));
  });
});

describe('state file (NFR-05)', () => {
  it('starts empty when nothing has been synced', async () => {
    expect(await loadState(dirs)).toEqual({ cursors: {}, lastOkAt: null, stop: null });
  });

  it('fails loud on a torn state file rather than pretending the cursor is 0', async () => {
    await saveState(dirs, { cursors: { 'run-a1b2c3d4e5f60718': 42 }, lastOkAt: NOW, stop: null });
    const file = join(dirs.root, 'state.json');
    await writeFile(file, '{ "cursors": { ');
    await expect(loadState(dirs)).rejects.toThrow();

    // 形状对但内容不是状态：同样不许当成"从没同步过"。
    await writeFile(file, '{"cursors": 42}');
    await expect(loadState(dirs)).rejects.toThrow(/形状/);
    await writeFile(file, '{}');
    await expect(loadState(dirs)).rejects.toThrow(/形状/);
  });

  it('round-trips cursors, last success and the stop reason', async () => {
    const state = {
      cursors: { 'run-a1b2c3d4e5f60718': 42 },
      lastOkAt: NOW,
      stop: { kind: 'version-unsupported', detail: '不支持的投影版本：99', at: NOW, attempts: 2 },
    };
    await saveState(dirs, state);
    expect(await loadState(dirs)).toEqual(state);
  });
});

describe('circuit breaker counting', () => {
  it('accumulates only for the same failure, and resets when the reason changes', async () => {
    let state = { cursors: {}, lastOkAt: null, stop: null };
    state = bumpStop(state, 'version-unsupported', 'a', NOW);
    expect(state.stop).toMatchObject({ kind: 'version-unsupported', attempts: 1 });
    state = bumpStop(state, 'version-unsupported', 'b', NOW + 1);
    expect(state.stop!.attempts).toBe(2);
    // 换了原因说明上一次的问题已经解决，熔断次数不能跟着旧账算。
    state = bumpStop(state, 'rejected', 'c', NOW + 2);
    expect(state.stop).toMatchObject({ kind: 'rejected', attempts: 1, detail: 'c' });
  });

  it('clips the detail so a message cannot carry an unbounded blob into state.json', () => {
    const state = bumpStop(
      { cursors: {}, lastOkAt: null, stop: null },
      'rejected',
      '长'.repeat(5_000),
      NOW,
    );
    expect(state.stop!.detail).toHaveLength(200);
  });
});
