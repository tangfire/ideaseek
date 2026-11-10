import type { RunRecord, TaskRecord } from '../workflow/types.js';
import type { ProjectRuntime } from '../workflow/runtime.js';

export interface HandlerArtifact {
  kind: string;
  data: string | Buffer;
  meta?: Record<string, unknown>;
}

export interface HandlerOutput {
  artifacts: HandlerArtifact[];
  summary: string;
  data?: Record<string, unknown>;
}

export interface TaskContext {
  task: TaskRecord;
  run: RunRecord;
  payload: Record<string, unknown>;
  /** Aborted when the run is canceled or hard-paused (observed via heartbeat). */
  signal: AbortSignal;
  runtime: ProjectRuntime;
  log(message: string): void;
}

export type TaskHandler = (ctx: TaskContext) => Promise<HandlerOutput>;

/**
 * Per-task fault injection used by tests and `ideaseek run --fault`.
 * Faults live in task payloads — never in code paths that could mask a real
 * recovery bug: each flag maps to one of the failure modes the docs require
 * (crash, retryable failure, external block, interrupted output write).
 */
export interface FaultSpec {
  /** Hard-crash the worker process on this attempt (default attempt 1). */
  crash?: boolean;
  crashAtAttempt?: number;
  /** Fail with a retryable error while attempt <= failTimes. */
  failTimes?: number;
  /** Fail permanently (no retries). */
  failPermanent?: boolean;
  /** Block the run with an external status (quota/auth/network). */
  blockCode?: 'QUOTA_EXHAUSTED' | 'AUTH_REQUIRED' | 'NETWORK_BLOCKED';
  /** Only block the first attempt; later attempts succeed. */
  blockOnce?: boolean;
  /** Sleep this long before producing output (cancel/pause test window). */
  slowMs?: number;
  /** Stage the first artifact, then crash before commit (interrupted write). */
  interruptStage?: boolean;
}
