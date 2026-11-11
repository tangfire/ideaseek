import type { ExperimentSpec, RunFailureCategory, RunResult } from '../experiment/spec.js';
import type { IdeaCard } from './card.js';

/**
 * Result Analyst (docs/plan.md §E.7–8, EVALUATION.md): reads baseline
 * results, the idea's main experiment, ablations, scenario/scale coverage,
 * resource use and logs, then emits a structured verdict. Hard rule: a
 * program crash / environment failure is NEVER interpreted as a scientific
 * hypothesis failure — only successful-but-ineffective runs can produce
 * hypothesis/effect verdicts.
 */

export type FailureClass =
  | 'engineering'
  | 'environment'
  | 'data'
  | 'resource'
  | 'metric'
  | 'hypothesis'
  | 'effect-insufficient'
  | 'unknown'
  | 'none';

export type AnalysisVerdict = 'supported' | 'inconclusive' | 'rejected' | 'invalid-run';

/** Runtime RunResult category → the seven-class failure taxonomy. */
export function classifyRuntimeFailure(
  category: RunFailureCategory | null | undefined,
): Exclude<FailureClass, 'hypothesis' | 'effect-insufficient' | 'none'> {
  switch (category) {
    case 'code':
      return 'engineering';
    case 'dependency':
    case 'environment':
    case 'timeout':
      return 'environment';
    case 'data':
      return 'data';
    case 'resource':
      return 'resource';
    case 'invalid-result':
      return 'metric';
    case 'unknown':
      return 'unknown';
    default:
      return 'unknown';
  }
}

export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export interface AblationEntryPlan {
  ablationId: string;
  label: string;
  /** Set for mechanism-chain-derived ablations (necessary components). */
  removeComponent: string | null;
}

/**
 * The ablation matrix DERIVES from the IdeaCard mechanism chain: every
 * necessary-mechanism component gets a "remove it" ablation, plus the
 * explicitly declared minimal-experiment ablations. Deduped by id.
 */
export function deriveAblations(card: IdeaCard): AblationEntryPlan[] {
  const entries: AblationEntryPlan[] = [];
  const seen = new Set<string>();
  const push = (entry: AblationEntryPlan): void => {
    if (seen.has(entry.ablationId)) return;
    seen.add(entry.ablationId);
    entries.push(entry);
  };
  for (const component of card.componentNecessity) {
    if (component.role !== 'necessary-mechanism') continue;
    const id = `w-o-${slugify(component.component)}`;
    push({
      ablationId: id,
      label: `w/o ${component.component}`,
      removeComponent: component.component,
    });
  }
  for (const label of card.minimalExperiment.ablations) {
    const id = `abl-${slugify(label)}`;
    push({ ablationId: id, label, removeComponent: null });
  }
  return entries;
}

export interface AblationObservation {
  ablationId: string;
  label: string;
  removeComponent: string | null;
  /** null when the ablation has not run or failed. */
  mainValue: number | null;
  ablationValue: number | null;
  /**
   * true  — removing the component hurt the metric (mechanism supported)
   * false — removing it did not help/hurt as predicted (mechanism not evidenced)
   * null  — not observed yet
   */
  supports: boolean | null;
}

export interface BaselineComparison {
  methodId: string;
  baselineValue: number | null;
  ideaValue: number | null;
  /** Positive = idea better (direction-adjusted). null when unknown. */
  delta: number | null;
  /** Scale this baseline value was recorded at (smoke/quick/…). */
  scale?: string;
}

export interface FailureObservation {
  specId: string;
  category: RunFailureCategory | null;
  class: FailureClass;
  logRefs: string[];
  /** Never 'hypothesis' for runtime failures — enforced by classifyRuntimeFailure. */
}

