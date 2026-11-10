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

    const payload = {
      schema: request.outputSchema,
      profile: request.profile,
      summary: `fake structured output for ${request.inputs.length} input(s)`,
      inputs: request.inputs.map((input) => ({ name: input.name, length: input.content.length })),
      call: count,
    };
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
      output: JSON.stringify(payload),
      usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
      model: 'fake-model',
      toolCalls: [],
      runtime: { kind: 'fake', version: this.version },
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
