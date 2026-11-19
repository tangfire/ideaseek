import type { Clock } from '../core/clock.js';
import type { HarnessAdapter } from '../dsh/adapter.js';
import { systemClock } from '../core/clock.js';
import { IdeaseekError } from '../core/errors.js';
import { ArtifactStore, type StagedArtifact } from '../artifact/store.js';
import { loadConfig, type LoadedConfig, type ResolvedConfig } from '../config/config.js';
import { findProjectRoot, projectPaths, type ProjectPaths } from '../config/paths.js';
import type { ProjectRecord, WorkflowDb } from './db.js';
import { SqliteWorkflowDb } from './sqlite.js';
import type { CommitOutcome, RecoveryReport, StagedArtifactInput } from './types.js';
import { emptyRecoveryReport } from './types.js';
import {
  emptyResearchSyncReport,
  syncResearchRun,
  type ResearchSyncReport,
} from './research-run.js';

export interface OpenRuntimeOptions {
  cwd: string;
  clock?: Clock;
  /** Override temp-file staleness; tests shrink it, defaults are production-safe. */
  staleTempMs?: number;
  /** Worker rows idle longer than this are marked stopped during recovery. */
  workerStaleMs?: number;
  /** Skip the recovery scan (only for tests that orchestrate it manually). */
  recover?: boolean;
  /**
   * Agent runtime used by harness-backed task handlers (Phase 1+). Optional:
   * Phase 0 demo tasks never touch it. Injected rather than constructed so
   * tests run the FakeHarnessAdapter and deployments can pin a DSH adapter.
   */
  harness?: HarnessAdapter;
}

export interface CommitTaskInput {
  taskId: string;
  workerId: string;
  attempt: number;
  staged: StagedArtifact[];
  result: { summary: string; data?: Record<string, unknown> };
}

/**
 * Project-scoped session over the workflow DB + artifact store. Opening a
 * runtime always runs recovery unless disabled: expired leases return to the
 * queue, interrupted commits are resumed or requeued, stale worker rows are
 * stopped and orphaned temp files are cleaned. This is what makes every CLI
 * invocation a restart-safe checkpoint boundary.
 */
export class ProjectRuntime {
  readonly paths: ProjectPaths;
  readonly config: ResolvedConfig;
  readonly configLoad: LoadedConfig;
  readonly db: WorkflowDb;
  readonly store: ArtifactStore;
  readonly project: ProjectRecord;
  readonly clock: Clock;
  /** Agent runtime for harness-backed tasks; null in pure Phase 0 usage. */
  readonly harness: HarnessAdapter | null;
  /** Filled by {@link recover}; starts empty until the first recovery run. */
  recovery: RecoveryReport;
  /** Filled by {@link syncResearchNodes}; null until the first sync attempt. */
  researchSync: ResearchSyncReport | null;

  private constructor(args: {
    paths: ProjectPaths;
    configLoad: LoadedConfig;
    db: WorkflowDb;
    store: ArtifactStore;
    project: ProjectRecord;
    clock: Clock;
    recovery: RecoveryReport;
    harness: HarnessAdapter | null;
  }) {
    this.paths = args.paths;
    this.configLoad = args.configLoad;
    this.config = args.configLoad.resolved;
    this.db = args.db;
    this.store = args.store;
    this.project = args.project;
    this.clock = args.clock;
    this.recovery = args.recovery;
    this.harness = args.harness;
    this.researchSync = null;
  }

  static async open(opts: OpenRuntimeOptions): Promise<ProjectRuntime> {
    const root = await findProjectRoot(opts.cwd);
    if (!root) {
      throw new IdeaseekError(
        'NOT_INITIALIZED',
        `no IdeaSeek project found from ${opts.cwd}; run: ideaseek init`,
      );
    }
    const paths = projectPaths(root);
    const clock = opts.clock ?? systemClock;
    const configLoad = await loadConfig(paths, paths.root.split(/[\\/]/).pop() ?? 'project');
    const db = new SqliteWorkflowDb(paths.dbFile, { clock });
    const project = await db.ensureProject({ root, name: configLoad.resolved.project.name });
    const store = new ArtifactStore({
      artifactsDir: paths.artifactsDir,
      tmpDir: paths.artifactTmpDir,
      staleTempMs: opts.staleTempMs ?? 60_000,
    });
    // Harness startup is lazy: only harness-backed tasks spawn the runtime,
    // so demo-only commands never pay for a DSH subprocess. Usage
    // recording (cost telemetry, PROGRESS 212) wraps at the composition
    // root — buildHarness — so CLI-direct harness callers are covered too.
    const runtime = new ProjectRuntime({
      paths,
      configLoad,
      db,
      store,
      project,
      clock,
      recovery: emptyRecoveryReport(),
      harness: opts.harness ?? null,
    });
    if (opts.recover !== false) {
      await runtime.recover(opts.workerStaleMs);
      await runtime.syncResearchNodes();
    }
    return runtime;
  }

  /**
   * Projects durable research state (rounds, experiment registry, analysis
   * files) into this run's ResearchRun node graph (docs/LONG_RUNNING_WORKFLOWS).
   * Idempotent — succeeded nodes are never reset and unchanged sources append
   * no events. Called on every recovery-enabled open so each CLI invocation is
   * a checkpoint boundary for the node ledger; returns a skipped report when
   * no run exists yet.
   */
  async syncResearchNodes(): Promise<ResearchSyncReport> {
    const run = await this.db.getLatestRun(this.project.id);
    if (!run) {
      this.researchSync = emptyResearchSyncReport();
      return this.researchSync;
    }
    this.researchSync = await syncResearchRun(this.db, run.runId, this.paths.root);
    return this.researchSync;
  }

