import type {
  ArtifactRecord,
  BeginCommitInput,
  ClaimOptions,
  CommitOutcome,
  EnqueueTaskInput,
  FinalizeCommitInput,
  HeartbeatResult,
  RunEvent,
  RunPhase,
  RunRecord,
  RunStatus,
  TaskError,
  TaskRecord,
  WorkerRecord,
} from './types.js';

export interface CreateRunInput {
  projectId: string;
  question: string;
  /** ResolvedConfig snapshot; stored as JSON so the run stays auditable. */
  config: object;
  strategy?: string;
}

export interface CreateProjectInput {
  root: string;
  name: string;
}

export interface ProjectRecord {
  id: string;
  root: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface NewRunEvent {
  runId: string;
  phase: string;
  objectId?: string | null;
  role?: string | null;
  eventType: string;
  summary: string;
  status?: string | null;
  artifactRefs?: string[];
}

export type BeginCommitResult =
  | { status: 'accepted'; artifactIds: string[] }
  | { status: 'duplicate'; artifactIds: string[]; task: TaskRecord };

export interface FailAttemptResult {
  task: TaskRecord;
  willRetry: boolean;
}

export interface BlockResult {
  task: TaskRecord;
  run: RunRecord;
}

export interface EmbeddingRowInput {
  source: string;
  sourceHash: string;
  page: number;
  preview: string;
  provider: string;
  modelId: string;
  dim: number;
  vector: number[];
  createdAt: number;
}

export interface EmbeddingRow {
  source: string;
  sourceHash: string;
  page: number;
  preview: string;
  vector: number[];
  dim: number;
}

export interface ProtocolLockRecord {
  protocolId: string;
  protocolHash: string;
  lockedAt: number;
  confirmedBy: string;
  /** Full proposal JSON as locked. */
  record: Record<string, unknown>;
}

export interface ComparisonDoc {
  methodId: string;
  status: string;
  required: boolean;
  /** Full ComparisonMethod record (docs/DATA_CONTRACTS.md). */
  record: Record<string, unknown>;
  updatedAt: number;
}

export interface DatasetSliceRecord {
  sliceId: string;
  datasetSnapshotId: string;
  scale: string;
  /** Full DatasetSlice JSON (docs/DATA_CONTRACTS.md). */
  record: Record<string, unknown>;
  createdAt: number;
}

export interface PaperIndexEntry {
  /** Content hash of the parsed source (sha256:<hex>) — index entry identity. */
  paperKey: string;
  /** Project-relative source path. */
  source: string;
  parser: string;
  pageCount: number;
  pages: { page: number; text: string }[];
  indexedAt: number;
}

export interface PaperIndexMeta {
  paperKey: string;
  source: string;
  parser: string;
  pageCount: number;
  indexedAt: number;
}

export interface PaperSearchHit {
  paperKey: string;
  source: string;
  page: number;
  snippet: string;
  score: number;
}

export interface ListEventsOptions {
  since?: number;
  limit?: number;
}

/**
 * Workflow DB contract (docs/plan.md §5): the authoritative, durable store for
 * runs, tasks, leases, events and artifact references. Async on purpose so a
 * PostgreSQL driver can replace SQLite without touching callers. Implementations
 * must provide atomic claim/lease/heartbeat/timeout-reclaim semantics and
 * idempotent commit; no method may rely on an Agent session for state.
 */
export interface WorkflowDb {
  close(): Promise<void>;

  // Projects
  ensureProject(input: CreateProjectInput): Promise<ProjectRecord>;
  getProjectByRoot(root: string): Promise<ProjectRecord | null>;

  // Runs
  createRun(input: CreateRunInput): Promise<RunRecord>;
  getRun(runId: string): Promise<RunRecord | null>;
  getLatestRun(projectId: string): Promise<RunRecord | null>;
  setRunPhase(runId: string, phase: RunPhase): Promise<RunRecord>;
  pauseRun(runId: string, opts: { hard: boolean }): Promise<RunRecord>;
  resumeRun(runId: string): Promise<RunRecord>;
  continueRun(runId: string): Promise<RunRecord>;
  cancelRun(runId: string): Promise<RunRecord>;

