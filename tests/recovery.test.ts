import { rm, utimes } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../src/core/clock.js';
import { createDemoRun, makeProjectDir, openRuntime } from './helpers.js';

let dir: string;
let clock: ManualClock;

beforeEach(async () => {
  dir = await makeProjectDir();
  clock = new ManualClock();
});

afterEach(async () => {
  // temp dirs are cleaned by the OS
});

const LEASE = { leaseMs: 10_000 };

describe('restart recovery', () => {
  it('reclaims expired leases when a fresh process opens the project', async () => {
    const first = await openRuntime(dir, { clock, recover: false });
    const run = await createDemoRun(first);
    const task = await first.db.claimNextTask(run.runId, 'dead-worker', LEASE);
    await first.db.markTaskStarted(task!.taskId, 'dead-worker');
    await first.close(); // simulated crash: no ack, no commit

    clock.advance(LEASE.leaseMs + 1);
    const second = await openRuntime(dir, { clock }); // recovery runs on open
    expect(second.recovery.reclaimedLeases).toEqual([task!.taskId]);
    const after = await second.db.getTask(task!.taskId);
    expect(after?.status).toBe('queued');
    expect(after?.leaseOwner).toBeNull();

    // The reclaimed task is claimable by a new worker; run completes normally.
    const claim = await second.db.claimNextTask(run.runId, 'fresh-worker', LEASE);
    expect(claim?.taskId).toBe(task!.taskId);
    expect(claim?.attempt).toBe(2);

    const events = await second.db.listEvents(run.runId);
    expect(events.some((event) => event.eventType === 'recovery')).toBe(true);
    await second.close();
  });

  it('resumes an interrupted commit when the staged temp survived', async () => {
    const first = await openRuntime(dir, { clock, recover: false });
    const run = await createDemoRun(first);
    const task = await first.db.claimNextTask(run.runId, 'w1', LEASE);
    await first.db.markTaskStarted(task!.taskId, 'w1');
    const staged = await first.store.stage('input-manifest', '{"interrupted":true}');
    await first.db.beginCommit({
      taskId: task!.taskId,
      workerId: 'w1',
      attempt: task!.attempt,
      artifacts: [
        {
          kind: 'input-manifest',
          tempPath: staged.tempPath,
          contentHash: staged.contentHash,
          size: staged.size,
          meta: {},
        },
      ],
      result: { summary: 'interrupted mid-commit', artifacts: [] },
    });
    await first.close(); // crash between begin and finalize

    clock.advance(61_000); // beginCommit grants a 60s commit lease
    const second = await openRuntime(dir, { clock });
    expect(second.recovery.resumedCommits).toEqual([task!.taskId]);

    const after = await second.db.getTask(task!.taskId);
    expect(after?.status).toBe('succeeded');
    expect(after?.result?.summary).toBe('interrupted mid-commit');
    const artifacts = await second.db.listArtifacts(task!.taskId);
    expect(artifacts[0]!.status).toBe('committed');
    expect(artifacts[0]!.tempPath).toBeNull();
    // File is at its final content address.
    const content = await second.store.readFinalText(artifacts[0]!.contentHash);
    expect(JSON.parse(content)).toEqual({ interrupted: true });
    await second.close();
  });

  it('requeues an interrupted commit when the staged bytes are gone', async () => {
    const first = await openRuntime(dir, { clock, recover: false });
    const run = await createDemoRun(first);
    const task = await first.db.claimNextTask(run.runId, 'w1', LEASE);
    const staged = await first.store.stage('input-manifest', '{"lost":true}');
    await first.db.beginCommit({
      taskId: task!.taskId,
      workerId: 'w1',
      attempt: task!.attempt,
      artifacts: [
        {
          kind: 'input-manifest',
          tempPath: staged.tempPath,
          contentHash: staged.contentHash,
          size: staged.size,
          meta: {},
        },
      ],
      result: { summary: 'about to lose the temp', artifacts: [] },
    });
    await rm(staged.tempPath); // disk lost the bytes before restart
    await first.close();

    clock.advance(61_000);
    const second = await openRuntime(dir, { clock });
    expect(second.recovery.abandonedCommits).toEqual([task!.taskId]);
    const after = await second.db.getTask(task!.taskId);
    expect(after?.status).toBe('queued');
    const artifacts = await second.db.listArtifacts(task!.taskId);
    expect(artifacts.every((artifact) => artifact.status === 'aborted')).toBe(true);

    // A fresh attempt can execute the task to completion.
    const claim = await second.db.claimNextTask(run.runId, 'w2', LEASE);
    expect(claim?.taskId).toBe(task!.taskId);
    await second.close();
  });

  it('cleans stale temp files left by an output-write crash', async () => {
    const runtime = await openRuntime(dir, { clock, recover: false, staleTempMs: 0 });
    const stale = await runtime.store.stage('report', 'half-written bytes');
    // Make it older than the (0ms) staleness threshold.
    const old = new Date(clock.now() - 1000);
    await utimes(stale.tempPath, old, old);
    await runtime.close();

    const reopened = await openRuntime(dir, { clock, staleTempMs: 0 });
    expect(reopened.recovery.staleTempsRemoved).toEqual([stale.tempPath]);
    await reopened.close();
  });

  it('a staged row outlives the sweep, then the interrupted commit consumes it', async () => {
    // Design review #11: with staleTempMs=0 the age rule would sweep EVERY
    // file, including a multi-GB temp an in-flight promote still owns —
    // the other CLI opening the project used to delete it →
    // OUTPUT_HASH_MISMATCH → requeue loop. The staged row, not the clock,
    // is the ownership signal; recovery must then resume the commit by
    // promoting that very temp.
    const first = await openRuntime(dir, { clock, recover: false, staleTempMs: 0 });
    const run = await createDemoRun(first);
    const task = await first.db.claimNextTask(run.runId, 'w1', LEASE);
    await first.db.markTaskStarted(task!.taskId, 'w1');
    const staged = await first.store.stage('input-manifest', '{"slow":true}');
    await first.db.beginCommit({
      taskId: task!.taskId,
      workerId: 'w1',
      attempt: task!.attempt,
      artifacts: [
        {
          kind: 'input-manifest',
          tempPath: staged.tempPath,
          contentHash: staged.contentHash,
          size: staged.size,
          meta: {},
        },
      ],
      result: { summary: 'promote outlives the sweep window', artifacts: [] },
    });
    await first.close();

    clock.advance(61_000);
    const second = await openRuntime(dir, { clock, staleTempMs: 0 });
    // The sweep saw the staged row and kept the temp despite age=∞.
    expect(second.recovery.staleTempsRemoved).toEqual([]);
    // …and the interrupted commit consumed it by promotion, not deletion.
    expect(second.recovery.resumedCommits).toEqual([task!.taskId]);
    const artifacts = await second.db.listArtifacts(task!.taskId);
    expect(artifacts[0]!.status).toBe('committed');
    const content = await second.store.readFinalText(artifacts[0]!.contentHash);
    expect(JSON.parse(content)).toEqual({ slow: true });
    await second.close();
  });

  it('stops stale worker rows so status does not see ghost workers', async () => {
    const first = await openRuntime(dir, { clock, recover: false });
    const run = await createDemoRun(first);
    await first.db.registerWorker({
      workerId: 'ghost',
      runId: run.runId,
      pid: 99999,
      kind: 'standalone',
    });
    await first.close();

    clock.advance(100_000);
    const second = await openRuntime(dir, { clock, workerStaleMs: 30_000 });
    expect(second.recovery.stoppedWorkers).toEqual(['ghost']);
    const workers = await second.db.listWorkers(run.runId);
    expect(workers).toHaveLength(0);
    await second.close();
  });

  it('recovers the full pipeline across a simulated process restart', async () => {
    // Process 1: run the pipeline but die after the first task.
    const first = await openRuntime(dir, { clock, recover: false });
    const run = await createDemoRun(first);
    const workerOne = await import('../src/worker/worker.js');
    const { demoHandlers } = await import('../src/worker/handlers.js');
    const exitOne = await new workerOne.FakeWorker({
      runtime: first,
      runId: run.runId,
      kind: 'test',
      handlers: demoHandlers,
      maxTasks: 1,
      leaseMs: 10_000,
      heartbeatMs: 250,
      pollMs: 20,
    }).run();
    expect(exitOne.processed).toBe(1);
    expect(exitOne.reason).toBe('stopped'); // more work remains
    await first.close();

    // Process 2: fresh open + worker finishes the rest.
    const second = await openRuntime(dir, { clock });
    const exitTwo = await new workerOne.FakeWorker({
      runtime: second,
      runId: run.runId,
      kind: 'test',
      handlers: demoHandlers,
      leaseMs: 10_000,
      heartbeatMs: 250,
      pollMs: 20,
    }).run();
    expect(exitTwo.reason).toBe('completed');
    expect(exitTwo.processed).toBe(2);

    const tasks = await second.db.listTasks(run.runId);
    expect(tasks.every((task) => task.status === 'succeeded')).toBe(true);
    const finalRun = await second.db.getRun(run.runId);
    expect(finalRun?.status).toBe('COMPLETED');
    expect(finalRun?.phase).toBe('COMPLETED');
    await second.close();
  });
});
