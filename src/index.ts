/**
 * Library entry point: everything the CLI uses, exported so tests and future
 * DSH plugins (Phase 1 HarnessAdapter) can drive the workflow engine
 * in-process without spawning the binary.
 */
export { ProjectRuntime, type OpenRuntimeOptions } from './workflow/runtime.js';
export { SqliteWorkflowDb, relPathForHash } from './workflow/sqlite.js';
export type {
  BeginCommitResult,
  CreateRunInput,
  ListEventsOptions,
  NewRunEvent,
  ProjectRecord,
  WorkflowDb,
} from './workflow/db.js';
export * from './workflow/types.js';
export { ArtifactStore, type StagedArtifact } from './artifact/store.js';
export { FakeWorker, type FakeWorkerOptions, type WorkerExit } from './worker/worker.js';
export { demoHandlers } from './worker/handlers.js';
export type { FaultSpec, TaskContext, TaskHandler, HandlerOutput } from './worker/types.js';
export { IdeaseekError, isIdeaseekError, exitCodeForError } from './core/errors.js';
export { ManualClock, systemClock, type Clock } from './core/clock.js';
export { sha256Of, sha256OfFile, type ContentHash } from './core/hash.js';
export { findProjectRoot, projectPaths, type ProjectPaths } from './config/paths.js';
export { loadConfig, defaultConfig, type ResolvedConfig } from './config/config.js';
export { buildProgram, runCli } from './cli.js';
