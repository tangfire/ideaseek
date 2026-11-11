import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { ensureDir, writeFileAtomic } from '../core/atomic.js';
import {
  attachSpecResult,
  buildIdeaSpec,
  executeSpecRun,
  ideaResourceRequest,
  prepareSpecRecording,
  recordPlannedSpec,
  resolveAttempt,
  type RegistryPort,
  type IdeaScale,
  type ExperimentDocLike,
  type IdeaRuntime,
} from './experiment.js';
import { deriveAblations, type AblationEntryPlan } from './analysis.js';
import { hashIdeaSource, ideaDir, loadIdeaCard, loadWorkspaceMeta } from './workspace.js';
import type { ExperimentSpec } from '../experiment/spec.js';

/**
 * Ablation runner (plan §E / EVALUATION: 消融必须能区分候选机制): executes the
 * matrix derived from the IdeaCard mechanism chain. Every ablation binds
 * idea_id, idea_version, its own ExperimentSpec and the src content hash;
 * each gets its own registry row (idea-<id>-abl-<slug>) with the same
 * idempotency/version rules as main experiments.
 */

export interface AblationRunEntry {
  ablationId: string;
  label: string;
  removeComponent: string | null;
  specId: string;
  version: number;
  alreadyRecorded: boolean;
  resultStatus: 'succeeded' | 'failed' | null;
  metrics: { name: string; value: number }[];
  failure: { category: string; summary: string } | null;
  exitCode: number;
}

export interface AblationRunResult {
  ideaId: string;
  ideaVersion: number;
  codeHash: string | null;
  entries: AblationRunEntry[];
  allOk: boolean;
}

export interface RunAblationsOptions {
  scale: IdeaScale;
  timeoutMs: number;
}

function slugExists(plan: AblationEntryPlan): boolean {
  return plan.ablationId.length > 0;
}

/**
 * Runs the derived ablation matrix for one idea. Gates: current passing
 * check-report, a SUCCEEDED main experiment (mechanism evidence compares
 * against it) and status ANALYZING. Failures are recorded per ablation and
 * never abort the sibling entries.
 */