export interface AnalysisInput {
  ideaId: string;
  ideaVersion: number;
  codeHash: string | null;
  card: IdeaCard;
  /** spec + result of idea-<id> (null when never run). */
  main: { spec: ExperimentSpec; result: RunResult } | null;
  ablations: {
    ablationId: string;
    label: string;
    removeComponent: string | null;
    spec: ExperimentSpec;
    result: RunResult;
  }[];
  /** Primary-metric values from baseline/reproduction runs (null = unknown). */
  baselines: { methodId: string; value: number | null; scale?: string }[];
  /** Primary-metric value of the idea per scale (succeeded mirrors only). */
  ideaByScale?: Record<string, number>;
  /** Distinct scales with a succeeded idea result (smoke/quick/…). */
  scalesRun: string[];
  /** Distinct dataset snapshot ids with a succeeded idea result. */
  datasetsRun: string[];
  /** Seeds declared on the main spec. */
  seedsCount: number;
  /** Every failed result seen (main + ablations), kept — never deleted. */
  failures: FailureObservation[];
  /** Resource usage records (specId → gpuMinutes/peakMemory if reported). */
  resources: { specId: string; gpuMinutes: number | null; peakMemoryGiB: number | null }[];
}

export interface IdeaAnalysis {
  ideaId: string;
  ideaVersion: number;
  codeHash: string | null;
  verdict: AnalysisVerdict;
  failureClass: FailureClass;
  /** Primary metric comparison against the best available baseline. */
  baselineComparison: BaselineComparison[];
  primaryDelta: number | null;
  mechanismEvidence: AblationObservation[];
  coverage: {
    scales: string[];
    datasets: string[];
    seeds: number;
    /** Scenario/scale gaps blocking a stronger verdict. */
    missing: string[];
  };
  failures: FailureObservation[];
  resources: AnalysisInput['resources'];
  /** Evidence chain behind the verdict (auditable, no model prose). */
  reasons: string[];
  nextSteps: string[];
  generatedAt: number;
}

/** Scale declared in a spec's environment notes ('scale:smoke', …). */
function specScale(spec: ExperimentSpec): string {
  const note = (spec.environment.notes ?? []).find((n) => n.startsWith('scale:'));
  return note ? note.slice('scale:'.length) : 'unknown';
}

function primaryOf(spec: ExperimentSpec): { name: string; direction: 'higher' | 'lower' } | null {
  const first = spec.metrics[0];
  return first ? { name: first.name, direction: first.direction } : null;
}

function metricValue(result: RunResult, name: string): number | null {
  const found = result.metrics.find((m) => m.name === name);
  return found && Number.isFinite(found.value) ? found.value : null;
}

/** Positive when `value` beats `reference` under `direction`. */
function adjustedDelta(value: number, reference: number, direction: 'higher' | 'lower'): number {
  return direction === 'higher' ? value - reference : reference - value;
}

/**
 * Deterministic verdict ladder:
 *   invalid-run  — main run failed at runtime (crash/env/data/…: NEVER hypothesis)
 *   rejected     — main succeeded but fails to beat the best baseline
 *   inconclusive — missing baseline / single seed / single scale / no mechanism evidence
 *   supported    — beats best baseline, seeds ≥ 2, ≥ 2 scales, mechanism ablations agree
 */