  // Tasks
  enqueueTask(input: EnqueueTaskInput): Promise<{ task: TaskRecord; created: boolean }>;
  getTask(taskId: string): Promise<TaskRecord | null>;
  listTasks(runId: string): Promise<TaskRecord[]>;
  /** Artifacts of one task, `staged` rows first (they carry temp paths). */
  listArtifacts(taskId: string): Promise<ArtifactRecord[]>;
  /** All committed artifacts of a kind across runs (knowledge indexing). */
  listArtifactsByKind(kind: string): Promise<ArtifactRecord[]>;
  claimNextTask(runId: string, workerId: string, opts: ClaimOptions): Promise<TaskRecord | null>;
  markTaskStarted(taskId: string, workerId: string): Promise<TaskRecord>;
  heartbeat(taskId: string, workerId: string, opts: ClaimOptions): Promise<HeartbeatResult>;
  /**
   * Phase 1 of the idempotent two-phase commit: validates lease/attempt/cancel
   * state and records `staged` artifact rows. Returns `duplicate` when the task
   * already succeeded with byte-identical output (a repeat submit is a no-op);
   * a repeat submit with different output is rejected as `ALREADY_COMMITTED`.
   */
  beginCommit(input: BeginCommitInput): Promise<BeginCommitResult>;
  finalizeCommit(input: FinalizeCommitInput): Promise<CommitOutcome>;
  failAttempt(taskId: string, workerId: string, error: TaskError): Promise<FailAttemptResult>;
  blockExternal(
    taskId: string,
    workerId: string,
    error: TaskError,
    blockedStatus: Extract<RunStatus, 'QUOTA_EXHAUSTED' | 'AUTH_REQUIRED' | 'NETWORK_BLOCKED'>,
  ): Promise<BlockResult>;
  /**
   * Worker acknowledges a cancel/pause request observed via heartbeat.
   * `pause` requeues the task (run stays PAUSED); `cancel` finalizes it as
   * canceled. Commit attempts after cancellation are rejected.
   */
  ackCancel(taskId: string, workerId: string, reason: 'cancel' | 'pause'): Promise<TaskRecord>;

  // Events
  appendEvent(event: NewRunEvent): Promise<RunEvent>;
  listEvents(runId: string, opts?: ListEventsOptions): Promise<RunEvent[]>;

  // Knowledge index (FTS5, migration v2)
  replacePaperIndex(entry: PaperIndexEntry): Promise<void>;
  reindexPaper(entry: PaperIndexEntry): Promise<{ inserted: number }>;
  removePaperIndex(paperKey: string): Promise<boolean>;
  searchPapers(query: string, opts?: { limit?: number }): Promise<PaperSearchHit[]>;
  listIndexedPapers(): Promise<PaperIndexMeta[]>;

  // Dataset slice registry (migration v3)
  upsertSlice(slice: DatasetSliceRecord): Promise<void>;
  getSlice(sliceId: string): Promise<DatasetSliceRecord | null>;
  listSlices(opts?: { datasetSnapshotId?: string; scale?: string }): Promise<DatasetSliceRecord[]>;

  // Comparison registry (migration v6)
  upsertComparison(method: ComparisonDoc): Promise<void>;
  getComparison(methodId: string): Promise<ComparisonDoc | null>;
  listComparisons(filter?: { required?: boolean }): Promise<ComparisonDoc[]>;
  transitionComparison(methodId: string, to: string, reason?: string): Promise<ComparisonDoc>;

  // Protocol locks (migration v4)
  lockProtocol(lock: ProtocolLockRecord): Promise<void>;
  getProtocolLock(protocolId: string): Promise<ProtocolLockRecord | null>;
  listProtocolLocks(): Promise<ProtocolLockRecord[]>;

  // Local embedding index (migration v5)
  upsertEmbedding(row: EmbeddingRowInput): Promise<void>;
  listEmbeddings(provider: string, modelId: string): Promise<EmbeddingRow[]>;
  countEmbeddings(provider: string, modelId: string): Promise<number>;

  // Workers
  registerWorker(input: {
    workerId: string;
    runId: string;
    pid: number;
    kind: WorkerRecord['kind'];
  }): Promise<WorkerRecord>;
  heartbeatWorker(workerId: string): Promise<void>;
  deregisterWorker(workerId: string): Promise<void>;
  listWorkers(runId: string, includeStopped?: boolean): Promise<WorkerRecord[]>;

  // Recovery primitives (invoked by ProjectRuntime.recover)
  reclaimExpiredLeases(
    runId?: string,
  ): Promise<{ reclaimed: string[]; failed: string[]; canceled: string[] }>;
  listInterruptedCommits(runId?: string): Promise<TaskRecord[]>;
  recoverInterruptedCommit(taskId: string, outcome: 'finalize' | 'requeue'): Promise<TaskRecord>;
  stopStaleWorkers(maxIdleMs: number): Promise<string[]>;
  /** Cancels queued tasks whose dependencies are terminal-dead, then settles idle runs. */
  recoverStrandedRuns(): Promise<{ settled: string[] }>;
}
