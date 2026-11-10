import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectRuntime } from '../src/workflow/runtime.js';
import { FakeWorker } from '../src/worker/worker.js';
import { demoHandlers } from '../src/worker/handlers.js';
import { createDemoRun, makeProjectDir, openRuntime } from './helpers.js';
import type { RunRecord } from '../src/workflow/types.js';
import type { FaultSpec } from '../src/worker/types.js';

let dir: string;
let runtime: ProjectRuntime;

beforeEach(async () => {
  dir = await makeProjectDir();
  runtime = await openRuntime(dir, { recover: false });
});

afterEach(async () => {
  await runtime.close();
});

function worker(runId: string, opts: Partial<ConstructorParameters<typeof FakeWorker>[0]> = {}) {
  return new FakeWorker({
    runtime,
    runId,
    kind: 'test',
    handlers: demoHandlers,
    leaseMs: 5_000,
    heartbeatMs: 100,
    pollMs: 20,
    ...opts,
  });
}

async function runWithFaults(faults: Record<string, FaultSpec>): Promise<RunRecord> {
  return createDemoRun(runtime, 'worker test question', faults);
}

describe('fake worker', () => {
  it('executes the demo pipeline and commits artifacts', async () => {
    const run = await createDemoRun(runtime);
    const exit = await worker(run.runId).run();
    expect(exit.reason).toBe('completed');
    expect(exit.processed).toBe(3);

    const tasks = await runtime.db.listTasks(run.runId);
    expect(tasks.every((task) => task.status === 'succeeded')).toBe(true);
    const report = tasks.find((task) => task.type === 'demo.report');
    expect(report?.result?.summary).toContain('report written');

    // Artifacts are readable at their content addresses.
    const artifacts = await runtime.db.listArtifacts(report!.taskId);
    const text = await runtime.store.readFinalText(artifacts[0]!.contentHash);
    expect(text).toContain('# IdeaSeek Demo Report');

    // Workers deregister themselves.
    const workers = await runtime.db.listWorkers(run.runId);
    expect(workers).toHaveLength(0);
  });

  it('retries a task that fails with a retryable injected error', async () => {
    const run = await runWithFaults({
      'demo.ingest': { failTimes: 2 },
    });
    const exit = await worker(run.runId).run();
    expect(exit.reason).toBe('completed');

    const tasks = await runtime.db.listTasks(run.runId);
    const ingest = tasks.find((task) => task.type === 'demo.ingest');
    expect(ingest?.status).toBe('succeeded');
    expect(ingest?.attempt).toBe(3); // two injected failures + one success

    const events = await runtime.db.listEvents(run.runId);
    const failures = events.filter((event) => event.eventType === 'task_failed');
    expect(failures).toHaveLength(2);
    expect(failures.every((event) => event.summary.includes('will retry'))).toBe(true);
  });

  it('fails the run when injected failures exhaust attempts', async () => {
    const run = await runWithFaults({ 'demo.ingest': { failTimes: 99 } });
    const exit = await worker(run.runId).run();
    expect(exit.reason).toBe('failed');

    const tasks = await runtime.db.listTasks(run.runId);
    const ingest = tasks.find((task) => task.type === 'demo.ingest');
    expect(ingest?.status).toBe('failed');
    expect(ingest?.attempt).toBe(3); // default max_attempts from config
    // Dependent tasks never run.
    const analyze = tasks.find((task) => task.type === 'demo.analyze');
    expect(analyze?.status).toBe('queued');
    expect((await runtime.db.getRun(run.runId))?.status).toBe('FAILED');
  });

  it('blocks the run on quota and resumes via continue without redoing successes', async () => {
    const run = await runWithFaults({
      'demo.analyze': { blockCode: 'QUOTA_EXHAUSTED', blockOnce: true },
    });
    const first = await worker(run.runId).run();
    expect(first.reason).toBe('blocked');

    let current = await runtime.db.getRun(run.runId);
    expect(current?.status).toBe('QUOTA_EXHAUSTED');
    const tasks = await runtime.db.listTasks(run.runId);
    const ingest = tasks.find((task) => task.type === 'demo.ingest');
    const analyze = tasks.find((task) => task.type === 'demo.analyze');
    expect(ingest?.status).toBe('succeeded'); // success preserved
    expect(analyze?.status).toBe('queued'); // blocked task parked, attempt not burned
    expect(analyze?.attempt).toBe(0);

    // No worker can claim while blocked.
    const idle = await worker(run.runId).run();
    expect(idle.processed).toBe(0);
    expect(idle.reason).toBe('blocked');

    await runtime.db.continueRun(run.runId);
    const second = await worker(run.runId).run();
    expect(second.reason).toBe('completed');
    current = await runtime.db.getRun(run.runId);
    expect(current?.status).toBe('COMPLETED');

    // The successful ingest artifact was not re-executed.
    const afterTasks = await runtime.db.listTasks(run.runId);
    const ingestAfter = afterTasks.find((task) => task.type === 'demo.ingest');
    expect(ingestAfter?.attempt).toBe(1);
  });

  it('stops claiming on pause and continues after resume', async () => {
    const run = await createDemoRun(runtime);
    // Worker1 executes only the first task, then we pause.
    const exit1 = await worker(run.runId, { maxTasks: 1 }).run();
    expect(exit1.processed).toBe(1);

    await runtime.db.pauseRun(run.runId, { hard: false });
    const paused = await worker(run.runId).run();
    expect(paused.reason).toBe('paused');
    expect(paused.processed).toBe(0);

    await runtime.db.resumeRun(run.runId);
    const exit2 = await worker(run.runId).run();
    expect(exit2.reason).toBe('completed');
    expect(exit2.processed).toBe(2);
  });

  it('cancel stops the worker and preserves the committed first task', async () => {
    const run = await createDemoRun(runtime);
    await worker(run.runId, { maxTasks: 1 }).run();
    const committed = await runtime.db.listTasks(run.runId);
    expect(committed.find((task) => task.type === 'demo.ingest')?.status).toBe('succeeded');

    await runtime.db.cancelRun(run.runId);
    const exit = await worker(run.runId).run();
    expect(exit.reason).toBe('canceled');
    expect(exit.processed).toBe(0);

    const tasks = await runtime.db.listTasks(run.runId);
    expect(tasks.find((task) => task.type === 'demo.ingest')?.status).toBe('succeeded');
    expect(tasks.find((task) => task.type === 'demo.analyze')?.status).toBe('canceled');
  });

  it('worker exits when its lease is lost to a competing worker', async () => {
    const run = await createDemoRun(runtime);
    // A rival holds the only claimable task with a long lease; our worker has
    // no idle work and must stop instead of spinning forever.
    const stolen = await runtime.db.claimNextTask(run.runId, 'rival', { leaseMs: 60_000 });
    expect(stolen).not.toBeNull();

    const exit = await worker(run.runId, { maxTasks: 1, heartbeatMs: 50, idleExitMs: 300 }).run();
    expect(exit.processed).toBe(0);
    expect(exit.reason).toBe('stopped');
    const after = await runtime.db.getTask(stolen!.taskId);
    expect(after?.leaseOwner).toBe('rival'); // still held by the rival
  });
});
