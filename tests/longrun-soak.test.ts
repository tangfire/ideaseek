import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/core/clock.js';
import { sha256Of, verifyFileHash } from '../src/core/hash.js';
import {
  buildCheckpointManifest,
  computeSpecConfigHash,
  validateCheckpointCompatibility,
  type CheckpointManifest,
} from '../src/experiment/checkpoint.js';
import { computeSpecHash, type ExperimentSpec, type RunResult } from '../src/experiment/spec.js';
import type { IdeaCard } from '../src/idea/card.js';
import { createRound } from '../src/idea/rounds.js';
import { createWorkspace, reviseEngineering, setIdeaStatus } from '../src/idea/workspace.js';
import { collectRuntimeAlerts } from '../src/runtime/alerts.js';
import { listBackupRecords, readLatestBackup, runProjectBackup } from '../src/runtime/backup.js';
import { computeAdmission, type CapacityProbe } from '../src/runtime/capacity.js';
import { collectMonitor } from '../src/runtime/monitor.js';
import { collectQueue } from '../src/runtime/queue.js';
import { detectWatchdog } from '../src/runtime/watchdog.js';
import { collectContext, writeSessionEnd } from '../src/session/context.js';
import type { ProjectRuntime } from '../src/workflow/runtime.js';
import { createDemoRun, makeProjectDir, openRuntime } from './helpers.js';

/**
 * Phase 7 long-run soak (docs/LONG_RUNNING_WORKFLOWS 验收测试): an
 * ACCELERATED-CLOCK, fault-injected timeline over ResearchRun, watchdog,
 * monitor, queue, checkpoint and session recovery — no real long
 * experiments, no wall-clock sleeps for time-dependent behavior.
 *
 * Guarantees pinned here:
 *   1. succeeded ResearchRun nodes never downgrade across crash/restart;
 *   2. committed artifacts survive every restart and stay hash-verifiable;
 *   3. failures/crashes rerun only the minimal unfinished task;
 *   4. runtime resource alerts report FACTS ONLY (measurements/states) and
 *      never judge idea validity — and they never mutate workflow state.
 */

const LEASE = { leaseMs: 10_000 };

function makeCard(ideaId: string): IdeaCard {
  return {
    ideaId,
    version: 1,
    parentVersion: null,
    status: 'CANDIDATE',
    hypothesis: { statement: 's', targetProblem: 't' },
    paperEvidence: [{ paperRef: 'p', statement: 's', evidence: 'e' }],
    contradictions: ['c'],
    novelty: { claim: 'c', uncertainty: 'u', whyNotRestatement: 'w' },
    mechanismChain: {
      designPrincipleLink: 'l',
      steps: [
        { kind: 'observation', text: 'a' },
        { kind: 'hypothesis', text: 'b' },
        { kind: 'intervention', text: 'c' },
        { kind: 'expected-change', text: 'd' },
        { kind: 'baseline-difference', text: 'e' },
        { kind: 'falsifier', text: 'f' },
      ],
    },
    nearestComparisons: [{ methodId: 'm', difference: 'd', evidence: 'e' }],
    componentNecessity: [{ component: 'c', role: 'necessary-mechanism', removeEffect: 'r' }],
    competingExplanations: ['x'],
    boundaryConditions: ['x'],
    risks: ['x'],
    minimalExperiment: {
      code: 'src/train.py',
      data: 'd',
      baselines: ['b'],
      metrics: ['accuracy'],
      ablations: ['a'],
    },
    falsification: { conditions: ['f'] },
    budget: { maxRounds: 1, maxGpuMinutes: 10 },
    stopConditions: ['s'],
    createdAt: 1,
  } as IdeaCard;
}

function soakSpec(): ExperimentSpec {
  return {
    specId: 'idea-soak-idea',
    version: 1,
    idea: { ideaId: 'soak-idea', version: 1 },
    comparisonIds: [],
    codeCommit: null,
    dataSnapshotId: 'data:soak',
    sliceIds: [],
    environment: { python: 'v24', notes: ['scale:smoke'] },
    command: ['python', 'src/smoke.py'],
    metrics: [{ name: 'accuracy', direction: 'higher' }],
    seeds: [42],
    resources: {},
    budget: { maxRuns: 1, maxMinutes: 5 },
    protocolId: 'proto-soak',
    createdAt: 1000,
  } as ExperimentSpec;
}

