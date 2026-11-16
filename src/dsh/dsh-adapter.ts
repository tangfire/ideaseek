import { mkdir } from 'node:fs/promises';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import type { RunResult } from '@deepseek-ai/dsh-sdk-client';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { SdkPromptContentBlock } from '@deepseek-ai/dsh-sdk-protocol';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { writeCapabilityPatch } from './capability.js';
import {
  HarnessBlockError,
  type HarnessAdapter,
  type HarnessEvent,
  type HarnessHealth,
  type HarnessTaskRequest,
  type HarnessTaskResult,
  type HarnessToolCallSummary,
} from './adapter.js';

/** Must match package.json (guarded by tests/runtime-lock.test.ts). */
export const DSH_SDK_VERSION = '0.2.2-rc.1';

/**
 * Default output ceiling, set at harness spawn. One constant because the
 * error text has to name the same number the harness actually used; two
 * literals here would drift and the message would lie.
 */
export const DEFAULT_DSH_MAX_TOKENS = 16_384;

/** Handshake bound when the caller does not set one; env-overridable. */
export const DEFAULT_DSH_INITIALIZE_TIMEOUT_MS = 30_000;

/**
 * Resolve the handshake bound, from the environment if the operator set one.
 *
 * An unparseable value is not silently trusted with a number: the point of the
 * knob is slow machines, and a typo that turned the bound into NaN would hang
 * the handshake instead of bounding it.
 */
export function dshInitializeTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
  fallback = DEFAULT_DSH_INITIALIZE_TIMEOUT_MS,
): number {
  const raw = env.IDEASEEK_DSH_INIT_TIMEOUT_MS;
  if (!raw || !raw.trim()) return fallback;
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) && parsed >= 1_000 && parsed <= 600_000
    ? Math.floor(parsed)
    : fallback;
}

export interface DshAdapterOptions {
  /** DSH home for this project (sessions, profiles): <project>/.research/dsh-home. */
  dshHome: string;
  cwd?: string;
  /** Ordered Cordis patch files layered over the `sdk` profile. */
  patches?: string[];
  provider?: string;
  model?: string;
  /** Env var NAME whose presence is checked; the value is never read into IdeaSeek. */
  apiKeyEnv?: string;
  /** Handshake/launch bound; the per-task bound comes from the task budget. */
  initializeTimeoutMs?: number;
  /**
   * File path for the raw text of a response that failed to parse, set from
   * IDEASEEK_DSH_RAW. Opt-in by the operator: the alternative is arguing about
   * what the model returned.
   */
  rawCapturePath?: string;
  /**
   * Project root exposed to tools as the sandbox workspace and to
   * project_read as IDEASEEK_WORKSPACE_ROOT. Defaults to `cwd`.
   */
  workspaceRoot?: string;
  /**
   * Load the generated IdeaSeek capability patch (research tool + extractor
   * preset with tool allowlist). Default true; tests may disable it.
   */
  capabilityPatch?: boolean;
  /** Per-request model output cap (DSH sets this at spawn; default 4096). */
  maxOutputTokens?: number;
  /** deepseek reasoning effort: off (default) keeps output inside the JSON cap. */
  reasoningEffort?: string;
}

/** Stable DSH LlmFailure.code → IdeaSeek handling (docs: never parse messages). */
export type LlmFailureDisposition =
  | { kind: 'block'; block: 'QUOTA_EXHAUSTED' | 'AUTH_REQUIRED' | 'NETWORK_BLOCKED' }
  | { kind: 'retryable' }
  | { kind: 'permanent' };

