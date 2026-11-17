import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { ensureDir, writeFileAtomic } from '../core/atomic.js';
import { metricIdentifier, metricUnit, unitViolation } from '../core/metric-id.js';
import type { ExperimentSpec, RunResult } from '../experiment/spec.js';
import {
  analyzeIdea,
  classifyRuntimeFailure,
  deriveAblations,
  duplicateControlFindings,
  type AnalysisInput,
  type IdeaAnalysis,
} from './analysis.js';
import { hashIdeaSource, ideaDir, loadIdeaCard, loadWorkspaceMeta } from './workspace.js';

/**
 * Result Analyst gathering layer: assembles baseline results, the idea's main
 * experiment, ablations, scale/dataset coverage, resource use and failures
 * from the unified registry + workspace, then runs the deterministic verdict
 * ladder (analysis.ts). All failures are kept — nothing is deleted.
 */

interface RegistryLike {
  getExperiment(specId: string): Promise<{
    specId: string;
    spec: Record<string, unknown>;
    result: Record<string, unknown> | null;
  } | null>;
  listExperiments(filter?: {
    status?: 'planned' | 'succeeded' | 'failed' | 'partial' | 'invalid';
  }): Promise<
    {
      specId: string;
      spec: Record<string, unknown>;
      result: Record<string, unknown> | null;
      status: string;
    }[]
  >;
}

function asSpec(record: Record<string, unknown>): ExperimentSpec {
  return record as unknown as ExperimentSpec;
}

function asResult(record: Record<string, unknown>): RunResult {
  return record as unknown as RunResult;
}

function primaryName(spec: ExperimentSpec): string | null {
  return spec.metrics[0]?.name ?? null;
}

/**
 * The value of `name` in a recorded run.
 *
 * Matched by exact name first, then by metric identifier: protocol names carry
 * their definition prose ("… (held-out domain value, all samples, %)") while
 * entries record whatever they printed, and raw-string matching silently
 * returned "no such metric" for records that plainly had it — which, in the
 * baseline path, reads as "no baseline available" and quietly discards real
 * evidence. This is the same vocabulary gap #15 was about, found here by the
 * contamination fix removing the wrong value that had been hiding it.
 */
function metricOf(result: RunResult, name: string | null): number | null {
  if (!name) return null;
  const identifier = metricIdentifier(name);
  const found =
    result.metrics.find((metric) => metric.name === name) ??
    result.metrics.find((metric) => metricIdentifier(metric.name) === identifier);
  return found && Number.isFinite(found.value) ? found.value : null;
}

function scaleOf(spec: ExperimentSpec): string {
  const note = (spec.environment.notes ?? []).find((n) => n.startsWith('scale:'));
  return note ? note.slice('scale:'.length) : 'unknown';
}

/**
 * A baseline value that contradicts the unit the protocol's own metric
 * declaration states cannot be compared, so it is dropped rather than ranked.
 *
 * Without this the platform computed `idea=0.1686 does not beat
 * fedavg=18.75` — a percent recorded against a metric declared in percent being
 * read as a fraction, or the reverse, and the arithmetic happily obeyed. An
 * unusable number must produce "no valid comparison", never a verdict.
 */
function comparableValue(
  declaredName: string | null,
  value: number | null,
): { value: number | null; violation: string | null } {
  if (value === null) return { value: null, violation: null };
  const violation = unitViolation(metricUnit(declaredName ?? ''), value);
  return violation ? { value: null, violation } : { value, violation: null };
}

/**
 * Whether a recorded run measures the given method as its subject.
 *
 * An idea-experiment run lists the baselines it is compared AGAINST in
 * `comparisonIds`; that is a reference, not a measurement. The fallback search
 * used to accept it, so the first idea declaring "nearest: rethinkfl" became
 * the source of rethinkfl's score — on FDG the analysis printed
 * `rethinkfl=0.2209625991904911`, which was another idea's own primary metric
 * to the last digit, and then judged the hypothesis against it. A baseline
 * number may only come from a run whose subject is that method: a
 * `repro-<methodId>` registry record, or a run with no idea binding
 * (baseline/protocol experiments).
 */
