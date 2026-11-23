import type {
  ArtifactRecord,
  BeginCommitInput,
  ClaimOptions,
  CommitOutcome,
  EnqueueTaskInput,
  FinalizeCommitInput,
  HeartbeatResult,
  NewResearchNode,
  ResearchNode,
  ResearchNodeKind,
  ResearchNodeStatus,
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

/** Experiment registry row (migration v7): spec + optional attached result. */
export interface ExperimentDoc {
  specId: string;
  version: number;
  /** Content hash of the spec at record time (stableJson). */
  specHash: string;
  /** planned until a result is attached; then mirrors result.status. */
  status: 'planned' | 'succeeded' | 'failed' | 'partial' | 'invalid';
  /** Full ExperimentSpec JSON (docs/DATA_CONTRACTS.md). */
  spec: Record<string, unknown>;
  /** Full RunResult JSON; null while planned. */
  result: Record<string, unknown> | null;
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
  pages: { page: number; text: string; warnings?: string[] }[];
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

/** A repository url mentioned on a page of an indexed paper. */
export interface RepoUrlMention {
  paperKey: string;
  source: string;
  page: number;
  url: string;
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

  /**
   * Highest applied migration version of this database file (0 before any).
   * The cloud projector stamps it into `local_schema_version` so the console
   * can show which engine build produced a view.
   */
  schemaVersion(): number;

  /**
   * Run `fn` inside a single read transaction (F1.15). Under WAL the whole
   * callback sees one snapshot, so a projector cannot pair `run_event seq=100`
   * with a `stage_progress` row from a later write. Nested calls join the
   * enclosing transaction; the callback must not write.
   */
  readSnapshot<T>(fn: () => Promise<T>): Promise<T>;

  // Projects
  ensureProject(input: CreateProjectInput): Promise<ProjectRecord>;
  getProjectByRoot(root: string): Promise<ProjectRecord | null>;

  // Runs
  createRun(input: CreateRunInput): Promise<RunRecord>;
  getRun(runId: string): Promise<RunRecord | null>;
  getLatestRun(projectId: string): Promise<RunRecord | null>;
  /**
   * Runs of one project, newest first. `limit` guards the cloud projector:
   * a batch is capped by contract size, so an unbounded read here would build
   * an in-memory snapshot the transport then has to re-split.
   */
  listRuns(projectId: string, limit?: number): Promise<RunRecord[]>;
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
  /** Single artifact by id (explain/provenance lookups). */
  getArtifact(artifactId: string): Promise<ArtifactRecord | null>;
  /** All artifacts committed for a run (export/archival bundles). */
  listArtifactsByRun(runId: string): Promise<ArtifactRecord[]>;
  /** Temp paths of still-staged artifacts (cleanup must keep these). */
  listStagedTempPaths(): Promise<(string | null)[]>;
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
  /**
   * Queue hygiene (experiment-queue): cancels tasks still `queued` on a
   * TERMINAL run — stale leftovers after cancel/complete/fail. Returns how
   * many tasks were cleaned; refuses non-terminal runs (cancel those).
   */
  cleanupQueued(runId: string): Promise<number>;

  // Events
  appendEvent(event: NewRunEvent): Promise<RunEvent>;
  listEvents(runId: string, opts?: ListEventsOptions): Promise<RunEvent[]>;

  // ResearchRun nodes (LONG_RUNNING WorkflowNode: idea-round | experiment | analysis)
  /**
   * Idempotent upsert keyed by (run_id, node_id). A `succeeded` node is never
   * downgraded to `pending` by a re-sync (成功节点不重做); `invalidated` may be
   * applied from any non-terminal status and is sticky.
   */
  upsertResearchNode(
    input: NewResearchNode,
  ): Promise<{ node: ResearchNode; created: boolean; changed: boolean }>;
  listResearchNodes(
    runId: string,
    filter?: { kind?: ResearchNodeKind; status?: ResearchNodeStatus },
  ): Promise<ResearchNode[]>;
  getResearchNode(runId: string, nodeId: string): Promise<ResearchNode | null>;

  // Knowledge index (FTS5, migration v2)
  replacePaperIndex(entry: PaperIndexEntry): Promise<void>;
  reindexPaper(entry: PaperIndexEntry): Promise<{ inserted: number }>;
  removePaperIndex(paperKey: string): Promise<boolean>;
  searchPapers(query: string, opts?: { limit?: number }): Promise<PaperSearchHit[]>;
  listIndexedPapers(): Promise<PaperIndexMeta[]>;
  /** Deterministic official-code discovery: repo urls found in indexed papers. */
  findRepoUrlMentions(): Promise<RepoUrlMention[]>;

  // Dataset slice registry (migration v3)
  upsertSlice(slice: DatasetSliceRecord): Promise<void>;
  /**
   * Removes one slice record. Used to prune derived artifacts that violate the
   * DatasetSlice contract (a malformed hash blocks the protocol lock), since
   * slices are rebuildable by rule + seed.
   */
  deleteSlice(sliceId: string): Promise<boolean>;
  getSlice(sliceId: string): Promise<DatasetSliceRecord | null>;
  listSlices(opts?: { datasetSnapshotId?: string; scale?: string }): Promise<DatasetSliceRecord[]>;

  // Comparison registry (migration v6)
  upsertComparison(method: ComparisonDoc): Promise<void>;
  getComparison(methodId: string): Promise<ComparisonDoc | null>;
  listComparisons(filter?: { required?: boolean }): Promise<ComparisonDoc[]>;
  transitionComparison(methodId: string, to: string, reason?: string): Promise<ComparisonDoc>;

  // Experiment registry (migration v7)
  /**
   * Idempotent by content: same specId+hash → no-op; a different hash is
   * accepted only when `version` strictly increases (no silent overwrites).
   */
  upsertExperiment(doc: ExperimentDoc): Promise<void>;
  getExperiment(specId: string): Promise<ExperimentDoc | null>;
  listExperiments(filter?: { status?: ExperimentDoc['status'] }): Promise<ExperimentDoc[]>;
  /** Attaches a validated result and moves status off `planned`. */
  attachExperimentResult(
    specId: string,
    result: Record<string, unknown>,
    status: Exclude<ExperimentDoc['status'], 'planned'>,
  ): Promise<ExperimentDoc>;

  // Protocol locks (migration v4)
  lockProtocol(lock: ProtocolLockRecord): Promise<void>;
  getProtocolLock(protocolId: string): Promise<ProtocolLockRecord | null>;
  listProtocolLocks(): Promise<ProtocolLockRecord[]>;

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