export function mapLlmFailureCode(code: string): LlmFailureDisposition {
  switch (code) {
    case 'QUOTA':
    case 'ACCOUNT_QUOTA':
      return { kind: 'block', block: 'QUOTA_EXHAUSTED' };
    case 'AUTH':
    case 'MISSING_CREDENTIAL':
    case 'INVALID_CREDENTIAL':
      return { kind: 'block', block: 'AUTH_REQUIRED' };
    case 'TRANSPORT':
      return { kind: 'block', block: 'NETWORK_BLOCKED' };
    case 'RATE_LIMIT':
    case 'SERVER':
    case 'TIMEOUT':
    case 'EMPTY_RESPONSE':
      return { kind: 'retryable' };
    case 'CONTEXT_WINDOW_EXCEEDED':
    case 'IMAGE_OFFLOAD_REQUIRED':
      return { kind: 'permanent' };
    default:
      return { kind: 'retryable' };
  }
}

interface LlmFailure {
  code?: string;
  message?: string;
}

/**
 * Extracts the typed failure from a failed RunResult: the terminal signal is
 * `turn/end` with `reason.kind === 'error'` carrying `LlmFailure`. Falls back
 * to a code-looking token in the diagnostic text only when no event exists.
 */
export function findLlmFailure(result: RunResult): LlmFailure | null {
  for (const event of result.events ?? []) {
    const typed = event as unknown as { type: string; data?: Record<string, unknown> };
    if (typed.type !== 'turn/end') continue;
    const reason = typed.data?.reason as { kind?: string; error?: LlmFailure } | undefined;
    if (reason?.kind === 'error' && reason.error) return reason.error;
  }
  const knownCodes = [
    'ACCOUNT_QUOTA',
    'QUOTA',
    'RATE_LIMIT',
    'AUTH',
    'MISSING_CREDENTIAL',
    'INVALID_CREDENTIAL',
    'SERVER',
    'TIMEOUT',
    'TRANSPORT',
    'EMPTY_RESPONSE',
    'CONTEXT_WINDOW_EXCEEDED',
    'IMAGE_OFFLOAD_REQUIRED',
  ];
  for (const code of knownCodes) {
    if (new RegExp(`\\b${code}\\b`).test(result.finalResponse ?? '')) {
      return { code, message: result.finalResponse.slice(0, 300) };
    }
  }
  return null;
}

/** Pulls the first JSON object out of a model response (plain or fenced). */
export function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const body = candidate.slice(start, end + 1);
  try {
    JSON.parse(body);
    return body;
  } catch {
    return null;
  }
}

/**
 * Why JSON extraction failed, in terms an operator can act on. Reporting
 * "did not contain a JSON object" for a response that clearly does is worse
 * than useless: the common cause is truncation at the harness output limit,
 * which the request's budget.maxOutputTokens does not control (it is set at
 * spawn time), so the message has to name the real ceiling.
 */
/**
 * Why a response that should be JSON was not usable — stated only as far as
 * the evidence goes.
 *
 * The first version of this said "most likely truncated" for every failure,
 * including the one that started this: 20205 characters with
 * finishReason=completed, i.e. the harness reported a normal end. A guess that
 * names a number sends the reader off to raise a token cap that was never the
 * problem, so the finish reason now decides what may be claimed, and the tail
 * is shown next to the head because trailing prose and an unterminated string
 * look nothing alike.
 */
/**
 * Naming the cap that cut a turn off. Kept as one function because the number
 * in the message has to be the number the harness actually used: two literals
 * here would drift and the message would then lie about the limit it is
 * blaming.
 */
export function describeTruncation(finishReason: string, maxTokens: number): string {
  return (
    `dsh response was truncated by the output token cap (finishReason=${finishReason}, ` +
    `maxTokens=${maxTokens}, set at spawn). The requested artifact does not fit in one response: ` +
    'shrink it, split it across turns, or move the bulk of it into a session that can write ' +
    'files instead of returning them.'
  );
}

