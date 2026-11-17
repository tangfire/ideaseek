import type { ExperimentSpec, RunFailureCategory, RunResult } from '../experiment/spec.js';
import { metricIdentifier, metricUnit, unitViolation } from '../core/metric-id.js';
import type { IdeaCard } from './card.js';
import type { IdeaRunStatus } from './workspace.js';

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
  /**
   * Which evidence the number came from, because the three are not equally
   * independent of the idea being judged: a `repro` is the platform's own
   * reproduction of that method, a `run` is a registered experiment whose
   * subject is that method, and an `in-run` control was measured by the idea's
   * own code inside the idea's own run. Best-paired (same slice, same seeds)
   * and self-reported — a verdict resting on it must be quotable as such.
   */
  source?: 'repro' | 'run' | 'in-run';
  /** The record the value was read out of (`in-run` provenance in particular). */
  fromSpecId?: string;
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
  /**
   * The locked protocol's declared name for the primary metric, prose and unit
   * included. The spec stores the bare identifier, so without this the
   * deterministic unit guard reads a name that can never declare anything.
   */
  declaredPrimary?: string;
  /** Primary-metric values from baseline/reproduction runs (null = unknown). */
  baselines: {
    methodId: string;
    value: number | null;
    scale?: string;
    /**
     * Where the number came from, because the three sources are not equally
     * trustworthy and a verdict text that hides which one it used cannot be
     * audited: `repro` is an independent reproduction of that method, `run` is
     * a registered experiment whose subject is that method, and `in-run` is a
     * control the idea's own code measured inside its own run — same slice and
     * seeds as the subject (so best-paired), but written by the party being
     * judged.
     */
    source?: 'repro' | 'run' | 'in-run';
    /** The record the value was read out of, for `source: in-run` provenance. */
    fromSpecId?: string;
  }[];
  /**
   * Recorded values dropped for contradicting the unit their metric name
   * declares (see core/metric-id.ts). Reported rather than silently discarded:
   * "no valid comparison" and "we threw away the only baseline" are different
   * messages, and only one of them tells the researcher to fix a unit.
   */
  unitProblems?: string[];
  /**
   * In-run controls that WERE measured and recorded, but under a metric label
   * that does not denote the primary metric — so they cannot be ranked. They
   * must still be reported: "no baseline available" and "a control exists that
   * this platform cannot read" send the researcher to fix two different files,
   * and the second is a vocabulary bug in the entry, not an absence of evidence.
   */
  unmatchableControls?: string[];
  /**
   * Controls that deserve a second look before any comparison trusts them
   * (see `duplicateControlFindings`). Built by `idea/analyze.ts`.
   */
  suspiciousControls?: string[];
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
  /**
   * What the deterministic ladder concluded, kept beside `verdict` when a model
   * review changes the comparative conclusion. Without it the artifact claimed a
   * verdict nobody could attribute: `analysis.json` held the ladder's `rejected`
   * while the command printed the review's `inconclusive`, and the downstream
   * gates read the file — so the platform acted on one conclusion and showed the
   * researcher another. Both are recorded, each attributed to its owner.
   */
  deterministicVerdict?: AnalysisVerdict;
  deterministicFailureClass?: FailureClass;
  /** Set when a model review's conclusion was adopted over the ladder's. */
  reviewAdopted?: { confidence: number; comparable: boolean } | null;
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

  const ideaValueRaw = metricValue(mainResult, primary.name);
  // The idea's own value is held to the same declared unit as the baselines.
  // Checking only the other side would have passed over the actual FDG case:
  // the protocol declares this metric in percent and the idea's run recorded
  // 0.1686, so the "idea loses" verdict was really a unit mismatch on the
  // idea's side of the comparison.
  // The protocol's declared name is the only place the unit exists: the spec
  // stores the bare identifier, so asking it would always answer "no unit".
  const declaredName = input.declaredPrimary ?? primary.name;
  const ideaUnitViolation =
    ideaValueRaw === null ? null : unitViolation(metricUnit(declaredName), ideaValueRaw);
  const ideaValue = ideaUnitViolation ? null : ideaValueRaw;
  if (ideaUnitViolation !== null) {
    reasons.push(
      `primary metric "${metricIdentifier(declaredName)}" ${ideaUnitViolation} — the recorded ` +
        'value cannot be compared against baselines in the declared unit',
    );
    nextSteps.push(
      'emit the metric in the unit the protocol declares (or re-lock the protocol with the ' +
        'intended unit), then rerun: ideaseek idea experiment ' +
        input.ideaId,
    );
    return finish(
      input,
      'invalid-run',
      'metric',
      input.baselines.map((baseline) => ({
        methodId: baseline.methodId,
        baselineValue: baseline.value,
        ideaValue: ideaValueRaw,
        delta: null,
        ...(baseline.scale !== undefined ? { scale: baseline.scale } : {}),
      })),
      null,
      [],
      reasons,
      nextSteps,
      missing,
    );
  }
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
      ...(baseline.source !== undefined ? { source: baseline.source } : {}),
      ...(baseline.fromSpecId !== undefined ? { fromSpecId: baseline.fromSpecId } : {}),
    });
    if (delta !== null && (bestDelta === null || delta > bestDelta)) bestDelta = delta;
  }

  if (knownBaselines.length === 0) {
    reasons.push(
      '缺少有效对照：no baseline result available — absolute results cannot claim superiority (plan §C.4)',
    );
    if ((input.unitProblems ?? []).length > 0) {
      // The difference matters: a dropped-for-units value means a baseline
      // EXISTS and disagrees with its own declared unit, which is a recording
      // bug to fix, not an absence to accept.
      reasons.push(
        `baseline value(s) discarded for contradicting the declared unit: ${(
          input.unitProblems ?? []
        ).join(' | ')}`,
      );
      nextSteps.push(
        'fix the unit the metric declares versus what was recorded, then re-run the baseline',
      );
    }
    nextSteps.push(
      'reproduce or repair the nearest baseline first (ideaseek baseline reproduce/repair)',
    );
    if ((input.unmatchableControls ?? []).length > 0) {
      // A third distinct fact: the control exists, was measured in this run,
      // and is labelled with the entry's private vocabulary. Neither of the
      // messages above is true for it, and an agent reading the record has to
      // be told which file to edit.
      reasons.push(
        `in-run controls were recorded but cannot be ranked, because their metric label does ` +
          `not denote the primary metric: ${(input.unmatchableControls ?? []).join(' | ')}`,
      );
      nextSteps.push(
        're-emit the entry\'s "baselines" with the primary metric name as the key ' +
          '(ideaseek idea implement <id> hands that name to the code as the metric contract)',
      );
    }
    // The second way to obtain a legal comparison, which the platform itself
    // used to make impossible: an idea run that records the controls it
    // measured in the same run (#22② — entries printed them, the record had no
    // field for them, and the analysis then reported an absence).
    nextSteps.push(
      `or make the idea's own entry measure its controls and report them under "baselines" ` +
        `(methodId + the primary metric name + value), then rerun: ideaseek idea experiment ${input.ideaId}`,
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

  // Reported whatever else the ladder concluded. A pair of controls agreeing to
  // the last bit of a float64 means the comparison may be resting on one
  // computation counted twice, so it must be visible even when the arithmetic
  // produced a win — but the platform does not decide on its own whether two
  // methods were legitimately expected to converge, which is a judgement about
  // the code. What it will not do is let a `supported` verdict stand silently on
  // such a pair: the conclusion downgrades to inconclusive with the numbers
  // quoted, because "beats fedavg" is not evidence when fedavg IS the other
  // control's own value.
  if ((input.suspiciousControls ?? []).length > 0) {
    reasons.push(
      `suspicious identical control values: ${(input.suspiciousControls ?? []).join(' | ')}`,
    );
    nextSteps.push(
      'check that each control is a genuinely different computation in the entry (not one result ' +
        'emitted under two method ids), then rerun: ideaseek idea experiment ' +
        input.ideaId,
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
        ...(baseline.source !== undefined ? { source: baseline.source } : {}),
        ...(baseline.fromSpecId !== undefined ? { fromSpecId: baseline.fromSpecId } : {}),
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
  if ((input.suspiciousControls ?? []).length > 0) {
    // A win measured against a control that is another control's own number is
    // not a win, and the platform will not call it one on the strength of the
    // arithmetic. Downgraded rather than discarded: the numbers stay in the
    // record, the reason quotes them, and the researcher decides what the entry
    // actually computed.
    reasons.push(
      `the comparison would favour the idea, but it is not reportable as support while the ` +
        'controls above are identical: verify the entry computes each control separately',
    );
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

/**
 * The one analysis verdict the platform may record as a status by itself.
 *
 * `supported` and `rejected` are decisions about a hypothesis and stay with the
 * researcher (the ladder's own guidance says to run `idea set-status`, and an
 * automatic SUPPORTED would let arithmetic speak for a scientific claim).
 * `inconclusive` means nothing was established, so there is nothing to record.
 *
 * `invalid-run` is different in kind: it is an engineering fact the
 * deterministic ladder already proved without a model — the run crashed, or a
 * value contradicted the unit its own metric declares. Refusing to record it
 * was the dead end researchers actually hit: the idea stayed in ANALYZING, whose
 * only legal exits are verdicts, so the documented repair route
 * INVALID_RUN → IMPLEMENTING was unreachable and re-implementing the idea
 * complained about an illegal transition instead of fixing the code.
 */
export function verdictAdvancesStatus(verdict: AnalysisVerdict): IdeaRunStatus | null {
  return verdict === 'invalid-run' ? 'INVALID_RUN' : null;
}

/**
 * Moves an idea onto the analysis phases it is demonstrably in, before any
 * verdict is considered.
 *
 * Returns a note for the caller, or null when there was nothing to record. The
 * reason this lives in code rather than in guidance is that its absence made
 * the documented repair route unreachable in practice: an idea whose recorded
 * experiment was invalid sat at SMOKE_TESTED, `idea analyze` proved the run was
 * unusable, and the only legal exits from SMOKE_TESTED are RUNNING,
 * NEEDS_REVISION and REJECTED — so INVALID_RUN could not be recorded at all and
 * `idea implement` then refused to re-open work. Advancing through RUNNING (both
 * edges legal) is the platform describing its own activity, which is exactly
 * what statuses are for; the verdict about the hypothesis is untouched and
 * still requires a human.
 */
export async function advanceAnalysisPhase(
  projectRoot: string,
  ideaId: string,
): Promise<string | null> {
  const { loadWorkspaceMeta, setIdeaStatus } = await import('./workspace.js');
  const meta = await loadWorkspaceMeta(projectRoot, ideaId);
  if (meta.status !== 'SMOKE_TESTED' && meta.status !== 'PROPOSED') return null;
  const trail: IdeaRunStatus[] = [meta.status];
  let current: IdeaRunStatus = meta.status;
  if (current === 'PROPOSED') {
    // A proposed idea cannot be analysed as if it had run: say so plainly
    // instead of inventing a phase it never reached.
    return `analysis phase not advanced from PROPOSED: no experiment has been recorded yet`;
  }
  current = (
    await setIdeaStatus(projectRoot, ideaId, 'RUNNING', 'analysis started on recorded results')
  ).status;
  trail.push(current);
  current = (await setIdeaStatus(projectRoot, ideaId, 'ANALYZING', 'analysis in progress')).status;
  trail.push(current);
  return `status: ${trail[0]} → ${current} (phase tracking only; no verdict recorded)`;
}

/**
 * Controls that carry exactly the same number as another control, or as the
 * subject itself.
 *
 * FDG's entry reported `fedavg` and `dp_noise_matched_no_shrinkage` as
 * 16.896707907604327 — identical to the last digit of a float64. Two genuinely
 * different federated aggregations agreeing to 17 significant digits is not a
 * finding; it is one computation printed twice, which turns "beats fedavg" into
 * "beats itself". The same signature is what #23 caught across records, and
 * nothing looked for it inside a single run.
 *
 * This is reported, never resolved: two methods CAN legitimately converge
 * (a no-op ablation of a null mechanism is the honest case), and deciding
 * whether this run did that is a judgement about the code, not an arithmetic
 * property. So the platform states the numbers, names the records, and leaves
 * the verdict class alone — it does not discard the values (that would hide
 * evidence) and does not treat the similarity as proof of a broken method.
 * Comparison is by exact float equality on purpose: a tolerance would turn
 * every close pair of accuracies into a false alarm, and 17-digit agreement is
 * the only signature that cannot be explained by coincidence.
 */
export function duplicateControlFindings(
  entries: { methodId: string; value: number | null; fromSpecId?: string }[],
  subjectValue: number | null,
): string[] {
  const findings: string[] = [];
  const byValue = new Map<string, { methodId: string; fromSpecId?: string }[]>();
  for (const entry of entries) {
    if (entry.value === null) continue;
    const key = String(entry.value);
    byValue.set(key, [
      ...(byValue.get(key) ?? []),
      { methodId: entry.methodId, fromSpecId: entry.fromSpecId },
    ]);
  }
  for (const [value, group] of byValue) {
    const distinct = [...new Set(group.map((item) => item.methodId))];
    if (distinct.length > 1) {
      findings.push(
        `${distinct.join(' and ')} recorded the identical value ${value}` +
          ` (to the last bit of the float)${
            group[0]?.fromSpecId
              ? ` in ${[...new Set(group.map((i) => i.fromSpecId).filter(Boolean))].join(', ')}`
              : ''
          } — two different methods agreeing to 17 significant digits means one computation was reported twice, not that the methods converge`,
      );
    }
  }
  if (subjectValue !== null) {
    const mirrors = entries.filter((entry) => entry.value !== null && entry.value === subjectValue);
    if (mirrors.length > 0) {
      findings.push(
        `${mirrors.map((entry) => entry.methodId).join(', ')} equal the idea's own primary value ` +
          `${subjectValue} exactly — the same signature as a borrowed baseline (#23), inside one run`,
      );
    }
  }
  return findings;
}
