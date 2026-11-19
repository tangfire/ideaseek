import { join } from 'node:path';
import { ensureDir, writeFileAtomic } from '../core/atomic.js';
import { IdeaseekError } from '../core/errors.js';
import {
  specScaleOf,
  stableJson,
  validateExperimentSpec,
  type ExperimentSpec,
} from '../experiment/spec.js';
import {
  buildIdeaSpec,
  executeSpecRun,
  type IdeaRuntime,
  type IdeaScale,
  type RegistryPort,
} from './experiment.js';
import { assertIdeaWorkspacePath, ideaDir } from './workspace.js';

/**
 * Result reproduction (design review #13): re-execute a RECORDED experiment
 * against unchanged inputs and compare the fresh metrics with the recorded
 * ones — without touching the registry, the idea status, or the result.
 * Verification is evidence production, not a new result: no novelty/review
 * gates (nothing is recorded) but the same `start-experiment` autonomy gate
 * as any execution, and the recorded spec's command runs — not a freshly
 * re-derived one, because the recorded spec IS the contract that produced
 * the numbers.
 *
 * Honesty contract:
 *  - a field-level drift gate refuses BEFORE executing when an input that
 *    defines the computation (code, data snapshot, seeds, command, metrics,
 *    card version) no longer matches the recorded spec — re-running changed
 *    inputs answers a different question than the recorded result;
 *  - verdicts are never coerced: a metric the re-run did not produce is
 *    `incomplete`, a beyond-tolerance delta is `diverged`, only a full match
 *    is `stable`;
 *  - stable exits 0, anything else exits 2, drift throws before execution.
 */
export type ReproduceVerdict = 'stable' | 'diverged' | 'incomplete' | 'failed';

export interface MetricComparison {
  name: string;
  recorded: number;
  /** null = the re-run did not produce this metric. */
  fresh: number | null;
  delta: number | null;
  withinTolerance: boolean;
}

export interface ReproduceOutcome {
  ideaId: string;
  specId: string;
  version: number;
  scale: string;
  verdict: ReproduceVerdict;
  tolerance: number;
  /** False when the recorded spec carries no code hash — drift undetectable. */
  codeVerified: boolean;
  recorded: { name: string; value: number }[];
  fresh: { name: string; value: number }[];
  comparisons: MetricComparison[];
  failure: string | null;
  logRef: string;
  reportPath: string;
  at: number;
}

export interface ReproduceOptions {
  /** Absolute per-metric tolerance; 0 (default) demands exact equality. */
  tolerance: number;
  timeoutMs: number;
}

/**
 * Compares recorded metrics against the re-run's. Precedence: a metric the
 * re-run did not produce makes the verdict `incomplete` (the comparison
 * could not happen — a missing number is not agreement), a beyond-tolerance
 * delta makes it `diverged`, only a full match within tolerance is `stable`.
 * An empty recorded set is `incomplete` too: nothing recorded, nothing
 * verified — never a vacuous pass.
 */
export function compareMetrics(
  recorded: { name: string; value: number }[],
  fresh: { name: string; value: number }[],
  tolerance: number,
): { comparisons: MetricComparison[]; verdict: 'stable' | 'diverged' | 'incomplete' } {
  const freshByName = new Map(fresh.map((metric) => [metric.name, metric.value]));
  const comparisons: MetricComparison[] = recorded.map((metric) => {
    const value = freshByName.get(metric.name);
    if (value === undefined) {
      return {
        name: metric.name,
        recorded: metric.value,
        fresh: null,
        delta: null,
        withinTolerance: false,
      };
    }
    const delta = value - metric.value;
    return {
      name: metric.name,
      recorded: metric.value,
      fresh: value,
      delta,
      withinTolerance: Math.abs(delta) <= tolerance,
    };
  });
  if (recorded.length === 0 || comparisons.some((comparison) => comparison.fresh === null)) {
    return { comparisons, verdict: 'incomplete' };
  }
  if (comparisons.some((comparison) => !comparison.withinTolerance)) {
    return { comparisons, verdict: 'diverged' };
  }
  return { comparisons, verdict: 'stable' };
}

