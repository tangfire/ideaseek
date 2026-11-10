import type { Command } from 'commander';
import { IdeaseekError, exitCodeForError } from '../core/errors.js';
import type { LoadedConfig } from '../config/config.js';
import type { HarnessAdapter } from '../dsh/adapter.js';
import { FakeHarnessAdapter } from '../dsh/fake-adapter.js';
import { DshHarnessAdapter } from '../dsh/dsh-adapter.js';
import { projectPaths } from '../config/paths.js';
import { join } from 'node:path';
import { demoHandlers } from '../worker/handlers.js';
import { paperExtract, paperParse } from '../worker/paper-handlers.js';
import type { TaskHandler } from '../worker/types.js';
import type { ProjectRuntime } from '../workflow/runtime.js';
import type { RunRecord, TaskRecord, RunStatus } from '../workflow/types.js';
import { BLOCKED_RUN_STATUSES, TERMINAL_RUN_STATUSES } from '../workflow/types.js';
import { FakeWorker, type FakeWorkerOptions, type WorkerExit } from '../worker/worker.js';
import type { FaultSpec } from '../worker/types.js';

/** Wraps an action so IdeaseekError maps to CLI exit codes (docs/CLI_SPEC.md). */
export function action<Args extends unknown[]>(
  fn: (...args: Args) => Promise<number | void>,
): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    try {
      const code = await fn(...args);
      process.exitCode = code ?? 0;
    } catch (error) {
      if (error instanceof IdeaseekError) {
        process.stderr.write(`error: [${error.code}] ${error.message}\n`);
        process.exitCode = exitCodeForError(error);
      } else {
        process.stderr.write(`error: ${(error as Error).stack ?? String(error)}\n`);
        process.exitCode = 1;
      }
    }
  };
}

/**
 * `run`/`worker` must not start on a broken research.yaml (CONFIG_SPEC:
 * unknown or invalid fields warn and refuse to run instead of becoming
 * silent defaults).
 */
export function assertConfigUsable(config: LoadedConfig): void {
  if (config.errors.length > 0) {
    throw new IdeaseekError(
      'USER_INPUT_REQUIRED',
      `research.yaml has ${config.errors.length} blocking problem(s); run: ideaseek config explain — first: ${config.errors[0]}`,
    );
  }
}

export async function resolveRun(runtime: ProjectRuntime, runArg?: string): Promise<RunRecord> {
  if (runArg) {
    const run = await runtime.db.getRun(runArg);
    if (!run) throw new IdeaseekError('RUN_NOT_FOUND', `run ${runArg} not found`);
    return run;
  }
  const latest = await runtime.db.getLatestRun(runtime.project.id);
  if (!latest) {
    throw new IdeaseekError(
      'RUN_NOT_FOUND',
      'no run exists yet; create one with: ideaseek run --question "..."',
    );
  }
  return latest;
}