export function isBaselineSubjectRun(
  spec: Pick<ExperimentSpec, 'idea' | 'comparisonIds'>,
  methodId: string,
  ideaId: string,
): boolean {
  if (spec.idea?.ideaId === ideaId) return false;
  if (spec.idea) return false;
  return Boolean(spec.comparisonIds?.includes(methodId));
}

export async function collectAnalysisInput(
  projectRoot: string,
  ideaId: string,
  db: RegistryLike,
  /**
   * The locked protocol's metric names as declared, prose and all:
   * `target_unseen_domain_top1_accuracy (held-out domain value, all samples, %)`.
   * The spec carries the bare identifier, so without these the unit the
   * protocol declares could never reach the comparison — the deterministic
   * guard would sit inert while an agent read the same parenthetical and
   * caught the mismatch.
   */
  protocolMetricNames: string[] = [],
): Promise<AnalysisInput> {
  const meta = await loadWorkspaceMeta(projectRoot, ideaId);
  const card = await loadIdeaCard(projectRoot, ideaId);
  const codeHash = await hashIdeaSource(projectRoot, ideaId);
  const all = await db.listExperiments();

  // Mirror history (experiments/*-vN.json): the immutable record of EVERY
  // run, successes and failures alike. Registry rows only hold the latest
  // state; mirrors guarantee unfavorable results never disappear.
  interface MirrorFile {
    spec: ExperimentSpec;
    result: RunResult | null;
  }
  const dir = join(ideaDir(projectRoot, ideaId), 'experiments');
  const { readdir } = await import('node:fs/promises');
  const mirrors: MirrorFile[] = [];
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    if (name === 'check-report.json' || name.startsWith('analysis')) continue;
    if (!name.startsWith(`idea-${ideaId}`)) continue;
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), 'utf8')) as {
        spec?: ExperimentSpec;
        result?: RunResult;
      };
      if (parsed.spec) {
        mirrors.push({ spec: parsed.spec, result: parsed.result ?? null });
      }
    } catch {
      continue;
    }
  }
  mirrors.sort((a, b) => a.spec.version - b.spec.version);

  // Main experiment: prefer the LATEST SUCCEEDED version; fall back to the
  // latest failed one so invalid-run verdicts still see the crash.
  const mainMirrors = mirrors.filter((m) => m.spec.specId === `idea-${ideaId}`);
  const succeededMains = mainMirrors.filter((m) => m.result?.status === 'succeeded');
  // Same-scale pairing: when a registered baseline exists, prefer the main
  // result recorded at the BASELINE's scale — cross-scale deltas would be a
  // methodological error (e.g. quick idea vs smoke baseline).
  let baselineScale: string | null = null;
  for (const doc of all) {
    if (!doc.specId.startsWith('repro-') || !doc.result) continue;
    if (asResult(doc.result).status !== 'succeeded') continue;
    baselineScale = scaleOf(asSpec(doc.spec));
    break;
  }
  const sameScaleMains = baselineScale
    ? succeededMains.filter((m) => scaleOf(m.spec) === baselineScale)
    : [];
  const mainPick =
    sameScaleMains[sameScaleMains.length - 1] ??
    succeededMains[succeededMains.length - 1] ??
    [...mainMirrors].reverse().find((m) => m.result) ??
    null;
  const main = mainPick?.result ? { spec: mainPick.spec, result: mainPick.result } : null;
  const primarySpec = main && main.result.status === 'succeeded' ? primaryName(main.spec) : null;
  // Prefer the protocol's declared form of the same metric: it is the only
  // place the unit (and, in future, the intended direction) is written down.
  // Matching is by identifier, because the spec's name is the identifier
  // stripped of exactly that prose.
  const primary =
    primarySpec === null
      ? null
      : (protocolMetricNames.find(
          (declared) => metricIdentifier(declared) === metricIdentifier(primarySpec),
        ) ?? primarySpec);

  // Ablations: latest succeeded version per ablationId (mirror preferred,
  // registry row as fallback for anything not yet mirrored).
  const plan = deriveAblations(card);
  const ablationById = new Map<string, AnalysisInput['ablations'][number]>();
  const ablationPrefix = `idea-${ideaId}-abl-`;
  const freshForCurrentVersion = (spec: ExperimentSpec): boolean =>
    (spec.environment.notes ?? []).some((n) => n === `idea-v:${meta.currentVersion}`);
  const pushAblation = (ablationId: string, spec: ExperimentSpec, result: RunResult): void => {
    // Only ablations recorded against the CURRENT idea version count as
    // mechanism evidence — stale-code ablations must not support a new version.
    if (!freshForCurrentVersion(spec)) return;
    const planned = plan.find((item) => item.ablationId === ablationId);
    const existing = ablationById.get(ablationId);
    if (existing && existing.spec.version >= spec.version) return;
    ablationById.set(ablationId, {
      ablationId,
      label: planned?.label ?? ablationId,
      removeComponent: planned?.removeComponent ?? null,
      spec,
      result,
    });
  };
  for (const mirror of mirrors) {
    if (!mirror.spec.specId.startsWith(ablationPrefix) || !mirror.result) continue;
    pushAblation(mirror.spec.specId.slice(ablationPrefix.length), mirror.spec, mirror.result);
  }
  for (const doc of all) {
    if (!doc.specId.startsWith(ablationPrefix) || !doc.result) continue;
    pushAblation(doc.specId.slice(ablationPrefix.length), asSpec(doc.spec), asResult(doc.result));
  }
  const ablations = [...ablationById.values()].sort((a, b) =>
    a.ablationId.localeCompare(b.ablationId),
  );

  // Baselines for the nearest comparisons (primary metric values).
  // Primary-metric value of the idea at each covered scale (latest wins).
  const ideaByScale: Record<string, number> = {};
  if (primary) {
    for (const mirror of succeededMains) {
      const value = metricOf(mirror.result!, primary);
      if (value !== null) ideaByScale[scaleOf(mirror.spec)] = value;
    }
  }

  const baselines: { methodId: string; value: number | null; scale?: string }[] = [];
  /** Values rejected for contradicting their metric's declared unit. */
  const unitProblems: string[] = [];
  /** In-run controls that exist but are not labelled as the primary metric. */
  const unmatchableControls: string[] = [];
  const seenMethods = new Set<string>();
  for (const nearest of card.nearestComparisons) {
    if (seenMethods.has(nearest.methodId)) continue;
    seenMethods.add(nearest.methodId);
    let value: number | null = null;
    let valueScale: string | undefined;
    let baselineSource: 'repro' | 'run' | 'in-run' | undefined;
    let baselineFrom: string | undefined;
    const repro = await db.getExperiment(`repro-${nearest.methodId}`);
    if (repro?.result) {
      const result = asResult(repro.result);
      if (result.status === 'succeeded') {
        const raw = metricOf(result, primary ?? primaryName(asSpec(repro.spec)));
        const checked = comparableValue(primary ?? primaryName(asSpec(repro.spec)), raw);
        value = checked.value;
        if (checked.violation) unitProblems.push(`repro-${nearest.methodId}: ${checked.violation}`);
        valueScale = scaleOf(asSpec(repro.spec));
        if (value !== null) baselineSource = 'repro';
      }
    }
    if (value === null) {
      for (const doc of all) {
        if (!doc.result) continue;
        // Never treat the idea's own runs as their own baseline.
        if (doc.specId.startsWith(`idea-${ideaId}`)) continue;
        const result = asResult(doc.result);
        if (result.status !== 'succeeded') continue;
        const spec = asSpec(doc.spec);
        // An idea-experiment run lists the baselines it is compared AGAINST in
        // `comparisonIds`; that is a reference, not a measurement of them. This
        // loop used to accept it, so the first idea that declared "nearest:
        // rethinkfl" became the source of rethinkfl's score — on FDG the
        // analysis printed `rethinkfl=0.2209625991904911`, which was another
        // idea's own primary metric to the last digit, and then called the
        // hypothesis beaten. A baseline number may only come from a run whose
        // subject is that method: the `repro-<methodId>` records above, or a run
        // with no idea binding (baseline/protocol experiments).
        if (!isBaselineSubjectRun(spec, nearest.methodId, ideaId)) continue;
        const raw = metricOf(result, primary ?? primaryName(spec));
        const checked = comparableValue(primary ?? primaryName(spec), raw);
        if (checked.value !== null) {
          value = checked.value;
          valueScale = scaleOf(spec);
          baselineSource = doc.specId.startsWith('repro-') ? 'repro' : 'run';
          baselineFrom = doc.specId;
          break;
        }
        if (checked.violation) unitProblems.push(`${doc.specId}: ${checked.violation}`);
      }
    }
    // In-run controls are consulted even when a repro already supplied a
    // number, and a control measured at the subject's own scale then wins: the
    // independence order (repro > registered > in-run) is right in general, but
    // FDG showed it wrong in the specific way that matters — `fedavg=18.75` from
    // a scale-unknown repro outranked the same run's own `fedavg=16.896708` at
    // smoke, and the review could only answer that the two are not matched
    // instrumentation. An unrankable comparison is not made honest by
    // preferring it for provenance.
    {
      // Last legal source: a control this idea's own run measured and recorded
      // as one (#22② — entries printed these for months and the platform threw
      // the numbers away, then reported "no baseline available"). Admissible
      // because the record names the method it measured, at this run's scale —
      // not because some other number in the file looks similar, which is the
      // #23 case this must not be confused with.
      const inRunCandidates: { spec: ExperimentSpec; result: RunResult }[] = [
        ...[...succeededMains]
          .filter((mirror): mirror is { spec: ExperimentSpec; result: RunResult } =>
            Boolean(mirror.result),
          )
          .reverse(),
        ...all
          .filter((doc) => doc.specId.startsWith(`idea-${ideaId}`) && doc.result)
          .map((doc) => ({ spec: asSpec(doc.spec), result: asResult(doc.result!) })),
      ];
      for (const candidate of inRunCandidates) {
        if (candidate.result.status !== 'succeeded') continue;
        const recorded = (candidate.result.baselines ?? []).filter(
          (entry) => entry.methodId === nearest.methodId,
        );
        if (recorded.length === 0) continue;
        const control =
          primary === null
            ? undefined
            : recorded.find(
                (entry) => metricIdentifier(entry.metric) === metricIdentifier(primary),
              );
        if (!control) {
          // The run DID measure this control, under a key that does not denote
          // the primary metric. FDG's entry writes {"fedavg": {"unseen": …,
          // "in_domain": …}} — private vocabulary again (#15), this time on the
          // baseline side. Ranking it would compare whatever `unseen` is
          // against an accuracy; dropping it silently would report an absence
          // that is not true. So it is reported, unranked, with the fix.
          unmatchableControls.push(
            `${nearest.methodId}: recorded as "${recorded
              .map((entry) => entry.metric)
              .join('", "')}" in ${candidate.spec.specId}@v${candidate.spec.version}, ` +
              `which does not denote the primary metric "${primary ?? '(unknown)'}"`,
          );
          continue;
        }
        const checked = comparableValue(primary, control.value);
        if (checked.value === null) {
          if (checked.violation) {
            unitProblems.push(
              `${candidate.spec.specId}@${candidate.spec.version}: ${checked.violation}`,
            );
          }
          continue;
        }
        const candidateScale = scaleOf(candidate.spec);
        // Override an already-found source only when this control is paired by
        // scale and the current one is not. Otherwise the more independent
        // source stands, which is the order that was chosen deliberately.
        const subjectScale = main ? scaleOf(main.spec) : null;
        const overrides =
          value === null ||
          (valueScale !== subjectScale && candidateScale === subjectScale && subjectScale !== null);
        if (!overrides) continue;
        value = checked.value;
        valueScale = candidateScale;
        baselineSource = 'in-run';
        baselineFrom = `${candidate.spec.specId}@v${candidate.spec.version}`;
        break;
      }
    }
    baselines.push({
      methodId: nearest.methodId,
      value,
      ...(valueScale !== undefined ? { scale: valueScale } : {}),
      ...(baselineSource ? { source: baselineSource } : {}),
      ...(baselineFrom ? { fromSpecId: baselineFrom } : {}),
    });
    // Additional per-scale registered baselines: repro-<methodId>-<scale>.
    for (const doc of all) {
      if (!doc.specId.startsWith(`repro-${nearest.methodId}-`) || !doc.result) continue;
      const result = asResult(doc.result);
      if (result.status !== 'succeeded') continue;
      const spec = asSpec(doc.spec);
      const extraScale = scaleOf(spec);
      if (extraScale === valueScale) continue;
      const extraChecked = comparableValue(
        primary ?? primaryName(spec),
        metricOf(result, primary ?? primaryName(spec)),
      );
      if (extraChecked.value === null) {
        if (extraChecked.violation) {
          unitProblems.push(`${doc.specId}: ${extraChecked.violation}`);
        }
        continue;
      }
      baselines.push({ methodId: nearest.methodId, value: extraChecked.value, scale: extraScale });
    }
  }

  // Coverage + resources + failures across the FULL mirror history.
  const scales = new Set<string>();
  const datasets = new Set<string>();
  const failures: AnalysisInput['failures'] = [];
  const resources: AnalysisInput['resources'] = [];
  const failedKeys = new Set<string>();
  const recordFailure = (specId: string, version: number, result: RunResult): void => {
    const key = `${specId}@${version}`;
    if (failedKeys.has(key)) return;
    failedKeys.add(key);
    failures.push({
      specId,
      category: result.failure?.category ?? null,
      class: classifyRuntimeFailure(result.failure?.category),
      logRefs: result.logRefs ?? [],
    });
  };
  const recordResources = (specId: string, result: RunResult): void => {
    resources.push({
      specId,
      gpuMinutes: result.resourcesUsed?.gpuMinutes ?? null,
      peakMemoryGiB: result.resourcesUsed?.peakMemoryGiB ?? null,
    });
  };
  for (const mirror of mirrors) {
    if (!mirror.spec.specId.startsWith(`idea-${ideaId}`)) continue;
    if (!mirror.result) continue;
    recordResources(mirror.spec.specId, mirror.result);
    if (mirror.result.status === 'succeeded') {
      scales.add(scaleOf(mirror.spec));
      if (mirror.spec.dataSnapshotId) datasets.add(mirror.spec.dataSnapshotId);
    } else {
      recordFailure(mirror.spec.specId, mirror.spec.version, mirror.result);
    }
  }
  // Registry rows without mirrors (defensive fallback).
  for (const doc of all) {
    if (!doc.specId.startsWith(`idea-${ideaId}`) || !doc.result) continue;
    const result = asResult(doc.result);
    const spec = asSpec(doc.spec);
    const mirrored = mirrors.some(
      (m) => m.spec.specId === doc.specId && m.spec.version === spec.version,
    );
    if (result.status !== 'succeeded') {
      recordFailure(doc.specId, spec.version, result);
    } else if (!mirrored) {
      scales.add(scaleOf(spec));
      if (spec.dataSnapshotId) datasets.add(spec.dataSnapshotId);
      recordResources(doc.specId, result);
    }
  }

  // Identical control values, detected here where the provenance of every
  // number is still known and reported there where a verdict is written. The
  // idea's own primary value is the reference because "fedavg equals the
  // subject" is the #23 signature in its single-run form.
  const subjectPrimary =
    main && main.result.status === 'succeeded' ? metricOf(main.result, primary) : null;
  // Duplicate detection runs over the control group each run actually
  // recorded, not over the subset the card happened to ask about. The first
  // version looked at `baselines` and found nothing on FDG while the record
  // plainly held fedavg = dp_noise_matched_no_shrinkage = 16.896708: the card
  // never declares dp_matched, so the pair could never meet inside the gathered
  // list. A check that only inspects what was asked about cannot find what was
  // not asked about, which is precisely the kind of number that should surface.
  const allControls: { methodId: string; value: number; fromSpecId: string }[] = [];
  const collectControls = (spec: ExperimentSpec, result: RunResult): void => {
    if (result.status !== 'succeeded') return;
    const from = `${spec.specId}@v${spec.version}`;
    for (const control of result.baselines ?? []) {
      if (metricIdentifier(control.metric) !== metricIdentifier(primary ?? '')) continue;
      if (
        allControls.some(
          (entry) => entry.fromSpecId === from && entry.methodId === control.methodId,
        )
      )
        continue;
      allControls.push({ methodId: control.methodId, value: control.value, fromSpecId: from });
    }
  };
  for (const mirror of succeededMains) collectControls(mirror.spec, mirror.result!);
  for (const doc of all) {
    if (!doc.result || !doc.specId.startsWith(`idea-${ideaId}`)) continue;
    collectControls(asSpec(doc.spec), asResult(doc.result));
  }
  const suspiciousControls = duplicateControlFindings(allControls, subjectPrimary);

  return {
    ideaId,
    ideaVersion: meta.currentVersion,
    codeHash,
    card,
    main,
    ablations,
    baselines,
    declaredPrimary: protocolMetricNames.find(
      (declared) => primary !== null && metricIdentifier(declared) === metricIdentifier(primary),
    ),
    unitProblems,
    unmatchableControls,
    suspiciousControls,
    ideaByScale,
    scalesRun: [...scales].sort(),
    datasetsRun: [...datasets].sort(),
    seedsCount: main && main.result.status === 'succeeded' ? (main.spec.seeds ?? []).length : 0,
    failures,
    resources,
  };
}