/**
 * The fields that define what the computation IS. version/createdAt/
 * environment.notes/resources/budget/protocolId are provenance or policy and
 * deliberately not compared: attempt notes change on a legitimate retry, so
 * a whole-spec hash would false-positive after a retry-success
 * (prepareSpecRecording normalizes version+createdAt — that is why this gate
 * is field-level). Card revision is caught via idea.version: revise bumps it.
 */
function driftedInputs(recorded: ExperimentSpec, rebuilt: ExperimentSpec): string[] {
  const drifted: string[] = [];
  if (typeof recorded.codeCommit === 'string') {
    // recorded null = legacy record without provenance (caller flags
    // codeVerified=false instead of comparing); rebuilt null = source gone.
    if (recorded.codeCommit !== (rebuilt.codeCommit ?? '')) drifted.push('code');
  }
  if (recorded.dataSnapshotId !== rebuilt.dataSnapshotId) drifted.push('data snapshot');
  if (stableJson(recorded.seeds) !== stableJson(rebuilt.seeds)) drifted.push('seeds');
  if (stableJson(recorded.command) !== stableJson(rebuilt.command)) drifted.push('command');
  if (stableJson(recorded.metrics) !== stableJson(rebuilt.metrics)) drifted.push('metrics');
  if (recorded.idea?.version !== rebuilt.idea?.version) drifted.push('idea version');
  return drifted;
}

function normalizeMetrics(value: unknown): { name: string; value: number }[] {
  if (!Array.isArray(value)) return [];
  const out: { name: string; value: number }[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as { name?: unknown; value?: unknown };
    if (
      typeof record.name === 'string' &&
      typeof record.value === 'number' &&
      Number.isFinite(record.value)
    ) {
      out.push({ name: record.name, value: record.value });
    }
  }
  return out;
}

export async function reproduceIdeaResult(
  projectRoot: string,
  ideaId: string,
  opts: ReproduceOptions,
  runtime: IdeaRuntime,
  db: RegistryPort,
): Promise<ReproduceOutcome> {
  const specId = `idea-${ideaId}`;
  const existing = await db.getExperiment(specId);
  const result = existing?.result as { status?: unknown; metrics?: unknown } | null;
  if (!existing || !result) {
    throw new IdeaseekError(
      'DEPENDENCY_NOT_MET',
      `no recorded result for ${ideaId} — record one first: ideaseek idea experiment ${ideaId}`,
    );
  }
  if (result.status !== 'succeeded') {
    throw new IdeaseekError(
      'INVALID_STATE',
      `recorded result is ${String(result.status)}; reproduce verifies succeeded results — ` +
        `re-run: ideaseek idea experiment ${ideaId}`,
    );
  }
  const validation = validateExperimentSpec(existing.spec);
  if (!validation.ok) {
    throw new IdeaseekError(
      'INVALID_STATE',
      `recorded spec for ${ideaId} failed validation: ${validation.errors.join('; ')}`,
    );
  }
  const recordedSpec = existing.spec as unknown as ExperimentSpec;
  const scale = specScaleOf(recordedSpec);
  if (scale !== 'smoke' && scale !== 'quick') {
    throw new IdeaseekError(
      'INVALID_STATE',
      `recorded scale ${scale ? `"${scale}"` : 'missing'} is not reproducible (smoke | quick)`,
    );
  }

  // Drift gate BEFORE any execution: rebuild the spec from today's inputs
  // and compare only the fields that define the computation.
  const { spec: rebuilt } = await buildIdeaSpec(projectRoot, ideaId, {
    scale: scale as IdeaScale,
    runtime,
  });
  const drifted = driftedInputs(recordedSpec, rebuilt);
  if (drifted.length > 0) {
    throw new IdeaseekError(
      'INVALID_STATE',
      `inputs changed since the result was recorded (${drifted.join(', ')}) — a re-run of ` +
        `current inputs would answer a different question; re-record instead: ` +
        `ideaseek idea check ${ideaId} && ideaseek idea experiment ${ideaId}`,
    );
  }

  const recorded = normalizeMetrics(result.metrics);
  // The RECORDED spec's command runs — the drift gate just proved it equals
  // what today's inputs would derive.
  const exec = await executeSpecRun(
    projectRoot,
    `${ideaId}-reproduce`,
    recordedSpec,
    opts.timeoutMs,
  );

  let verdict: ReproduceVerdict;
  let comparisons: MetricComparison[] = [];
  let failure: string | null = null;
  if (!exec.succeeded) {
    verdict = 'failed';
    failure = exec.failure?.summary ?? 're-run did not complete';
  } else {
    const compared = compareMetrics(recorded, exec.metrics, opts.tolerance);
    verdict = compared.verdict;
    comparisons = compared.comparisons;
  }

  const at = Date.now();
  const workspace = ideaDir(projectRoot, ideaId);
  const reportPath = join(workspace, 'experiments', 'reproduce-report.json');
  assertIdeaWorkspacePath(projectRoot, ideaId, reportPath);
  await ensureDir(join(workspace, 'experiments'));
  await writeFileAtomic(
    reportPath,
    `${JSON.stringify(
      {
        contract: 'idea-reproduce-report-v1',
        ideaId,
        specId,
        version: existing.version,
        scale,
        verdict,
        tolerance: opts.tolerance,
        codeVerified: typeof recordedSpec.codeCommit === 'string',
        recorded,
        fresh: exec.metrics,
        comparisons,
        failure,
        startedAt: exec.startedAt,
        finishedAt: exec.finishedAt,
        logRef: exec.logRef,
        at,
      },
      null,
      2,
    )}\n`,
  );

  return {
    ideaId,
    specId,
    version: existing.version,
    scale,
    verdict,
    tolerance: opts.tolerance,
    codeVerified: typeof recordedSpec.codeCommit === 'string',
    recorded,
    fresh: exec.metrics,
    comparisons,
    failure,
    logRef: exec.logRef,
    reportPath: `ideas/${ideaId}/experiments/reproduce-report.json`,
    at,
  };
}

