import { IdeaseekError } from '../core/errors.js';
import {
  HarnessBlockError,
  type HarnessAdapter,
  type HarnessEvent,
  type HarnessHealth,
  type HarnessTaskRequest,
  type HarnessTaskResult,
} from './adapter.js';

export interface FakeHarnessOptions {
  /** Tool-call summaries to report on successful results (audit tests). */
  toolCalls?: { tool: string; summary: string; ok: boolean }[];
  /** Fail the first N calls of a task with a normal error. */
  failTimes?: number;
  /** Block the first N calls with an external condition. */
  blockTimes?: number;
  block?: 'QUOTA_EXHAUSTED' | 'AUTH_REQUIRED' | 'NETWORK_BLOCKED';
  latencyMs?: number;
}

/**
 * Deterministic in-memory harness used by tests and Phase 0-style runs that
 * must exercise the workflow without any model or network. It honors the same
 * contract as the DSH adapter: idempotency keys, typed block errors and
 * secret-free event summaries.
 */

/**
 * Builds a validator-compliant PaperCard from the request inputs: everything
 * unknown stays "unknown", and the single claim quotes a real line of the
 * provided text so the deterministic Evidence Checker can verify it. The
 * platform stamps document_hash/paper_id in the extract handler.
 */
function buildFakeCard(request: HarnessTaskRequest, call: number): string {
  const content = request.inputs[0]?.content ?? '';
  const line =
    content
      .split(/\r?\n/)
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate.length >= 15) ?? content.slice(0, 60).trim();
  const card = {
    paper_id: 'pending',
    document_hash: `sha256:${'0'.repeat(64)}`,
    title: 'unknown',
    problem: 'unknown',
    method: { summary: 'unknown', steps: [], motivation: [] },
    datasets: [],
    metrics: [],
    baselines: [],
    limitations: [],
    claims: line
      ? [
          {
            text: `fake claim derived from source text (call ${call})`,
            evidence: [{ quote: line.slice(0, 120) }],
          },
        ]
      : [],
    unknowns: ['fake harness leaves every field it cannot know as unknown'],
    parser_version: 'fake-1',
    prompt_schema_version: request.outputSchema,
  };
  return JSON.stringify(card);
}

export class FakeHarnessAdapter implements HarnessAdapter {
  readonly kind = 'fake' as const;
  readonly version = 'fake-1';

  private readonly opts: FakeHarnessOptions;
  private readonly calls = new Map<string, number>();
  private initialized = false;

  constructor(opts: FakeHarnessOptions = {}) {
    this.opts = opts;
  }

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  callCount(idempotencyKey: string): number {
    return this.calls.get(idempotencyKey) ?? 0;
  }

  async runTask(
    request: HarnessTaskRequest,
    onEvent?: (event: HarnessEvent) => void,
    signal?: AbortSignal,
  ): Promise<HarnessTaskResult> {
    if (!this.initialized) {
      throw new IdeaseekError('INVALID_STATE', 'harness not initialized; call initialize() first');
    }
    const now = Date.now();
    const count = (this.calls.get(request.idempotencyKey) ?? 0) + 1;
    this.calls.set(request.idempotencyKey, count);

    onEvent?.({
      type: 'started',
      ts: now,
      runId: request.runId,
      taskId: request.taskId,
      summary: `fake harness started ${request.profile} (call ${count})`,
    });

    if (this.opts.latencyMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.opts.latencyMs);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          },
          { once: true },
        );
      });
    }

    if (this.opts.block && count <= (this.opts.blockTimes ?? 1)) {
      throw new HarnessBlockError(
        this.opts.block,
        `fake harness injected ${this.opts.block} (call ${count})`,
      );
    }
    if (this.opts.failTimes && count <= this.opts.failTimes) {
      throw new Error(`fake harness injected failure (call ${count})`);
    }

    const payload = buildFakeCard(request, count);
    onEvent?.({
      type: 'completed',
      ts: Date.now(),
      runId: request.runId,
      taskId: request.taskId,
      summary: `fake harness produced ${request.outputSchema} output`,
    });
    return {
      runId: request.runId,
      taskId: request.taskId,
      output: payload, // buildFakeCard already returns JSON text
      usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
      model: 'fake-model',
      toolCalls: this.opts.toolCalls ?? [],
      runtime: { kind: 'fake', version: this.version },
      sessionId: null,
      finishedAt: Date.now(),
    };
  }

  async health(): Promise<HarnessHealth> {
    return {
      reachable: true,
      models: [{ name: 'fake-model', available: true, detail: 'in-memory' }],
      blocked: this.opts.block != null && (this.opts.blockTimes ?? 1) > 0,
      blockReason: null,
    };
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
  }
}