function succeededResult(specId: string): RunResult {
  return {
    specId,
    status: 'succeeded',
    logRefs: [],
    artifactRefs: [],
    metrics: [{ name: 'accuracy', value: 0.9 }],
    resourcesUsed: {},
    failure: null,
    startedAt: 1,
    finishedAt: 2,
  } as RunResult;
}

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

async function expectContiguousEvents(runtime: ProjectRuntime, runId: string): Promise<void> {
  const events = await runtime.db.listEvents(runId, { limit: 10_000 });
  const seqs = events.map((event) => event.seq);
  expect(new Set(seqs).size).toBe(seqs.length); // no duplicates
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b)); // ordered
  expect(seqs[0]).toBe(1);
  expect(seqs[seqs.length - 1]).toBe(seqs.length); // no gaps
}

describe('Phase 7 long-run soak: ResearchRun node ledger', () => {
  it('crash+restart never downgrades succeeded nodes, loses artifacts, or reruns finished tasks', async () => {
    const dir = await makeProjectDir();
    const clock = new ManualClock();

    // --- process 1: run + durable research sources accrue ------------------
    const first = await openRuntime(dir, { clock, recover: false });
    const run = await createDemoRun(first, 'soak research-run', {
      'demo.analyze': { failTimes: 1 },
    });

    const { round } = await createRound(dir, {
      question: 'soak question',
      ideaLimit: 1,
      modelRoute: 'fast',
    });
    expect(round.roundId).toBe('r1');

    await createWorkspace(dir, { ideaId: 'soak-idea', card: makeCard('soak-idea') });
    const spec = soakSpec();
    const result = succeededResult(spec.specId);
    const mirror = { spec, result };
    await writeFile(
      join(dir, 'ideas', 'soak-idea', 'experiments', 'idea-soak-idea-v1.json'),
      JSON.stringify(mirror, null, 2),
      'utf8',
    );
    await first.db.upsertExperiment({
      specId: spec.specId,
      version: 1,
      specHash: computeSpecHash(spec),
      status: 'succeeded',
      spec: spec as unknown as Record<string, unknown>,
      result: result as unknown as Record<string, unknown>,
      updatedAt: clock.now(),
    });
    await writeFile(
      join(dir, 'ideas', 'soak-idea', 'experiments', 'analysis-v1.json'),
      JSON.stringify(
        { ideaId: 'soak-idea', ideaVersion: 1, verdict: 'inconclusive', failureClass: 'none' },
        null,
        2,
      ),
      'utf8',
    );

    // Checkpoint A: first projection creates the node graph + one audit event.
    const syncA = await first.syncResearchNodes();
    expect(syncA.created).toEqual(
      expect.arrayContaining([
        'idea-round:r1',
        'experiment:idea-soak-idea:v1',
        'analysis:soak-idea:v1',
      ]),
    );
    expect(syncA.eventsAppended).toBe(1);
    const nodesA = await first.db.listResearchNodes(run.runId);
    const analysisNode = nodesA.find((node) => node.nodeId === 'analysis:soak-idea:v1')!;
    expect(analysisNode.dependsOn).toContain('experiment:idea-soak-idea:v1');
    expect(analysisNode.status).toBe('succeeded');

    // Unchanged sources → idempotent: no writes, no second audit event.
    const syncB = await first.syncResearchNodes();
    expect(syncB.created).toEqual([]);
    expect(syncB.updated).toEqual([]);
    expect(syncB.unchanged).toBeGreaterThanOrEqual(3);
    expect(syncB.eventsAppended).toBe(0);

    // --- fault injection: first task ok, second fails, third never runs ----
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
    const passOne = await new FakeWorker({ runtime: first, ...workerOpts, maxTasks: 2 }).run();
    expect(passOne.processed).toBe(2); // ingest ok + analyze failed once

    const tasksAfterPass = await first.db.listTasks(run.runId);
    const ingest = tasksAfterPass.find((task) => task.type === 'demo.ingest')!;
    const analyze = tasksAfterPass.find((task) => task.type === 'demo.analyze')!;
    expect(ingest.status).toBe('succeeded');
    expect(ingest.attempt).toBe(1);
    expect(analyze.status).toBe('queued'); // retryable failure parked

    // Committed artifact from the succeeded task (must survive everything).
    const ingestArtifacts = await first.db.listArtifacts(ingest.taskId);
    expect(ingestArtifacts.length).toBeGreaterThan(0);
    expect(ingestArtifacts.every((artifact) => artifact.status === 'committed')).toBe(true);
    const artifactHash = ingestArtifacts[0]!.contentHash;
    const artifactText = await first.store.readFinalText(artifactHash);
    expect(artifactText).toContain('ideaseek-demo-ingest');

    // --- simulated crash while the failed task is leased again ------------
    const leased = await first.db.claimNextTask(run.runId, 'crash-w', LEASE);
    expect(leased?.taskId).toBe(analyze.taskId);
    await first.db.markTaskStarted(leased!.taskId, 'crash-w');
    await first.close();

    // --- process 2 (machine restart): reclaim + re-project ----------------
    clock.advance(LEASE.leaseMs + 1);
    const second = await openRuntime(dir, { clock });
    expect(second.recovery.reclaimedLeases).toContain(analyze.taskId);
    // Graph re-projected from unchanged sources: nothing downgraded, no event.
    expect(second.researchSync?.created).toEqual([]);
    expect(second.researchSync?.updated).toEqual([]);
    expect(second.researchSync?.eventsAppended).toBe(0);
    const nodesAfterRestart = await second.db.listResearchNodes(run.runId);
    expect(
      nodesAfterRestart.find((node) => node.nodeId === 'experiment:idea-soak-idea:v1')?.status,
    ).toBe('succeeded'); // 成功节点不降级

    // Artifact survived the restart and is still hash-verifiable.
    const artifactAfter = (await second.db.listArtifacts(ingest.taskId)).find(
      (row) => row.contentHash === artifactHash,
    );
    expect(artifactAfter?.status).toBe('committed');
    expect(await verifyFileHash(second.store.resolvePath(artifactHash), artifactHash)).toBe(true);

    // --- finish: ONLY the unfinished node reruns ---------------------------
    const passTwo = await new FakeWorker({ runtime: second, ...workerOpts }).run();
    expect(passTwo.reason).toBe('completed');
    const finalTasks = await second.db.listTasks(run.runId);
    expect(finalTasks.every((task) => task.status === 'succeeded')).toBe(true);
    const finalIngest = finalTasks.find((task) => task.type === 'demo.ingest')!;
    const finalAnalyze = finalTasks.find((task) => task.type === 'demo.analyze')!;
    const finalReport = finalTasks.find((task) => task.type === 'demo.report')!;
    expect(finalIngest.attempt).toBe(1); // succeeded task never re-executed
    expect(finalReport.attempt).toBe(1);
    expect(finalAnalyze.attempt).toBe(3); // failed once + crashed once + success
    expect(finalAnalyze.attempt).toBeGreaterThan(finalIngest.attempt);
    expect((await second.db.getRun(run.runId))?.status).toBe('COMPLETED');

    // --- idea revision invalidates only the version-bound nodes ------------
    await reviseEngineering(dir, 'soak-idea', 'soak engineering revision');
    const syncC = await second.syncResearchNodes();
    expect(syncC.eventsAppended).toBe(1); // graph actually changed
    const nodesFinal = await second.db.listResearchNodes(run.runId);
    const v1 = nodesFinal.find((node) => node.nodeId === 'experiment:idea-soak-idea:v1')!;
    expect(v1.status).toBe('invalidated');
    expect(v1.invalidationReason).toContain('superseded by idea v2');
    expect(v1.payload.resultStatus).toBe('succeeded'); // 保留旧结果 payload
    expect(nodesFinal.find((node) => node.nodeId === 'analysis:soak-idea:v1')?.status).toBe(
      'invalidated',
    );
    expect(nodesFinal.find((node) => node.nodeId === 'idea-round:r1')?.status).toBe('succeeded'); // unrelated node untouched
    expect(nodesFinal).toHaveLength(nodesAfterRestart.length); // no rows deleted

    // Exactly one research_sync per graph change; event log gapless overall.
    const events = await second.db.listEvents(run.runId, { limit: 10_000 });
    expect(events.filter((event) => event.eventType === 'research_sync')).toHaveLength(2);
    await expectContiguousEvents(second, run.runId);
    await second.close();
  }, 120_000);
});

