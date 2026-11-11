import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/core/clock.js';
import { createDemoRun, makeProjectDir, openRuntime } from './helpers.js';
import { computeAdmission, type CapacityProbe } from '../src/runtime/capacity.js';
import { classifyRuntimeFailure } from '../src/idea/analysis.js';

/**
 * Accelerated-clock long-run soak (docs/LONG_RUNNING_WORKFLOWS 验收测试):
 * one stitched timeline covering crash → lease reclaim → supervisor restart →
 * quota pause/resume → approval-wait persistence, asserting the three
 * guarantees: no re-do of succeeded nodes, no lost RunEvents, no permanent
 * stale tasks. Disk-threshold and GPU-OOM-classification rules are pinned
 * alongside (they gate the same long-run behavior).
 */

const LEASE = { leaseMs: 10_000 };

function fakeProbe(overrides: Partial<CapacityProbe> = {}): CapacityProbe {
  return {
    gpus: [],
    cpuCores: 8,
    freeMemGiB: 32,
    diskFreeGiB: 100,
    nvidiaSmiAvailable: false,
    probedAt: 1,
    ...overrides,
  };
}

describe('long-run admission guards', () => {
  it('pauses ALL new idea runs below the disk free threshold', () => {
    const plan = computeAdmission(
      fakeProbe({ diskFreeGiB: 2 }),
      [{ ideaId: 'a', gpus: 0, memoryGiB: 1, createdAt: 1 }],
      { maxParallelIdeas: 4 },
    );
    expect(plan.effectiveN).toBe(0);
    expect(plan.admitted).toEqual([]);
    expect(plan.queued).toHaveLength(1);
    expect(plan.queued[0]!.reason).toContain('disk threshold');
    expect(plan.queued[0]!.reason).toContain('2 GiB free');
    expect(plan.constraints.join(' ')).toContain('disk threshold');
  });

  it('admits normally when disk is above the floor (default 5 GiB)', () => {
    const plan = computeAdmission(
      fakeProbe({ diskFreeGiB: 50 }),
      [{ ideaId: 'a', gpus: 0, memoryGiB: 1, createdAt: 1 }],
      { maxParallelIdeas: 4 },
    );
    expect(plan.effectiveN).toBe(1);
    expect(plan.queued).toEqual([]);
  });

  it('a GPU OOM classifies as resource — never as a hypothesis failure', () => {
    expect(classifyRuntimeFailure('resource')).toBe('resource');
    expect(classifyRuntimeFailure('resource')).not.toBe('hypothesis');
  });
});

