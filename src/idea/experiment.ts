import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { sha256Of } from '../core/hash.js';
import { ensureDir, writeFileAtomic } from '../core/atomic.js';
import { classifyRepairFailure, runRepairCommand, writeRepairLog } from '../comparison/repair.js';
import { stableJson, type ExperimentSpec, type RunResult } from '../experiment/spec.js';
import type { RunFailureCategory } from '../experiment/spec.js';
import { assessIdeaCard } from './card.js';
import { hashIdeaSource, ideaDir, loadIdeaCard, loadWorkspaceMeta } from './workspace.js';
import type { IdeaCheckReport } from './check.js';

/**
 * ExperimentSpec/RunResult wiring for ideas (plan §E, DATA_CONTRACTS): every
 * idea run is recorded in the unified registry, bound to the idea version and
 * src content hash, gated behind a passing `idea check`, and limited to
 * smoke/quick micro-runs — full training stays in the handoff package.
 */

export type IdeaScale = 'smoke' | 'quick';

export interface BuildIdeaSpecResult {
  spec: ExperimentSpec;
  attempt: number;
}

async function readJsonIfPresent<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Direction lookup from the locked/latest protocol when available. */
async function metricDirections(runtime: {
  db: { listArtifactsByKind(kind: string): Promise<{ contentHash: string }[]> };
  store: { readFinalText(hash: string): Promise<string> };
}): Promise<Map<string, 'higher' | 'lower'>> {
  const directions = new Map<string, 'higher' | 'lower'>();
  try {
    const artifacts = await runtime.db.listArtifactsByKind('protocol-proposal');
    const chosen = artifacts[artifacts.length - 1];
    if (!chosen) return directions;
    const proposal = JSON.parse(await runtime.store.readFinalText(chosen.contentHash)) as {
      primaryMetrics?: { name?: unknown; direction?: unknown }[];
      secondaryMetrics?: { name?: unknown; direction?: unknown }[];
    };
    for (const metric of [
      ...(proposal.primaryMetrics ?? []),
      ...(proposal.secondaryMetrics ?? []),
    ]) {
      if (
        typeof metric.name === 'string' &&
        (metric.direction === 'higher' || metric.direction === 'lower')
      ) {
        directions.set(metric.name, metric.direction);
      }
    }
  } catch {
    // no protocol yet — default direction applies
  }
  return directions;
}

/**
 * Builds the unified ExperimentSpec for the idea's current version:
 * specId `idea-<id>` (versions bump in place), comparisonIds from the card's
 * nearest comparisons, code binding via src hash + idea version notes,
 * seeds/budget from the card and config, protocol linkage when present.
 */
export async function buildIdeaSpec(
  projectRoot: string,
  ideaId: string,
  opts: {
    scale: IdeaScale;
    runtime: Parameters<typeof metricDirections>[0];
    /** Retry ordinal; baked into environment.notes so retries hash differently. */
    attempt?: number;
  },
): Promise<BuildIdeaSpecResult> {
  const meta = await loadWorkspaceMeta(projectRoot, ideaId);
  const card = await loadIdeaCard(projectRoot, ideaId);
  const workspace = ideaDir(projectRoot, ideaId);
  const config =
    (await readJsonIfPresent<Record<string, unknown>>(join(workspace, 'config', 'train.json'))) ??
    {};
  const codeHash = await hashIdeaSource(projectRoot, ideaId);

  const directions = await metricDirections(opts.runtime);
  const configMetrics = Array.isArray(config.metrics) ? config.metrics : [];
  const metrics = configMetrics
    .map((m) => (typeof m === 'string' ? m : String((m as { name?: unknown }).name ?? '')))
    .filter((name) => name)
    .map((name) => ({ name, direction: directions.get(name) ?? ('higher' as const) }));
  if (metrics.length === 0) {
    // Fall back to the card's minimal experiment metric names.
    for (const name of card.minimalExperiment.metrics) {
      metrics.push({ name, direction: directions.get(name) ?? 'higher' });
    }
  }

  const manifest = await readJsonIfPresent<{ inputs?: { path: string; sha256: string }[] }>(
    join(workspace, 'data', 'manifest.json'),
  );
  const dataSnapshotId = manifest?.inputs?.length
    ? `inputs:${sha256Of(stableJson(manifest.inputs)).slice(7, 25)}`
    : 'synthetic:idea-workspace';

  const protocolId = await latestProtocolId(opts.runtime);
  const attempt = opts.attempt ?? 1;

  const spec: ExperimentSpec = {
    specId: `idea-${ideaId}`,
    version: 1, // caller rewrites after hash comparison
    idea: { ideaId, version: meta.currentVersion },
    comparisonIds: card.nearestComparisons.map((item) => item.methodId),
    codeCommit: null,
    dataSnapshotId,
    sliceIds: [],
    environment: {
      python: process.version,
      notes: [
        `scale:${opts.scale}`,
        `idea-v:${meta.currentVersion}`,
        `idea-code:${codeHash ?? 'empty'}`,
        `attempt:${attempt}`,
      ],
    },
    command: commandFor(config, opts.scale),
    metrics,
    seeds: Array.isArray(config.seeds)
      ? config.seeds.filter((s): s is number => typeof s === 'number' && Number.isInteger(s))
      : [42],
    resources: (() => {
      const res = (config.resources ?? {}) as { gpus?: unknown; memoryGiB?: unknown };
      return {
        ...(typeof res.gpus === 'number' && res.gpus >= 0 ? { gpus: Math.floor(res.gpus) } : {}),
        ...(typeof res.memoryGiB === 'number' && res.memoryGiB > 0
          ? { memoryGiB: res.memoryGiB }
          : {}),
      };
    })(),
    budget: {
      maxRuns: card.budget.maxRounds,
      maxMinutes: card.budget.maxGpuMinutes,
    },
    protocolId,
    createdAt: Date.now(),
  };

  return { spec, attempt };
}

