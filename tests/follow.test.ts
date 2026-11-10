import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPidAlive, readDaemonInfo, writeDaemonInfo } from '../src/runtime/daemon.js';
import { followEvents } from '../src/workflow/follow.js';
import type { ProjectRuntime } from '../src/workflow/runtime.js';
import type { RunRecord } from '../src/workflow/types.js';
import { createDemoRun, makeProjectDir, openRuntime } from './helpers.js';

let dir: string;
let runtime: ProjectRuntime;
let run: RunRecord;

beforeEach(async () => {
  dir = await makeProjectDir();
  runtime = await openRuntime(dir, { recover: false });
  run = await createDemoRun(runtime);
});

afterEach(async () => {
  await runtime.close();
});

describe('followEvents', () => {
  it('replays the full stream and stops immediately on a terminal run', async () => {
    const { FakeWorker } = await import('../src/worker/worker.js');
    const { demoHandlers } = await import('../src/worker/handlers.js');
    await new FakeWorker({
      runtime,
      runId: run.runId,
      kind: 'test',
      handlers: demoHandlers,
      leaseMs: 5_000,
      heartbeatMs: 100,
      pollMs: 10,
    }).run();

    const seen: number[] = [];
    const result = await followEvents({
      db: runtime.db,
      runId: run.runId,
      since: 0,
      pollMs: 5,
      onEvent: (event) => seen.push(event.seq),
    });
    expect(result.stopReason).toBe('terminal');
    expect(result.replayed).toBeGreaterThanOrEqual(17);
    expect(seen[0]).toBe(1);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    // --since skips history.
    const tail = await followEvents({
      db: runtime.db,
      runId: run.runId,
      since: seen[5]!,
      pollMs: 5,
      onEvent: () => undefined,
    });
    expect(tail.replayed).toBe(result.replayed - 6);
  });

  it('follows live events until the caller aborts (Ctrl-C semantics)', async () => {
    const controller = new AbortController();
    const seen: number[] = [];
    const promise = followEvents({
      db: runtime.db,
      runId: run.runId,
      since: 0,
      pollMs: 20,
      signal: controller.signal,
      onEvent: (event) => seen.push(event.seq),
    });
    // Let it replay the initial events, then simulate Ctrl-C.
    await new Promise((resolve) => setTimeout(resolve, 60));
    controller.abort();
    const result = await promise;
    expect(result.stopReason).toBe('signal');
    expect(seen.length).toBeGreaterThanOrEqual(4);
    // No duplicate deliveries after the abort.
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('stops with worker-lost when a RUNNING run has no live worker', async () => {
    const result = await followEvents({
      db: runtime.db,
      runId: run.runId,
      since: 0,
      pollMs: 5,
      workerLostAfterMs: 0,
      workerStaleMs: 1,
      onEvent: () => undefined,
      onWarn: () => undefined,
    });
    expect(result.stopReason).toBe('worker-lost');
  });

  it('waits for a live worker before declaring worker-lost', async () => {
    const now = { t: 1_000_000 };
    // Fresh worker heartbeat keeps the follower patient.
    await runtime.db.registerWorker({
      workerId: 'w-live',
      runId: run.runId,
      pid: process.pid,
      kind: 'test',
    });
    const promise = followEvents({
      db: runtime.db,
      runId: run.runId,
      since: 0,
      pollMs: 5,
      workerLostAfterMs: 60_000,
      workerStaleMs: 30_000,
      now: () => now.t,
      signal: AbortSignal.timeout(50),
      onEvent: () => undefined,
    });
    const result = await promise;
    expect(result.stopReason).toBe('signal'); // aborted first, worker still fresh
  });
});

describe('daemon metadata', () => {
  it('round-trips daemon info and probes pid liveness', async () => {
    const { projectPaths } = await import('../src/config/paths.js');
    const paths = projectPaths(dir);
    expect(readDaemonInfo(paths.researchDir)).toBeNull();

    writeDaemonInfo(paths.researchDir, {
      runId: run.runId,
      pid: process.pid,
      startedAt: 1,
      heartbeatAt: 2,
      logPath: 'x.log',
      version: '0.1.0',
    });
    const info = readDaemonInfo(paths.researchDir);
    expect(info?.runId).toBe(run.runId);
    expect(info?.pid).toBe(process.pid);

    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2 ** 30 - 1)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
  });
});
