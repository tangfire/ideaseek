import { DatabaseSync } from 'node:sqlite';
import { IdeaseekError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { systemClock, type Clock } from '../core/clock.js';
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
  TaskResult,
  TaskStatus,
  WorkerRecord,
} from './types.js';
import { BLOCKED_RUN_STATUSES, TERMINAL_RUN_STATUSES } from './types.js';
import { assertTransition } from '../comparison/types.js';
import type { ComparisonStatus } from '../comparison/types.js';
import { extractRepoUrls } from '../comparison/discover.js';
import type {
  BeginCommitResult,
  ComparisonDoc,
  ExperimentDoc,
  DatasetSliceRecord,
  EmbeddingRow,
  EmbeddingRowInput,
  ProtocolLockRecord,
  PaperIndexEntry,
  PaperIndexMeta,
  PaperSearchHit,
  RepoUrlMention,
  BlockResult,
  CreateProjectInput,
  CreateRunInput,
  FailAttemptResult,
  ListEventsOptions,
  NewRunEvent,
  ProjectRecord,
  WorkflowDb,
} from './db.js';

/** Ordered migrations; each runs exactly once, guarded by `schema_version`. */
const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS project (
        id TEXT PRIMARY KEY,
        root TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run (
        run_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES project(id),
        question TEXT NOT NULL,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        strategy TEXT NOT NULL,
        block_reason TEXT,
        config_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_run_project ON run(project_id, created_at);
      CREATE TABLE IF NOT EXISTS task (
        task_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES run(run_id),
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        depends_on_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        heartbeat_at INTEGER,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        result_json TEXT,
        error_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        UNIQUE (run_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_task_run_status ON task(run_id, status);
      CREATE INDEX IF NOT EXISTS idx_task_lease ON task(status, lease_expires_at);
      CREATE TABLE IF NOT EXISTS artifact (
        artifact_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES run(run_id),
        task_id TEXT,
        kind TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        rel_path TEXT NOT NULL,
        temp_path TEXT,
        status TEXT NOT NULL,
        meta_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        committed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_artifact_task ON artifact(task_id, status);
      CREATE TABLE IF NOT EXISTS run_event (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        phase TEXT NOT NULL,
        object_id TEXT,
        role TEXT,
        event_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT,
        artifact_refs_json TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE TABLE IF NOT EXISTS worker (
        worker_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES run(run_id),
        pid INTEGER NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS paper_index (
        paper_key TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        parser TEXT NOT NULL,
        page_count INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_paper_index_source ON paper_index(source);
      CREATE VIRTUAL TABLE IF NOT EXISTS paper_fts USING fts5(
        body,
        page UNINDEXED,
        paper_key UNINDEXED,
        tokenize = 'porter unicode61'
      );
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS dataset_slice (
        slice_id TEXT PRIMARY KEY,
        dataset_snapshot_id TEXT NOT NULL,
        scale TEXT NOT NULL,
        record_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dataset_slice_dataset
        ON dataset_slice(dataset_snapshot_id, scale);
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS protocol_lock (
        protocol_id TEXT PRIMARY KEY,
        protocol_hash TEXT NOT NULL,
        locked_at INTEGER NOT NULL,
        confirmed_by TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS paper_embedding (
        source_hash TEXT NOT NULL,
        source TEXT NOT NULL,
        page INTEGER NOT NULL,
        preview TEXT NOT NULL,
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vector BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (source_hash, provider, model_id, page)
      );
      CREATE INDEX IF NOT EXISTS idx_embedding_lookup ON paper_embedding(provider, model_id);
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS comparison (
        method_id TEXT PRIMARY KEY,
        doc_json TEXT NOT NULL,
        status TEXT NOT NULL,
        required INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 7,
    sql: `
      CREATE TABLE IF NOT EXISTS experiment (
        spec_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        spec_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        result_json TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_experiment_status ON experiment(status);
    `,
  },
  {
    version: 8,
    sql: `
      CREATE TABLE IF NOT EXISTS research_node (
        node_id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES run(run_id),
        kind TEXT NOT NULL,
        object_id TEXT NOT NULL,
        status TEXT NOT NULL,
        depends_on_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        invalidation_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, node_id)
      );
      CREATE INDEX IF NOT EXISTS idx_research_node_run ON research_node(run_id, status);
      CREATE INDEX IF NOT EXISTS idx_research_node_kind ON research_node(run_id, kind);
    `,
  },
];

const TASK_COLUMNS = `
  task_id, run_id, type, status, phase, payload_json, depends_on_json, idempotency_key,
  attempt, max_attempts, lease_owner, lease_expires_at, heartbeat_at, cancel_requested,
  result_json, error_json, created_at, updated_at, started_at, finished_at
`;

interface TaskRow {
  task_id: string;
  run_id: string;
  type: string;
  status: TaskStatus;
  phase: string;
  payload_json: string;
  depends_on_json: string;
  idempotency_key: string;
  attempt: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  heartbeat_at: number | null;
  cancel_requested: number;
  result_json: string | null;
  error_json: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}

interface RunRow {
  run_id: string;
  project_id: string;
  question: string;
  status: RunStatus;
  phase: RunRecord['phase'];
  strategy: string;
  block_reason: string | null;
  config_json: string;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

interface ArtifactRow {
  artifact_id: string;
  run_id: string;
  task_id: string | null;
  kind: string;
  content_hash: string;
  size: number;
  rel_path: string;
  temp_path: string | null;
  status: 'staged' | 'committed' | 'aborted';
  meta_json: string;
  created_at: number;
  committed_at: number | null;
}

interface EventRow {
  run_id: string;
  seq: number;
  ts: number;
  phase: string;
  object_id: string | null;
  role: string | null;
  event_type: string;
  summary: string;
  status: string | null;
  artifact_refs_json: string;
}

interface WorkerRow {
  worker_id: string;
  run_id: string;
  pid: number;
  kind: WorkerRecord['kind'];
  status: WorkerRecord['status'];
  started_at: number;
  heartbeat_at: number;
}

interface ResearchNodeRow {
  node_id: string;
  run_id: string;
  kind: string;
  object_id: string;
  status: string;
  depends_on_json: string;
  payload_json: string;
  invalidation_reason: string | null;
  created_at: number;
  updated_at: number;
}

interface ProjectRow {
  id: string;
  root: string;
  name: string;
  created_at: number;
  updated_at: number;
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (text == null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function rowToTask(row: TaskRow): TaskRecord {
  return {
    taskId: row.task_id,
    runId: row.run_id,
    type: row.type,
    status: row.status,
    phase: row.phase,
    payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    dependsOn: parseJson<string[]>(row.depends_on_json, []),
    idempotencyKey: row.idempotency_key,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    cancelRequested: row.cancel_requested === 1,
    result: parseJson<TaskResult | null>(row.result_json, null),
    error: parseJson<TaskError | null>(row.error_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function rowToRun(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    projectId: row.project_id,
    question: row.question,
    status: row.status,
    phase: row.phase,
    strategy: row.strategy,
    blockReason: row.block_reason,
    config: parseJson<Record<string, unknown>>(row.config_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function rowToEvent(row: EventRow): RunEvent {
  return {
    seq: row.seq,
    runId: row.run_id,
    ts: row.ts,
    phase: row.phase,
    objectId: row.object_id,
    role: row.role,
    eventType: row.event_type,
    summary: row.summary,
    status: row.status,
    artifactRefs: parseJson<string[]>(row.artifact_refs_json, []),
  };
}

function rowToResearchNode(row: ResearchNodeRow): ResearchNode {
  return {
    runId: row.run_id,
    nodeId: row.node_id,
    kind: row.kind as ResearchNodeKind,
    objectId: row.object_id,
    status: row.status as ResearchNodeStatus,
    dependsOn: parseJson<string[]>(row.depends_on_json, []),
    payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    invalidationReason: row.invalidation_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    artifactId: row.artifact_id,
    runId: row.run_id,
    taskId: row.task_id,
    kind: row.kind,
    contentHash: row.content_hash as ArtifactRecord['contentHash'],
    size: row.size,
    relPath: row.rel_path,
    tempPath: row.temp_path,
    status: row.status,
    meta: parseJson<Record<string, unknown>>(row.meta_json, {}),
    createdAt: row.created_at,
    committedAt: row.committed_at,
  };
}

function rowToWorker(row: WorkerRow): WorkerRecord {
  return {
    workerId: row.worker_id,
    runId: row.run_id,
    pid: row.pid,
    kind: row.kind,
    status: row.status,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
  };
}

function toProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    root: row.root,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function boolParam(value: boolean): number {
  return value ? 1 : 0;
}

/**
 * Quotes each whitespace-separated term so arbitrary user input is a valid
 * FTS5 MATCH expression (AND semantics, no operators injection).
 */
export function sanitizeFtsQuery(query: string): string {
  const terms = query
    .split(/\s+/)
    .map((term) => term.replace(/"/g, '""').trim())
    .filter(Boolean);
  return terms.map((term) => `"${term}"`).join(' ');
}

export function relPathForHash(hash: string): string {
  const hex = hash.startsWith('sha256:') ? hash.slice('sha256:'.length) : hash;
  return `sha256/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}`;
}

function cancelError(): TaskError {
  return {
    code: 'CANCELED_BY_USER',
    message: 'task canceled by user request',
    retryable: false,
    at: 0,
  };
}

export interface SqliteWorkflowDbOptions {
  clock?: Clock;
}

/**
 * SQLite (WAL) implementation of {@link WorkflowDb}. All writes go through
 * `BEGIN IMMEDIATE` transactions (savepoints when nested) so concurrent
 * processes serialize on the write lock; `busy_timeout` handles contention.
 * Time comes from an injectable clock so lease-expiry tests need no sleeping.
 */
export class SqliteWorkflowDb implements WorkflowDb {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  private depth = 0;
  private closed = false;

  constructor(path: string, opts: SqliteWorkflowDbOptions = {}) {
    this.db = new DatabaseSync(path);
    this.clock = opts.clock ?? systemClock;
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA foreign_keys=ON');
    this.db.exec('PRAGMA busy_timeout=10000');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
    );
    const row = this.db
      .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version')
      .get() as {
      v: number;
    };
    let current = Number(row.v);
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(migration.sql);
        this.db
          .prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
          .run(migration.version, this.clock.now());
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      current = migration.version;
    }
  }

  private tx<T>(fn: () => T): T {
    const level = this.depth;
    const isOuter = level === 0;
    const savepoint = `ideaseek_sp_${level}`;
    if (isOuter) this.db.exec('BEGIN IMMEDIATE');
    else this.db.exec(`SAVEPOINT ${savepoint}`);
    this.depth = level + 1;
    let result: T;
    try {
      result = fn();
    } catch (error) {
      this.depth = level;
      try {
        if (isOuter) this.db.exec('ROLLBACK');
        else this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      } catch {
        // Rollback of an already-aborted transaction; original error wins.
      }
      throw error;
    }
    this.depth = level;
    if (isOuter) this.db.exec('COMMIT');
    else this.db.exec(`RELEASE ${savepoint}`);
    return result;
  }

  // ---------------------------------------------------------------- projects

  ensureProject(input: CreateProjectInput): Promise<ProjectRecord> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        const existing = this.db.prepare('SELECT * FROM project WHERE root = ?').get(input.root) as
          ProjectRow | undefined;
        if (existing) {
          if (existing.name !== input.name) {
            const now = this.clock.now();
            this.db
              .prepare('UPDATE project SET name = ?, updated_at = ? WHERE id = ?')
              .run(input.name, now, existing.id);
            return { ...toProject(existing), name: input.name, updatedAt: now };
          }
          return toProject(existing);
        }
        const now = this.clock.now();
        const record: ProjectRecord = {
          id: newId('proj'),
          root: input.root,
          name: input.name,
          createdAt: now,
          updatedAt: now,
        };
        this.db
          .prepare(
            'INSERT INTO project (id, root, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
          )
          .run(record.id, record.root, record.name, record.createdAt, record.updatedAt);
        return record;
      }),
    );
  }

  getProjectByRoot(root: string): Promise<ProjectRecord | null> {
    const row = this.db.prepare('SELECT * FROM project WHERE root = ?').get(root) as
      ProjectRow | undefined;
    return Promise.resolve(row ? toProject(row) : null);
  }

  // -------------------------------------------------------------------- runs

  createRun(input: CreateRunInput): Promise<RunRecord> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        const now = this.clock.now();
        const record: RunRecord = {
          runId: newId('run'),
          projectId: input.projectId,
          question: input.question,
          status: 'RUNNING',
          phase: 'INIT',
          strategy: input.strategy ?? 'starter',
          blockReason: null,
          config: JSON.parse(JSON.stringify(input.config)) as Record<string, unknown>,
          createdAt: now,
          updatedAt: now,
          finishedAt: null,
        };
        this.db
          .prepare(
            `INSERT INTO run
             (run_id, project_id, question, status, phase, strategy, block_reason, config_json,
              created_at, updated_at, finished_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
          )
          .run(
            record.runId,
            record.projectId,
            record.question,
            record.status,
            record.phase,
            record.strategy,
            JSON.stringify(record.config),
            now,
            now,
          );
        this.insertEvent({
          runId: record.runId,
          phase: record.phase,
          eventType: 'run_created',
          summary: 'run created',
          status: record.status,
        });
        return record;
      }),
    );
  }

  getRun(runId: string): Promise<RunRecord | null> {
    const row = this.db.prepare('SELECT * FROM run WHERE run_id = ?').get(runId) as unknown as
      RunRow | undefined;
    return Promise.resolve(row ? rowToRun(row) : null);
  }

  getLatestRun(projectId: string): Promise<RunRecord | null> {
    const row = this.db
      .prepare(
        'SELECT * FROM run WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      )
      .get(projectId) as unknown as RunRow | undefined;
    return Promise.resolve(row ? rowToRun(row) : null);
  }

  setRunPhase(runId: string, phase: RunPhase): Promise<RunRecord> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        this.requireRun(runId);
        this.db
          .prepare('UPDATE run SET phase = ?, updated_at = ? WHERE run_id = ?')
          .run(phase, this.clock.now(), runId);
        return this.requireRun(runId);
      }),
    );
  }

  pauseRun(runId: string, opts: { hard: boolean }): Promise<RunRecord> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        const run = this.requireRun(runId);
        if (run.status === 'PAUSED') return run;
        if (TERMINAL_RUN_STATUSES.includes(run.status)) {
          throw new IdeaseekError('RUN_TERMINAL', `run ${runId} already finished (${run.status})`);
        }
        if (run.status !== 'RUNNING') {
          throw new IdeaseekError(
            'RUN_NOT_ACTIVE',
            `run is ${run.status}; use ideaseek continue instead of pause`,
            { status: run.status },
          );
        }
        const now = this.clock.now();
        if (opts.hard) {
          this.db
            .prepare(
              `UPDATE task SET cancel_requested = 1, updated_at = ?
               WHERE run_id = ? AND status IN ('leased', 'running')`,
            )
            .run(now, runId);
        }
        const updated = this.setRunStatus(runId, 'PAUSED', { blockReason: null, finished: false });
        this.insertEvent({
          runId,
          phase: updated.phase,
          eventType: 'run_paused',
          summary: opts.hard
            ? 'run paused (hard); running tasks asked to checkpoint'
            : 'run paused',
          status: 'PAUSED',
        });
        return updated;
      }),
    );
  }

  resumeRun(runId: string): Promise<RunRecord> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        const run = this.requireRun(runId);
        if (run.status === 'RUNNING') return run;
        if (TERMINAL_RUN_STATUSES.includes(run.status)) {
          throw new IdeaseekError('RUN_TERMINAL', `run ${runId} already finished (${run.status})`);
        }
        if (BLOCKED_RUN_STATUSES.includes(run.status)) {
          throw new IdeaseekError(
            'RUN_BLOCKED',
            `run is ${run.status}; use ideaseek continue after resolving the block`,
            { status: run.status },
          );
        }
        const updated = this.setRunStatus(runId, 'RUNNING', { blockReason: null, finished: false });
        this.insertEvent({
          runId,
          phase: updated.phase,
          eventType: 'run_resumed',
          summary: 'run resumed',
          status: 'RUNNING',
        });
        return updated;
      }),
    );
  }

  continueRun(runId: string): Promise<RunRecord> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        const run = this.requireRun(runId);
        if (run.status === 'RUNNING') return run;
        if (TERMINAL_RUN_STATUSES.includes(run.status)) {
          throw new IdeaseekError('RUN_TERMINAL', `run ${runId} already finished (${run.status})`);
        }
        if (!BLOCKED_RUN_STATUSES.includes(run.status)) {
          throw new IdeaseekError(
            'RUN_NOT_ACTIVE',
            `run is ${run.status}; use ideaseek resume to continue after pause`,
            { status: run.status },
          );
        }
        const previous = run.status;
        const updated = this.setRunStatus(runId, 'RUNNING', { blockReason: null, finished: false });
        this.insertEvent({
          runId,
          phase: updated.phase,
          eventType: 'run_resumed',
          summary: `run continued from ${previous}`,
          status: 'RUNNING',
        });
        return updated;
      }),
    );
  }

  cancelRun(runId: string): Promise<RunRecord> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        const run = this.requireRun(runId);
        if (run.status === 'CANCELED') return run;
        if (TERMINAL_RUN_STATUSES.includes(run.status)) {
          throw new IdeaseekError(
            'RUN_TERMINAL',
            `run ${runId} already finished (${run.status}); nothing to cancel`,
          );
        }
        const now = this.clock.now();
        const queued = this.db
          .prepare(
            `UPDATE task SET status = 'canceled', cancel_requested = 1, finished_at = ?, updated_at = ?,
                            error_json = ?
             WHERE run_id = ? AND status = 'queued'`,
          )
          .run(now, now, JSON.stringify(cancelError()), runId);
        if (Number(queued.changes) > 0) {
          this.insertEvent({
            runId,
            phase: run.phase,
            eventType: 'task_canceled',
            summary: `${Number(queued.changes)} queued task(s) canceled`,
            status: 'canceled',
          });
        }
        this.db
          .prepare(
            `UPDATE task SET cancel_requested = 1, updated_at = ?
             WHERE run_id = ? AND status IN ('leased', 'running', 'committing')`,
          )
          .run(now, runId);
        const updated = this.setRunStatus(runId, 'CANCELED', { blockReason: null, finished: true });
        this.insertEvent({
          runId,
          phase: updated.phase,
          eventType: 'run_canceled',
          summary: 'run canceled; committed artifacts and events are preserved',
          status: 'CANCELED',
        });
        return updated;
      }),
    );
  }

  cleanupQueued(runId: string): Promise<number> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        const run = this.requireRun(runId);
        if (!TERMINAL_RUN_STATUSES.includes(run.status)) {
          throw new IdeaseekError(
            'INVALID_STATE',
            `run ${runId} is ${run.status}; cancel it instead of cleaning the queue`,
          );
        }
        const now = this.clock.now();
        const result = this.db
          .prepare(
            `UPDATE task SET status = 'canceled', cancel_requested = 1, finished_at = ?, updated_at = ?,
                            error_json = ?
             WHERE run_id = ? AND status = 'queued'`,
          )
          .run(now, now, JSON.stringify(cancelError()), runId);
        const count = Number(result.changes);
        if (count > 0) {
          this.insertEvent({
            runId,
            phase: run.phase,
            eventType: 'task_canceled',
            summary: `${count} stale queued task(s) cleaned up from terminal run`,
            status: 'canceled',
          });
        }
        return count;
      }),
    );
  }

  // ------------------------------------------------------------------- tasks

  enqueueTask(input: EnqueueTaskInput): Promise<{ task: TaskRecord; created: boolean }> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        this.requireRun(input.runId);
        for (const dep of input.dependsOn ?? []) {
          const depRow = this.db
            .prepare('SELECT task_id FROM task WHERE task_id = ? AND run_id = ?')
            .get(dep, input.runId);
          if (!depRow) {
            throw new IdeaseekError(
              'DEPENDENCY_NOT_MET',
              `dependency ${dep} does not exist in run ${input.runId}`,
              { dependency: dep },
            );
          }
        }
        const now = this.clock.now();
        const taskId = newId('task');
        const insert = this.db
          .prepare(
            `INSERT INTO task
             (task_id, run_id, type, status, phase, payload_json, depends_on_json, idempotency_key,
              attempt, max_attempts, lease_owner, lease_expires_at, heartbeat_at, cancel_requested,
              result_json, error_json, created_at, updated_at, started_at, finished_at)
             VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, 0, NULL, NULL, ?, ?, NULL, NULL)
             ON CONFLICT (run_id, idempotency_key) DO NOTHING`,
          )
          .run(
            taskId,
            input.runId,
            input.type,
            input.phase ?? 'DEMO',
            JSON.stringify(input.payload ?? {}),
            JSON.stringify(input.dependsOn ?? []),
            input.idempotencyKey,
            input.maxAttempts ?? 3,
            now,
            now,
          );
        const created = Number(insert.changes) > 0;
        const row = created
          ? (this.db
              .prepare(`SELECT ${TASK_COLUMNS} FROM task WHERE task_id = ?`)
              .get(taskId) as unknown as TaskRow)
          : (this.db
              .prepare(`SELECT ${TASK_COLUMNS} FROM task WHERE run_id = ? AND idempotency_key = ?`)
              .get(input.runId, input.idempotencyKey) as unknown as TaskRow);
        if (created) {
          this.insertEvent({
            runId: input.runId,
            phase: row.phase,
            objectId: row.task_id,
            eventType: 'task_enqueued',
            summary: `task ${row.type} queued`,
            status: 'queued',
          });
        }
        return { task: rowToTask(row), created };
      }),
    );
  }

  getTask(taskId: string): Promise<TaskRecord | null> {
    const row = this.db
      .prepare(`SELECT ${TASK_COLUMNS} FROM task WHERE task_id = ?`)
      .get(taskId) as TaskRow | undefined;
    return Promise.resolve(row ? rowToTask(row) : null);
  }

  listTasks(runId: string): Promise<TaskRecord[]> {
    const rows = this.db
      .prepare(`SELECT ${TASK_COLUMNS} FROM task WHERE run_id = ? ORDER BY created_at, rowid`)
      .all(runId) as unknown as TaskRow[];
    return Promise.resolve(rows.map(rowToTask));
  }

  listArtifactsByKind(kind: string): Promise<ArtifactRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM artifact WHERE kind = ? AND status = 'committed' ORDER BY created_at, rowid`,
      )
      .all(kind) as unknown as ArtifactRow[];
    return Promise.resolve(rows.map(rowToArtifact));
  }

  getArtifact(artifactId: string): Promise<ArtifactRecord | null> {
    const row = this.db.prepare('SELECT * FROM artifact WHERE artifact_id = ?').get(artifactId) as
      ArtifactRow | undefined;
    return Promise.resolve(row ? rowToArtifact(row) : null);
  }

  listArtifactsByRun(runId: string): Promise<ArtifactRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM artifact WHERE run_id = ? AND status = 'committed' ORDER BY created_at, rowid`,
      )
      .all(runId) as unknown as ArtifactRow[];
    return Promise.resolve(rows.map(rowToArtifact));
  }

  listStagedTempPaths(): Promise<(string | null)[]> {
    const rows = this.db
      .prepare(`SELECT temp_path FROM artifact WHERE status = 'staged'`)
      .all() as unknown as { temp_path: string | null }[];
    return Promise.resolve(rows.map((row) => row.temp_path));
  }

  replacePaperIndex(entry: PaperIndexEntry): Promise<void> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        this.replacePaperIndexTx(entry);
      }),
    );
  }

  reindexPaper(entry: PaperIndexEntry): Promise<{ inserted: number }> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        this.replacePaperIndexTx(entry);
        return { inserted: entry.pages.length };
      }),
    );
  }

  removePaperIndex(paperKey: string): Promise<boolean> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        const existed =
          this.db.prepare('DELETE FROM paper_index WHERE paper_key = ?').run(paperKey).changes > 0;
        this.db.prepare('DELETE FROM paper_fts WHERE paper_key = ?').run(paperKey);
        return existed;
      }),
    );
  }

  listIndexedPapers(): Promise<PaperIndexMeta[]> {
    const rows = this.db.prepare('SELECT * FROM paper_index ORDER BY source').all() as unknown as {
      paper_key: string;
      source: string;
      parser: string;
      page_count: number;
      indexed_at: number;
    }[];
    return Promise.resolve(
      rows.map((row) => ({
        paperKey: row.paper_key,
        source: row.source,
        parser: row.parser,
        pageCount: row.page_count,
        indexedAt: row.indexed_at,
      })),
    );
  }

  findRepoUrlMentions(): Promise<RepoUrlMention[]> {
    // Cheap LIKE prefilter over indexed pages; URL normalization and
    // reserved-owner filtering happen in comparison/discover.
    const rows = this.db
      .prepare(
        `SELECT f.paper_key AS paper_key, f.page AS page, f.body AS body, p.source AS source
         FROM paper_fts f
         JOIN paper_index p ON p.paper_key = f.paper_key
         WHERE f.body LIKE '%github.com%'
            OR f.body LIKE '%gitlab.com%'
            OR f.body LIKE '%bitbucket.org%'
            OR f.body LIKE '%gitee.com%'
         ORDER BY p.source, f.page`,
      )
      .all() as unknown as {
      paper_key: string;
      page: number;
      body: string;
      source: string;
    }[];
    const seen = new Set<string>();
    const out: RepoUrlMention[] = [];
    for (const row of rows) {
      for (const url of extractRepoUrls(row.body)) {
        const key = `${row.paper_key} ${row.page} ${url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          paperKey: row.paper_key,
          source: row.source,
          page: Number(row.page),
          url,
        });
      }
    }
    return Promise.resolve(out);
  }

  upsertSlice(slice: DatasetSliceRecord): Promise<void> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        this.db
          .prepare(
            'INSERT INTO dataset_slice (slice_id, dataset_snapshot_id, scale, record_json, created_at) VALUES (?, ?, ?, ?, ?) ' +
              'ON CONFLICT(slice_id) DO UPDATE SET dataset_snapshot_id = excluded.dataset_snapshot_id, scale = excluded.scale, record_json = excluded.record_json',
          )
          .run(
            slice.sliceId,
            slice.datasetSnapshotId,
            slice.scale,
            JSON.stringify(slice.record),
            slice.createdAt,
          );
      }),
    );
  }

  getSlice(sliceId: string): Promise<DatasetSliceRecord | null> {
    const row = this.db.prepare('SELECT * FROM dataset_slice WHERE slice_id = ?').get(sliceId) as
      | {
          slice_id: string;
          dataset_snapshot_id: string;
          scale: string;
          record_json: string;
          created_at: number;
        }
      | undefined;
    if (!row) return Promise.resolve(null);
    return Promise.resolve({
      sliceId: row.slice_id,
      datasetSnapshotId: row.dataset_snapshot_id,
      scale: row.scale,
      record: parseJson<Record<string, unknown>>(row.record_json, {}),
      createdAt: row.created_at,
    });
  }

  listSlices(
    opts: { datasetSnapshotId?: string; scale?: string } = {},
  ): Promise<DatasetSliceRecord[]> {
    let sql = 'SELECT * FROM dataset_slice';
    const params: string[] = [];
    const where: string[] = [];
    if (opts.datasetSnapshotId) {
      where.push('dataset_snapshot_id = ?');
      params.push(opts.datasetSnapshotId);
    }
    if (opts.scale) {
      where.push('scale = ?');
      params.push(opts.scale);
    }
    if (where.length > 0) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY created_at, slice_id';
    const rows = this.db.prepare(sql).all(...params) as unknown as {
      slice_id: string;
      dataset_snapshot_id: string;
      scale: string;
      record_json: string;
      created_at: number;
    }[];
    return Promise.resolve(
      rows.map((row) => ({
        sliceId: row.slice_id,
        datasetSnapshotId: row.dataset_snapshot_id,
        scale: row.scale,
        record: parseJson<Record<string, unknown>>(row.record_json, {}),
        createdAt: row.created_at,
      })),
    );
  }

  lockProtocol(lock: ProtocolLockRecord): Promise<void> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        const existing = this.db
          .prepare('SELECT protocol_hash FROM protocol_lock WHERE protocol_id = ?')
          .get(lock.protocolId) as { protocol_hash: string } | undefined;
        if (existing && existing.protocol_hash !== lock.protocolHash) {
          throw new IdeaseekError(
            'INVALID_STATE',
            `protocol ${lock.protocolId} is already locked with a different hash`,
          );
        }
        if (existing) return; // idempotent re-lock of the same content
        this.db
          .prepare(
            'INSERT INTO protocol_lock (protocol_id, protocol_hash, locked_at, confirmed_by, record_json) VALUES (?, ?, ?, ?, ?)',
          )
          .run(
            lock.protocolId,
            lock.protocolHash,
            lock.lockedAt,
            lock.confirmedBy,
            JSON.stringify(lock.record),
          );
      }),
    );
  }

  getProtocolLock(protocolId: string): Promise<ProtocolLockRecord | null> {
    const row = this.db
      .prepare('SELECT * FROM protocol_lock WHERE protocol_id = ?')
      .get(protocolId) as
      | {
          protocol_id: string;
          protocol_hash: string;
          locked_at: number;
          confirmed_by: string;
          record_json: string;
        }
      | undefined;
    if (!row) return Promise.resolve(null);
    return Promise.resolve({
      protocolId: row.protocol_id,
      protocolHash: row.protocol_hash,
      lockedAt: row.locked_at,
      confirmedBy: row.confirmed_by,
      record: parseJson<Record<string, unknown>>(row.record_json, {}),
    });
  }

  listProtocolLocks(): Promise<ProtocolLockRecord[]> {
    const rows = this.db
      .prepare('SELECT * FROM protocol_lock ORDER BY locked_at, protocol_id')
      .all() as unknown as {
      protocol_id: string;
      protocol_hash: string;
      locked_at: number;
      confirmed_by: string;
      record_json: string;
    }[];
    return Promise.resolve(
      rows.map((row) => ({
        protocolId: row.protocol_id,
        protocolHash: row.protocol_hash,
        lockedAt: row.locked_at,
        confirmedBy: row.confirmed_by,
        record: parseJson<Record<string, unknown>>(row.record_json, {}),
      })),
    );
  }

  searchPapers(query: string, opts: { limit?: number } = {}): Promise<PaperSearchHit[]> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const match = sanitizeFtsQuery(query);
    if (!match) return Promise.resolve([]);
    const rows = this.db
      .prepare(
        `SELECT f.paper_key AS paper_key, f.page AS page,
                snippet(paper_fts, 0, '[', ']', '…', 16) AS snippet,
                bm25(paper_fts) AS score,
                p.source AS source
         FROM paper_fts f
         JOIN paper_index p ON p.paper_key = f.paper_key
         WHERE paper_fts MATCH ?
         ORDER BY score
         LIMIT ?`,
      )
      .all(match, limit) as unknown as {
      paper_key: string;
      page: number;
      snippet: string;
      score: number;
      source: string;
    }[];
    return Promise.resolve(
      rows.map((row) => ({
        paperKey: row.paper_key,
        source: row.source,
        page: Number(row.page),
        snippet: row.snippet ?? '',
        score: Number(row.score),
      })),
    );
  }

  private replacePaperIndexTx(entry: PaperIndexEntry): void {
    // Drop any previous generation for this source (content may have changed)
    // and any stale rows for this key, then insert the fresh page rows.
    const stale = this.db
      .prepare('SELECT paper_key FROM paper_index WHERE source = ?')
      .all(entry.source) as unknown as { paper_key: string }[];
    for (const row of stale) {
      this.db.prepare('DELETE FROM paper_fts WHERE paper_key = ?').run(row.paper_key);
      this.db.prepare('DELETE FROM paper_index WHERE paper_key = ?').run(row.paper_key);
    }
    this.db.prepare('DELETE FROM paper_fts WHERE paper_key = ?').run(entry.paperKey);
    this.db
      .prepare(
        `INSERT INTO paper_index (paper_key, source, parser, page_count, indexed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(paper_key) DO UPDATE SET
           source = excluded.source, parser = excluded.parser,
           page_count = excluded.page_count, indexed_at = excluded.indexed_at`,
      )
      .run(entry.paperKey, entry.source, entry.parser, entry.pageCount, entry.indexedAt);
    const insertFts = this.db.prepare(
      'INSERT INTO paper_fts (body, page, paper_key) VALUES (?, ?, ?)',
    );
    for (const page of entry.pages) {
      if (page.text.trim()) insertFts.run(page.text, page.page, entry.paperKey);
    }
  }

  listArtifacts(taskId: string): Promise<ArtifactRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM artifact WHERE task_id = ?
         ORDER BY CASE status WHEN 'staged' THEN 0 WHEN 'committed' THEN 1 ELSE 2 END, created_at, rowid`,
      )
      .all(taskId) as unknown as ArtifactRow[];
    return Promise.resolve(rows.map(rowToArtifact));
  }

  claimNextTask(runId: string, workerId: string, opts: ClaimOptions): Promise<TaskRecord | null> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        const run = this.requireRun(runId);
        if (run.status !== 'RUNNING') return null;
        this.reclaimExpiredLeasesTx(runId);
        const tasks = this.listTasksTx(runId);
        const byId = new Map(tasks.map((task) => [task.taskId, task]));
        const now = this.clock.now();
        for (const task of tasks) {
          if (task.status !== 'queued' || task.cancelRequested) continue;
          const depsOk = task.dependsOn.every((dep) => byId.get(dep)?.status === 'succeeded');
          if (!depsOk) continue;
          const claim = this.db
            .prepare(
              `UPDATE task SET status = 'leased', attempt = attempt + 1, lease_owner = ?,
                               lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
               WHERE task_id = ? AND status = 'queued'`,
            )
            .run(workerId, now + opts.leaseMs, now, now, task.taskId);
          if (Number(claim.changes) === 0) continue; // lost the race; try next task
          const row = this.db
            .prepare(`SELECT ${TASK_COLUMNS} FROM task WHERE task_id = ?`)
            .get(task.taskId) as unknown as TaskRow;
          this.insertEvent({
            runId,
            phase: row.phase,
            objectId: row.task_id,
            role: workerId,
            eventType: 'task_leased',
            summary: `worker ${workerId} leased ${row.type} (attempt ${row.attempt}/${row.max_attempts})`,
            status: 'leased',
          });
          return rowToTask(row);
        }
        return null;
      }),
    );
  }

  markTaskStarted(taskId: string, workerId: string): Promise<TaskRecord> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        const task = this.requireTask(taskId);
        this.assertOwner(task, workerId);
        if (task.status === 'running') return task;
        if (task.status !== 'leased') {
          throw new IdeaseekError(
            'INVALID_STATE',
            `task ${taskId} is ${task.status}, cannot start from here`,
          );
        }
        const now = this.clock.now();
        this.db
          .prepare(
            `UPDATE task SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
             WHERE task_id = ? AND status = 'leased'`,
          )
          .run(now, now, taskId);
        const row = this.db
          .prepare(`SELECT ${TASK_COLUMNS} FROM task WHERE task_id = ?`)
          .get(taskId) as unknown as TaskRow;
        this.insertEvent({
          runId: row.run_id,
          phase: row.phase,
          objectId: taskId,
          role: workerId,
          eventType: 'task_started',
          summary: `${row.type} started`,
          status: 'running',
        });
        return rowToTask(row);
      }),
    );
  }

  heartbeat(taskId: string, workerId: string, opts: ClaimOptions): Promise<HeartbeatResult> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        const task = this.requireTask(taskId);
        this.assertOwner(task, workerId);
        if (!['leased', 'running', 'committing'].includes(task.status)) {
          throw new IdeaseekError(
            'LEASE_LOST',
            `task ${taskId} is ${task.status}; worker ${workerId} no longer holds it`,
          );
        }
        const now = this.clock.now();
        const leaseExpiresAt = now + opts.leaseMs;
        this.db
          .prepare(
            'UPDATE task SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ? WHERE task_id = ?',
          )
          .run(now, leaseExpiresAt, now, taskId);
        return { ok: true, cancelRequested: task.cancelRequested, leaseExpiresAt };
      }),
    );
  }

  beginCommit(input: BeginCommitInput): Promise<BeginCommitResult> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        const task = this.requireTask(input.taskId);
        // A succeeded task short-circuits to idempotent duplicate detection:
        // its lease was cleared on finalize, so owner checks must not run first.
        if (task.status === 'succeeded') {
          return this.duplicateCheck(task, input.artifacts);
        }
        this.assertOwner(task, input.workerId);
        if (task.attempt !== input.attempt) {
          throw new IdeaseekError(
            'STALE_ATTEMPT',
            `stale commit for ${input.taskId}: attempt ${input.attempt} != ${task.attempt}`,
            { expected: task.attempt, got: input.attempt },
          );
        }
        if (task.status === 'canceled' || task.cancelRequested) {
          throw new IdeaseekError('TASK_CANCELED', `task ${input.taskId} was canceled`);
        }
        if (task.status === 'committing') {
          // Same worker resumed after an interruption inside its own commit.
          const rows = this.db
            .prepare(`SELECT artifact_id FROM artifact WHERE task_id = ? AND status = 'staged'`)
            .all(task.taskId) as unknown as { artifact_id: string }[];
          return { status: 'accepted', artifactIds: rows.map((row) => row.artifact_id) };
        }
        if (task.status !== 'leased' && task.status !== 'running') {
          throw new IdeaseekError(
            'INVALID_STATE',
            `task ${input.taskId} is ${task.status}; commit requires leased/running/committing`,
          );
        }
        if (input.artifacts.length === 0) {
          throw new IdeaseekError(
            'INVALID_ARTIFACT',
            'a commit must include at least one artifact',
          );
        }
        const now = this.clock.now();
        const artifactIds: string[] = [];
        for (const artifact of input.artifacts) {
          if (!artifact.contentHash.startsWith('sha256:')) {
            throw new IdeaseekError('INVALID_ARTIFACT', 'artifact hash must be sha256:<hex>');
          }
          const artifactId = newId('art');
          // One row per task attempt; the file itself is deduplicated by the
          // content-addressed store, so identical outputs share one file while
          // keeping per-task provenance.
          this.db
            .prepare(
              `INSERT INTO artifact
               (artifact_id, run_id, task_id, kind, content_hash, size, rel_path, temp_path,
                status, meta_json, created_at, committed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?, ?, NULL)`,
            )
            .run(
              artifactId,
              task.runId,
              task.taskId,
              artifact.kind,
              artifact.contentHash,
              artifact.size,
              relPathForHash(artifact.contentHash),
              artifact.tempPath,
              JSON.stringify(artifact.meta ?? {}),
              now,
            );
          artifactIds.push(artifactId);
        }
        this.db
          .prepare(
            `UPDATE task SET status = 'committing', result_json = ?, lease_expires_at = ?,
                             heartbeat_at = ?, updated_at = ?
             WHERE task_id = ?`,
          )
          .run(
            JSON.stringify({
              summary: input.result.summary,
              artifacts: [],
              data: input.result.data,
            }),
            now + 60_000,
            now,
            now,
            task.taskId,
          );
        return { status: 'accepted', artifactIds };
      }),
    );
  }

  finalizeCommit(input: FinalizeCommitInput): Promise<CommitOutcome> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        const task = this.requireTask(input.taskId);
        if (task.status === 'succeeded') {
          const duplicate = this.duplicateCheck(task, []);
          if (duplicate.status === 'duplicate') {
            return {
              status: 'duplicate',
              task: duplicate.task,
              artifactIds: duplicate.artifactIds,
            };
          }
          throw new IdeaseekError('ALREADY_COMMITTED', `task ${input.taskId} already committed`);
        }
        this.assertOwner(task, input.workerId);
        if (task.status !== 'committing') {
          throw new IdeaseekError(
            'INVALID_STATE',
            `task ${input.taskId} is ${task.status}; finalize requires committing`,
          );
        }
        const now = this.clock.now();
        const rows = this.db
          .prepare(`SELECT * FROM artifact WHERE task_id = ? AND status = 'staged'`)
          .all(task.taskId) as unknown as ArtifactRow[];
        if (rows.length === 0) {
          throw new IdeaseekError(
            'INVALID_ARTIFACT',
            `task ${input.taskId} has no staged artifacts to finalize`,
          );
        }
        this.db
          .prepare(
            `UPDATE artifact SET status = 'committed', committed_at = ?, temp_path = NULL
             WHERE task_id = ? AND status = 'staged'`,
          )
          .run(now, task.taskId);
        const existing = task.result;
        const result: TaskResult = {
          summary: existing?.summary ?? 'committed',
          artifacts: rows.map((row) => row.artifact_id),
          data: existing?.data,
        };
        this.db
          .prepare(
            `UPDATE task SET status = 'succeeded', result_json = ?, lease_owner = NULL,
                             lease_expires_at = NULL, cancel_requested = 0, error_json = NULL,
                             finished_at = ?, updated_at = ?
             WHERE task_id = ?`,
          )
          .run(JSON.stringify(result), now, now, task.taskId);
        for (const row of rows) {
          this.insertEvent({
            runId: task.runId,
            phase: task.phase,
            objectId: task.taskId,
            eventType: 'artifact_committed',
            summary: `${row.kind} committed (${row.content_hash.slice(0, 19)}…)`,
            status: 'committed',
            artifactRefs: [row.artifact_id],
          });
        }
        this.insertEvent({
          runId: task.runId,
          phase: task.phase,
          objectId: task.taskId,
          role: input.workerId,
          eventType: 'task_result',
          summary: result.summary,
          status: 'succeeded',
          artifactRefs: rows.map((row) => row.artifact_id),
        });
        this.insertEvent({
          runId: task.runId,
          phase: task.phase,
          objectId: task.taskId,
          role: input.workerId,
          eventType: 'task_succeeded',
          summary: `${task.type} succeeded`,
          status: 'succeeded',
          artifactRefs: rows.map((row) => row.artifact_id),
        });
        this.checkRunCompletion(task.runId);
        return {
          status: 'committed',
          task: this.requireTask(task.taskId),
          artifactIds: rows.map((row) => row.artifact_id),
        };
      }),
    );
  }

  failAttempt(taskId: string, workerId: string, error: TaskError): Promise<FailAttemptResult> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        const task = this.requireTask(taskId);
        if (task.status === 'canceled') return { task, willRetry: false };
        this.assertOwner(task, workerId);
        if (task.status === 'succeeded' || task.status === 'failed') {
          return { task, willRetry: false };
        }
        if (task.status !== 'leased' && task.status !== 'running' && task.status !== 'committing') {
          throw new IdeaseekError(
            'INVALID_STATE',
            `task ${taskId} is ${task.status}; cannot record failure from here`,
          );
        }
        const now = this.clock.now();
        if (task.status === 'committing') {
          this.db
            .prepare(
              `UPDATE artifact SET status = 'aborted' WHERE task_id = ? AND status = 'staged'`,
            )
            .run(taskId);
        }
        this.db
          .prepare('UPDATE task SET error_json = ? WHERE task_id = ?')
          .run(JSON.stringify(error), taskId);
        const willRetry = error.retryable && task.attempt < task.maxAttempts;
        if (willRetry) {
          this.db
            .prepare(
              `UPDATE task SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
                               updated_at = ?
               WHERE task_id = ?`,
            )
            .run(now, taskId);
        } else {
          this.db
            .prepare(
              `UPDATE task SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
                               finished_at = ?, updated_at = ?
               WHERE task_id = ?`,
            )
            .run(now, now, taskId);
        }
        this.insertEvent({
          runId: task.runId,
          phase: task.phase,
          objectId: taskId,
          role: workerId,
          eventType: 'task_failed',
          summary: `${task.type} failed (${error.code}): ${willRetry ? 'will retry' : 'no retries left'}`,
          status: willRetry ? 'queued' : 'failed',
        });
        if (!willRetry) {
          this.cascadeUnrunnableDependents(task.runId, taskId);
          this.settleAfterTerminalFailure(task.runId, task);
        }
        return { task: this.requireTask(taskId), willRetry };
      }),
    );
  }

  blockExternal(
    taskId: string,
    workerId: string,
    error: TaskError,
    blockedStatus: Extract<RunStatus, 'QUOTA_EXHAUSTED' | 'AUTH_REQUIRED' | 'NETWORK_BLOCKED'>,
  ): Promise<BlockResult> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        const task = this.requireTask(taskId);
        this.assertOwner(task, workerId);
        if (task.status !== 'leased' && task.status !== 'running') {
          throw new IdeaseekError(
            'INVALID_STATE',
            `task ${taskId} is ${task.status}; external blocks only apply to leased/running tasks`,
          );
        }
        const now = this.clock.now();
        // External blocks are not attempt failures: undo the claim increment so
        // `continue` re-runs the task without burning retries.
        this.db
          .prepare(
            `UPDATE task SET status = 'queued', attempt = MAX(attempt - 1, 0),
                             lease_owner = NULL, lease_expires_at = NULL, error_json = ?, updated_at = ?
             WHERE task_id = ?`,
          )
          .run(JSON.stringify(error), now, taskId);
        this.db
          .prepare('UPDATE run SET status = ?, block_reason = ?, updated_at = ? WHERE run_id = ?')
          .run(blockedStatus, error.message, now, task.runId);
        this.insertEvent({
          runId: task.runId,
          phase: task.phase,
          objectId: taskId,
          role: workerId,
          eventType: 'task_blocked',
          summary: `${task.type} blocked: ${error.code}`,
          status: 'queued',
        });
        this.insertEvent({
          runId: task.runId,
          phase: task.phase,
          eventType: 'run_blocked',
          summary: `run ${blockedStatus}: ${error.code}`,
          status: blockedStatus,
        });
        return { task: this.requireTask(taskId), run: this.requireRun(task.runId) };
      }),
    );
  }

  ackCancel(taskId: string, workerId: string, reason: 'cancel' | 'pause'): Promise<TaskRecord> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        const task = this.requireTask(taskId);
        if (task.status === 'canceled' || task.status === 'succeeded' || task.status === 'failed') {
          return task;
        }
        this.assertOwner(task, workerId);
        if (task.status === 'committing') {
          throw new IdeaseekError(
            'INVALID_STATE',
            `task ${taskId} is committing; let the commit finish instead of acking ${reason}`,
          );
        }
        const now = this.clock.now();
        if (reason === 'pause') {
          this.db
            .prepare(
              `UPDATE task SET status = 'queued', cancel_requested = 0, lease_owner = NULL,
                               lease_expires_at = NULL, updated_at = ?
               WHERE task_id = ?`,
            )
            .run(now, taskId);
          this.insertEvent({
            runId: task.runId,
            phase: task.phase,
            objectId: taskId,
            role: workerId,
            eventType: 'task_reclaimed',
            summary: `${task.type} interrupted by hard pause; returned to queue`,
            status: 'queued',
          });
        } else {
          this.db
            .prepare(
              `UPDATE task SET status = 'canceled', lease_owner = NULL, lease_expires_at = NULL,
                               finished_at = ?, updated_at = ?, error_json = ?
               WHERE task_id = ?`,
            )
            .run(now, now, JSON.stringify(cancelError()), taskId);
          this.insertEvent({
            runId: task.runId,
            phase: task.phase,
            objectId: taskId,
            role: workerId,
            eventType: 'task_canceled',
            summary: `${task.type} canceled`,
            status: 'canceled',
          });
        }
        return this.requireTask(taskId);
      }),
    );
  }

  // ------------------------------------------------------------------ events

  appendEvent(event: NewRunEvent): Promise<RunEvent> {
    return Promise.resolve(this.tx(() => this.insertEvent(event)));
  }

  listEvents(runId: string, opts: ListEventsOptions = {}): Promise<RunEvent[]> {
    const since = opts.since ?? 0;
    const limit = opts.limit ?? 1000;
    const rows = this.db
      .prepare(`SELECT * FROM run_event WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`)
      .all(runId, since, limit) as unknown as EventRow[];
    return Promise.resolve(rows.map(rowToEvent));
  }

  // ------------------------------------------------------- research nodes

  upsertResearchNode(
    input: NewResearchNode,
  ): Promise<{ node: ResearchNode; created: boolean; changed: boolean }> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        const existing = this.db
          .prepare('SELECT * FROM research_node WHERE run_id = ? AND node_id = ?')
          .get(input.runId, input.nodeId) as unknown as ResearchNodeRow | undefined;
        const now = this.clock.now();

        if (existing) {
          const current = rowToResearchNode(existing);
          // 成功节点不重做: a succeeded node is never downgraded to pending by a
          // re-sync. `invalidated` may be applied from any non-terminal status
          // and is sticky afterwards (superseded evidence never revives).
          let nextStatus = input.status;
          let nextReason = input.invalidationReason ?? null;
          if (current.status === 'invalidated') {
            nextStatus = 'invalidated';
            nextReason = current.invalidationReason;
          } else if (current.status === 'succeeded' && nextStatus === 'pending') {
            nextStatus = 'succeeded';
            nextReason = null;
          }
          const changed =
            nextStatus !== current.status ||
            JSON.stringify(input.dependsOn) !== JSON.stringify(current.dependsOn) ||
            JSON.stringify(input.payload) !== JSON.stringify(current.payload) ||
            nextReason !== current.invalidationReason;
          if (!changed) {
            return { node: current, created: false, changed: false };
          }
          this.db
            .prepare(
              `UPDATE research_node
                 SET status = ?, depends_on_json = ?, payload_json = ?, invalidation_reason = ?, updated_at = ?
               WHERE run_id = ? AND node_id = ?`,
            )
            .run(
              nextStatus,
              JSON.stringify(input.dependsOn),
              JSON.stringify(input.payload),
              nextReason,
              now,
              input.runId,
              input.nodeId,
            );
          return {
            node: {
              ...current,
              status: nextStatus,
              invalidationReason: nextReason,
              dependsOn: input.dependsOn,
              payload: input.payload,
              updatedAt: now,
            },
            created: false,
            changed: true,
          };
        }

        this.db
          .prepare(
            `INSERT INTO research_node
               (node_id, run_id, kind, object_id, status, depends_on_json, payload_json,
                invalidation_reason, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.nodeId,
            input.runId,
            input.kind,
            input.objectId,
            input.status,
            JSON.stringify(input.dependsOn),
            JSON.stringify(input.payload),
            input.invalidationReason ?? null,
            now,
            now,
          );
        const row = this.db
          .prepare('SELECT * FROM research_node WHERE run_id = ? AND node_id = ?')
          .get(input.runId, input.nodeId) as unknown as ResearchNodeRow;
        return { node: rowToResearchNode(row), created: true, changed: true };
      }),
    );
  }

  listResearchNodes(
    runId: string,
    filter: { kind?: ResearchNodeKind; status?: ResearchNodeStatus } = {},
  ): Promise<ResearchNode[]> {
    const clauses = ['run_id = ?'];
    const params: (string | number)[] = [runId];
    if (filter.kind !== undefined) {
      clauses.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter.status !== undefined) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM research_node WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC, node_id ASC`,
      )
      .all(...params) as unknown as ResearchNodeRow[];
    return Promise.resolve(rows.map(rowToResearchNode));
  }

  getResearchNode(runId: string, nodeId: string): Promise<ResearchNode | null> {
    const row = this.db
      .prepare('SELECT * FROM research_node WHERE run_id = ? AND node_id = ?')
      .get(runId, nodeId) as unknown as ResearchNodeRow | undefined;
    return Promise.resolve(row ? rowToResearchNode(row) : null);
  }

  // ----------------------------------------------------------------- workers

  registerWorker(input: {
    workerId: string;
    runId: string;
    pid: number;
    kind: WorkerRecord['kind'];
  }): Promise<WorkerRecord> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        const now = this.clock.now();
        this.db
          .prepare(
            `INSERT INTO worker (worker_id, run_id, pid, kind, status, started_at, heartbeat_at)
             VALUES (?, ?, ?, ?, 'active', ?, ?)
             ON CONFLICT (worker_id) DO UPDATE SET status = 'active',
                                                   heartbeat_at = excluded.heartbeat_at`,
          )
          .run(input.workerId, input.runId, input.pid, input.kind, now, now);
        const row = this.db
          .prepare('SELECT * FROM worker WHERE worker_id = ?')
          .get(input.workerId) as unknown as WorkerRow;
        return rowToWorker(row);
      }),
    );
  }

  heartbeatWorker(workerId: string): Promise<void> {
    this.db
      .prepare(`UPDATE worker SET heartbeat_at = ? WHERE worker_id = ? AND status = 'active'`)
      .run(this.clock.now(), workerId);
    return Promise.resolve();
  }

  deregisterWorker(workerId: string): Promise<void> {
    this.db.prepare(`UPDATE worker SET status = 'stopped' WHERE worker_id = ?`).run(workerId);
    return Promise.resolve();
  }

  listWorkers(runId: string, includeStopped = false): Promise<WorkerRecord[]> {
    const sql = includeStopped
      ? 'SELECT * FROM worker WHERE run_id = ? ORDER BY started_at'
      : `SELECT * FROM worker WHERE run_id = ? AND status = 'active' ORDER BY started_at`;
    const rows = this.db.prepare(sql).all(runId) as unknown as WorkerRow[];
    return Promise.resolve(rows.map(rowToWorker));
  }

  // --------------------------------------------------------------- recovery

  reclaimExpiredLeases(
    runId?: string,
  ): Promise<{ reclaimed: string[]; failed: string[]; canceled: string[] }> {
    return Promise.resolve(this.tx(() => this.reclaimExpiredLeasesTx(runId)));
  }

  listInterruptedCommits(runId?: string): Promise<TaskRecord[]> {
    const now = this.clock.now();
    const rows = (runId
      ? this.db
          .prepare(
            `SELECT ${TASK_COLUMNS} FROM task
               WHERE status = 'committing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
                 AND run_id = ?
               ORDER BY created_at`,
          )
          .all(now, runId)
      : this.db
          .prepare(
            `SELECT ${TASK_COLUMNS} FROM task
               WHERE status = 'committing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
               ORDER BY created_at`,
          )
          .all(now)) as unknown as TaskRow[];
    return Promise.resolve(rows.map(rowToTask));
  }

  recoverInterruptedCommit(taskId: string, outcome: 'finalize' | 'requeue'): Promise<TaskRecord> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        const task = this.requireTask(taskId);
        if (task.status !== 'committing') return task; // another actor already resolved it
        const now = this.clock.now();
        if (outcome === 'finalize') {
          const rows = this.db
            .prepare(`SELECT * FROM artifact WHERE task_id = ? AND status = 'staged'`)
            .all(taskId) as unknown as ArtifactRow[];
          if (rows.length === 0) {
            // Staged rows were lost; requeue instead of recording a phantom success.
            return this.requeueInterruptedTx(task, now);
          }
          this.db
            .prepare(
              `UPDATE artifact SET status = 'committed', committed_at = ?, temp_path = NULL
               WHERE task_id = ? AND status = 'staged'`,
            )
            .run(now, taskId);
          this.db
            .prepare(
              `UPDATE task SET status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
                               cancel_requested = 0, finished_at = ?, updated_at = ?
               WHERE task_id = ?`,
            )
            .run(now, now, taskId);
          this.insertEvent({
            runId: task.runId,
            phase: task.phase,
            objectId: taskId,
            eventType: 'task_commit_resumed',
            summary: `${task.type} interrupted commit completed during recovery`,
            status: 'succeeded',
            artifactRefs: rows.map((row) => row.artifact_id),
          });
          this.checkRunCompletion(task.runId);
          return this.requireTask(taskId);
        }
        return this.requeueInterruptedTx(task, now);
      }),
    );
  }

  private requeueInterruptedTx(task: TaskRecord, now: number): TaskRecord {
    this.db
      .prepare(`UPDATE artifact SET status = 'aborted' WHERE task_id = ? AND status = 'staged'`)
      .run(task.taskId);
    const run = this.requireRun(task.runId);
    if (task.cancelRequested || run.status === 'CANCELED') {
      this.db
        .prepare(
          `UPDATE task SET status = 'canceled', lease_owner = NULL, lease_expires_at = NULL,
                           finished_at = ?, updated_at = ?, error_json = ?
           WHERE task_id = ?`,
        )
        .run(now, now, JSON.stringify(cancelError()), task.taskId);
      this.insertEvent({
        runId: task.runId,
        phase: task.phase,
        objectId: task.taskId,
        eventType: 'task_canceled',
        summary: `${task.type} interrupted commit abandoned (cancel requested)`,
        status: 'canceled',
      });
      return this.requireTask(task.taskId);
    }
    if (TERMINAL_RUN_STATUSES.includes(run.status)) {
      this.db
        .prepare(
          `UPDATE task SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
                           finished_at = ?, updated_at = ?, error_json = ?
           WHERE task_id = ?`,
        )
        .run(
          now,
          now,
          JSON.stringify({
            code: 'COMMIT_INTERRUPTED',
            message: `commit interrupted after run reached ${run.status}`,
            retryable: false,
            at: now,
          }),
          task.taskId,
        );
      this.insertEvent({
        runId: task.runId,
        phase: task.phase,
        objectId: task.taskId,
        eventType: 'task_failed',
        summary: `${task.type} interrupted commit abandoned (run ${run.status})`,
        status: 'failed',
      });
      return this.requireTask(task.taskId);
    }
    if (task.attempt >= task.maxAttempts) {
      this.db
        .prepare(
          `UPDATE task SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
                           finished_at = ?, updated_at = ?, error_json = ?
           WHERE task_id = ?`,
        )
        .run(
          now,
          now,
          JSON.stringify({
            code: 'COMMIT_INTERRUPTED',
            message: 'artifact commit kept failing after crash/restart',
            retryable: false,
            at: now,
          }),
          task.taskId,
        );
      this.insertEvent({
        runId: task.runId,
        phase: task.phase,
        objectId: task.taskId,
        eventType: 'task_failed',
        summary: `${task.type} failed: commit interrupted and attempts exhausted`,
        status: 'failed',
      });
      this.cascadeUnrunnableDependents(task.runId, task.taskId);
      this.settleAfterTerminalFailure(task.runId, task);
      return this.requireTask(task.taskId);
    }
    this.db
      .prepare(
        `UPDATE task SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE task_id = ?`,
      )
      .run(now, task.taskId);
    this.insertEvent({
      runId: task.runId,
      phase: task.phase,
      objectId: task.taskId,
      eventType: 'task_commit_interrupted',
      summary: `${task.type} commit interrupted; returned to queue (attempt ${task.attempt}/${task.maxAttempts})`,
      status: 'queued',
    });
    return this.requireTask(task.taskId);
  }

  stopStaleWorkers(maxIdleMs: number): Promise<string[]> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        const cutoff = this.clock.now() - maxIdleMs;
        const stale = this.db
          .prepare(`SELECT worker_id FROM worker WHERE status = 'active' AND heartbeat_at < ?`)
          .all(cutoff) as unknown as { worker_id: string }[];
        if (stale.length === 0) return [];
        this.db
          .prepare(
            `UPDATE worker SET status = 'stopped' WHERE status = 'active' AND heartbeat_at < ?`,
          )
          .run(cutoff);
        return stale.map((row) => row.worker_id);
      }),
    );
  }

  // ---------------------------------------------------------------- internal

  private assertOwner(task: TaskRecord, workerId: string): void {
    if (task.leaseOwner !== workerId) {
      throw new IdeaseekError(
        'LEASE_LOST',
        `worker ${workerId} does not hold the lease of ${task.taskId} (held by ${task.leaseOwner ?? 'nobody'})`,
      );
    }
  }

  private requireRun(runId: string): RunRecord {
    const row = this.db.prepare('SELECT * FROM run WHERE run_id = ?').get(runId) as unknown as
      RunRow | undefined;
    if (!row) throw new IdeaseekError('RUN_NOT_FOUND', `run ${runId} not found`);
    return rowToRun(row);
  }

  private requireTask(taskId: string): TaskRecord {
    const row = this.db
      .prepare(`SELECT ${TASK_COLUMNS} FROM task WHERE task_id = ?`)
      .get(taskId) as TaskRow | undefined;
    if (!row) throw new IdeaseekError('TASK_NOT_FOUND', `task ${taskId} not found`);
    return rowToTask(row);
  }

  private listTasksTx(runId: string): TaskRecord[] {
    const rows = this.db
      .prepare(`SELECT ${TASK_COLUMNS} FROM task WHERE run_id = ? ORDER BY created_at, rowid`)
      .all(runId) as unknown as TaskRow[];
    return rows.map(rowToTask);
  }

  private setRunStatus(
    runId: string,
    status: RunStatus,
    opts: { blockReason: string | null; finished: boolean },
  ): RunRecord {
    const now = this.clock.now();
    this.db
      .prepare(
        `UPDATE run SET status = ?, block_reason = ?, updated_at = ?,
                        finished_at = CASE WHEN ? = 1 THEN ? ELSE finished_at END
         WHERE run_id = ?`,
      )
      .run(status, opts.blockReason, now, boolParam(opts.finished), now, runId);
    return this.requireRun(runId);
  }

  private insertEvent(event: NewRunEvent): RunEvent {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS next FROM run_event WHERE run_id = ?')
      .get(event.runId) as unknown as { next: number };
    const seq = Number(row.next) + 1;
    const record: RunEvent = {
      seq,
      runId: event.runId,
      ts: this.clock.now(),
      phase: event.phase,
      objectId: event.objectId ?? null,
      role: event.role ?? null,
      eventType: event.eventType,
      summary: event.summary,
      status: event.status ?? null,
      artifactRefs: event.artifactRefs ?? [],
    };
    this.db
      .prepare(
        `INSERT INTO run_event
         (run_id, seq, ts, phase, object_id, role, event_type, summary, status, artifact_refs_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.runId,
        record.seq,
        record.ts,
        record.phase,
        record.objectId,
        record.role,
        record.eventType,
        record.summary,
        record.status,
        JSON.stringify(record.artifactRefs),
      );
    return record;
  }

  private reclaimExpiredLeasesTx(runId?: string): {
    reclaimed: string[];
    failed: string[];
    canceled: string[];
  } {
    const now = this.clock.now();
    const rows = (runId
      ? this.db
          .prepare(
            `SELECT ${TASK_COLUMNS} FROM task
               WHERE status IN ('leased', 'running') AND lease_expires_at IS NOT NULL
                 AND lease_expires_at <= ? AND run_id = ?`,
          )
          .all(now, runId)
      : this.db
          .prepare(
            `SELECT ${TASK_COLUMNS} FROM task
               WHERE status IN ('leased', 'running') AND lease_expires_at IS NOT NULL
                 AND lease_expires_at <= ?`,
          )
          .all(now)) as unknown as TaskRow[];

    const reclaimed: string[] = [];
    const failed: string[] = [];
    const canceled: string[] = [];
    for (const row of rows) {
      const task = rowToTask(row);
      if (task.cancelRequested) {
        this.db
          .prepare(
            `UPDATE task SET status = 'canceled', lease_owner = NULL, lease_expires_at = NULL,
                             finished_at = ?, updated_at = ?, error_json = ?
             WHERE task_id = ?`,
          )
          .run(now, now, JSON.stringify(cancelError()), task.taskId);
        canceled.push(task.taskId);
        this.insertEvent({
          runId: task.runId,
          phase: task.phase,
          objectId: task.taskId,
          eventType: 'task_canceled',
          summary: `${task.type} lease expired after cancel request`,
          status: 'canceled',
        });
        continue;
      }
      if (task.attempt >= task.maxAttempts) {
        this.db
          .prepare(
            `UPDATE task SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
                             finished_at = ?, updated_at = ?, error_json = ?
             WHERE task_id = ?`,
          )
          .run(
            now,
            now,
            JSON.stringify({
              code: 'LEASE_EXPIRED',
              message: `lease expired on attempt ${task.attempt}/${task.maxAttempts} (worker crash?)`,
              retryable: false,
              at: now,
            }),
            task.taskId,
          );
        failed.push(task.taskId);
        this.insertEvent({
          runId: task.runId,
          phase: task.phase,
          objectId: task.taskId,
          eventType: 'task_failed',
          summary: `${task.type} lease expired and attempts exhausted`,
          status: 'failed',
        });
        this.cascadeUnrunnableDependents(task.runId, task.taskId);
        this.settleAfterTerminalFailure(task.runId, task);
        continue;
      }
      this.db
        .prepare(
          `UPDATE task SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE task_id = ?`,
        )
        .run(now, task.taskId);
      reclaimed.push(task.taskId);
      this.insertEvent({
        runId: task.runId,
        phase: task.phase,
        objectId: task.taskId,
        eventType: 'task_reclaimed',
        summary: `${task.type} lease expired; returned to queue (attempt ${task.attempt}/${task.maxAttempts})`,
        status: 'queued',
      });
    }
    return { reclaimed, failed, canceled };
  }

  private checkRunCompletion(runId: string): void {
    const run = this.requireRun(runId);
    if (TERMINAL_RUN_STATUSES.includes(run.status)) return;
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS done
         FROM task WHERE run_id = ?`,
      )
      .get(runId) as { total: number; done: number | null };
    const total = Number(row.total);
    const done = Number(row.done ?? 0);
    if (total > 0 && done === total) {
      this.setRunStatus(runId, 'COMPLETED', { blockReason: null, finished: true });
      this.db.prepare('UPDATE run SET phase = ? WHERE run_id = ?').run('COMPLETED', runId);
      this.insertEvent({
        runId,
        phase: 'COMPLETED',
        eventType: 'run_completed',
        summary: `all ${done} task(s) succeeded`,
        status: 'COMPLETED',
      });
      return;
    }
    // Mixed terminal state (some flagged failures, nothing claimable): settle.
    this.settleIdleRun(runId);
  }

  /**
   * A non-blocking failure (payload.nonBlocking, e.g. a corrupt PDF in
   * ingest) must not stop sibling tasks: the run only turns FAILED once
   * nothing remains claimable. Regular failures keep immediate semantics.
   */
  /**
   * Queued dependents of a terminal task can never run: cancel them with
   * DEPENDENCY_FAILED (flagged, not lost) so runs settle instead of stranding
   * queued work whose preconditions are gone (docs: 失败被标记而不是丢失).
   */
  private cascadeUnrunnableDependents(runId: string, terminalTaskId: string): void {
    const now = this.clock.now();
    const error = JSON.stringify({
      code: 'DEPENDENCY_FAILED',
      message: `dependency ${terminalTaskId} no longer runnable`,
      retryable: false,
      at: now,
    });
    const queue = [terminalTaskId];
    while (queue.length > 0) {
      const depId = queue.shift()!;
      const rows = this.db
        .prepare(`SELECT ${TASK_COLUMNS} FROM task WHERE run_id = ? AND status = 'queued'`)
        .all(runId) as unknown as TaskRow[];
      for (const row of rows) {
        const task = rowToTask(row);
        if (!task.dependsOn.includes(depId)) continue;
        this.db
          .prepare(
            `UPDATE task SET status = 'canceled', cancel_requested = 1, finished_at = ?, updated_at = ?, error_json = ? WHERE task_id = ? AND status = 'queued'`,
          )
          .run(now, now, error, task.taskId);
        this.insertEvent({
          runId,
          phase: task.phase,
          objectId: task.taskId,
          eventType: 'task_canceled',
          summary: `${task.type} canceled: dependency no longer runnable`,
          status: 'canceled',
        });
        queue.push(task.taskId);
      }
    }
  }

  private settleAfterTerminalFailure(runId: string, task: TaskRecord): void {
    if (task.payload.nonBlocking !== true) {
      this.checkRunFailure(runId);
      return;
    }
    this.settleIdleRun(runId);
  }

  /** Marks FAILED when every task is terminal and at least one failed. */
  private settleIdleRun(runId: string): void {
    const run = this.requireRun(runId);
    if (TERMINAL_RUN_STATUSES.includes(run.status)) return;
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status IN ('queued','leased','running','committing') THEN 1 ELSE 0 END) AS unfinished,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM task WHERE run_id = ?`,
      )
      .get(runId) as { unfinished: number | null; failed: number | null };
    if (Number(row.unfinished ?? 0) > 0) return;
    if (Number(row.failed ?? 0) > 0) this.checkRunFailure(runId);
  }

  private checkRunFailure(runId: string): void {
    const run = this.requireRun(runId);
    if (TERMINAL_RUN_STATUSES.includes(run.status)) return;
    const row = this.db
      .prepare(
        `SELECT type, error_json FROM task WHERE run_id = ? AND status = 'failed'
         ORDER BY finished_at, rowid LIMIT 1`,
      )
      .get(runId) as unknown as { type: string; error_json: string | null } | undefined;
    if (!row) return;
    const error = parseJson<TaskError | null>(row.error_json, null);
    this.setRunStatus(runId, 'FAILED', { blockReason: null, finished: true });
    this.insertEvent({
      runId,
      phase: run.phase,
      eventType: 'run_failed',
      summary: `run failed: ${row.type} ${error ? `(${error.code})` : ''}`.trim(),
      status: 'FAILED',
    });
  }

  private duplicateCheck(
    task: TaskRecord,
    submitted: { kind: string; contentHash: string }[],
  ): BeginCommitResult {
    const rows = this.db
      .prepare(
        `SELECT kind, content_hash, artifact_id FROM artifact
         WHERE task_id = ? AND status = 'committed'`,
      )
      .all(task.taskId) as unknown as {
      kind: string;
      content_hash: string;
      artifact_id: string;
    }[];
    if (submitted.length > 0) {
      const key = (items: { kind: string; hash: string }[]) =>
        [...items]
          .map((item) => `${item.kind} ${item.hash}`)
          .sort()
          .join('|');
      const stored = key(rows.map((row) => ({ kind: row.kind, hash: row.content_hash })));
      const incoming = key(submitted.map((row) => ({ kind: row.kind, hash: row.contentHash })));
      if (stored !== incoming) {
        throw new IdeaseekError(
          'ALREADY_COMMITTED',
          `task ${task.taskId} already committed with different output`,
          { taskId: task.taskId },
        );
      }
    }
    return { status: 'duplicate', task, artifactIds: rows.map((row) => row.artifact_id) };
  }

  recoverStrandedRuns(): Promise<{ settled: string[] }> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        const runs = this.db
          .prepare("SELECT run_id FROM run WHERE status NOT IN ('FAILED', 'CANCELED', 'COMPLETED')")
          .all() as unknown as { run_id: string }[];
        const settled: string[] = [];
        for (const row of runs) {
          const runId = row.run_id;
          const dead = this.db
            .prepare(
              "SELECT task_id FROM task WHERE run_id = ? AND status IN ('failed', 'canceled')",
            )
            .all(runId) as unknown as { task_id: string }[];
          if (dead.length === 0) continue;
          const queued = this.db
            .prepare("SELECT task_id FROM task WHERE run_id = ? AND status = 'queued'")
            .all(runId) as unknown as { task_id: string }[];
          const deadIds = new Set(dead.map((entry) => entry.task_id));
          const stranded = queued.filter((entry) =>
            this.requireTask(entry.task_id).dependsOn.some((dep) => deadIds.has(dep)),
          );
          if (stranded.length === 0) continue;
          for (const entry of dead) this.cascadeUnrunnableDependents(runId, entry.task_id);
          this.settleIdleRun(runId);
          const after = this.requireRun(runId);
          if (['FAILED', 'COMPLETED', 'CANCELED'].includes(after.status)) settled.push(runId);
        }
        return { settled };
      }),
    );
  }

  upsertEmbedding(row: EmbeddingRowInput): Promise<void> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        const blob = Buffer.from(new Float32Array(row.vector).buffer);
        this.db
          .prepare(
            'INSERT INTO paper_embedding (source_hash, source, page, preview, provider, model_id, dim, vector, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
              'ON CONFLICT(source_hash, provider, model_id, page) DO UPDATE SET preview = excluded.preview, dim = excluded.dim, vector = excluded.vector, created_at = excluded.created_at',
          )
          .run(
            row.sourceHash,
            row.source,
            row.page,
            row.preview,
            row.provider,
            row.modelId,
            row.dim,
            blob,
            row.createdAt,
          );
      }),
    );
  }

  listEmbeddings(provider: string, modelId: string): Promise<EmbeddingRow[]> {
    const rows = this.db
      .prepare('SELECT * FROM paper_embedding WHERE provider = ? AND model_id = ?')
      .all(provider, modelId) as unknown as {
      source: string;
      source_hash: string;
      page: number;
      preview: string;
      vector: Uint8Array;
      dim: number;
    }[];
    return Promise.resolve(
      rows.map((row) => ({
        source: row.source,
        sourceHash: row.source_hash,
        page: row.page,
        preview: row.preview,
        dim: row.dim,
        vector: Array.from(new Float32Array(row.vector.buffer.slice(0), 0, row.dim)),
      })),
    );
  }

  countEmbeddings(provider: string, modelId: string): Promise<number> {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM paper_embedding WHERE provider = ? AND model_id = ?')
      .get(provider, modelId) as { n: number };
    return Promise.resolve(Number(row.n));
  }

  upsertComparison(method: ComparisonDoc): Promise<void> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        this.db
          .prepare(
            'INSERT INTO comparison (method_id, doc_json, status, required, updated_at) VALUES (?, ?, ?, ?, ?) ' +
              'ON CONFLICT(method_id) DO UPDATE SET doc_json = excluded.doc_json, status = excluded.status, required = excluded.required, updated_at = excluded.updated_at',
          )
          .run(
            method.methodId,
            JSON.stringify(method.record),
            method.status,
            method.required ? 1 : 0,
            method.updatedAt,
          );
      }),
    );
  }

  getComparison(methodId: string): Promise<ComparisonDoc | null> {
    const row = this.db.prepare('SELECT * FROM comparison WHERE method_id = ?').get(methodId) as
      | {
          method_id: string;
          doc_json: string;
          status: string;
          required: number;
          updated_at: number;
        }
      | undefined;
    if (!row) return Promise.resolve(null);
    return Promise.resolve({
      methodId: row.method_id,
      status: row.status,
      required: row.required === 1,
      record: parseJson<Record<string, unknown>>(row.doc_json, {}),
      updatedAt: row.updated_at,
    });
  }

  listComparisons(filter: { required?: boolean } = {}): Promise<ComparisonDoc[]> {
    let sql = 'SELECT * FROM comparison';
    const params: number[] = [];
    if (filter.required !== undefined) {
      sql += ' WHERE required = ?';
      params.push(filter.required ? 1 : 0);
    }
    sql += ' ORDER BY method_id';
    const rows = this.db.prepare(sql).all(...params) as unknown as {
      method_id: string;
      doc_json: string;
      status: string;
      required: number;
      updated_at: number;
    }[];
    return Promise.resolve(
      rows.map((row) => ({
        methodId: row.method_id,
        status: row.status,
        required: row.required === 1,
        record: parseJson<Record<string, unknown>>(row.doc_json, {}),
        updatedAt: row.updated_at,
      })),
    );
  }

  transitionComparison(methodId: string, to: string, reason?: string): Promise<ComparisonDoc> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        const current = this.requireComparison(methodId);
        const from = current.status as ComparisonStatus;
        assertTransition(from, to as ComparisonStatus, reason);
        const now = this.clock.now();
        const history = Array.isArray(current.record.history)
          ? (current.record.history as {
              at: number;
              from: string;
              to: string;
              reason: string | null;
            }[])
          : [];
        history.push({ at: now, from, to, reason: reason ?? null });
        const record = {
          ...current.record,
          status: to,
          statusReason: reason ?? null,
          history,
          updatedAt: now,
        };
        this.db
          .prepare(
            'UPDATE comparison SET status = ?, doc_json = ?, updated_at = ? WHERE method_id = ?',
          )
          .run(to, JSON.stringify(record), now, methodId);
        return this.requireComparison(methodId);
      }),
    );
  }
  private requireComparison(methodId: string): ComparisonDoc {
    const row = this.db.prepare('SELECT * FROM comparison WHERE method_id = ?').get(methodId) as
      | {
          method_id: string;
          doc_json: string;
          status: string;
          required: number;
          updated_at: number;
        }
      | undefined;
    if (!row) throw new IdeaseekError('TASK_NOT_FOUND', `comparison ${methodId} not found`);
    return {
      methodId: row.method_id,
      status: row.status,
      required: row.required === 1,
      record: parseJson<Record<string, unknown>>(row.doc_json, {}),
      updatedAt: row.updated_at,
    };
  }

  private rowToExperiment(row: {
    spec_id: string;
    version: number;
    spec_hash: string;
    status: string;
    spec_json: string;
    result_json: string | null;
    updated_at: number;
  }): ExperimentDoc {
    return {
      specId: row.spec_id,
      version: row.version,
      specHash: row.spec_hash,
      status: row.status as ExperimentDoc['status'],
      spec: parseJson<Record<string, unknown>>(row.spec_json, {}),
      result: row.result_json
        ? parseJson<Record<string, unknown> | null>(row.result_json, null)
        : null,
      updatedAt: row.updated_at,
    };
  }

  private requireExperiment(specId: string): ExperimentDoc {
    const row = this.db.prepare('SELECT * FROM experiment WHERE spec_id = ?').get(specId) as
      | {
          spec_id: string;
          version: number;
          spec_hash: string;
          status: string;
          spec_json: string;
          result_json: string | null;
          updated_at: number;
        }
      | undefined;
    if (!row) throw new IdeaseekError('TASK_NOT_FOUND', `experiment ${specId} not found`);
    return this.rowToExperiment(row);
  }

  upsertExperiment(doc: ExperimentDoc): Promise<void> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        const existing = this.db
          .prepare('SELECT version, spec_hash FROM experiment WHERE spec_id = ?')
          .get(doc.specId) as { version: number; spec_hash: string } | undefined;
        if (existing) {
          if (existing.spec_hash === doc.specHash) {
            // Idempotent re-record of the identical spec: refresh timestamp only.
            this.db
              .prepare('UPDATE experiment SET updated_at = ? WHERE spec_id = ?')
              .run(doc.updatedAt, doc.specId);
            return;
          }
          if (doc.version <= existing.version) {
            throw new IdeaseekError(
              'INVALID_ARGUMENT',
              `spec ${doc.specId} already recorded at version ${existing.version} with a different hash; bump version to ${existing.version + 1}`,
              { specId: doc.specId, existingVersion: existing.version },
            );
          }
        }
        this.db
          .prepare(
            'INSERT INTO experiment (spec_id, version, spec_hash, status, spec_json, result_json, updated_at) ' +
              'VALUES (?, ?, ?, ?, ?, ?, ?) ' +
              'ON CONFLICT(spec_id) DO UPDATE SET version = excluded.version, spec_hash = excluded.spec_hash, ' +
              'status = excluded.status, spec_json = excluded.spec_json, result_json = excluded.result_json, updated_at = excluded.updated_at',
          )
          .run(
            doc.specId,
            doc.version,
            doc.specHash,
            doc.status,
            JSON.stringify(doc.spec),
            doc.result ? JSON.stringify(doc.result) : null,
            doc.updatedAt,
          );
      }),
    );
  }

  getExperiment(specId: string): Promise<ExperimentDoc | null> {
    const row = this.db.prepare('SELECT * FROM experiment WHERE spec_id = ?').get(specId) as
      | {
          spec_id: string;
          version: number;
          spec_hash: string;
          status: string;
          spec_json: string;
          result_json: string | null;
          updated_at: number;
        }
      | undefined;
    return Promise.resolve(row ? this.rowToExperiment(row) : null);
  }

  listExperiments(filter: { status?: ExperimentDoc['status'] } = {}): Promise<ExperimentDoc[]> {
    let sql = 'SELECT * FROM experiment';
    const params: string[] = [];
    if (filter.status !== undefined) {
      sql += ' WHERE status = ?';
      params.push(filter.status);
    }
    sql += ' ORDER BY spec_id';
    const rows = this.db.prepare(sql).all(...params) as unknown as {
      spec_id: string;
      version: number;
      spec_hash: string;
      status: string;
      spec_json: string;
      result_json: string | null;
      updated_at: number;
    }[];
    return Promise.resolve(rows.map((row) => this.rowToExperiment(row)));
  }

  attachExperimentResult(
    specId: string,
    result: Record<string, unknown>,
    status: Exclude<ExperimentDoc['status'], 'planned'>,
  ): Promise<ExperimentDoc> {
    return Promise.resolve().then(() =>
      this.tx(() => {
        const current = this.requireExperiment(specId);
        if (current.result) {
          throw new IdeaseekError(
            'ALREADY_COMMITTED',
            `experiment ${specId} already has a result (status ${current.status}); record a new spec version instead`,
            { specId },
          );
        }
        const now = Date.now();
        this.db
          .prepare(
            'UPDATE experiment SET status = ?, result_json = ?, updated_at = ? WHERE spec_id = ?',
          )
          .run(status, JSON.stringify(result), now, specId);
        return this.requireExperiment(specId);
      }),
    );
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
    return Promise.resolve();
  }
}