interface ExperimentDocLike {
  version: number;
  specHash: string;
  spec: Record<string, unknown>;
  result: Record<string, unknown> | null;
}

async function latestProtocolId(
  runtime: Parameters<typeof metricDirections>[0],
): Promise<string | null> {
  try {
    const artifacts = await runtime.db.listArtifactsByKind('protocol-proposal');
    const chosen = artifacts[artifacts.length - 1];
    if (!chosen) return null;
    const proposal = JSON.parse(await runtime.store.readFinalText(chosen.contentHash)) as {
      protocolId?: unknown;
    };
    return typeof proposal.protocolId === 'string' ? proposal.protocolId : null;
  } catch {
    return null;
  }
}

function commandFor(config: Record<string, unknown>, scale: IdeaScale): string[] {
  if (Array.isArray(config.command) && config.command.every((c) => typeof c === 'string')) {
    return config.command as string[];
  }
  // smoke uses the micro-run entry; quick runs the training entry.
  return scale === 'smoke' ? ['python', 'src/smoke.py'] : ['python', 'src/train.py'];
}

const KIND_TO_FAILURE: Record<string, RunFailureCategory> = {
  'missing-dependency': 'dependency',
  'path-error': 'data',
  'syntax-error': 'code',
  'permission-error': 'environment',
  'device-error': 'resource',
  timeout: 'timeout',
  unknown: 'unknown',
};

/** Per-idea resource request from config/train.json (conservative default). */
export async function ideaResourceRequest(
  projectRoot: string,
  ideaId: string,
): Promise<{ ideaId: string; gpus: number; memoryGiB: number; createdAt: number }> {
  let gpus = 0;
  let memoryGiB = 1;
  let createdAt = 0;
  try {
    const cfg = JSON.parse(
      await readFile(join(ideaDir(projectRoot, ideaId), 'config', 'train.json'), 'utf8'),
    ) as { resources?: { gpus?: unknown; memoryGiB?: unknown } };
    if (typeof cfg.resources?.gpus === 'number' && cfg.resources.gpus >= 0) {
      gpus = Math.floor(cfg.resources.gpus);
    }
    if (typeof cfg.resources?.memoryGiB === 'number' && cfg.resources.memoryGiB > 0) {
      memoryGiB = cfg.resources.memoryGiB;
    }
  } catch {
    // no config yet — conservative CPU-only default
  }
  try {
    createdAt = (await loadIdeaCard(projectRoot, ideaId)).createdAt;
  } catch {
    createdAt = 0;
  }
  return { ideaId, gpus, memoryGiB, createdAt };
}

export interface IdeaExperimentOutcome {
  specId: string;
  version: number;
  attempt: number;
  /** True when an identical successful spec was already recorded. */
  alreadyRecorded: boolean;
  resultStatus: 'succeeded' | 'failed' | null;
  metrics: { name: string; value: number }[];
  failure: { category: RunFailureCategory; summary: string } | null;
  exitCode: number;
  statusAfter: string;
}