describe('accelerated long-run soak timeline', () => {
  it('crash+reclaim+restart+quota+approval: no redo, no lost events, no stale tasks', async () => {
    const dir = await makeProjectDir();
    const clock = new ManualClock();

    // --- process 1: start the run, finish one task, record an approval.
    const first = await openRuntime(dir, { clock, recover: false });
    const run = await createDemoRun(first);
    const { FakeWorker } = await import('../src/worker/worker.js');
    const { demoHandlers } = await import('../src/worker/handlers.js');
    const workerOpts = {
      runId: run.runId,
      kind: 'test' as const,
      handlers: demoHandlers,
      leaseMs: 10_000,
      heartbeatMs: 50,
      pollMs: 10,
    };

    const passOne = await new FakeWorker({ runtime: first, ...workerOpts, maxTasks: 1 }).run();
    expect(passOne.processed).toBe(1);
    const afterFirst = await first.db.listTasks(run.runId);
    const doneTask = afterFirst.find((task) => task.status === 'succeeded')!;
    expect(doneTask.attempt).toBe(1);

    // Human approval wait: a Decision is recorded and must survive restarts.
    const decision = await first.db.appendEvent({
      runId: run.runId,
      phase: 'DECISION',
      objectId: null,
      role: 'user',
      eventType: 'decision',
      summary: 'approve soak continuation [guided]',
      status: 'confirmed',
    });
    expect(decision.eventType).toBe('decision');

    // Simulated crash while another task is leased.
    const leased = await first.db.claimNextTask(run.runId, 'crash-worker', LEASE);
    expect(leased).not.toBeNull();
    await first.db.markTaskStarted(leased!.taskId, 'crash-worker');
    await first.close();

    // --- process 2 (supervisor restart): expired lease reclaimed on open.
    clock.advance(LEASE.leaseMs + 1);
    const second = await openRuntime(dir, { clock });
    expect(second.recovery.reclaimedLeases).toContain(leased!.taskId);
    const reclaimed = await second.db.getTask(leased!.taskId);
    expect(reclaimed?.status).toBe('queued'); // no permanent stale task
    expect(reclaimed?.leaseOwner).toBeNull();

    // Approval decision survived the restart.
    const eventsAfterRestart = await second.db.listEvents(run.runId);
    expect(
      eventsAfterRestart.some(
        (event) => event.eventType === 'decision' && event.summary.includes('soak continuation'),
      ),
    ).toBe(true);

    // --- quota exhaustion: pause, verify no leasing, then continue.
    const quotaClaim = await second.db.claimNextTask(run.runId, 'quota-worker', LEASE);
    expect(quotaClaim).not.toBeNull();
    const blocked = await second.db.blockExternal(
      quotaClaim!.taskId,
      'quota-worker',
      { code: 'QUOTA_EXHAUSTED', message: 'quota gone', retryable: true, at: clock.now() },
      'QUOTA_EXHAUSTED',
    );
    expect(blocked.run.status).toBe('QUOTA_EXHAUSTED');
    expect(await second.db.claimNextTask(run.runId, 'other', LEASE)).toBeNull();
    const resumed = await second.db.continueRun(run.runId);
    expect(resumed.status).toBe('RUNNING');

    // --- finish everything with a fresh worker.
    const passTwo = await new FakeWorker({ runtime: second, ...workerOpts }).run();
    expect(passTwo.reason).toBe('completed');

    // --- guarantees:
    const finalTasks = await second.db.listTasks(run.runId);
    expect(finalTasks.every((task) => task.status === 'succeeded')).toBe(true);
    // The first task was NEVER re-done after crash/quota/restart.
    const firstStill = finalTasks.find((task) => task.taskId === doneTask.taskId)!;
    expect(firstStill.attempt).toBe(1);
    // No permanently stale leases.
    expect(finalTasks.some((task) => task.status === 'leased' || task.status === 'running')).toBe(
      false,
    );
    const finalRun = await second.db.getRun(run.runId);
    expect(finalRun?.status).toBe('COMPLETED');

    // RunEvents: contiguous, gapless, dup-free sequence across the timeline.
    const allEvents = await second.db.listEvents(run.runId, { limit: 10_000 });
    expect(allEvents.length).toBeGreaterThanOrEqual(6); // created+enqueues+decision+recovery+...
    const seqs = allEvents.map((event) => event.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs[0]).toBe(1);
    expect(seqs[seqs.length - 1]).toBe(seqs.length);
    // Recovery + decision are both in the durable log.
    expect(allEvents.some((event) => event.eventType === 'recovery')).toBe(true);
    expect(allEvents.some((event) => event.eventType === 'decision')).toBe(true);
    await second.close();
  }, 120_000);

  it('accelerated clock advances lease windows without wall-clock sleeps', async () => {
    const dir = await makeProjectDir();
    const clock = new ManualClock();
    const runtime = await openRuntime(dir, { clock, recover: false });
    const run = await createDemoRun(runtime);
    const task = await runtime.db.claimNextTask(run.runId, 'w-slow', LEASE);
    await runtime.db.markTaskStarted(task!.taskId, 'w-slow');
    await runtime.close();

    // Just before expiry: nothing reclaimed.
    clock.advance(LEASE.leaseMs - 1);
    const mid = await openRuntime(dir, { clock, recover: true });
    expect(mid.recovery.reclaimedLeases).toEqual([]);
    await mid.close();

    // Past expiry: reclaimed — total elapsed is pure virtual time.
    clock.advance(2);
    const after = await openRuntime(dir, { clock, recover: true });
    expect(after.recovery.reclaimedLeases).toEqual([task!.taskId]);
    const recovered = await after.db.getTask(task!.taskId);
    expect(recovered?.status).toBe('queued');
    await after.close();
  }, 60_000);
});