export interface AnalysisOutcome {
  analysis: IdeaAnalysis;
  /** analysis.json (latest) and analysis-v<version>.json (immutable history). */
  paths: string[];
}

/**
 * Gathers inputs, runs the analyst and persists versioned + latest analysis
 * under the idea's experiments/ directory (own workspace only).
 */
export async function runAnalysis(
  projectRoot: string,
  ideaId: string,
  db: RegistryLike,
  protocolMetricNames: string[] = [],
): Promise<AnalysisOutcome> {
  const input = await collectAnalysisInput(projectRoot, ideaId, db, protocolMetricNames);
  const analysis = analyzeIdea(input);
  const paths = await persistAnalysis(projectRoot, analysis);
  return { analysis, paths };
}

/**
 * Write the analysis into the idea workspace: the versioned copy and the
 * `analysis.json` every downstream gate reads.
 *
 * Exported because the conclusion a command displays is not always the one it
 * first persisted: a comparability review may adopt a different comparative
 * verdict, and a file that still holds the superseded conclusion makes the
 * platform act on one verdict while showing the researcher another — which is
 * what happened on FDG, where `analysis.json` said `rejected` and the command
 * printed `inconclusive`, and `full plan` then blocked handoff on the stale word.
 */
export async function persistAnalysis(
  projectRoot: string,
  analysis: IdeaAnalysis,
): Promise<string[]> {
  const dir = join(ideaDir(projectRoot, analysis.ideaId), 'experiments');
  await ensureDir(dir);
  const { assertIdeaWorkspacePath } = await import('./workspace.js');
  const versioned = join(dir, `analysis-v${analysis.ideaVersion}.json`);
  const latest = join(dir, 'analysis.json');
  assertIdeaWorkspacePath(projectRoot, analysis.ideaId, versioned);
  const payload = `${JSON.stringify(analysis, null, 2)}\n`;
  await writeFileAtomic(versioned, payload);
  await writeFileAtomic(latest, payload);
  return [versioned, latest];
}

/** Validates the idea exists before analysis (fail fast with clear errors). */
export async function assertAnalyzable(projectRoot: string, ideaId: string): Promise<void> {
  try {
    await loadWorkspaceMeta(projectRoot, ideaId);
  } catch (error) {
    if (error instanceof IdeaseekError) throw error;
    throw new IdeaseekError('TASK_NOT_FOUND', `idea ${ideaId} not found`);
  }
}
