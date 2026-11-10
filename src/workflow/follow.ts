import type { WorkflowDb } from './db.js';
import type { RunEvent } from './types.js';

export type FollowStopReason = 'terminal' | 'signal' | 'worker-lost';

export interface FollowOptions {
  db: WorkflowDb;
  runId: string;
  /** Replay events with seq > since before following live ones. */
  since: number;
  pollMs?: number;
  /** Stop when the run reaches a terminal status (attach/watch both do). */
  stopOnTerminal?: boolean;
  /**
   * When set, follow stops with `worker-lost` after this many ms without a
   * live worker while the run is still RUNNING (watch behavior; attach passes
   * null to keep waiting).
   */
  workerLostAfterMs?: number | null;
  /** Injected for tests; defaults to the DB clock. */
  now?: () => number;
  /** Live-worker heartbeat staleness window (defaults to 3× lease TTL). */
  workerStaleMs?: number;
  signal?: AbortSignal;
  onEvent: (event: RunEvent) => void;
  onWarn?: (message: string) => void;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Replays persisted RunEvents from `since`, then polls for new ones until the
 * stop condition fires. Events are read from the database (persisted before
 * delivery), so a client that reconnects never misses or reorders history.
 */
export async function followEvents(opts: FollowOptions): Promise<{
  stopReason: FollowStopReason;
  lastSeq: number;
  replayed: number;
}> {
  const pollMs = opts.pollMs ?? 300;
  const now = opts.now ?? (() => Date.now());
  const staleMs = opts.workerStaleMs ?? 30_000;
  const workerLostAfterMs = opts.workerLostAfterMs ?? null;
  let since = opts.since;
  let replayed = 0;
  let workerLostSince: number | null = null;

  for (;;) {
    if (opts.signal?.aborted) return { stopReason: 'signal', lastSeq: since, replayed };

    const events = await opts.db.listEvents(opts.runId, { since, limit: 500 });
    for (const event of events) {
      opts.onEvent(event);
      since = event.seq;
      replayed += 1;
    }

    const run = await opts.db.getRun(opts.runId);
    if (!run) return { stopReason: 'terminal', lastSeq: since, replayed };
    const terminal = ['FAILED', 'CANCELED', 'COMPLETED'].includes(run.status);
    if (terminal && opts.stopOnTerminal !== false) {
      return { stopReason: 'terminal', lastSeq: since, replayed };
    }

    if (!terminal && workerLostAfterMs != null) {
      const workers = await opts.db.listWorkers(opts.runId);
      const live = workers.filter((worker) => now() - worker.heartbeatAt < staleMs);
      if (live.length === 0) {
        workerLostSince ??= now();
        if (now() - workerLostSince >= workerLostAfterMs) {
          opts.onWarn?.(
            'no live worker while the run is RUNNING; start one with: ideaseek run (or ideaseek worker)',
          );
          return { stopReason: 'worker-lost', lastSeq: since, replayed };
        }
      } else {
        workerLostSince = null;
      }
    }

    try {
      await defaultSleep(pollMs, opts.signal);
    } catch {
      return { stopReason: 'signal', lastSeq: since, replayed };
    }
  }
}