describe('Phase 7 long-run soak: watchdog + monitor over accelerated time', () => {
  it('reports stale worker and long no-progress as facts, then clears after recovery', async () => {
    const dir = await makeProjectDir();
    const clock = new ManualClock();

    const runtime = await openRuntime(dir, { clock, recover: false });
    const run = await createDemoRun(runtime, 'soak liveness');
    await runtime.db.registerWorker({
      workerId: 'soak-stale-w',
      runId: run.runId,
      pid: 4194303,
      kind: 'test',
    });
    const leased = await runtime.db.claimNextTask(run.runId, 'soak-stale-w', LEASE);
    await runtime.db.markTaskStarted(leased!.taskId, 'soak-stale-w');

    // In-flight experiment with a heartbeat that will go stale.
    await runtime.db.upsertExperiment({
      specId: 'idea-stall-idea',
      version: 1,
      specHash: 'sha256:stall',
      status: 'planned',
      spec: { specId: 'idea-stall-idea' },
      result: null,
      updatedAt: clock.now(),
    });
    const expDir = join(dir, 'ideas', 'stall-idea', 'experiments');
    await mkdir(expDir, { recursive: true });
    const staleAt = clock.now() - 20 * 60_000; // 20 min without progress
    const writeProgress = async (at: number): Promise<void> => {
      await writeFile(
        join(expDir, 'progress-idea-stall-idea.json'),
        JSON.stringify({
          specId: 'idea-stall-idea',
          recovery: 'task-level',
          policy: { kind: 'none' },
          heartbeat: { step: 7, epoch: 1, checkpointId: null, at },
          checkpoints: [],
          resumeHint: null,
          interrupt: null,
          updatedAt: at,
        }),
        'utf8',
      );
    };
    await writeProgress(staleAt);
    await runtime.close(); // crash: worker row stays active

    // --- accelerated time: jump past 3× lease TTL and the stall grace ------
    clock.advance(91_000); // > 3 × 30 s default TTL

    const wd = await detectWatchdog(dir, { now: clock.now() });
    expect(wd.healthy).toBe(false);
    const workerFinding = wd.findings.find((finding) => finding.scope === 'worker')!;
    expect(workerFinding.state).toBe('stale');
    expect(workerFinding.target).toContain('soak-stale-w');
    expect(workerFinding.detail).toContain('lease TTL'); // factual threshold
    const stallFinding = wd.findings.find((finding) => finding.scope === 'experiment')!;
    expect(stallFinding.state).toBe('stalled');
    expect(stallFinding.target).toBe('idea-stall-idea');
    expect(stallFinding.detail).toContain('no progress for');
    expect(wd.checked.workers).toBeGreaterThanOrEqual(1);
    expect(wd.checked.experiments).toBeGreaterThanOrEqual(1);

    const mon = await collectMonitor(dir, { now: clock.now() });
    const monWorker = mon.workers.find((worker) => worker.workerId === 'soak-stale-w')!;
    expect(monWorker.ageSeconds).toBeGreaterThanOrEqual(90);
    const monExp = mon.experiments.find((entry) => entry.specId === 'idea-stall-idea')!;
    expect(monExp.ageSeconds).toBeGreaterThanOrEqual(1200);
    expect(monExp.step).toBe(7);

    // --- recovery: reopen reclaims the lease, stops the ghost worker -------
    const reopened = await openRuntime(dir, { clock });
    expect(reopened.recovery.reclaimedLeases).toContain(leased!.taskId);
    expect(reopened.recovery.stoppedWorkers).toContain('soak-stale-w');
    expect((await reopened.db.getTask(leased!.taskId))?.status).toBe('queued');
    expect(await reopened.db.listWorkers(run.runId)).toHaveLength(0);

    // Progress resumes → same instant reports healthy again.
    await writeProgress(clock.now());
    const wdAfter = await detectWatchdog(dir, { now: clock.now() });
    expect(wdAfter.healthy).toBe(true);
    expect(wdAfter.findings).toEqual([]);
    const monAfter = await collectMonitor(dir, { now: clock.now() });
    expect(monAfter.workers).toEqual([]);
    expect(
      monAfter.experiments.find((entry) => entry.specId === 'idea-stall-idea')!.ageSeconds,
    ).toBeLessThan(60);

    await reopened.close();
  }, 120_000);
});