export interface RunIdeaExperimentOptions {
  scale: IdeaScale;
  timeoutMs: number;
}

/**
 * Gate → build → (idempotent | run) → attach RunResult. The check-report must
 * be passing AND current (version + code hash) before any experiment runs.
 */
export async function runIdeaExperiment(
  projectRoot: string,
  ideaId: string,
  opts: RunIdeaExperimentOptions,
  runtime: Parameters<typeof metricDirections>[0],
  db: {
    getExperiment(specId: string): Promise<ExperimentDocLike | null>;
    upsertExperiment(doc: {
      specId: string;
      version: number;
      specHash: string;
      status: 'planned' | 'succeeded' | 'failed' | 'partial' | 'invalid';
      spec: Record<string, unknown>;
      result: Record<string, unknown> | null;
      updatedAt: number;
    }): Promise<void>;
    attachExperimentResult(
      specId: string,
      result: Record<string, unknown>,
      status: 'succeeded' | 'failed' | 'partial' | 'invalid',
    ): Promise<unknown>;
  },
): Promise<IdeaExperimentOutcome> {
  const meta = await loadWorkspaceMeta(projectRoot, ideaId);
  const workspace = ideaDir(projectRoot, ideaId);

  // Queue gate: a current, passing check report is mandatory (plan §E.3).
  const report = await readJsonIfPresent<IdeaCheckReport>(
    join(workspace, 'experiments', 'check-report.json'),
  );
  if (!report || report.outcome !== 'passed') {
    throw new IdeaseekError(
      'DEPENDENCY_NOT_MET',
      `idea ${ideaId} has no passing check report — run: ideaseek idea check ${ideaId} ` +
        '(scaffold with ideaseek idea scaffold first)',
    );
  }
  if (
    report.version !== meta.currentVersion ||
    report.codeHash !== (await hashIdeaSource(projectRoot, ideaId))
  ) {
    throw new IdeaseekError(
      'DEPENDENCY_NOT_MET',
      `check report is stale (checked v${report.version}, current v${meta.currentVersion} or code changed) — ` +
        `rerun: ideaseek idea check ${ideaId}`,
    );
  }
  if (meta.status !== 'SMOKE_TESTED' && meta.status !== 'RUNNING' && meta.status !== 'ANALYZING') {
    throw new IdeaseekError(
      'INVALID_STATE',
      `idea ${ideaId} is ${meta.status}; experiments start from SMOKE_TESTED ` +
        `(walk NEEDS_REVISION → IMPLEMENTING → check after revisions)`,
      { status: meta.status },
    );
  }

  const assessment = assessIdeaCard(await loadIdeaCard(projectRoot, ideaId));
  if (!assessment.ok) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `idea card invalid: ${assessment.validation.errors.join('; ')}`,
    );
  }

  const specId = `idea-${ideaId}`;
  const existing = await db.getExperiment(specId);

  // Retry failed attempts as a new version; succeeded ones stay idempotent.
  const latestFailed =
    existing?.result != null && (existing.result as { status?: unknown }).status !== 'succeeded';
  const attempt = latestFailed && existing ? existing.version + 1 : 1;

  const { spec: specWithAttempt } = await buildIdeaSpec(projectRoot, ideaId, {
    scale: opts.scale,
    runtime,
    attempt,
  });

  const { computeSpecHash, validateExperimentSpec } = await import('../experiment/spec.js');
  const validation = validateExperimentSpec(specWithAttempt);
  if (!validation.ok) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `built experiment spec failed validation: ${validation.errors.join('; ')}`,
    );
  }
  // Hash stability: compare at the CURRENT version with the original
  // createdAt (wall-clock in the hash would make every run look changed).
  specWithAttempt.version = existing ? existing.version : 1;
  const existingCreatedAt = (existing?.spec as { createdAt?: unknown } | null)?.createdAt;
  if (typeof existingCreatedAt === 'number') {
    specWithAttempt.createdAt = existingCreatedAt;
  }
  const specHash = computeSpecHash(specWithAttempt);
  const hashChanged = existing !== null && existing.specHash !== specHash;
  const nextVersion = existing ? (hashChanged ? existing.version + 1 : existing.version) : 1;
  specWithAttempt.version = nextVersion;
  const finalHash = computeSpecHash(specWithAttempt);

  // Idempotent: same spec already has a recorded result → do not re-run.
  if (existing && existing.specHash === finalHash && existing.result) {
    const status = (existing.result as { status?: string }).status ?? 'unknown';
    const after = await import('./workspace.js').then((m) =>
      m.loadWorkspaceMeta(projectRoot, ideaId),
    );
    return {
      specId,
      version: existing.version,
      attempt,
      alreadyRecorded: true,
      resultStatus: status === 'succeeded' ? 'succeeded' : 'failed',
      metrics: (
        (existing.result as { metrics?: { name?: unknown; value?: unknown }[] }).metrics ?? []
      )
        .filter((m) => typeof m.value === 'number')
        .map((m) => ({ name: String(m.name), value: m.value as number })),
      failure: null,
      exitCode: 0,
      statusAfter: after.status,
    };
  }

  // A real (re-)run needs the pre-analysis part of the graph: ANALYZING ideas
  // walk NEEDS_REVISION → IMPLEMENTING → check first; SMOKE_TESTED enters
  // RUNNING. Failed runs stay RUNNING (fix + retry without ceremony).
  if (meta.status === 'ANALYZING') {
    throw new IdeaseekError(
      'INVALID_STATE',
      `idea ${ideaId} is ANALYZING with a changed spec — walk back first: ` +
        `ideaseek idea set-status ${ideaId} NEEDS_REVISION --reason "..." ` +
        `→ IMPLEMENTING → check → SMOKE_TESTED`,
      { status: meta.status },
    );
  }
  if (meta.status === 'SMOKE_TESTED') {
    const { setIdeaStatus } = await import('./workspace.js');
    await setIdeaStatus(projectRoot, ideaId, 'RUNNING');
  }

  await db.upsertExperiment({
    specId,
    version: nextVersion,
    specHash: finalHash,
    status: 'planned',
    spec: specWithAttempt as unknown as Record<string, unknown>,
    result: existing && existing.specHash === finalHash ? existing.result : null,
    updatedAt: Date.now(),
  });

  // --- execute the bounded run (smoke/quick only; never full training).
  const command = specWithAttempt.command;
  const startedAt = Date.now();
  const run = await runRepairCommand(command, workspace, opts.timeoutMs);
  const logName = `idea-${ideaId}-experiment-${opts.scale}.log`;
  await writeRepairLog(projectRoot, logName, command, run.exitCode, run.out);
  const logRef = `.research/logs/${logName}`;

  // Parse {"metrics": {...}} (last JSON line).
  const metrics: { name: string; value: number }[] = [];
  let parseFailure: string | null = null;
  const lines = run.out.split(/\r?\n/).filter((line) => line.trim());
  let parsed: { metrics?: Record<string, unknown> } | null = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const candidate = JSON.parse(lines[i]!) as { metrics?: Record<string, unknown> };
      if (candidate && typeof candidate.metrics === 'object' && candidate.metrics) {
        parsed = candidate;
        break;
      }
    } catch {
      continue;
    }
  }
  const metricMap = parsed?.metrics ?? {};
  if (run.exitCode === 0 && !run.timedOut) {
    if (!parsed || Object.keys(metricMap).length === 0) {
      parseFailure = 'entry produced no {"metrics": {...}} JSON line';
    } else {
      const missing: string[] = [];
      for (const expected of specWithAttempt.metrics) {
        const value = metricMap[expected.name];
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          missing.push(expected.name);
          continue;
        }
        metrics.push({ name: expected.name, value });
      }
      if (missing.length > 0) {
        parseFailure = `metrics missing or non-finite: ${missing.join(', ')}`;
      }
    }
  }

  const succeeded = run.exitCode === 0 && !run.timedOut && parseFailure === null;
  const failureCategory: RunFailureCategory = succeeded
    ? 'unknown'
    : run.timedOut
      ? 'timeout'
      : parseFailure
        ? 'invalid-result'
        : (KIND_TO_FAILURE[classifyRepairFailure(run.out, run.exitCode, run.timedOut).kind] ??
          'unknown');
  const failureSummary = succeeded
    ? ''
    : run.timedOut
      ? `timed out after ${opts.timeoutMs}ms`
      : (parseFailure ??
        classifyRepairFailure(run.out, run.exitCode, run.timedOut).summary.slice(0, 300));

  const result: RunResult = {
    specId,
    status: succeeded ? 'succeeded' : 'failed',
    logRefs: [logRef],
    artifactRefs: [],
    metrics,
    resourcesUsed: {},
    failure: succeeded ? null : { category: failureCategory, summary: failureSummary },
    startedAt,
    finishedAt: Date.now(),
    explanation: `idea ${ideaId} v${meta.currentVersion} scale=${opts.scale} attempt=${attempt}`,
  };
  await db.attachExperimentResult(
    specId,
    result as unknown as Record<string, unknown>,
    succeeded ? 'succeeded' : 'failed',
  );

  // Mirror spec+result into the idea workspace (own directory only).
  const { assertIdeaWorkspacePath } = await import('./workspace.js');
  const mirrorPath = join(workspace, 'experiments', `${specId}-v${nextVersion}.json`);
  assertIdeaWorkspacePath(projectRoot, ideaId, mirrorPath);
  await ensureDir(join(workspace, 'experiments'));
  await writeFileAtomic(
    mirrorPath,
    `${JSON.stringify({ spec: specWithAttempt, result }, null, 2)}\n`,
  );

  // Lifecycle: a SUCCEEDED run moves RUNNING → ANALYZING (Result Analyst
  // territory). A FAILED run stays RUNNING — fix, re-check, retry; the
  // failure itself is already recorded as a RunResult.
  const { setIdeaStatus } = await import('./workspace.js');
  const after = await loadWorkspaceMeta(projectRoot, ideaId);
  let statusAfter = after.status;
  if (succeeded && after.status === 'RUNNING') {
    statusAfter = (await setIdeaStatus(projectRoot, ideaId, 'ANALYZING')).status;
  }

  return {
    specId,
    version: nextVersion,
    attempt,
    alreadyRecorded: false,
    resultStatus: succeeded ? 'succeeded' : 'failed',
    metrics,
    failure: succeeded ? null : { category: failureCategory, summary: failureSummary },
    exitCode: succeeded ? 0 : 1,
    statusAfter,
  };
}