export function describeJsonFailure(
  text: string,
  maxTokens: number,
  finishReason?: string,
): string {
  const trimmed = text.trim();
  if (!trimmed.includes('{')) return 'the response contains no JSON object';
  const size = `Received ${trimmed.length} characters (output cap maxTokens=${maxTokens}, set at spawn).`;
  if (finishReason === 'length') {
    return (
      `the response was cut off at the output cap: ${size} It begins like JSON and ends ` +
      `mid-structure: …${trimmed.slice(-120)}`
    );
  }
  return (
    `the response is not valid JSON although the harness reported no length limit ` +
    `(finishReason=${finishReason ?? 'unknown'}); ${size} Causes to rule out in order: prose ` +
    `before or after the object, an unescaped quote or newline inside a string value, or ` +
    `several JSON objects concatenated. head: ${trimmed.slice(0, 160)} … tail: ${trimmed.slice(-160)}`
  );
}

async function captureFailedResponse(path: string | undefined, text: string): Promise<void> {
  if (!path || !text) return;
  try {
    const { writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, 'utf8');
  } catch {
    // Diagnostics must never be the reason a command fails.
  }
}

function collectToolCalls(events: SessionEvent[]): HarnessToolCallSummary[] {
  const calls: HarnessToolCallSummary[] = [];
  for (const event of events ?? []) {
    const typed = event as unknown as { type: string; data?: Record<string, unknown> };
    if (typed.type !== 'tool/call') continue;
    const data = typed.data ?? {};
    const args = JSON.stringify(data.arguments ?? {});
    calls.push({
      tool: String(data.name ?? 'unknown'),
      summary: args.length > 200 ? `${args.slice(0, 200)}…` : args,
      ok: true,
    });
  }
  return calls;
}

function composeInput(request: HarnessTaskRequest): string | SdkPromptContentBlock[] {
  const textInputs = request.inputs.filter((input) => input.kind === 'text');
  const imageInputs = request.inputs.filter((input) => input.kind === 'image');
  const inputs = textInputs
    .map(
      (input) => `### ${input.name}
${input.content}`,
    )
    .join('\\n');
  const text = [
    request.instruction,
    '',
    '## Inputs',
    inputs || '(none)',
    '',
    '## Output contract',
    `Return ONLY a JSON object matching schema "${request.outputSchema}".`,
    'No prose, no markdown fences, no commentary outside the JSON.',
  ].join('\\n');
  // No images → the exact string path (byte-identical to the text-only
  // behavior). Images → SDK content blocks; the DSH admission validates
  // and normalizes them into the durable attachment store, and the
  // provider refuses text-only models with a typed failure the caller
  // degrades on.
  if (imageInputs.length === 0) return text;
  return [
    { type: 'text', text },
    ...imageInputs.map((input) => ({
      type: 'image' as const,
      data: input.data,
      mimeType: input.mimeType,
      name: input.name,
    })),
  ];
}

/**
 * Real DSH adapter: spawns the pinned `@deepseek-ai/dsh` runtime as a child
 * process over the public JSON-RPC SDK (`DeepSeekHarness`, profile `sdk`) and
 * translates RunResults into the HarnessAdapter contract.
 *
 * Boundaries honored here:
 * - Credentials stay in the DSH provider: IdeaSeek only checks whether the
 *   configured env NAME is set and never reads or forwards its value.
 * - DSH has no cancel RPC: a timed-out task closes the runtime (documented
 *   SDK limitation) and surfaces a retryable error; the next call respawns.
 * - Quota/auth/network are typed blocks (attempt not burned); model output is
 *   validated as JSON before anything is committed.
 */
export class DshHarnessAdapter implements HarnessAdapter {
  readonly kind = 'dsh' as const;
  readonly version = `dsh-sdk@${DSH_SDK_VERSION}`;

  private readonly opts: DshAdapterOptions;
  private harness: DeepSeekHarness | null = null;
  private startPromise: Promise<void> | null = null;

  constructor(opts: DshAdapterOptions) {
    this.opts = opts;
  }

  private get apiKeyEnv(): string {
    return this.opts.apiKeyEnv ?? 'DEEPSEEK_API_KEY';
  }