describe('Phase 7 long-run soak: queue admission facts (GPU queueing + disk floor)', () => {
  it('pins the admission timeline: disk floor → single-GPU queue → both admitted', () => {
    const gpu = {
      index: 0,
      memTotalMiB: 16384,
      memFreeMiB: 10240,
      utilizationPct: 10,
    };
    const probeOneGpu = fakeProbe({
      gpus: [gpu],
      diskFreeGiB: 50,
      nvidiaSmiAvailable: true,
    });
    const requests = [
      { ideaId: 'gpu-a', gpus: 1, memoryGiB: 8, createdAt: 1 },
      { ideaId: 'gpu-b', gpus: 1, memoryGiB: 8, createdAt: 2 },
    ];

    // Stage 1: disk below floor pauses EVERYTHING (fact with numbers).
    const planDisk = computeAdmission({ ...probeOneGpu, diskFreeGiB: 2 }, requests, {
      maxParallelIdeas: 4,
    });
    expect(planDisk.effectiveN).toBe(0);
    expect(planDisk.queued).toHaveLength(2);
    expect(planDisk.queued[0]!.reason).toContain('disk threshold');
    expect(planDisk.queued[0]!.reason).toContain('2 GiB free');

    // Stage 2: disk ok, one GPU → first binds device 0, second queues with
    // an explicit factual reason (never silently dropped, never over-assigned).
    const planGpu = computeAdmission(probeOneGpu, requests, { maxParallelIdeas: 4 });
    expect(planGpu.admitted).toHaveLength(1);
    expect(planGpu.admitted[0]!.ideaId).toBe('gpu-a');
    expect(planGpu.admitted[0]!.deviceIndices).toEqual([0]);
    expect(planGpu.queued).toHaveLength(1);
    expect(planGpu.queued[0]!.ideaId).toBe('gpu-b');
    expect(planGpu.queued[0]!.reason).toContain('insufficient free GPU');
    expect(planGpu.queued[0]!.reason).toContain('need 1×8GiB');
    expect(planGpu.constraints).toContain('GPU free memory / count');

    // Stage 3: a second GPU arrives → both admitted, queue drains.
    const planBoth = computeAdmission(
      fakeProbe({
        gpus: [gpu, { ...gpu, index: 1 }],
        diskFreeGiB: 50,
        nvidiaSmiAvailable: true,
      }),
      requests,
      { maxParallelIdeas: 4 },
    );
    expect(planBoth.admitted).toHaveLength(2);
    expect(planBoth.queued).toEqual([]);
  });

  it('queue and monitor surface the GPU request as admission facts on a real project', async () => {
    const dir = await makeProjectDir();
    const runtime = await openRuntime(dir, { recover: false });
    const run = await createDemoRun(runtime, 'soak gpu queue');

    // A ready (SMOKE_TESTED) idea asking for one GPU.
    await createWorkspace(dir, { ideaId: 'gpu-idea', card: makeCard('gpu-idea') });
    await setIdeaStatus(dir, 'gpu-idea', 'IMPLEMENTING');
    await setIdeaStatus(dir, 'gpu-idea', 'SMOKE_TESTED');
    await writeFile(
      join(dir, 'ideas', 'gpu-idea', 'config', 'train.json'),
      JSON.stringify({ resources: { gpus: 1, memoryGiB: 8 } }, null, 2),
      'utf8',
    );
    await runtime.close();

    const queue = await collectQueue(dir);
    expect(queue.admission).not.toBeNull();
    const plan = queue.admission!;
    // Host-independent: the plan accounts for the GPU request either way
    // (queued on hosts without a free 8 GiB GPU, admitted on ones with it).
    const accounted =
      plan.queued.some((entry) => entry.ideaId === 'gpu-idea') ||
      plan.admitted.some((entry) => entry.ideaId === 'gpu-idea');
    expect(accounted).toBe(true);
    for (const entry of plan.queued) {
      expect(entry.reason.length).toBeGreaterThan(0); // every queue has a fact
    }

    const monitor = await collectMonitor(dir);
    if (plan.queued.length > 0) {
      const waiting = monitor.waiting.find(
        (entry) => entry.scope === 'admission' && entry.reason.includes('gpu-idea'),
      );
      expect(waiting).toBeDefined();
    }
    expect(run.status).toBe('RUNNING');
  }, 60_000);
});