export interface ReadyRunRequest {
  scale: IdeaScale;
  timeoutMs: number;
  /** User ceiling from config (resources.max_parallel_ideas). */
  maxParallelIdeas: number;
}

export interface ReadyRunOutcome {
  ideaId: string;
  ok: boolean;
  /** Present when the experiment executed (or was already recorded). */
  outcome?: IdeaExperimentOutcome;
  /** Set when the per-idea run threw (gate violation, IO, …). */
  error?: string;
}

export interface ReadyRunResult {
  admitted: string[];
  queued: { ideaId: string; reason: string }[];
  constraints: string[];
  outcomes: ReadyRunOutcome[];
  /** False when any admitted run failed or errored. */
  allOk: boolean;
}

/**
 * Multi-idea parallel runner (plan §E): discovers SMOKE_TESTED ideas, admits
 * them through the capacity planner (user limit + live probe, never
 * over-assigning GPUs), then executes the admitted experiments CONCURRENTLY.
 * Queued ideas are reported, not started; each idea keeps its own workspace,
 * spec and result — nothing crosses idea boundaries.
 */
export async function runReadyExperiments(
  projectRoot: string,
  opts: ReadyRunRequest,
  runtime: Parameters<typeof metricDirections>[0],
  db: Parameters<typeof runIdeaExperiment>[4],
): Promise<ReadyRunResult> {
  const { probeCapacity, computeAdmission } = await import('../runtime/capacity.js');
  const { listWorkspaces } = await import('./workspace.js');

  const probe = await probeCapacity(projectRoot);
  const workspaces = await listWorkspaces(projectRoot);
  const ready = workspaces.filter((idea) => idea.status === 'SMOKE_TESTED');
  const requests = [];
  for (const idea of ready) {
    requests.push(await ideaResourceRequest(projectRoot, idea.ideaId));
  }

  const plan = computeAdmission(probe, requests, { maxParallelIdeas: opts.maxParallelIdeas });

  const outcomes: ReadyRunOutcome[] = await Promise.all(
    plan.admitted.map(async (entry) => {
      try {
        const outcome = await runIdeaExperiment(
          projectRoot,
          entry.ideaId,
          { scale: opts.scale, timeoutMs: opts.timeoutMs },
          runtime,
          db,
        );
        return {
          ideaId: entry.ideaId,
          ok: outcome.exitCode === 0 || outcome.alreadyRecorded,
          outcome,
        };
      } catch (error) {
        return {
          ideaId: entry.ideaId,
          ok: false,
          error: (error as Error).message,
        };
      }
    }),
  );

  return {
    admitted: plan.admitted.map((entry) => entry.ideaId),
    queued: plan.queued,
    constraints: plan.constraints,
    outcomes,
    allOk: outcomes.every((entry) => entry.ok),
  };
}
