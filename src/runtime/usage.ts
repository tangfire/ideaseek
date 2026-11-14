import { IdeaseekError } from '../core/errors.js';

/**
 * Cost telemetry (PROGRESS 212: 成本遥测与预算执行) — the ledger lives in
 * the ONE audit stream we already have: RunEvent entries with
 * `eventType: 'model_usage'` and a compact JSON summary
 * `{"in":n,"out":n,"cost":number|null,"model":str,"taskId":str}`.
 * No second event log, no second database.
 *
 * Cost is only ever computed from CONFIGURED rates
 * (`resources.model_rates`, USD per million tokens) — with no rates the
 * dollar ceiling is honestly reported as not enforced (tokens still
 * count). The pause gate parks runs through the existing
 * QUOTA_EXHAUSTED worker machinery at COST_PAUSE_RATIO of
 * `resources.max_model_cost`.
 */

export const COST_PAUSE_RATIO = 0.9;

export interface UsageEntry {
  runId: string;
  taskId: string | null;
  ideaId: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  /** null when no rates are configured (never invented). */
  costUsd: number | null;
}

export interface UsageSummary {
  runId: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** null when rates are not configured — dollar ceiling not enforced. */
  costUsd: number | null;
  rateConfigured: boolean;
  ceilingUsd: number;
  /** Remaining dollars under the ceiling (null without rates). */
  remainingUsd: number | null;
  /**
   * Token ceiling from resources.max_model_tokens. This is what still bounds a
   * runaway loop when rates are unknown and the dollar ceiling cannot be
   * measured; null means no token gate is configured.
   */
  tokenCeiling: number | null;
  /** Fraction of the ceiling at which new model calls pause (0–1). */
  pauseRatio: number;
  byModel: Record<
    string,
    { calls: number; inputTokens: number; outputTokens: number; costUsd: number | null }
  >;
}

export interface ModelRates {
  inputPerMtok: number;
  outputPerMtok: number;
}

export function computeCostUsd(
  rates: ModelRates | null,
  inputTokens: number,
  outputTokens: number,
): number | null {
  if (!rates) return null;
  const cost =
    (inputTokens / 1_000_000) * rates.inputPerMtok +
    (outputTokens / 1_000_000) * rates.outputPerMtok;
  // Round to cents-scale to keep aggregates stable across float noise.
  return Math.round(cost * 1e6) / 1e6;
}

/** Parses one model_usage event summary; malformed JSON → null (honest skip). */
export function parseUsageSummary(summary: string): {
  in: number;
  out: number;
  cost: number | null;
  model: string | null;
  taskId: string | null;
} | null {
  try {
    const parsed = JSON.parse(summary) as Record<string, unknown>;
    const input = typeof parsed.in === 'number' ? parsed.in : 0;
    const output = typeof parsed.out === 'number' ? parsed.out : 0;
    const cost =
      typeof parsed.cost === 'number' && Number.isFinite(parsed.cost) ? parsed.cost : null;
    return {
      in: input,
      out: output,
      cost,
      model: typeof parsed.model === 'string' ? parsed.model : null,
      taskId: typeof parsed.taskId === 'string' ? parsed.taskId : null,
    };
  } catch {
    return null;
  }
}

export interface UsageEventLike {
  eventType: string;
  summary: string;
  objectId: string | null;
}