describe('Phase 7 long-run soak: runtime alerts are facts, never verdicts', () => {
  it('disk, quota and dead-supervisor facts alert and clear without mutating state', async () => {
    const dir = await makeProjectDir();
    const clock = new ManualClock();
    const runtime = await openRuntime(dir, { clock, recover: false });
    const run = await createDemoRun(runtime, 'soak alerts');

    // --- disk threshold (injected probe — deterministic on any host) -------
    const lowDisk = await collectRuntimeAlerts(dir, {
      now: clock.now(),
      probe: fakeProbe({ diskFreeGiB: 2 }),
      liveness: false,
    });
    expect(lowDisk.healthy).toBe(false);
    const diskAlert = lowDisk.alerts.find((alert) => alert.kind === 'disk-threshold')!;
    expect(diskAlert.facts.diskFreeGiB).toBe(2);
    expect(diskAlert.facts.floorGiB).toBe(5);
    expect(diskAlert.detail).toContain('2 GiB'); // measurement in the sentence

    const okDisk = await collectRuntimeAlerts(dir, {
      now: clock.now(),
      probe: fakeProbe({ diskFreeGiB: 50 }),
      liveness: false,
    });
    expect(okDisk.alerts.find((alert) => alert.kind === 'disk-threshold')).toBeUndefined();

    // --- quota exhaustion fact ---------------------------------------------
    const task = await runtime.db.claimNextTask(run.runId, 'quota-w', LEASE);
    await runtime.db.blockExternal(
      task!.taskId,
      'quota-w',
      {
        code: 'QUOTA_EXHAUSTED',
        message: 'injected quota exhaustion',
        retryable: true,
        at: clock.now(),
      },
      'QUOTA_EXHAUSTED',
    );

    const eventsBefore = (await runtime.db.listEvents(run.runId, { limit: 10_000 })).length;
    const tasksBefore = (await runtime.db.listTasks(run.runId)).map(
      (entry) => `${entry.taskId}:${entry.status}:${entry.attempt}`,
    );

    const quotaAlerts = await collectRuntimeAlerts(dir, {
      now: clock.now(),
      probe: fakeProbe({ diskFreeGiB: 50 }),
      liveness: false,
    });
    const quotaAlert = quotaAlerts.alerts.find((alert) => alert.kind === 'quota-exhausted')!;
    expect(quotaAlert.facts.runId).toBe(run.runId);
    expect(quotaAlert.facts.status).toBe('QUOTA_EXHAUSTED');

    // Monitor echoes the same fact as a waiting reason.
    const monitor = await collectMonitor(dir, { now: clock.now() });
    expect(
      monitor.waiting.some(
        (entry) => entry.scope === 'run' && entry.reason.includes('QUOTA_EXHAUSTED'),
      ),
    ).toBe(true);

    // Read-only: alerts changed no task, run or event.
    const eventsAfter = (await runtime.db.listEvents(run.runId, { limit: 10_000 })).length;
    const tasksAfter = (await runtime.db.listTasks(run.runId)).map(
      (entry) => `${entry.taskId}:${entry.status}:${entry.attempt}`,
    );
    expect(eventsAfter).toBe(eventsBefore);
    expect(tasksAfter).toEqual(tasksBefore);
    expect((await runtime.db.getRun(run.runId))?.status).toBe('QUOTA_EXHAUSTED');

    // continue → the fact clears (state change is the CLI's job, not alerts').
    await runtime.db.continueRun(run.runId);
    const afterContinue = await collectRuntimeAlerts(dir, {
      now: clock.now(),
      probe: fakeProbe({ diskFreeGiB: 50 }),
      liveness: false,
    });
    expect(afterContinue.alerts).toEqual([]);
    expect(afterContinue.healthy).toBe(true);

    // --- liveness composition: dead supervisor → supervisor-dead -----------
    const { spawn } = await import('node:child_process');
    const deadPid = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
      child.on('close', () => resolve(child.pid ?? 4194303));
    });
    const { writeDaemonInfo } = await import('../src/runtime/daemon.js');
    writeDaemonInfo(join(dir, '.research'), {
      runId: run.runId,
      pid: deadPid,
      startedAt: Date.now() - 60_000,
      heartbeatAt: Date.now() - 60_000,
      logPath: 'log',
      version: 'test',
    });
    const withLiveness = await collectRuntimeAlerts(dir, {
      now: clock.now(),
      probe: fakeProbe({ diskFreeGiB: 50 }),
    });
    const deadAlert = withLiveness.alerts.find((alert) => alert.kind === 'supervisor-dead')!;
    expect(deadAlert.severity).toBe('critical');
    expect(String(deadAlert.facts.target)).toContain(String(deadPid));

    // Fact-only guard: no alert may judge ideas, hypotheses or novelty.
    const banned =
      /idea\s+(is\s+)?(valid|invalid|weak|strong)|hypothesis\s+(holds|fails)|novelty\s+(is|verdict)|breakthrough|proves?/;
    for (const alert of withLiveness.alerts) {
      expect(alert.detail).not.toMatch(banned);
      expect(Object.keys(alert.facts).length).toBeGreaterThan(0);
    }

    await runtime.close();
  }, 120_000);
});

