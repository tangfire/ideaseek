import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { ensureDir, writeFileAtomic } from '../core/atomic.js';
import type { ExperimentSpec, RunResult } from '../experiment/spec.js';
import {
  analyzeIdea,
  classifyRuntimeFailure,
  deriveAblations,
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

function metricOf(result: RunResult, name: string | null): number | null {
  if (!name) return null;
  const found = result.metrics.find((m) => m.name === name);
  return found && Number.isFinite(found.value) ? found.value : null;
}

function scaleOf(spec: ExperimentSpec): string {
  const note = (spec.environment.notes ?? []).find((n) => n.startsWith('scale:'));
  return note ? note.slice('scale:'.length) : 'unknown';
}

export async function collectAnalysisInput(
  projectRoot: string,
  ideaId: string,
  db: RegistryLike,
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
  const mainPick =
    succeededMains[succeededMains.length - 1] ??
    [...mainMirrors].reverse().find((m) => m.result) ??
    null;
  const main = mainPick?.result ? { spec: mainPick.spec, result: mainPick.result } : null;
  const primary = main && main.result.status === 'succeeded' ? primaryName(main.spec) : null;

  // Ablations: latest succeeded version per ablationId (mirror preferred,
  // registry row as fallback for anything not yet mirrored).
  const plan = deriveAblations(card);
  const ablationById = new Map<string, AnalysisInput['ablations'][number]>();
  const ablationPrefix = `idea-${ideaId}-abl-`;
  const pushAblation = (ablationId: string, spec: ExperimentSpec, result: RunResult): void => {
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
  const baselines: { methodId: string; value: number | null }[] = [];
  const seenMethods = new Set<string>();
  for (const nearest of card.nearestComparisons) {
    if (seenMethods.has(nearest.methodId)) continue;
    seenMethods.add(nearest.methodId);
    let value: number | null = null;
    const repro = await db.getExperiment(`repro-${nearest.methodId}`);
    if (repro?.result) {
      const result = asResult(repro.result);
      if (result.status === 'succeeded') {
        value = metricOf(result, primary ?? primaryName(asSpec(repro.spec)));
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
        if (!spec.comparisonIds?.includes(nearest.methodId)) continue;
        const candidate = metricOf(result, primary ?? primaryName(spec));
        if (candidate !== null) {
          value = candidate;
          break;
        }
      }
    }
    baselines.push({ methodId: nearest.methodId, value });
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

  return {
    ideaId,
    ideaVersion: meta.currentVersion,
    codeHash,
    card,
    main,
    ablations,
    baselines,
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
): Promise<AnalysisOutcome> {
  const input = await collectAnalysisInput(projectRoot, ideaId, db);
  const analysis = analyzeIdea(input);
  const dir = join(ideaDir(projectRoot, ideaId), 'experiments');
  await ensureDir(dir);
  const { assertIdeaWorkspacePath } = await import('./workspace.js');
  const versioned = join(dir, `analysis-v${analysis.ideaVersion}.json`);
  const latest = join(dir, 'analysis.json');
  assertIdeaWorkspacePath(projectRoot, ideaId, versioned);
  const payload = `${JSON.stringify(analysis, null, 2)}\n`;
  await writeFileAtomic(versioned, payload);
  await writeFileAtomic(latest, payload);
  return { analysis, paths: [versioned, latest] };
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
