import type { ContentHash } from '../core/hash.js';

/**
 * Task lifecycle (docs/ARCHITECTURE.md):
 * `queued → leased → running → committing → succeeded/failed/canceled`.
 * A lease that expires without heartbeat returns to `queued` until
 * `max_attempts` is exhausted, then the task becomes `failed`.
 */
export type TaskStatus =
  'queued' | 'leased' | 'running' | 'committing' | 'succeeded' | 'failed' | 'canceled';

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['succeeded', 'failed', 'canceled'];

/**
 * Run lifecycle statuses for Phase 0. Blocked statuses (quota/auth/network)
 * are recoverable via `ideaseek continue`; `PAUSED` via `ideaseek resume`.
 * Phase 1+ maps WORKFLOW_SPEC research phases onto `RunPhase`.
 */
export type RunStatus =
  | 'RUNNING'
  | 'PAUSED'
  | 'QUOTA_EXHAUSTED'
  | 'AUTH_REQUIRED'
  | 'NETWORK_BLOCKED'
  | 'FAILED_RECOVERABLE'
  | 'FAILED'
  | 'CANCELED'
  | 'COMPLETED';

/** Statuses from which `ideaseek continue` returns the run to RUNNING. */
export const BLOCKED_RUN_STATUSES: readonly RunStatus[] = [
  'QUOTA_EXHAUSTED',
  'AUTH_REQUIRED',
  'NETWORK_BLOCKED',
  'FAILED_RECOVERABLE',
];

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['FAILED', 'CANCELED', 'COMPLETED'];

export type RunPhase = 'INIT' | 'DEMO' | 'COMPLETED';

export interface TaskError {
  code: string;
  message: string;
  retryable: boolean;
  at: number;
}

export interface TaskResult {
  summary: string;
  artifacts: string[];
  data?: Record<string, unknown>;
}

export interface TaskRecord {
  taskId: string;
  runId: string;
  type: string;
  status: TaskStatus;
  phase: string;
  payload: Record<string, unknown>;
  dependsOn: string[];
  idempotencyKey: string;
  attempt: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  heartbeatAt: number | null;
  cancelRequested: boolean;
  result: TaskResult | null;
  error: TaskError | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface RunRecord {
  runId: string;
  projectId: string;
  question: string;
  status: RunStatus;
  phase: RunPhase;
  strategy: string;
  blockReason: string | null;
  config: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export interface ArtifactRecord {
  artifactId: string;
  runId: string;
  taskId: string | null;
  kind: string;
  contentHash: ContentHash;
  size: number;
  relPath: string;
  /** Temp write location while `status === 'staged'`; null once committed. */
  tempPath: string | null;
  status: 'staged' | 'committed' | 'aborted';
  meta: Record<string, unknown>;
  createdAt: number;
  committedAt: number | null;
}

export interface RunEvent {
  seq: number;
  runId: string;
  ts: number;
  phase: string;
  objectId: string | null;
  role: string | null;
  eventType: string;
  summary: string;
  status: string | null;
  artifactRefs: string[];
}

export interface WorkerRecord {
  workerId: string;
  runId: string;
  pid: number;
  kind: 'inline' | 'standalone' | 'test';
  status: 'active' | 'stopped';
  startedAt: number;
  heartbeatAt: number;
}

export interface EnqueueTaskInput {
  runId: string;
  type: string;
  phase?: string;
  payload?: Record<string, unknown>;
  dependsOn?: string[];
  /** Dedupe key, unique per run. Re-enqueueing the same key is a no-op. */
  idempotencyKey: string;
  maxAttempts?: number;
}

export interface ClaimOptions {
  leaseMs: number;
}

export interface HeartbeatResult {
  ok: boolean;
  cancelRequested: boolean;
  leaseExpiresAt: number;
}

export interface StagedArtifactInput {
  kind: string;
  /** Absolute path of the temp file produced by the artifact store. */
  tempPath: string;
  contentHash: ContentHash;
  size: number;
  meta?: Record<string, unknown>;
}

export interface BeginCommitInput {
  taskId: string;
  workerId: string;
  attempt: number;
  artifacts: StagedArtifactInput[];
  result: TaskResult;
}

export interface FinalizeCommitInput {
  taskId: string;
  workerId: string;
}

export type CommitOutcome =
  | { status: 'committed'; task: TaskRecord; artifactIds: string[] }
  | { status: 'duplicate'; task: TaskRecord; artifactIds: string[] };

export interface RecoveryReport {
  reclaimedLeases: string[];
  failedExhausted: string[];
  canceledAfterExpiry: string[];
  resumedCommits: string[];
  abandonedCommits: string[];
  stoppedWorkers: string[];
  /** Runs un-stranded on open (dead-dependency tasks canceled, run settled). */
  settledRuns: string[];
  staleTempsRemoved: string[];
  eventsAppended: number;
}

/**
 * Kinds of ResearchRun orchestration nodes (docs/LONG_RUNNING_WORKFLOWS
 * WorkflowNode subset): the durable graph that spans idea rounds, experiments
 * and analysis for one ResearchRun.
 */
export type ResearchNodeKind = 'idea-round' | 'experiment' | 'analysis';

/**
 * Node lifecycle. `invalidated` marks superseded evidence (the bound idea
 * version advanced, or an upstream dependency was invalidated) — the row and
 * its payload are retained, never deleted (LONG_RUNNING: 保留旧结果).
 */
export type ResearchNodeStatus = 'pending' | 'succeeded' | 'failed' | 'invalidated';

export interface ResearchNode {
  runId: string;
  /** Stable natural key `${kind}:${objectId}` (e.g. `experiment:idea-x:v1`). */
  nodeId: string;
  kind: ResearchNodeKind;
  objectId: string;
  status: ResearchNodeStatus;
  /** Sources this node was derived from (analysis → experiments, round → parent round). */
  dependsOn: string[];
  payload: Record<string, unknown>;
  /** Set iff status is `invalidated` (version supersession or dependency). */
  invalidationReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface NewResearchNode {
  runId: string;
  nodeId: string;
  kind: ResearchNodeKind;
  objectId: string;
  status: ResearchNodeStatus;
  dependsOn: string[];
  payload: Record<string, unknown>;
  invalidationReason?: string | null;
}

export function emptyRecoveryReport(): RecoveryReport {
  return {
    reclaimedLeases: [],
    failedExhausted: [],
    canceledAfterExpiry: [],
    resumedCommits: [],
    abandonedCommits: [],
    stoppedWorkers: [],
    settledRuns: [],
    staleTempsRemoved: [],
    eventsAppended: 0,
  };
}