export async function runAblations(
  projectRoot: string,
  ideaId: string,
  opts: RunAblationsOptions,
  runtime: IdeaRuntime,
  db: RegistryPort,
): Promise<AblationRunResult> {
  const meta = await loadWorkspaceMeta(projectRoot, ideaId);
  const card = await loadIdeaCard(projectRoot, ideaId);
  const workspace = ideaDir(projectRoot, ideaId);

  // Gate 1: current passing check report (same rule as idea experiment).
  const { readFile } = await import('node:fs/promises');
  interface CheckReportShape {
    outcome?: string;
    version?: number;
    codeHash?: string | null;
  }
  let report: CheckReportShape | null = null;
  try {
    report = JSON.parse(
      await readFile(join(workspace, 'experiments', 'check-report.json'), 'utf8'),
    ) as CheckReportShape;
  } catch {
    report = null;
  }
  const codeHash = await hashIdeaSource(projectRoot, ideaId);
  if (!report || report.outcome !== 'passed') {
    throw new IdeaseekError(
      'DEPENDENCY_NOT_MET',
      `idea ${ideaId} has no passing check report — run: ideaseek idea check ${ideaId}`,
    );
  }
  if (report.version !== meta.currentVersion || report.codeHash !== codeHash) {
    throw new IdeaseekError(
      'DEPENDENCY_NOT_MET',
      `check report is stale (checked v${report.version}, current v${meta.currentVersion} or code changed) — ` +
        `rerun: ideaseek idea check ${ideaId}`,
    );
  }

  // Gate 2: the main experiment must have succeeded (mechanism deltas need it).
  const mainDoc = await db.getExperiment(`idea-${ideaId}`);
  const mainResult = mainDoc?.result as { status?: unknown } | null;
  if (!mainDoc || !mainResult || mainResult.status !== 'succeeded') {
    throw new IdeaseekError(
      'DEPENDENCY_NOT_MET',
      `idea ${ideaId} has no succeeded main experiment — run: ideaseek idea experiment ${ideaId} first`,
    );
  }

  // Gate 3: analysis-phase status.
  if (meta.status !== 'ANALYZING') {
    throw new IdeaseekError(
      'INVALID_STATE',
      `ablations run from ANALYZING (current: ${meta.status}); complete the main experiment first`,
      { status: meta.status },
    );
  }

  const plan = deriveAblations(card).filter(slugExists);
  if (plan.length === 0) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `idea ${ideaId} declares no ablations (componentNecessity with role necessary-mechanism and/or minimalExperiment.ablations)`,
    );
  }

  const entries: AblationRunEntry[] = [];
  for (const item of plan) {
    const specId = `idea-${ideaId}-abl-${item.ablationId}`;
    const existing = (await db.getExperiment(specId)) as ExperimentDocLike | null;
    const attempt = resolveAttempt(existing);
    const { spec: baseSpec } = await buildIdeaSpec(projectRoot, ideaId, {
      scale: opts.scale,
      runtime,
      attempt,
      specIdOverride: specId,
      extraNotes: [
        `ablation:${item.ablationId}`,
        `ablation-label:${item.label}`,
        `parent-spec:idea-${ideaId}`,
        ...(item.removeComponent ? [`removes:${item.removeComponent}`] : []),
      ],
      commandSuffix: ['--ablate', item.ablationId],
    });
    const prepared = await prepareSpecRecording(baseSpec, existing);

    if (prepared.alreadyRecorded && existing) {
      const status = (existing.result as { status?: string }).status ?? 'unknown';
      entries.push({
        ablationId: item.ablationId,
        label: item.label,
        removeComponent: item.removeComponent,
        specId,
        version: existing.version,
        alreadyRecorded: true,
        resultStatus: status === 'succeeded' ? 'succeeded' : 'failed',
        metrics: (
          (existing.result as { metrics?: { name?: unknown; value?: unknown }[] }).metrics ?? []
        )
          .filter((m) => typeof m.value === 'number')
          .map((m) => ({ name: String(m.name), value: m.value as number })),
        failure: null,
        exitCode: 0,
      });
      continue;
    }

    await recordPlannedSpec(db, prepared, existing);
    const exec = await executeSpecRun(
      projectRoot,
      `idea-${ideaId}-abl-${item.ablationId}`,
      prepared.spec,
      opts.timeoutMs,
    );
    await attachSpecResult(
      db,
      prepared.spec,
      exec,
      `ablation ${item.ablationId} for idea ${ideaId} v${meta.currentVersion} ` +
        `(removes: ${item.removeComponent ?? 'declared label'})`,
    );

    // Immutable per-version mirror inside the idea's own experiments/ dir.
    const { assertIdeaWorkspacePath } = await import('./workspace.js');
    const mirrorPath = join(workspace, 'experiments', `${specId}-v${prepared.nextVersion}.json`);
    assertIdeaWorkspacePath(projectRoot, ideaId, mirrorPath);
    await ensureDir(join(workspace, 'experiments'));
    const { spec: preparedSpec } = prepared;
    await writeFileAtomic(
      mirrorPath,
      `${JSON.stringify(
        {
          spec: preparedSpec,
          result: {
            specId,
            status: exec.succeeded ? 'succeeded' : 'failed',
            metrics: exec.metrics,
            failure: exec.failure,
            logRefs: [exec.logRef],
          },
        },
        null,
        2,
      )}\n`,
    );

    entries.push({
      ablationId: item.ablationId,
      label: item.label,
      removeComponent: item.removeComponent,
      specId,
      version: prepared.nextVersion,
      alreadyRecorded: false,
      resultStatus: exec.succeeded ? 'succeeded' : 'failed',
      metrics: exec.metrics,
      failure: exec.failure,
      exitCode: exec.succeeded ? 0 : 1,
    });
  }

  return {
    ideaId,
    ideaVersion: meta.currentVersion,
    codeHash,
    entries,
    allOk: entries.every((entry) => entry.exitCode === 0),
  };
}

/** Resource requests for ablation planning (reuses the main request reader). */
export { ideaResourceRequest };
export type { ExperimentSpec };
