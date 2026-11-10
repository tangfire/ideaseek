/**
 * Structured error taxonomy for IdeaSeek. Codes are stable: CLI exit-code
 * mapping, tests and future worker protocols rely on them. Never embed
 * secrets in `message` or `details`.
 */
export type IdeaseekErrorCode =
  | 'NOT_INITIALIZED'
  | 'ALREADY_INITIALIZED'
  | 'PROJECT_NOT_FOUND'
  | 'RUN_NOT_FOUND'
  | 'RUN_TERMINAL'
  | 'RUN_NOT_ACTIVE'
  | 'RUN_BLOCKED'
  | 'TASK_NOT_FOUND'
  | 'TASK_TERMINAL'
  | 'TASK_CANCELED'
  | 'STALE_ATTEMPT'
  | 'LEASE_LOST'
  | 'INVALID_STATE'
  | 'ALREADY_COMMITTED'
  | 'OUTPUT_HASH_MISMATCH'
  | 'INVALID_ARTIFACT'
  | 'DEPENDENCY_NOT_MET'
  | 'INVALID_ARGUMENT'
  | 'USER_INPUT_REQUIRED'
  | 'QUOTA_EXHAUSTED'
  | 'AUTH_REQUIRED'
  | 'NETWORK_BLOCKED'
  | 'INTERNAL';

export class IdeaseekError extends Error {
  readonly code: IdeaseekErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: IdeaseekErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'IdeaseekError';
    this.code = code;
    this.details = details;
  }
}

export function isIdeaseekError(error: unknown): error is IdeaseekError {
  return error instanceof IdeaseekError;
}

/** Exit codes defined by docs/CLI_SPEC.md. */
export const EXIT_OK = 0;
export const EXIT_TASK_FAILED = 1;
export const EXIT_USER_INPUT = 2;
export const EXIT_STILL_RUNNING = 3;
export const EXIT_CANCELED = 4;
export const EXIT_ENV_UNSUPPORTED = 5;

export function exitCodeForError(error: unknown): number {
  if (!isIdeaseekError(error)) return EXIT_TASK_FAILED;
  switch (error.code) {
    case 'NOT_INITIALIZED':
    case 'PROJECT_NOT_FOUND':
    case 'USER_INPUT_REQUIRED':
    case 'QUOTA_EXHAUSTED':
    case 'AUTH_REQUIRED':
    case 'NETWORK_BLOCKED':
      return EXIT_USER_INPUT;
    case 'INVALID_ARGUMENT':
    case 'ALREADY_INITIALIZED':
    case 'RUN_NOT_ACTIVE':
    case 'RUN_BLOCKED':
      return EXIT_USER_INPUT;
    case 'TASK_CANCELED':
      return EXIT_CANCELED;
    case 'RUN_TERMINAL':
    case 'TASK_TERMINAL':
    case 'INVALID_STATE':
    case 'OUTPUT_HASH_MISMATCH':
    case 'ALREADY_COMMITTED':
    case 'STALE_ATTEMPT':
    case 'LEASE_LOST':
      return EXIT_TASK_FAILED;
    default:
      return EXIT_TASK_FAILED;
  }
}