export function analyzeIdea(input: AnalysisInput): IdeaAnalysis {
  const reasons: string[] = [];
  const nextSteps: string[] = [];
  const card = input.card;
  const primary = input.main ? primaryOf(input.main.spec) : null;

  // Coverage bookkeeping (multi-dataset / multi-seed / multi-scale support).
  const missing: string[] = [];
  if (input.scalesRun.length < 2) {
    missing.push(
      `scales: ran ${input.scalesRun.join(',') || 'none'}; need smoke AND quick/standard`,
    );
  }
  if (input.seedsCount < 2) missing.push(`seeds: ${input.seedsCount} < 2`);
  if (input.datasetsRun.length < 1) missing.push('datasets: no succeeded run bound to a dataset');

  // --- main result handling.
  if (!input.main) {
    reasons.push('no main experiment result recorded');
    nextSteps.push(`run: ideaseek idea experiment ${input.ideaId}`);
    return finish(input, 'inconclusive', 'none', [], null, [], reasons, nextSteps, missing);
  }

  const mainResult = input.main.result;
  if (mainResult.status !== 'succeeded') {
    // Crash / env / data / metric failures are engineering facts, not science.
    const failureClass = classifyRuntimeFailure(mainResult.failure?.category);
    reasons.push(
      `main run ${mainResult.status}: ${mainResult.failure?.category ?? 'unknown'} — ` +
        `${mainResult.failure?.summary ?? 'no summary'} (class=${failureClass}, NOT a hypothesis failure)`,
    );
    nextSteps.push(failureNextStep(failureClass, input.ideaId));
    nextSteps.push(`rerun: ideaseek idea experiment ${input.ideaId} after the fix`);
    return finish(input, 'invalid-run', failureClass, [], null, [], reasons, nextSteps, missing);
  }

  if (!primary) {
    reasons.push('main spec declares no metrics');
    nextSteps.push('add metrics to config/train.json and rerun idea check');
    return finish(input, 'inconclusive', 'none', [], null, [], reasons, nextSteps, missing);
  }

  const ideaValue = metricValue(mainResult, primary.name);
  if (ideaValue === null) {
    const failureClass: FailureClass = 'metric';
    reasons.push(`main run succeeded but primary metric "${primary.name}" is missing/non-finite`);
    nextSteps.push('fix metric emission in src/train.py ({"metrics": …} JSON) and rerun');
    return finish(input, 'invalid-run', failureClass, [], null, [], reasons, nextSteps, missing);
  }

  // --- baseline comparison (direction-adjusted; positive = idea better).
  const comparisons: BaselineComparison[] = [];
  let bestDelta: number | null = null;
  const knownBaselines = input.baselines.filter((b) => b.value !== null);
  const mainScale = input.main ? specScale(input.main.spec) : null;
  for (const baseline of input.baselines) {
    // Only same-scale baselines count toward the primary delta — a quick
    // idea run may never be compared against a smoke baseline.
    const sameScale = baseline.scale === undefined || baseline.scale === mainScale;
    const delta =
      baseline.value === null || !sameScale
        ? null
        : adjustedDelta(ideaValue, baseline.value, primary.direction);
    comparisons.push({
      methodId: baseline.methodId,
      baselineValue: baseline.value,
      ideaValue,
      delta,
      ...(baseline.scale !== undefined ? { scale: baseline.scale } : {}),
    });
    if (delta !== null && (bestDelta === null || delta > bestDelta)) bestDelta = delta;
  }

  if (knownBaselines.length === 0) {
    reasons.push(
      '缺少有效对照：no baseline result available — absolute results cannot claim superiority (plan §C.4)',
    );
    nextSteps.push(
      'reproduce or repair the nearest baseline first (ideaseek baseline reproduce/repair)',
    );
    nextSteps.push(`then rerun analysis: ideaseek idea analyze ${input.ideaId}`);
    return finish(
      input,
      'inconclusive',
      'none',
      comparisons,
      null,
      mechanismEvidence(input, primary),
      reasons,
      nextSteps,
      missing,
    );
  }

  if (bestDelta !== null && bestDelta <= 0) {
    reasons.push(
      `effect insufficient: primary "${primary.name}"=${ideaValue} does not beat best baseline ` +
        `(${knownBaselines.map((b) => `${b.methodId}=${b.value}`).join(', ')})`,
    );
    nextSteps.push(
      'revise the implementation (ideaseek idea set-status … NEEDS_REVISION → IMPLEMENTING) or abandon',
    );
    nextSteps.push(`record falsification check: ${card.falsification.conditions.join(' | ')}`);
    return finish(
      input,
      'rejected',
      'effect-insufficient',
      comparisons,
      bestDelta,
      mechanismEvidence(input, primary),
      reasons,
      nextSteps,
      missing,
    );
  }

  // --- mixed-scale evidence: winning at the paired scale is NOT enough if
  // any other covered scale shows no gain (expected-change must hold where
  // both sides are registered — found by live FL-direction validation).
  if (input.ideaByScale) {
    const mixed: string[] = [];
    for (const baseline of input.baselines) {
      if (!baseline.scale || baseline.scale === mainScale || baseline.value === null) continue;
      const ideaAt = input.ideaByScale[baseline.scale];
      if (ideaAt === undefined) continue;
      const d = adjustedDelta(ideaAt, baseline.value, primary.direction);
      comparisons.push({
        methodId: baseline.methodId,
        baselineValue: baseline.value,
        ideaValue: ideaAt,
        delta: d,
        scale: baseline.scale,
      });
      if (d <= 0) mixed.push(`${baseline.scale} (${ideaAt} vs baseline ${baseline.value})`);
    }
    if (mixed.length > 0) {
      reasons.push(
        `mixed-scale evidence: no gain at ${mixed.join(', ')} — expected-change not met on every covered scale`,
      );
      nextSteps.push(
        'narrow the claim to the scale that works, or rework the estimator for the failing scale',
      );
      nextSteps.push(`rerun analysis: ideaseek idea analyze ${input.ideaId}`);
      return finish(
        input,
        'inconclusive',
        'none',
        comparisons,
        bestDelta,
        mechanismEvidence(input, primary),
        reasons,
        nextSteps,
        missing,
      );
    }
  }

  // Without a same-scale baseline nothing can claim superiority.
  if (bestDelta === null) {
    reasons.push('no same-scale baseline comparison available');
    nextSteps.push(
      'record a baseline result at this scale (repro-<methodId> spec with a matching scale note)',
    );
    return finish(
      input,
      'inconclusive',
      'none',
      comparisons,
      null,
      mechanismEvidence(input, primary),
      reasons,
      nextSteps,
      missing,
    );
  }

  // --- mechanism evidence: every necessary-mechanism component declared on
  // the card must have a RUN ablation that degrades the metric as predicted.
  const evidence = mechanismEvidence(input, primary);
  const declaredNecessary = input.card.componentNecessity.filter(
    (component) => component.role === 'necessary-mechanism',
  );
  const untested = declaredNecessary.filter(
    (component) =>
      !evidence.some(
        (item) => item.removeComponent === component.component && item.supports !== null,
      ),
  );
  if (declaredNecessary.length > 0 && untested.length > 0) {
    reasons.push(
      `mechanism chain declares necessary components but no component ablation has run ` +
        `(${untested.map((c) => c.component).join(', ')})`,
    );
    nextSteps.push(`run the ablation matrix: ideaseek idea ablate ${input.ideaId}`);
    return finish(
      input,
      'inconclusive',
      'none',
      comparisons,
      bestDelta,
      evidence,
      reasons,
      nextSteps,
      missing,
    );
  }
  const contradicted = evidence.filter(
    (item) => item.removeComponent !== null && item.supports === false,
  );
  if (contradicted.length > 0) {
    reasons.push(
      `mechanism not evidenced: removing ${contradicted.map((c) => c.removeComponent).join(', ')} ` +
        'did not degrade the primary metric as predicted',
    );
    nextSteps.push('reexamine the mechanism chain or the ablation implementation');
    return finish(
      input,
      'inconclusive',
      'none',
      comparisons,
      bestDelta,
      evidence,
      reasons,
      nextSteps,
      missing,
    );
  }

  // --- coverage gates for SUPPORTED.
  if (missing.length > 0) {
    reasons.push(`coverage incomplete: ${missing.join('; ')}`);
    if (input.seedsCount < 2) {
      nextSteps.push('add seeds to config/train.json (≥ 2) and rerun experiment + analysis');
    }
    if (input.scalesRun.length < 2) {
      nextSteps.push(
        `run the second scale: ideaseek idea experiment ${input.ideaId} --scale quick`,
      );
    }
    return finish(
      input,
      'inconclusive',
      'none',
      comparisons,
      bestDelta,
      evidence,
      reasons,
      nextSteps,
      missing,
    );
  }

  const evidencedNecessary = evidence.filter(
    (item) => item.removeComponent !== null && item.supports === true,
  );
  reasons.push(
    `beats best baseline on "${primary.name}" (Δ=${bestDelta?.toFixed(4)}) with ` +
      `${input.seedsCount} seeds across scales [${input.scalesRun.join(', ')}]` +
      (evidencedNecessary.length > 0
        ? `; ${evidencedNecessary.length} necessary-component ablation(s) degrade the metric as predicted`
        : ''),
  );
  nextSteps.push(`record the verdict: ideaseek idea set-status ${input.ideaId} SUPPORTED`);
  nextSteps.push(`build the repro package: ideaseek idea handoff ${input.ideaId}`);
  return finish(
    input,
    'supported',
    'none',
    comparisons,
    bestDelta,
    evidence,
    reasons,
    nextSteps,
    [],
  );
}