/** Aggregates model_usage events for one run (malformed lines skipped). */
export function summarizeUsage(
  runId: string,
  events: UsageEventLike[],
  rates: ModelRates | null,
  ceilingUsd: number,
  tokenCeiling: number | null = null,
): UsageSummary {
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let anyCost = false;
  const byModel: UsageSummary['byModel'] = {};
  for (const event of events) {
    if (event.eventType !== 'model_usage') continue;
    const parsed = parseUsageSummary(event.summary);
    if (!parsed) continue;
    calls += 1;
    inputTokens += parsed.in;
    outputTokens += parsed.out;
    // Prefer the recorded cost; without one, derive from tokens when
    // rates exist (records written before rates were configured still
    // aggregate honestly instead of silently counting as zero).
    const eventCost = parsed.cost ?? (rates ? computeCostUsd(rates, parsed.in, parsed.out) : null);
    if (eventCost !== null) {
      costUsd += eventCost;
      anyCost = true;
    }
    const key = parsed.model ?? 'unknown';
    const slot = (byModel[key] ??= {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
    });
    slot.calls += 1;
    slot.inputTokens += parsed.in;
    slot.outputTokens += parsed.out;
    if (eventCost !== null) {
      slot.costUsd = Math.round(((slot.costUsd ?? 0) + eventCost) * 1e6) / 1e6;
    }
  }
  const aggregatedCost = anyCost ? Math.round(costUsd * 1e6) / 1e6 : rates ? 0 : null;
  return {
    runId,
    calls,
    inputTokens,
    outputTokens,
    // Recorded dollars are real even if rates were later removed; only
    // token-only histories need rates to become dollar-denominated.
    costUsd: aggregatedCost,
    rateConfigured: rates !== null,
    ceilingUsd,
    remainingUsd:
      aggregatedCost !== null
        ? Math.max(0, Math.round((ceilingUsd - aggregatedCost) * 1e6) / 1e6)
        : null,
    pauseRatio: COST_PAUSE_RATIO,
    tokenCeiling,
    byModel,
  };
}

/**
 * Pre-call gate: throws QUOTA_EXHAUSTED (the worker parks the run with
 * the existing block machinery) when the run's accumulated cost reaches
 * COST_PAUSE_RATIO of the ceiling. Without configured rates there is
 * nothing dollar-denominated to gate — callers surface that honestly.
 */
export function assertCostWithinBudget(summary: UsageSummary): void {
  // The token ceiling is the guard that works without prices: a runaway
  // loop still stops when nobody has configured rates yet.
  const tokens = summary.inputTokens + summary.outputTokens;
  if (summary.tokenCeiling !== null && tokens >= summary.tokenCeiling) {
    throw new IdeaseekError(
      'QUOTA_EXHAUSTED',
      `${tokens} tokens reached the resources.max_model_tokens ceiling ${summary.tokenCeiling} — new model calls paused (dollar budget${summary.rateConfigured ? '' : ' is not measurable without resources.model_rates'}); raise it in research.yaml then ideaseek continue`,
      { tokens, tokenCeiling: summary.tokenCeiling },
    );
  }
  if (summary.costUsd === null) return; // no rates → tokens-only mode
  const pauseAt = summary.ceilingUsd * summary.pauseRatio;
  if (summary.costUsd >= pauseAt) {
    throw new IdeaseekError(
      'QUOTA_EXHAUSTED',
      `model cost $${summary.costUsd} reached ${Math.round(summary.pauseRatio * 100)}% of max_model_cost $${summary.ceilingUsd} — new model calls paused; raise resources.max_model_cost in research.yaml (then ideaseek continue) or wait for a lower ceiling`,
      { costUsd: summary.costUsd, ceilingUsd: summary.ceilingUsd },
    );
  }
}

/** One human line for status/monitor. */
export function formatUsageLine(summary: UsageSummary): string {
  const spent = summary.inputTokens + summary.outputTokens;
  const tokens = `${summary.inputTokens} in / ${summary.outputTokens} out tokens · ${summary.calls} call(s)`;
  const tokenGate =
    summary.tokenCeiling === null
      ? 'no token gate (resources.max_model_tokens unset)'
      : `token ceiling ${summary.tokenCeiling} (${summary.tokenCeiling > 0 ? Math.round((spent / summary.tokenCeiling) * 100) : 100}%)`;
  if (!summary.rateConfigured) {
    return (
      `usage: ${tokens} · rates not configured (resources.model_rates) — ` +
      `$${summary.ceilingUsd} ceiling NOT enforced · guard: ${tokenGate}`
    );
  }
  const used = summary.costUsd ?? 0;
  const pct = summary.ceilingUsd > 0 ? Math.round((used / summary.ceilingUsd) * 100) : 0;
  return (
    `usage: ${tokens} · $${used.toFixed(4)} / $${summary.ceilingUsd} max_model_cost (${pct}%, ` +
    `pause at ${Math.round(summary.pauseRatio * 100)}%) · guard: ${tokenGate}`
  );
}
