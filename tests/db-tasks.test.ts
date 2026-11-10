import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../src/core/clock.js';
import { IdeaseekError } from '../src/core/errors.js';
import type { ProjectRuntime } from '../src/workflow/runtime.js';
import { createDemoRun, makeProjectDir, openRuntime } from './helpers.js';
import type { RunRecord } from '../src/workflow/types.js';

let dir: string;
let clock: ManualClock;
let runtime: ProjectRuntime;
let run: RunRecord;

beforeEach(async () => {
  dir = await makeProjectDir();
  clock = new ManualClock();
  runtime = await openRuntime(dir, { clock, recover: false });
  run = await createDemoRun(runtime);
});

afterEach(async () => {
  await runtime.close();
});

const LEASE = { leaseMs: 1000 };

/** A run without the demo pipeline, for tests that need a single task. */
async function createEmptyRun(): Promise<RunRecord> {
  return runtime.db.createRun({
    projectId: runtime.project.id,
    question: 'single-task run',
    config: runtime.config,
  });
}

describe('task queue and leases', () => {
  it('enqueues with idempotency: duplicate enqueue returns the same task', async () => {
    const first = await runtime.db.enqueueTask({
      runId: run.runId,
      type: 'demo.ingest',
      idempotencyKey: 'dup-key',
      payload: {},
    });
    const second = await runtime.db.enqueueTask({
      runId: run.runId,
      type: 'demo.ingest',
      idempotencyKey: 'dup-key',
      payload: { changed: true },
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.task.taskId).toBe(first.task.taskId);
  });

  it('claims tasks in creation order and only when dependencies succeeded', async () => {
    const tasks = await runtime.db.listTasks(run.runId);
    expect(tasks.map((task) => task.type)).toEqual(['demo.ingest', 'demo.analyze', 'demo.report']);

    const first = await runtime.db.claimNextTask(run.runId, 'w1', LEASE);
    expect(first?.type).toBe('demo.ingest');
    expect(first?.attempt).toBe(1);
    expect(first?.leaseOwner).toBe('w1');

    // analyze depends on ingest: not claimable until ingest succeeds.
    const second = await runtime.db.claimNextTask(run.runId, 'w2', LEASE);
    expect(second).toBeNull();
  });

  it('renews leases through heartbeat and reports cancel requests', async () => {
    const task = await runtime.db.claimNextTask(run.runId, 'w1', LEASE);
    expect(task).not.toBeNull();
    clock.advance(500);
    const beat = await runtime.db.heartbeat(task!.taskId, 'w1', LEASE);
    expect(beat.ok).toBe(true);
    expect(beat.leaseExpiresAt).toBe(clock.now() + 1000);

    await runtime.db.cancelRun(run.runId);
    const afterCancel = await runtime.db.heartbeat(task!.taskId, 'w1', LEASE);
    expect(afterCancel.cancelRequested).toBe(true);
  });

  it('rejects heartbeat and commit from a worker that lost the lease', async () => {
    const task = await runtime.db.claimNextTask(run.runId, 'w1', LEASE);
    await expect(runtime.db.heartbeat(task!.taskId, 'w2', LEASE)).rejects.toMatchObject({
      code: 'LEASE_LOST',
    });
    await expect(
      runtime.db.beginCommit({
        taskId: task!.taskId,
        workerId: 'w2',
        attempt: task!.attempt,
        artifacts: [],
        result: { summary: 'x', artifacts: [] },
      }),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });

  it('reclaims an expired lease for another worker and increments the attempt', async () => {
    const task = await runtime.db.claimNextTask(run.runId, 'w1', LEASE);
    expect(task?.attempt).toBe(1);

    clock.advance(LEASE.leaseMs + 1);
    const reclaimed = await runtime.db.reclaimExpiredLeases(run.runId);
    expect(reclaimed.reclaimed).toEqual([task!.taskId]);

    const again = await runtime.db.claimNextTask(run.runId, 'w2', LEASE);
    expect(again?.taskId).toBe(task!.taskId);
    expect(again?.attempt).toBe(2);
    expect(again?.leaseOwner).toBe('w2');
  });

  it('fails a task permanently after max_attempts lease expiries (crash loop)', async () => {
    const single = await createEmptyRun();
    const enqueued = await runtime.db.enqueueTask({
      runId: single.runId,
      type: 'demo.ingest',
      idempotencyKey: 'crash-loop',
      maxAttempts: 2,
      payload: {},
    });
    // First claim: attempt 1 → expire → reclaim → queued.
    const claim1 = await runtime.db.claimNextTask(single.runId, 'w1', LEASE);
    expect(claim1?.taskId).toBe(enqueued.task.taskId);
    clock.advance(LEASE.leaseMs + 1);
    await runtime.db.reclaimExpiredLeases(single.runId);
    // Second claim: attempt 2 → expire → attempts exhausted → failed.
    const claim2 = await runtime.db.claimNextTask(single.runId, 'w2', LEASE);
    expect(claim2?.attempt).toBe(2);
    clock.advance(LEASE.leaseMs + 1);
    const reclaimed = await runtime.db.reclaimExpiredLeases(single.runId);
    expect(reclaimed.failed).toEqual([enqueued.task.taskId]);

    const failed = await runtime.db.getTask(enqueued.task.taskId);
    expect(failed?.status).toBe('failed');
    expect(failed?.error?.code).toBe('LEASE_EXPIRED');
    const after = await runtime.db.getRun(single.runId);
    expect(after?.status).toBe('FAILED');
  });

  it('requeues retryable failures until attempts are exhausted', async () => {
    const single = await createEmptyRun();
    await runtime.db.enqueueTask({
      runId: single.runId,
      type: 'demo.ingest',
      idempotencyKey: 'retry-me',
      maxAttempts: 3,
      payload: {},
    });
    let task = await runtime.db.claimNextTask(single.runId, 'w1', LEASE);
    expect(task?.attempt).toBe(1);
    const first = await runtime.db.failAttempt(task!.taskId, 'w1', {
      code: 'WORKER_ERROR',
      message: 'boom',
      retryable: true,
      at: clock.now(),
    });
    expect(first.willRetry).toBe(true);
    expect(first.task.status).toBe('queued');

    task = await runtime.db.claimNextTask(single.runId, 'w1', LEASE);
    expect(task?.attempt).toBe(2);
    await runtime.db.failAttempt(task!.taskId, 'w1', {
      code: 'WORKER_ERROR',
      message: 'boom',
      retryable: true,
      at: clock.now(),
    });
    task = await runtime.db.claimNextTask(single.runId, 'w1', LEASE);
    expect(task?.attempt).toBe(3);
    const last = await runtime.db.failAttempt(task!.taskId, 'w1', {
      code: 'WORKER_ERROR',
      message: 'boom',
      retryable: true,
      at: clock.now(),
    });
    expect(last.willRetry).toBe(false);
    expect(last.task.status).toBe('failed');
    expect((await runtime.db.getRun(single.runId))?.status).toBe('FAILED');
  });

  it('does not claim while the run is paused, blocked or canceled', async () => {
    await runtime.db.pauseRun(run.runId, { hard: false });
    expect(await runtime.db.claimNextTask(run.runId, 'w1', LEASE)).toBeNull();
    await runtime.db.resumeRun(run.runId);
    expect(await runtime.db.claimNextTask(run.runId, 'w1', LEASE)).not.toBeNull();

    await runtime.db.continueRun(run.runId).catch(() => undefined); // RUNNING → no-op
    await runtime.db.cancelRun(run.runId);
    expect(await runtime.db.claimNextTask(run.runId, 'w2', LEASE)).toBeNull();
  });

  it('cancel finalizes queued tasks immediately and preserves committed state', async () => {
    const tasks = await runtime.db.listTasks(run.runId);
    const updated = await runtime.db.cancelRun(run.runId);
    expect(updated.status).toBe('CANCELED');
    const after = await runtime.db.listTasks(run.runId);
    for (const task of after) expect(task.status).toBe('canceled');
    expect(tasks).toHaveLength(3);

    // Cancel is idempotent.
    const again = await runtime.db.cancelRun(run.runId);
    expect(again.status).toBe('CANCELED');
  });

  it('cancel flags a running task; heartbeat surfaces it and ack finalizes', async () => {
    const task = await runtime.db.claimNextTask(run.runId, 'w1', LEASE);
    await runtime.db.markTaskStarted(task!.taskId, 'w1');
    await runtime.db.cancelRun(run.runId);

    const beat = await runtime.db.heartbeat(task!.taskId, 'w1', LEASE);
    expect(beat.cancelRequested).toBe(true);

    const acked = await runtime.db.ackCancel(task!.taskId, 'w1', 'cancel');
    expect(acked.status).toBe('canceled');
  });

  it('hard pause requeues the in-flight task instead of canceling it', async () => {
    const task = await runtime.db.claimNextTask(run.runId, 'w1', LEASE);
    await runtime.db.markTaskStarted(task!.taskId, 'w1');
    const paused = await runtime.db.pauseRun(run.runId, { hard: true });
    expect(paused.status).toBe('PAUSED');

    const acked = await runtime.db.ackCancel(task!.taskId, 'w1', 'pause');
    expect(acked.status).toBe('queued');
    expect(acked.cancelRequested).toBe(false);

    await runtime.db.resumeRun(run.runId);
    const reclaimed = await runtime.db.claimNextTask(run.runId, 'w2', LEASE);
    expect(reclaimed?.taskId).toBe(task!.taskId);
    expect(reclaimed?.attempt).toBe(2);
  });

  it('external blocks park the run without burning attempts; continue resumes', async () => {
    const single = await createEmptyRun();
    const enqueued = await runtime.db.enqueueTask({
      runId: single.runId,
      type: 'demo.ingest',
      idempotencyKey: 'quota-once',
      maxAttempts: 3,
      payload: {},
    });
    const task = await runtime.db.claimNextTask(single.runId, 'w1', LEASE);
    expect(task?.attempt).toBe(1);

    const blocked = await runtime.db.blockExternal(
      task!.taskId,
      'w1',
      { code: 'QUOTA_EXHAUSTED', message: 'quota gone', retryable: true, at: clock.now() },
      'QUOTA_EXHAUSTED',
    );
    expect(blocked.run.status).toBe('QUOTA_EXHAUSTED');
    expect(blocked.task.status).toBe('queued');
    expect(blocked.task.attempt).toBe(0); // attempt not burned

    // No leasing while blocked.
    expect(await runtime.db.claimNextTask(single.runId, 'w2', LEASE)).toBeNull();

    const resumed = await runtime.db.continueRun(single.runId);
    expect(resumed.status).toBe('RUNNING');
    expect(resumed.blockReason).toBeNull();
    const again = await runtime.db.claimNextTask(single.runId, 'w1', LEASE);
    expect(again?.taskId).toBe(enqueued.task.taskId);
    expect(again?.attempt).toBe(1);
  });

  it('persists a monotonic per-run event sequence for replay', async () => {
    const events = await runtime.db.listEvents(run.runId);
    expect(events.length).toBeGreaterThanOrEqual(4); // run_created + 3 enqueued
    const seqs = events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);

    const sinceFirst = await runtime.db.listEvents(run.runId, { since: seqs[0]! });
    expect(sinceFirst.every((event) => event.seq > seqs[0]!)).toBe(true);

    await runtime.db.appendEvent({
      runId: run.runId,
      phase: 'DEMO',
      eventType: 'custom',
      summary: 'manual event',
    });
    const after = await runtime.db.listEvents(run.runId, { since: seqs.at(-1)! });
    expect(after).toHaveLength(1);
    expect(after[0]!.eventType).toBe('custom');
  });

  it('pause/resume transitions guard invalid verbs', async () => {
    await runtime.db.pauseRun(run.runId, { hard: false });
    await expect(runtime.db.pauseRun(run.runId, { hard: false })).resolves.toMatchObject({
      status: 'PAUSED',
    });
    await expect(runtime.db.continueRun(run.runId)).rejects.toBeInstanceOf(IdeaseekError);
    await runtime.db.resumeRun(run.runId);
    await expect(runtime.db.resumeRun(run.runId)).resolves.toMatchObject({ status: 'RUNNING' });
    await runtime.db.cancelRun(run.runId);
    await expect(runtime.db.resumeRun(run.runId)).rejects.toMatchObject({ code: 'RUN_TERMINAL' });
    await expect(runtime.db.cancelRun(run.runId)).resolves.toMatchObject({ status: 'CANCELED' });
  });
});
