import { mkdir } from 'node:fs/promises';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import type { RunResult } from '@deepseek-ai/dsh-sdk-client';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
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

function composePrompt(request: HarnessTaskRequest): string {
  const inputs = request.inputs.map((input) => `### ${input.name}\n${input.content}`).join('\n\n');
  return [
    request.instruction,
    '',
    '## Inputs',
    inputs || '(none)',
    '',
    '## Output contract',
    `Return ONLY a JSON object matching schema "${request.outputSchema}".`,
    'No prose, no markdown fences, no commentary outside the JSON.',
  ].join('\n');
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
    const harness = new DeepSeekHarness({
      dshHome: this.opts.dshHome,
      cwd: this.opts.cwd ?? process.cwd(),
      patches: this.opts.patches ?? [],
      provider: this.opts.provider ?? 'deepseek-official',
      model: this.opts.model ?? 'deepseek-v4-flash',
      initializeTimeoutMs: this.opts.initializeTimeoutMs ?? 15_000,
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

    const prompt = composePrompt(request);
    let result: RunResult;
    try {
      result = await this.withTimeout(harness.run(prompt), request.budget.timeoutMs, signal);
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      // Timeout/abort cannot cancel a turn over the SDK: reap the runtime.
      await this.shutdown().catch(() => undefined);
      throw error;
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
      throw new Error('dsh response did not contain a JSON object matching the output schema');
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
