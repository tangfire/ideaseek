import type {
  HarnessAdapter,
  HarnessEvent,
  HarnessTaskRequest,
  HarnessTaskResult,
} from '../dsh/adapter.js';
import type { HarnessHealth } from '../dsh/adapter.js';
import { IdeaseekError } from '../core/errors.js';
import {
  assertCostWithinBudget,
  computeCostUsd,
  summarizeUsage,
  type ModelRates,
} from './usage.js';

/**
 * Usage-recording decorator around ANY HarnessAdapter (the composition
 * root attaches it in ProjectRuntime.open — every model call, worker
 * handler or inline CLI, flows through here):
 *
 * - beforeCall: aggregate this run's model_usage events and park the
 *   run via QUOTA_EXHAUSTED when cost reaches the pause ratio (the
 *   worker's existing block machinery handles the rest);
 * - afterCall: append ONE model_usage RunEvent (audit stream, no second
 *   ledger) with tokens/cost/model/task attribution.
 */

export interface UsageRecorderDeps {
  rates: ModelRates | null;
  ceilingUsd: number;
  /** Append one model_usage event (wired to WorkflowDb.appendEvent). */
  record(entry: {
    runId: string;
    taskId: string;
    ideaId: string | null;
    model: string | null;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
  }): Promise<void>;
  /** Aggregate the run's current usage (wired to collectUsage). */
  load(runId: string): Promise<ReturnType<typeof summarizeUsage>>;
  /**
   * Maps synthetic CLI request runIds (`ask-session`, `idea:<id>`, …)
   * onto the project's real run (run_event has a FK on run_id). Returns
   * null when the project has no run yet — telemetry then passes
   * through uncaptured instead of silently failing.
   */
  resolveRunId(requestRunId: string): Promise<string | null>;
}

export class UsageRecordingHarness implements HarnessAdapter {
  private readonly inner: HarnessAdapter;
  private readonly getDeps: () => Promise<UsageRecorderDeps | null>;

  constructor(inner: HarnessAdapter, getDeps: () => Promise<UsageRecorderDeps | null>) {
    this.inner = inner;
    this.getDeps = getDeps;
  }

  get kind(): 'dsh' | 'fake' {
    return this.inner.kind;
  }

  get version(): string {
    return this.inner.version;
  }

  initialize(): Promise<void> {
    return this.inner.initialize();
  }

  health(): Promise<HarnessHealth> {
    return this.inner.health();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  async runTask(
    request: HarnessTaskRequest,
    onEvent?: (event: HarnessEvent) => void,
    signal?: AbortSignal,
  ): Promise<HarnessTaskResult> {
    // deps resolve lazily (the composition root may not have a project
    // runtime yet); null = no budget context → pass through honestly.
    let deps = await this.getDeps().catch(() => null);

    // Attribution: synthetic CLI runIds map onto the project's real run
    // (the events table enforces a run FK). No run yet → no ledger.
    let effectiveRunId = request.runId;
    if (deps) {
      const resolved = await deps.resolveRunId(request.runId).catch(() => null);
      if (resolved === null) {
        deps = null;
      } else {
        effectiveRunId = resolved;
      }
    }

    // Budget gate BEFORE spending: accumulated cost at/over the pause
    // ratio throws QUOTA_EXHAUSTED (worker parks the run; CLI surfaces).
    if (deps) {
      const summary = await deps.load(effectiveRunId);
      assertCostWithinBudget(summary);
    }

    const result = await this.inner.runTask(request, onEvent, signal);

    const input = result.usage?.inputTokens ?? 0;
    const output = result.usage?.outputTokens ?? 0;
    if (deps && (input > 0 || output > 0)) {
      const costUsd = computeCostUsd(deps.rates, input, output);
      await deps
        .record({
          runId: effectiveRunId,
          taskId: request.taskId,
          ideaId: null,
          model: result.model,
          inputTokens: input,
          outputTokens: output,
          costUsd,
        })
        .catch(() => undefined); // telemetry must never fail the task itself
    }
    return result;
  }
}

/** Builds recorder deps from a WorkflowDb-like port + config resources. */
export function usageRecorderDeps(opts: {
  maxModelCost: number;
  rates: ModelRates | null;
  projectId: string;
  db: {
    getRun(runId: string): Promise<{ runId: string } | null>;
    getLatestRun(projectId: string): Promise<{ runId: string } | null>;
    listEvents(
      runId: string,
      opts?: { limit?: number },
    ): Promise<{ eventType: string; summary: string; objectId: string | null }[]>;
    appendEvent(event: {
      runId: string;
      phase: string;
      objectId: string | null;
      role: string | null;
      eventType: string;
      summary: string;
      status: string | null;
    }): Promise<{ seq: number }>;
    listTasks(runId: string): Promise<{ taskId: string; payload?: unknown }[]>;
  };
}): UsageRecorderDeps {
  const ideaByTask = new Map<string, string | null>();
  return {
    rates: opts.rates,
    ceilingUsd: opts.maxModelCost,
    async record(entry) {
      if (entry.ideaId === null && entry.taskId) {
        // Attribute to the task's idea when the payload carries one
        // (cached per run — payloads are immutable after enqueue).
        if (!ideaByTask.has(entry.taskId)) {
          const tasks = await opts.db.listTasks(entry.runId).catch(() => []);
          const task = tasks.find((t) => t.taskId === entry.taskId);
          const payload = (task?.payload ?? {}) as { ideaId?: unknown };
          ideaByTask.set(entry.taskId, typeof payload.ideaId === 'string' ? payload.ideaId : null);
        }
      }
      const ideaId = entry.ideaId ?? (entry.taskId ? (ideaByTask.get(entry.taskId) ?? null) : null);
      await opts.db.appendEvent({
        runId: entry.runId,
        phase: 'USAGE',
        objectId: ideaId,
        role: entry.model,
        eventType: 'model_usage',
        summary: JSON.stringify({
          in: entry.inputTokens,
          out: entry.outputTokens,
          cost: entry.costUsd,
          model: entry.model,
          taskId: entry.taskId,
        }),
        status: null,
      });
    },
    async load(runId) {
      const events = await opts.db.listEvents(runId, { limit: 100_000 });
      return summarizeUsage(runId, events, opts.rates, opts.maxModelCost);
    },
    async resolveRunId(requestRunId) {
      try {
        const existing = await opts.db.getRun(requestRunId);
        if (existing) return requestRunId;
        const latest = await opts.db.getLatestRun(opts.projectId);
        return latest?.runId ?? null;
      } catch {
        return null;
      }
    },
  };
}

/** Re-export for callers that only need the guard type. */
export { IdeaseekError };
