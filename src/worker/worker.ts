import { IdeaseekError, isIdeaseekError } from '../core/errors.js';
import { isHarnessBlockError } from '../dsh/adapter.js';
import { newId } from '../core/ids.js';
import type { StagedArtifact } from '../artifact/store.js';
import type { ProjectRuntime } from '../workflow/runtime.js';
import type { RunStatus, TaskRecord, WorkerRecord } from '../workflow/types.js';
import { isAbortError, sleep } from './handlers.js';
import type { HandlerOutput, TaskContext, TaskHandler } from './types.js';

export type WorkerExitReason =
  'completed' | 'failed' | 'canceled' | 'paused' | 'blocked' | 'idle' | 'stopped';

export interface WorkerExit {
  reason: WorkerExitReason;
  runStatus: RunStatus;
  processed: number;
  runId: string;
}

export interface FakeWorkerOptions {
  runtime: ProjectRuntime;
  runId: string;
  workerId?: string;
  kind?: WorkerRecord['kind'];
  leaseMs?: number;
  heartbeatMs?: number;
  pollMs?: number;
  /** Stop after this many executed tasks (tests; default: run until exit). */
  maxTasks?: number;
  /** Standalone workers exit after this much claimable-idle time. */
  idleExitMs?: number;
  handlers: Record<string, TaskHandler>;
  /** External stop signal: first SIGINT stops new claims (soft pause). */
  signal?: AbortSignal;
  onLog?: (message: string) => void;
}

/**
 * The Phase 0 fake worker: claims tasks under a lease, heartbeats while
 * executing, stages output through the artifact store and commits with the
 * two-phase idempotent protocol. Crash/fault behavior is driven by task
 * payloads (see `FaultSpec`), never by deleting recovery checks.
 */
export class FakeWorker {
  readonly workerId: string;
  private readonly runtime: ProjectRuntime;
  private readonly runId: string;
  private readonly kind: WorkerRecord['kind'];
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly pollMs: number;
  private readonly maxTasks: number | undefined;
  private readonly idleExitMs: number | undefined;
  private readonly handlers: Record<string, TaskHandler>;
  private readonly onLog: (message: string) => void;
  /** Internal stop flag; mirrors the external signal if one was provided. */
  private readonly stop = new AbortController();
  private currentTask: TaskRecord | null = null;
  private taskController: AbortController | null = null;
  private lostLease = false;

  constructor(options: FakeWorkerOptions) {
    const runtime = options.runtime;
    this.runtime = runtime;
    this.runId = options.runId;
    this.workerId = options.workerId ?? newId('worker');
    this.kind = options.kind ?? 'standalone';
    this.leaseMs = options.leaseMs ?? runtime.config.runtime.leaseTtlSeconds * 1000;
    this.heartbeatMs =
      options.heartbeatMs ?? Math.max(250, runtime.config.runtime.heartbeatIntervalSeconds * 1000);
    this.pollMs = options.pollMs ?? runtime.config.runtime.workerPollMs;
    this.maxTasks = options.maxTasks;
    this.idleExitMs = options.idleExitMs;
    this.handlers = options.handlers;
    this.onLog = options.onLog ?? (() => undefined);
    if (options.signal) {
      if (options.signal.aborted) this.stop.abort();
      else options.signal.addEventListener('abort', () => this.stop.abort(), { once: true });
    }
  }

  async run(): Promise<WorkerExit> {
    const { runtime, runId } = this;
    await runtime.db.registerWorker({
      workerId: this.workerId,
      runId,
      pid: process.pid,
      kind: this.kind,
    });
    let processed = 0;
    let idleSince: number | null = null;

    try {
      for (;;) {
        if (this.stop.signal.aborted || this.lostLease) break;
        const run = await runtime.db.getRun(runId);
        if (!run) break;
        if (run.status !== 'RUNNING') break;

        const task = await runtime.db.claimNextTask(runId, this.workerId, {
          leaseMs: this.leaseMs,
        });
        if (!task) {
          const tasks = await runtime.db.listTasks(runId);
          const unfinished = tasks.filter((t) =>
            ['queued', 'leased', 'running', 'committing'].includes(t.status),
          );
          if (unfinished.length === 0) break;
          idleSince ??= runtime.clock.now();
          if (this.idleExitMs !== undefined && runtime.clock.now() - idleSince >= this.idleExitMs) {
            break;
          }
          try {
            await sleep(this.pollMs, this.stop.signal);
          } catch {
            break; // external stop requested while idle
          }
          continue;
        }
        idleSince = null;
        this.onLog(`claimed ${task.type} attempt=${task.attempt}/${task.maxAttempts}`);
        await this.execute(task);
        processed += 1;
        if (this.maxTasks !== undefined && processed >= this.maxTasks) break;
      }
    } finally {
      await runtime.db.deregisterWorker(this.workerId).catch(() => undefined);
    }

    const run = await runtime.db.getRun(runId);
    const runStatus = run?.status ?? 'CANCELED';
    return { reason: exitReasonFor(runStatus), runStatus, processed, runId };
  }