function failureNextStep(failureClass: FailureClass, ideaId: string): string {
  switch (failureClass) {
    case 'engineering':
      return `fix the code error, then: ideaseek idea check ${ideaId} && ideaseek idea experiment ${ideaId}`;
    case 'environment':
      return 'fix the environment/dependency (ideaseek doctor), then re-check and re-run';
    case 'data':
      return 'fix the data interface (src/check_data.py / data manifest), then re-check';
    case 'resource':
      return 'free resources or lower the request (config/train.json resources), then re-run';
    case 'metric':
      return 'fix metric emission ({"metrics": …} JSON) in the entry, then re-run';
    default:
      return `inspect the log and rerun: ideaseek idea experiment ${ideaId}`;
  }
}

function mechanismEvidence(
  input: AnalysisInput,
  primary: { name: string; direction: 'higher' | 'lower' } | null,
): AblationObservation[] {
  if (!primary) return [];
  const mainValue =
    input.main && input.main.result.status === 'succeeded'
      ? metricValue(input.main.result, primary.name)
      : null;
  const mainScale = input.main ? specScale(input.main.spec) : null;
  return input.ablations.map((entry) => {
    const ablationValue =
      entry.result.status === 'succeeded' ? metricValue(entry.result, primary.name) : null;
    let supports: boolean | null = null;
    // Only same-scale observations count as mechanism evidence — comparing a
    // quick main run against a smoke ablation would be a methodological error.
    const ablationScale = specScale(entry.spec);
    if (
      entry.removeComponent !== null &&
      mainValue !== null &&
      ablationValue !== null &&
      mainScale !== null &&
      ablationScale === mainScale
    ) {
      // Component is necessary iff REMOVING it makes the metric worse
      // (direction-adjusted drop > 0).
      const drop = adjustedDelta(mainValue, ablationValue, primary.direction);
      supports = drop > 0;
    }
    return {
      ablationId: entry.ablationId,
      label: entry.label,
      removeComponent: entry.removeComponent,
      mainValue,
      ablationValue,
      supports,
    };
  });
}

function finish(
  input: AnalysisInput,
  verdict: AnalysisVerdict,
  failureClass: FailureClass,
  comparisons: BaselineComparison[],
  primaryDelta: number | null,
  evidence: AblationObservation[],
  reasons: string[],
  nextSteps: string[],
  missing: string[],
): IdeaAnalysis {
  return {
    ideaId: input.ideaId,
    ideaVersion: input.ideaVersion,
    codeHash: input.codeHash,
    verdict,
    failureClass,
    baselineComparison: comparisons,
    primaryDelta,
    mechanismEvidence: evidence,
    coverage: {
      scales: input.scalesRun,
      datasets: input.datasetsRun,
      seeds: input.seedsCount,
      missing,
    },
    failures: input.failures,
    resources: input.resources,
    reasons,
    nextSteps,
    generatedAt: Date.now(),
  };
}