describe('Phase 7 long-run soak: backup outcomes', () => {
  it('records a verifiable backup, alerts on failure, and clears when the next backup succeeds', async () => {
    const dir = await makeProjectDir();
    const clock = new ManualClock();
    const runtime = await openRuntime(dir, { clock, recover: false });
    const run = await createDemoRun(runtime, 'soak backup');

    // --- successful backup: snapshot + config + manifest all verify --------
    const first = await runProjectBackup(dir, { now: clock.now() });
    expect(first.status).toBe('ok');
    expect(first.dir).toBe(`.research/backups/b-${clock.now()}`);
    const backupRoot = join(dir, first.dir!);
    const manifest = JSON.parse(await readFile(join(backupRoot, 'manifest.json'), 'utf8')) as {
      files: { path: string; sha256: `sha256:${string}` }[];
    };
    expect(manifest.files.map((entry) => entry.path).sort()).toEqual([
      'research.yaml',
      'workflow.db',
    ]);
    for (const entry of manifest.files) {
      expect(await verifyFileHash(join(backupRoot, entry.path), entry.sha256)).toBe(true);
    }

    // The snapshot is a real, queryable DB containing this run.
    const snapshot = new DatabaseSync(join(backupRoot, 'workflow.db'), { readOnly: true });
    try {
      const row = snapshot
        .prepare('SELECT COUNT(*) AS c FROM run WHERE run_id = ?')
        .get(run.runId) as { c: number };
      expect(row.c).toBe(1);
    } finally {
      snapshot.close();
    }
    expect((await listBackupRecords(dir)).map((record) => record.status)).toEqual(['ok']);

    // --- failure injection: a blocking file sits at the next backup id -----
    const failedAt = clock.advance(1_000);
    await mkdir(join(dir, '.research', 'backups'), { recursive: true });
    await writeFile(join(dir, '.research', 'backups', `b-${failedAt}`), 'blocker', 'utf8');
    const failed = await runProjectBackup(dir, { now: failedAt });
    expect(failed.status).toBe('failed');
    expect(failed.error).toBeTruthy();
    expect((await readLatestBackup(dir))?.status).toBe('failed');

    const eventsBefore = (await runtime.db.listEvents(run.runId, { limit: 10_000 })).length;
    const alerts = await collectRuntimeAlerts(dir, { probe: null, liveness: false });
    const backupAlert = alerts.alerts.find((alert) => alert.kind === 'backup-failed')!;
    expect(backupAlert.severity).toBe('critical');
    expect(backupAlert.facts.at).toBe(failedAt);
    expect(String(backupAlert.facts.error).length).toBeGreaterThan(0);
    // Backup failure is a fact about the backup — the run is untouched.
    expect((await runtime.db.getRun(run.runId))?.status).toBe('RUNNING');
    expect((await runtime.db.listEvents(run.runId, { limit: 10_000 })).length).toBe(eventsBefore);

    // --- recovery: next backup succeeds → the alert clears -----------------
    const recoveredAt = clock.advance(1_000);
    const recovered = await runProjectBackup(dir, { now: recoveredAt });
    expect(recovered.status).toBe('ok');
    const after = await collectRuntimeAlerts(dir, { probe: null, liveness: false });
    expect(after.alerts).toEqual([]);
    expect((await listBackupRecords(dir)).map((record) => record.status)).toEqual([
      'ok',
      'failed',
      'ok',
    ]);

    await runtime.close();
  }, 120_000);
});