  async initialize(): Promise<void> {
    await mkdir(this.opts.dshHome, { recursive: true });
    if (this.harness && this.startPromise) {
      await this.startPromise;
      return;
    }
    const projectRoot = this.opts.workspaceRoot ?? this.opts.cwd ?? process.cwd();
    let patches = this.opts.patches ?? [];
    if (this.opts.capabilityPatch !== false && patches.length === 0) {
      const capability = await writeCapabilityPatch({ dshHome: this.opts.dshHome });
      patches = [capability.patchPath];
    }
    // Child env: inherit the parent (the DSH provider reads the credential env
    // itself) and add only non-secret policy variables. `env` replaces the
    // whole environment, so pass a merged copy.
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_PERMISSION_MODE: 'read-only',
      IDEASEEK_WORKSPACE_ROOT: projectRoot,
    };
    const harness = new DeepSeekHarness({
      dshHome: this.opts.dshHome,
      cwd: projectRoot,
      processCwd: projectRoot,
      env: childEnv,
      patches,
      provider: this.opts.provider ?? 'deepseek-official',
      model: this.opts.model ?? 'deepseek-v4-flash',
      // Output cap is a ceiling, not an allocation: raising it costs nothing
      // unless a response is actually long. It is fixed at spawn, so a
      // request's budget.maxOutputTokens cannot lift it — which the failure
      // text now says only when finishReason actually reports a length cut.
      maxTokens: this.opts.maxOutputTokens ?? DEFAULT_DSH_MAX_TOKENS,
      reasoningEffort: ReasoningEffortId(this.opts.reasoningEffort ?? 'off'),
      // The handshake bound is configurable because it is a machine property,
      // not a protocol one: a loaded box (concurrent builds, installs and
      // LaTeX runs) made a real figure session fail with
      // `initialize timed out after 15000ms waiting for dsh profile "sdk"`,
      // whose message blames a missing install when the actual cause was
      // contention. 30s default, overridable for slow environments.
      initializeTimeoutMs: this.opts.initializeTimeoutMs ?? dshInitializeTimeoutMs(),
    });
    this.harness = harness;
    this.startPromise = harness.start();
    try {
      await this.startPromise;
    } catch (error) {
      // A failed handshake must not leave a half-started client behind.
      this.harness = null;
      this.startPromise = null;
      await harness.close().catch(() => undefined);
      throw new Error(
        `failed to start DSH runtime (is @deepseek-ai/dsh ${DSH_SDK_VERSION} installed?): ${(error as Error).message}`,
        { cause: error },
      );
    }
  }

  async runTask(
    request: HarnessTaskRequest,
    onEvent?: (event: HarnessEvent) => void,
    signal?: AbortSignal,
  ): Promise<HarnessTaskResult> {
    await this.initialize();
    const harness = this.harness;
    if (!harness) throw new Error('DSH runtime unavailable after initialize()');

    onEvent?.({
      type: 'started',
      ts: Date.now(),
      runId: request.runId,
      taskId: request.taskId,
      summary: `dsh ${request.profile} started (${request.outputSchema})`,
    });

    let result: RunResult;
    try {
      result = await this.withTimeout(
        harness.run(composeInput(request)),
        request.budget.timeoutMs,
        signal,
      );
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      // Timeout/abort cannot cancel a turn over the SDK: reap the runtime.
      await this.shutdown().catch(() => undefined);
      throw error;
    }

    // A turn that ended at the output cap is its own failure mode, and it has
    // to be named before the generic error path: DSH reports max-tokens as an
    // error status without an LlmFailure code, so this surfaced as
    // `dsh UNKNOWN` — indistinguishable from a provider outage — while the
    // actual finding was "the artifact you asked for does not fit in one
    // response". We never set maxTokensAsSuccess, so this reason is always an
    // error on our side of the boundary.
    if (result.finishReason === 'max-tokens' || result.finishReason === 'length') {
      throw new Error(
        describeTruncation(
          result.finishReason,
          this.opts.maxOutputTokens ?? DEFAULT_DSH_MAX_TOKENS,
        ),
      );
    }

    if (result.finishReason === 'error') {
      const failure = findLlmFailure(result);
      const code = failure?.code ?? 'UNKNOWN';
      const message = (failure?.message ?? result.finalResponse.slice(0, 300)) || 'dsh turn failed';
      const disposition = mapLlmFailureCode(code);
      if (disposition.kind === 'block') {
        throw new HarnessBlockError(disposition.block, `dsh ${code}: ${message}`, { code });
      }
      const taskError = new Error(`dsh ${code}: ${message}`);
      if (disposition.kind === 'permanent') {
        (taskError as Error & { permanent?: boolean }).permanent = true;
      }
      throw taskError;
    }

    const json = extractJson(result.finalResponse);
    if (!json) {
      const reason = result.finishReason ?? 'null';
      // Same escape hatch that settled the implementation-generation question:
      // without the bytes the model actually returned, every explanation of a
      // malformed response is a guess — including mine.
      await captureFailedResponse(this.opts.rawCapturePath, result.finalResponse ?? '');
      if (reason === 'length' || reason === 'max-tokens') {
        // Same wording as the pre-JSON branch: two messages for one cause
        // drift, and this one named no cap at all — the number the earlier
        // investigation existed to pin down.
        throw new Error(
          describeTruncation(reason, this.opts.maxOutputTokens ?? DEFAULT_DSH_MAX_TOKENS),
        );
      }
      throw new Error(
        `dsh response did not yield usable JSON (finishReason=${reason}): ${describeJsonFailure(
          result.finalResponse ?? '',
          this.opts.maxOutputTokens ?? DEFAULT_DSH_MAX_TOKENS,
          reason,
        )}`,
      );
    }

    onEvent?.({
      type: 'completed',
      ts: Date.now(),
      runId: request.runId,
      taskId: request.taskId,
      summary: `dsh produced ${request.outputSchema} output (session ${result.sessionId})`,
    });

    return {
      runId: request.runId,
      taskId: request.taskId,
      output: json,
      usage: extractUsage(result),
      model: this.opts.model ?? 'deepseek-v4-flash',
      toolCalls: collectToolCalls(result.events),
      runtime: { kind: 'dsh', version: this.version },
      finishedAt: Date.now(),
      sessionId: result.sessionId,
    };
  }

  async health(): Promise<HarnessHealth> {
    const keySet = Boolean(process.env[this.apiKeyEnv]);
    return {
      reachable: this.harness != null,
      models: [
        {
          name: this.opts.model ?? 'deepseek-v4-flash',
          available: keySet,
          detail: keySet
            ? `${this.apiKeyEnv} is set (value never read by IdeaSeek)`
            : `${this.apiKeyEnv} is not set`,
        },
      ],
      blocked: !keySet,
      blockReason: keySet ? null : `missing credential reference: env ${this.apiKeyEnv}`,
    };
  }

  async shutdown(): Promise<void> {
    const harness = this.harness;
    this.harness = null;
    this.startPromise = null;
    if (harness) await harness.close();
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`dsh request timed out after ${timeoutMs}ms`);
        error.name = 'TimeoutError';
        reject(error);
      }, timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        const error = new Error('dsh request aborted');
        error.name = 'AbortError';
        reject(error);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }
}

function extractUsage(result: RunResult): HarnessTaskResult['usage'] {
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  for (const event of result.events ?? []) {
    const typed = event as unknown as { type: string; data?: Record<string, unknown> };
    if (typed.type !== 'assistant/message') continue;
    const usage = typed.data?.usage as Record<string, unknown> | undefined;
    if (!usage) continue;
    inputTokens ??= firstNumber(usage, ['inputTokens', 'promptTokens', 'input_tokens']);
    outputTokens ??= firstNumber(usage, ['outputTokens', 'completionTokens', 'output_tokens']);
  }
  return { inputTokens, outputTokens };
}

function firstNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}