  /** Lease/worker/commit/temp recovery; safe to run concurrently and repeatedly. */
  async recover(workerStaleMs?: number): Promise<RecoveryReport> {
    const report = emptyRecoveryReport();
    const affectedRuns = new Set<string>();

    const reclaim = await this.db.reclaimExpiredLeases();
    report.reclaimedLeases = reclaim.reclaimed;
    report.failedExhausted = reclaim.failed;
    report.canceledAfterExpiry = reclaim.canceled;
    for (const taskId of [...reclaim.reclaimed, ...reclaim.failed, ...reclaim.canceled]) {
      const task = await this.db.getTask(taskId);
      if (task) affectedRuns.add(task.runId);
    }

    const staleWorkers = await this.db.stopStaleWorkers(
      workerStaleMs ?? this.config.runtime.leaseTtlSeconds * 3000,
    );
    report.stoppedWorkers = staleWorkers;

    // Age-based sweep, but temps owned by a live staged row are never
    // touched — the row (not the clock) is what says "still in use"
    // (design review #11: deleting a >60s-old multi-GB temp mid-promote
    // made promote fail and the task requeue forever).
    report.staleTempsRemoved = await this.store.cleanupStaleTemps(
      this.clock.now(),
      await this.db.listStagedTempPaths(),
    );

    const stranded = await this.db.recoverStrandedRuns();
    for (const runId of stranded.settled) {
      affectedRuns.add(runId);
      report.settledRuns.push(runId);
    }

    const interrupted = await this.db.listInterruptedCommits();
    for (const task of interrupted) {
      affectedRuns.add(task.runId);
      const artifacts = await this.db.listArtifacts(task.taskId);
      const staged = artifacts.filter((artifact) => artifact.status === 'staged');
      let allPresent = staged.length > 0;
      for (const artifact of staged) {
        if (!artifact.tempPath) {
          allPresent = false;
          break;
        }
        const outcome = await this.store.ensureCommittedFile(
          artifact.tempPath,
          artifact.contentHash,
        );
        if (outcome === 'missing') {
          allPresent = false;
          break;
        }
      }
      if (allPresent) {
        await this.db.recoverInterruptedCommit(task.taskId, 'finalize');
        report.resumedCommits.push(task.taskId);
      } else {
        await this.db.recoverInterruptedCommit(task.taskId, 'requeue');
        report.abandonedCommits.push(task.taskId);
      }
    }

    const hadWork =
      report.reclaimedLeases.length > 0 ||
      report.failedExhausted.length > 0 ||
      report.canceledAfterExpiry.length > 0 ||
      report.resumedCommits.length > 0 ||
      report.abandonedCommits.length > 0 ||
      report.stoppedWorkers.length > 0 ||
      report.staleTempsRemoved.length > 0;
    this.recovery = report;
    if (hadWork) {
      for (const runId of affectedRuns) {
        const parts: string[] = [];
        if (report.reclaimedLeases.length)
          parts.push(`${report.reclaimedLeases.length} lease(s) reclaimed`);
        if (report.failedExhausted.length)
          parts.push(`${report.failedExhausted.length} task(s) failed after lease expiry`);
        if (report.canceledAfterExpiry.length)
          parts.push(`${report.canceledAfterExpiry.length} canceled task(s) finalized`);
        if (report.resumedCommits.length)
          parts.push(`${report.resumedCommits.length} interrupted commit(s) completed`);
        if (report.abandonedCommits.length)
          parts.push(`${report.abandonedCommits.length} interrupted commit(s) requeued`);
        if (report.stoppedWorkers.length)
          parts.push(`${report.stoppedWorkers.length} stale worker(s) stopped`);
        if (report.staleTempsRemoved.length)
          parts.push(`${report.staleTempsRemoved.length} temp file(s) removed`);
        await this.db.appendEvent({
          runId,
          phase: 'INIT',
          eventType: 'recovery',
          summary: `recovery on open: ${parts.join('; ')}`,
        });
        report.eventsAppended += 1;
      }
    }
    return report;
  }

  /**
   * Two-phase idempotent commit: stage rows in the DB, promote files with
   * hash verification, then finalize. A repeat submit of identical output
   * returns `duplicate` without touching state; different output on an
   * already-succeeded task is rejected.
   */
  async commitTask(input: CommitTaskInput): Promise<CommitOutcome> {
    const stagedInputs: StagedArtifactInput[] = input.staged.map((artifact) => ({
      kind: artifact.kind,
      tempPath: artifact.tempPath,
      contentHash: artifact.contentHash,
      size: artifact.size,
      meta: artifact.meta,
    }));
    const begin = await this.db.beginCommit({
      taskId: input.taskId,
      workerId: input.workerId,
      attempt: input.attempt,
      artifacts: stagedInputs,
      result: { summary: input.result.summary, artifacts: [] },
    });
    if (begin.status === 'duplicate') {
      await this.store.discard(input.staged);
      return { status: 'duplicate', task: begin.task, artifactIds: begin.artifactIds };
    }
    await this.store.promote(input.staged);
    return this.db.finalizeCommit({
      taskId: input.taskId,
      workerId: input.workerId,
    });
  }

  async close(): Promise<void> {
    await this.db.close();
    if (this.harness) await this.harness.shutdown().catch(() => undefined);
  }
}