const fmt = (value: number): string => value.toFixed(4);
const fmtDelta = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(4)}`;

export function formatReproduce(outcome: ReproduceOutcome): string {
  const lines: string[] = [];
  const scope = `(${outcome.scale}, v${outcome.version})`;
  if (outcome.verdict === 'stable') {
    lines.push(
      `reproduce ${outcome.ideaId}: STABLE — ${outcome.comparisons.length}/${outcome.recorded.length} ` +
        `metric(s) within tolerance ${outcome.tolerance} ${scope}`,
    );
  } else if (outcome.verdict === 'diverged') {
    const beyond = outcome.comparisons.filter((c) => !c.withinTolerance).length;
    lines.push(
      `reproduce ${outcome.ideaId}: DIVERGED — ${beyond}/${outcome.recorded.length} ` +
        `metric(s) beyond tolerance ${outcome.tolerance} ${scope}`,
    );
  } else if (outcome.verdict === 'incomplete') {
    const missing = outcome.comparisons.filter((c) => c.fresh === null).map((c) => c.name);
    lines.push(
      `reproduce ${outcome.ideaId}: INCOMPLETE — ${
        outcome.recorded.length === 0
          ? 'the recorded result carries no metrics to verify'
          : `not produced by the re-run: ${missing.join(', ')}`
      } ${scope}`,
    );
  } else {
    lines.push(
      `reproduce ${outcome.ideaId}: FAILED — ${outcome.failure ?? 're-run did not complete'} ${scope}`,
    );
  }
  for (const comparison of outcome.comparisons) {
    if (comparison.fresh === null) {
      lines.push(
        `  ${comparison.name}: recorded ${fmt(comparison.recorded)} → not produced by the re-run ✗`,
      );
    } else {
      lines.push(
        `  ${comparison.name}: recorded ${fmt(comparison.recorded)} → fresh ${fmt(comparison.fresh)} ` +
          `Δ${fmtDelta(comparison.delta ?? 0)} ${comparison.withinTolerance ? '✓' : '✗'}`,
      );
    }
  }
  if (!outcome.codeVerified) {
    lines.push('  ! recorded result carries no code provenance — code drift was not detectable');
  }
  lines.push(`  log: ${outcome.logRef}`);
  lines.push(`  report: ${outcome.reportPath}`);
  if (outcome.verdict === 'diverged' || outcome.verdict === 'incomplete') {
    lines.push(`next: inspect the log, then re-record: ideaseek idea experiment ${outcome.ideaId}`);
  } else if (outcome.verdict === 'failed') {
    lines.push(
      `next: fix the failure above, then retry: ideaseek idea reproduce ${outcome.ideaId}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