export function isTerminalRun(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export function isBlockedRun(status: RunStatus): boolean {
  return BLOCKED_RUN_STATUSES.includes(status);
}

export function countByStatus(tasks: TaskRecord[]): Record<string, number> {
  const counts: Record<string, number> = {
    queued: 0,
    leased: 0,
    running: 0,
    committing: 0,
    succeeded: 0,
    failed: 0,
    canceled: 0,
  };
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
  return counts;
}

/** `--fault '{"demo.analyze":{"crash":true}}'` → per-task-type fault map. */
export function parseFaultSpec(spec: string | undefined): Record<string, FaultSpec> {
  if (!spec) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(spec);
  } catch (error) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `--fault must be JSON: ${(error as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new IdeaseekError('INVALID_ARGUMENT', '--fault must be a JSON object keyed by task type');
  }
  for (const [type, value] of Object.entries(parsed)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new IdeaseekError('INVALID_ARGUMENT', `--fault entry for ${type} must be an object`);
    }
  }
  return parsed as Record<string, FaultSpec>;
}

/**
 * Phase 0 demo pipeline: ingest → analyze → report, with dependencies so
 * resume/partial-failure semantics are exercised. Idempotency keys are
 * deterministic, so re-enqueueing on an adopted run is a no-op.
 */
export async function enqueueDemoPipeline(
  runtime: ProjectRuntime,
  run: RunRecord,
  question: string,
  faults: Record<string, FaultSpec>,
): Promise<TaskRecord[]> {
  const maxAttempts = runtime.config.runtime.maxAttempts;
  const specs: { type: string; deps: string[] }[] = [
    { type: 'demo.ingest', deps: [] },
    { type: 'demo.analyze', deps: [] },
    { type: 'demo.report', deps: [] },
  ];
  const created: TaskRecord[] = [];
  let previousId = '';
  for (const spec of specs) {
    const deps = previousId ? [previousId] : [];
    const { task } = await runtime.db.enqueueTask({
      runId: run.runId,
      type: spec.type,
      phase: 'DEMO',
      payload: { question, fault: faults[spec.type] },
      dependsOn: deps,
      idempotencyKey: `${spec.type}:v1`,
      maxAttempts,
    });
    created.push(task);
    previousId = task.taskId;
  }
  await runtime.db.setRunPhase(run.runId, 'DEMO');
  return created;
}

export interface InteractiveWorkerResult {
  exit: WorkerExit;
  sigints: number;
  pausedBySignal: boolean;
}

/**
 * Runs a worker with Ctrl-C semantics: first SIGINT stops new claims and
 * pauses after the in-flight task checkpoints (soft); second SIGINT hard-pauses
 * (task aborts and requeues). SIGINT delivery is emulated by tests via the
 * exported handler-independent helpers, because Windows cannot deliver SIGINT
 * to child processes.
 */
export async function runWorkerInteractive(
  runtime: ProjectRuntime,
  runId: string,
  options: Omit<FakeWorkerOptions, 'runId' | 'runtime' | 'signal'>,
): Promise<InteractiveWorkerResult> {
  const controller = new AbortController();
  let sigints = 0;
  let worker: FakeWorker | null = null;
  const onSigint = () => {
    sigints += 1;
    if (sigints === 1) {
      controller.abort();
    } else if (worker) {
      void runtime.db
        .pauseRun(runId, { hard: true })
        .catch(() => undefined)
        .then(() => worker?.hardStop());
    }
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigint);
  worker = new FakeWorker({ ...options, runId, runtime, signal: controller.signal });
  try {
    let exit = await worker.run();
    let pausedBySignal = false;
    if (exit.runStatus === 'RUNNING' && controller.signal.aborted) {
      await runtime.db.pauseRun(runId, { hard: sigints > 1 });
      const after = await runtime.db.getRun(runId);
      exit = { ...exit, reason: 'paused', runStatus: after?.status ?? 'PAUSED' };
      pausedBySignal = true;
    }
    return { exit, sigints, pausedBySignal };
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigint);
  }
}

/** Builds the agent harness for CLI commands (Phase 1: fake only). */
export function buildHarness(kind: string | undefined): HarnessAdapter {
  const selected = kind ?? 'fake';
  if (selected === 'fake') return new FakeHarnessAdapter();
  if (selected === 'dsh') {
    const researchDir = projectPaths(process.cwd()).researchDir;
    return new DshHarnessAdapter({
      dshHome: join(researchDir, 'dsh-home'),
      cwd: process.cwd(),
    });
  }
  throw new IdeaseekError('INVALID_ARGUMENT', `unknown harness kind: ${selected}`);
}

/** Worker handler registry: demo pipeline + harness-backed paper extractor. */
export function buildHandlers(): Record<string, TaskHandler> {
  return { ...demoHandlers, 'paper.parse': paperParse, 'paper.extract': paperExtract };
}

export function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function formatTaskLine(task: TaskRecord): string {
  const attempt = `${task.attempt}/${task.maxAttempts}`;
  const lease = task.leaseExpiresAt ? ` lease→${new Date(task.leaseExpiresAt).toISOString()}` : '';
  const error = task.error ? ` error=${task.error.code}` : '';
  return `  ${task.taskId}  ${task.type.padEnd(14)} ${task.status.padEnd(10)} attempt=${attempt}${lease}${error}`;
}

/** Registers a command with uniform `--json` support handled by the caller. */
export type CommandRegistrar = (program: Command) => void;