  /**
   * Hard stop: stops claiming and aborts the in-flight task at its next
   * checkpoint. Callers should `pauseRun({hard: true})` first so the abort is
   * acked as `pause` (requeue) rather than `cancel`.
   */
  hardStop(): void {
    this.stop.abort();
    this.taskController?.abort();
  }

  private async execute(task: TaskRecord): Promise<void> {
    const { runtime, runId } = this;
    let staged: StagedArtifact[] = [];
    const controller = new AbortController();
    this.currentTask = task;
    this.taskController = controller;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    try {
      await runtime.db.markTaskStarted(task.taskId, this.workerId);
      const run = await runtime.db.getRun(runId);
      if (!run) throw new IdeaseekError('RUN_NOT_FOUND', `run ${runId} disappeared`);

      heartbeatTimer = setInterval(() => {
        void this.beat(task, controller);
      }, this.heartbeatMs);

      const handler = this.handlers[task.type];
      if (!handler) {
        const error = new IdeaseekError(
          'INVALID_ARGUMENT',
          `no handler registered for task type ${task.type}`,
        );
        (error as IdeaseekError & { permanent?: boolean }).permanent = true;
        throw error;
      }

      const ctx: TaskContext = {
        task,
        run,
        payload: task.payload,
        signal: controller.signal,
        runtime,
        log: (message) => this.onLog(`${task.type}: ${message}`),
      };
      const output: HandlerOutput = await handler(ctx);
      if (output.artifacts.length === 0) {
        throw new IdeaseekError('INVALID_ARTIFACT', `handler ${task.type} produced no artifacts`);
      }

      for (const artifact of output.artifacts) {
        staged.push(await runtime.store.stage(artifact.kind, artifact.data, artifact.meta ?? {}));
      }
      if (task.payload.interruptStage === true) {
        // Fault: bytes are on disk (temp) but the commit never starts.
        process.exit(7);
      }

      const outcome = await runtime.commitTask({
        taskId: task.taskId,
        workerId: this.workerId,
        attempt: task.attempt,
        staged,
        result: { summary: output.summary, data: output.data },
      });
      staged = []; // ownership transferred (or discarded) by commit
      this.onLog(
        outcome.status === 'duplicate'
          ? `${task.type} duplicate commit ignored`
          : `${task.type} committed`,
      );
    } catch (error) {
      await this.handleTaskError(task, error, staged, controller);
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      this.currentTask = null;
      this.taskController = null;
    }
  }

  private async beat(task: TaskRecord, controller: AbortController): Promise<void> {
    if (this.currentTask?.taskId !== task.taskId) return;
    try {
      await this.runtime.db.heartbeatWorker(this.workerId);
      const result = await this.runtime.db.heartbeat(task.taskId, this.workerId, {
        leaseMs: this.leaseMs,
      });
      if (result.cancelRequested) controller.abort();
    } catch (error) {
      if (isIdeaseekError(error) && error.code === 'LEASE_LOST') {
        this.lostLease = true;
        controller.abort();
      }
      // Transient heartbeat errors are retried on the next tick.
    }
  }