describe('Phase 7 long-run soak: machine restart + session recovery + checkpoint', () => {
  it('rebuilds context from persisted state and keeps the checkpoint resume-compatible', async () => {
    const dir = await makeProjectDir();
    const clock = new ManualClock();

    // --- process 1: commit one artifact, park an in-flight checkpoint ------
    const runtime = await openRuntime(dir, { clock, recover: false });
    const run = await createDemoRun(runtime, 'soak session');
    const task = await runtime.db.claimNextTask(run.runId, 'sess-w', LEASE);
    await runtime.db.markTaskStarted(task!.taskId, 'sess-w');
    const staged = await runtime.store.stage('input-manifest', '{"session":"soak"}');
    const begin = await runtime.db.beginCommit({
      taskId: task!.taskId,
      workerId: 'sess-w',
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
      result: { summary: 'committed before the machine died', artifacts: [] },
    });
    expect(begin.status).toBe('accepted');
    await runtime.db.finalizeCommit({ taskId: task!.taskId, workerId: 'sess-w' });

    const ckSpec: ExperimentSpec = {
      ...soakSpec(),
      specId: 'idea-ck-soak',
      environment: { python: 'v24', notes: ['scale:smoke'] },
    };
    const codeHash = sha256Of('soak code snapshot');
    const manifest = buildCheckpointManifest(
      { checkpointId: 'ckpt-soak', step: 40, epoch: 2, files: [{ path: 'model.pt' }] },
      ckSpec,
      codeHash,
    );
    const expDir = join(dir, 'ideas', 'soak-idea', 'experiments');
    await mkdir(expDir, { recursive: true });
    await writeFile(
      join(expDir, 'progress-idea-ck-soak.json'),
      JSON.stringify(
        {
          specId: 'idea-ck-soak',
          recovery: 'checkpoint',
          policy: { kind: 'steps', every: 5 },
          heartbeat: { step: 40, epoch: 2, checkpointId: 'ckpt-soak', at: clock.now() },
          checkpoints: [manifest],
          resumeHint: { checkpointId: 'ckpt-soak', compatible: true, mismatches: [] },
          interrupt: null,
          updatedAt: clock.now(),
        },
        null,
        2,
      ),
      'utf8',
    );
    await runtime.db.upsertExperiment({
      specId: 'idea-ck-soak',
      version: 1,
      specHash: 'sha256:ck',
      status: 'planned',
      spec: ckSpec as unknown as Record<string, unknown>,
      result: null,
      updatedAt: clock.now(),
    });
    await runtime.close();

    // The session died with the machine: started marker, never ended.
    await writeFile(
      join(dir, '.research', 'last-session.json'),
      JSON.stringify({ pid: 4194303, startedAt: Date.now() - 60_000 }, null, 2),
      'utf8',
    );

    // --- machine restart: fresh open runs recovery + node projection -------
    const reopened = await openRuntime(dir, { clock });
    expect(reopened.recovery.reclaimedLeases).toEqual([]); // nothing leased
    await reopened.close();

    // --- context rebuilt purely from persisted state (ADR-002) -------------
    const context = await collectContext(dir);
    expect(context.previousSession).not.toBeNull();
    expect(context.previousSession!.endedCleanly).toBe(false); // crashed
    expect(context.run?.runId).toBe(run.runId);
    expect(context.run?.status).toBe('RUNNING');
    expect(context.lastEvents.length).toBeGreaterThan(0);
    expect(
      context.artifacts.some(
        (artifact) => artifact.kind === 'input-manifest' && artifact.hash.startsWith('sha256:'),
      ),
    ).toBe(true); // committed artifact visible after restart

    // --- checkpoint facts survive: resume still compatible, drift blocks ---
    const progress = JSON.parse(
      await readFile(join(expDir, 'progress-idea-ck-soak.json'), 'utf8'),
    ) as {
      checkpoints: CheckpointManifest[];
      resumeHint: { checkpointId: string; compatible: boolean } | null;
    };
    expect(progress.checkpoints[0]!.checkpointId).toBe('ckpt-soak');
    expect(progress.resumeHint?.compatible).toBe(true);
    const current = {
      codeHash,
      protocolId: ckSpec.protocolId,
      dataSnapshotId: ckSpec.dataSnapshotId,
      configHash: computeSpecConfigHash(ckSpec),
    };
    expect(validateCheckpointCompatibility(progress.checkpoints[0]!, current)).toEqual({
      compatible: true,
      mismatches: [],
    });
    const drifted = validateCheckpointCompatibility(progress.checkpoints[0]!, {
      ...current,
      codeHash: sha256Of('changed code'),
    });
    expect(drifted.compatible).toBe(false);
    expect(drifted.mismatches).toContain('code changed since the checkpoint');

    // Fresh heartbeat → watchdog sees no stall after the restart
    // (checked on the same accelerated clock the heartbeat was written with).
    const wd = await detectWatchdog(dir, { now: clock.now() });
    expect(wd.healthy).toBe(true);

    // --- the new session ends cleanly; the marker records it ---------------
    const marker = JSON.parse(
      await readFile(join(dir, '.research', 'last-session.json'), 'utf8'),
    ) as { pid: number; startedAt: number };
    await writeSessionEnd(dir, true); // no-op: marker pid ≠ this process
    expect(
      (await readFile(join(dir, '.research', 'last-session.json'), 'utf8')).includes('"endedAt"'),
    ).toBe(false);
    await writeFile(
      join(dir, '.research', 'last-session.json'),
      JSON.stringify({ ...marker, endedAt: Date.now(), clean: true }, null, 2),
      'utf8',
    );
    const afterClean = await collectContext(dir);
    expect(afterClean.previousSession!.endedCleanly).toBe(true);
  }, 120_000);
});
