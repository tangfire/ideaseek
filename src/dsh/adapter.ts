/**
 * HarnessAdapter boundary (docs/ARCHITECTURE.md): the research workflow talks
 * to an Agent Runtime only through this interface, so a DSH upgrade replaces
 * the implementation, never the callers. Two implementations exist:
 * `DshHarnessAdapter` (real DSH via its public SDK/plugin APIs) and
 * `FakeHarnessAdapter` (deterministic, no model, used by tests and by
 * `--fake-harness` runs).
 *
 * Hard rules encoded here:
 * - No method receives credentials; auth lives in the runtime's credential
 *   store and IdeaSeek only references it by name.
 * - Events are summaries suitable for RunEvent persistence: never raw prompts,
 *   never chain-of-thought, never secret material.
 * - Quota/auth/network failures surface as typed `HarnessBlockError` so the
 *   workflow can park the run in QUOTA_EXHAUSTED/AUTH_REQUIRED/NETWORK_BLOCKED
 *   and resume later without redoing successful work.
 */

export type HarnessProfile =
  | 'paper-extractor'
  | 'evidence-checker'
  | 'synthesis-analyst'
  | 'dataset-discovery'
  | 'idea-generator'
  | 'paper-planner'
  | 'experiment-designer'
  | 'reviewer'
  | 'demo';

export interface HarnessTextInput {
  kind: 'text';
  name: string;
  content: string;
}

export interface HarnessImageInput {
  kind: 'image';
  name: string;
  /** Canonical base64 (no data: prefix) of a PNG/JPEG/WebP/GIF raster. */
  data: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  /**
   * Provenance echoed into analysis results (paper hash / page / figure
   * id) — stamped by the platform, never trusted from model output.
   */
  source?: { paperHash?: string; page?: number; figureId?: string };
}

export interface HarnessBudget {
  timeoutMs: number;
  maxOutputTokens?: number;
}

export interface HarnessTaskRequest {
  /** Workflow correlation ids (persisted with the result for provenance). */
  runId: string;
  taskId: string;
  /** Capability profile selecting tools, paths and model route. */
  profile: HarnessProfile;
  /** Structured instruction; must never contain secrets. */
  instruction: string;
  /**
   * Input fragments. Backward compatible: text inputs behave exactly as
   * before; image inputs (Phase 2 vision slice) are canonical-base64
   * rasters that the DSH adapter forwards as SDK image blocks ONLY when
   * the routed model declares image capability.
   */
  inputs: (HarnessTextInput | HarnessImageInput)[];
  /** Expected structured output schema id, e.g. 'papercard-v1'. */
  outputSchema: string;
  budget: HarnessBudget;
  /** Stable key so a retried workflow task maps to one logical agent call. */
  idempotencyKey: string;
}

/** Text input at `index` among TEXT inputs only (image blocks never count). */
export function textInputAt(request: HarnessTaskRequest, index: number): string | undefined {
  const texts = request.inputs.filter((input): input is HarnessTextInput => input.kind === 'text');
  return texts[index]?.content;
}

/** First text input, or '' — the common fake/real context lookup. */
export function firstTextInput(request: HarnessTaskRequest): string {
  return textInputAt(request, 0) ?? '';
}

export interface HarnessUsage {
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
}

export type HarnessToolCallSummary = {
  tool: string;
  /** Short, sanitized argument summary (no secrets, no full file contents). */
  summary: string;
  ok: boolean;
};

export interface HarnessTaskResult {
  runId: string;
  taskId: string;
  /** The agent's structured output (JSON string) matching outputSchema. */
  output: string;
  usage: HarnessUsage;
  model: string | null;
  toolCalls: HarnessToolCallSummary[];
  /** Adapter-level provenance: which runtime executed the call. */
  runtime: { kind: 'dsh' | 'fake'; version: string };
  /** DSH session id when the runtime kept one (null for the fake adapter). */
  sessionId?: string | null;
  finishedAt: number;
}

export type HarnessEventType = 'started' | 'tool_call' | 'completed' | 'blocked';

export interface HarnessEvent {
  type: HarnessEventType;
  ts: number;
  runId: string;
  taskId: string;
  /** Human-readable, secret-free summary safe to persist as a RunEvent. */
  summary: string;
  toolCall?: HarnessToolCallSummary;
}

/** External condition (quota/auth/network) — never a scientific failure. */
export class HarnessBlockError extends Error {
  readonly block: 'QUOTA_EXHAUSTED' | 'AUTH_REQUIRED' | 'NETWORK_BLOCKED';
  readonly details: Record<string, unknown> | undefined;

  constructor(
    block: 'QUOTA_EXHAUSTED' | 'AUTH_REQUIRED' | 'NETWORK_BLOCKED',
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HarnessBlockError';
    this.block = block;
    this.details = details;
  }
}

export function isHarnessBlockError(error: unknown): error is HarnessBlockError {
  return error instanceof HarnessBlockError;
}

export interface HarnessHealth {
  reachable: boolean;
  /** Model/provider connectivity as reported by the runtime (no secrets). */
  models: { name: string; available: boolean; detail: string }[];
  blocked: boolean;
  blockReason: string | null;
}

export interface HarnessAdapter {
  readonly kind: 'dsh' | 'fake';
  /** e.g. pinned DSH commit or 'fake-1'. */
  readonly version: string;
  initialize(): Promise<void>;
  /**
   * Executes one structured agent task. Rejects with `HarnessBlockError` for
   * external conditions and ordinary `Error` for task-level failures.
   */
  runTask(
    request: HarnessTaskRequest,
    onEvent?: (event: HarnessEvent) => void,
    signal?: AbortSignal,
  ): Promise<HarnessTaskResult>;
  health(): Promise<HarnessHealth>;
  shutdown(): Promise<void>;
}