  private async handleTaskError(
    task: TaskRecord,
    error: unknown,
    staged: StagedArtifact[],
    controller: AbortController,
  ): Promise<void> {
    const { runtime } = this;

    // Ownership of temp files ends here on every failure path.
    const cleanup = async () => {
      await runtime.store.discard(staged).catch(() => undefined);
    };

    if (isAbortError(error) || controller.signal.aborted) {
      await cleanup();
      try {
        const run = await runtime.db.getRun(task.runId);
        const reason: 'cancel' | 'pause' = run?.status === 'PAUSED' ? 'pause' : 'cancel';
        await runtime.db.ackCancel(task.taskId, this.workerId, reason);
        this.onLog(`${task.type} acked ${reason}`);
      } catch (ackError) {
        this.onLog(`${task.type} cancel ack failed: ${(ackError as Error).message}`);
      }
      return;
    }

    if (isHarnessBlockError(error)) {
      // Quota/auth/network are external conditions: park the run without
      // burning the task attempt (docs/WORKFLOW_SPEC.md §QUOTA_EXHAUSTED).
      await cleanup();
      await runtime.db.blockExternal(
        task.taskId,
        this.workerId,
        {
          code: error.block,
          message: error.message.slice(0, 500),
          retryable: true,
          at: runtime.clock.now(),
        },
        error.block,
      );
      this.onLog(`${task.type} blocked: ${error.block}`);
      return;
    }

    if (isIdeaseekError(error)) {
      if (error.code === 'LEASE_LOST' || error.code === 'STALE_ATTEMPT') {
        await cleanup();
        this.lostLease = error.code === 'LEASE_LOST';
        this.onLog(`${task.type} lost its lease (${error.code})`);
        return;
      }
      if (error.code === 'TASK_CANCELED') {
        await cleanup();
        const run = await runtime.db.getRun(task.runId);
        const reason: 'cancel' | 'pause' = run?.status === 'PAUSED' ? 'pause' : 'cancel';
        await runtime.db.ackCancel(task.taskId, this.workerId, reason).catch(() => undefined);
        return;
      }
      if (
        error.code === 'QUOTA_EXHAUSTED' ||
        error.code === 'AUTH_REQUIRED' ||
        error.code === 'NETWORK_BLOCKED'
      ) {
        await cleanup();
        await runtime.db.blockExternal(
          task.taskId,
          this.workerId,
          {
            code: error.code,
            message: error.message,
            retryable: true,
            at: runtime.clock.now(),
          },
          error.code,
        );
        this.onLog(`${task.type} blocked: ${error.code}`);
        return;
      }
      const permanent = (error as IdeaseekError & { permanent?: boolean }).permanent === true;
      await cleanup();
      const result = await runtime.db.failAttempt(task.taskId, this.workerId, {
        code: error.code,
        message: error.message.slice(0, 500),
        retryable: !permanent,
        at: runtime.clock.now(),
      });
      // Advance the clock past the exponential backoff so the retry is
      // claimable. In production the real clock advances naturally; in tests
      // with ManualClock it would otherwise block the retry forever.
      if (result.willRetry) {
        const backoffMs = Math.min(1000 * Math.pow(2, result.task.attempt - 1), 60_000);
        const clock = runtime.clock as { advance?: (ms: number) => void };
        if (typeof clock.advance === 'function') {
          clock.advance(backoffMs + 1);
        }
      }
      this.onLog(`${task.type} failed (${error.code}), retry=${result.willRetry}`);
      return;
    }

    const failure = error as Error & { permanent?: boolean };
    await cleanup();
    const result = await runtime.db.failAttempt(task.taskId, this.workerId, {
      code: failure.name === 'AbortError' ? 'ABORTED' : 'WORKER_ERROR',
      message: (failure.message ?? String(error)).slice(0, 500),
      retryable: !failure.permanent,
      at: runtime.clock.now(),
    });
    if (result.willRetry) {
      const backoffMs = Math.min(1000 * Math.pow(2, result.task.attempt - 1), 60_000);
      const clock = runtime.clock as { advance?: (ms: number) => void };
      if (typeof clock.advance === 'function') {
        clock.advance(backoffMs + 1);
      }
    }
    this.onLog(`${task.type} failed (${failure.message}), retry=${result.willRetry}`);
  }
}

function exitReasonFor(status: RunStatus): WorkerExitReason {
  switch (status) {
    case 'COMPLETED':
      return 'completed';
    case 'FAILED':
      return 'failed';
    case 'CANCELED':
      return 'canceled';
    case 'PAUSED':
      return 'paused';
    case 'QUOTA_EXHAUSTED':
    case 'AUTH_REQUIRED':
    case 'NETWORK_BLOCKED':
    case 'FAILED_RECOVERABLE':
      return 'blocked';
    default:
      return 'stopped';
  }
}
