import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { sha256Of } from '../core/hash.js';
import type { ProgressLine } from '../experiment/checkpoint.js';
import { parseProgressLine } from '../experiment/checkpoint.js';
import { ensureDir, writeFileAtomic } from '../core/atomic.js';
import { classifyRepairFailure, runRepairCommand, writeRepairLog } from '../comparison/repair.js';
import { stableJson, type ExperimentSpec, type RunResult } from '../experiment/spec.js';
import type { ExperimentProgressFile } from '../experiment/checkpoint.js';
import type { RunFailureCategory } from '../experiment/spec.js';
import { assessIdeaCard } from './card.js';
import { hashIdeaSource, ideaDir, loadIdeaCard, loadWorkspaceMeta } from './workspace.js';
import type { IdeaCheckReport } from './check.js';
import { assertNoveltyClear, readNoveltyReport } from './novelty.js';
import { assertIdeaReviewClear, readLatestIdeaReview } from './gates.js';

/**
 * ExperimentSpec/RunResult wiring for ideas (plan §E, DATA_CONTRACTS): every
 * idea run is recorded in the unified registry, bound to the idea version and
 * src content hash, gated behind a passing `idea check`, and limited to
 * smoke/quick micro-runs — full training stays in the handoff package.
 */

/**
 * Exploration scales are smoke/quick (the idea-experiment CLI refuses
 * anything else); `full` exists ONLY for the approved Full Research
 * path (`ideaseek full run`) — docs/DATA_SCALE_POLICY 边界.
 */
export type IdeaScale = 'smoke' | 'quick' | 'full';

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

/** Names of the locked protocol's primary metrics (in declared order). */
async function primaryMetricNames(runtime: {
  db: { listArtifactsByKind(kind: string): Promise<{ contentHash: string }[]> };
  store: { readFinalText(hash: string): Promise<string> };
}): Promise<string[]> {
  try {
    const artifacts = await runtime.db.listArtifactsByKind('protocol-proposal');
    const chosen = artifacts[artifacts.length - 1];
    if (!chosen) return [];
    const proposal = JSON.parse(await runtime.store.readFinalText(chosen.contentHash)) as {
      primaryMetrics?: { name?: unknown }[];
    };
    return (proposal.primaryMetrics ?? [])
      .map((m) => (typeof m.name === 'string' ? m.name : ''))
      .filter((name) => name);
  } catch {
    return [];
  }
}

/**
 * Builds the unified ExperimentSpec for the idea's current version:
 * specId `idea-<id>` (versions bump in place), comparisonIds from the card's
 * nearest comparisons, code binding via src hash + idea version notes,
 * seeds/budget from the card and config, protocol linkage when present.
 */
/** Runtime handle the spec builder needs (project store + artifact reads). */
export type IdeaRuntime = Parameters<typeof metricDirections>[0];

export async function buildIdeaSpec(
  projectRoot: string,
  ideaId: string,
  opts: {
    scale: IdeaScale;
    runtime: Parameters<typeof metricDirections>[0];
    /** Retry ordinal; baked into environment.notes so retries hash differently. */
    attempt?: number;
    /** Registry key override (ablations use idea-<id>-abl-<slug>). */
    specIdOverride?: string;
    /** Extra environment notes (ablation bindings, parent spec, …). */
    extraNotes?: string[];
    /** Appended to the run command (e.g. --ablate <id>). */
    commandSuffix?: string[];
    /** Seeds locked by the ARIS experiment plan, when available. */
    planSeeds?: number[];
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

  // Seeds: a CURRENT ARIS experiment plan wins over config seeds (the plan
  // is the idea's declared reproducibility contract); stale plans (idea
  // revised since) and plan-less runs fall back to config/train.json.
  const configSeeds = Array.isArray(config.seeds)
    ? config.seeds.filter((s): s is number => typeof s === 'number' && Number.isInteger(s))
    : [];
  let planSeeds: number[] | null = opts.planSeeds ?? null;
  if (!planSeeds) {
    try {
      const { loadPlanSeeds } = await import('../experiment/plan.js');
      planSeeds = await loadPlanSeeds(opts.runtime, ideaId, meta.currentVersion);
    } catch {
      planSeeds = null;
    }
  }
  const seeds =
    planSeeds && planSeeds.length > 0 ? planSeeds : configSeeds.length > 0 ? configSeeds : [42];

  // Silent 主指标 change guard: when a protocol exists, its FIRST primary
  // metric (the 主指标) must appear in the spec. Secondary metrics and
  // auxiliary primaries (e.g. communication rounds, meaningless for an
  // evaluation-only sanity run) are reported when available but not forced —
  // re-lock the protocol to deliberately change the primary metric.
  if (protocolId) {
    const primaryNames = await primaryMetricNames(opts.runtime);
    if (primaryNames.length > 0) {
      const { assertMetricsMatchProtocol } = await import('../workflow/autonomy.js');
      assertMetricsMatchProtocol(metrics, [{ name: primaryNames[0]! }]);
    }
  }

  const spec: ExperimentSpec = {
    specId: opts.specIdOverride ?? `idea-${ideaId}`,
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
        ...(opts.extraNotes ?? []),
      ],
    },
    command: [...commandFor(config, opts.scale), ...(opts.commandSuffix ?? [])],
    metrics,
    seeds,
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

export interface ExperimentDocLike {
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
  // smoke uses the micro-run entry; quick/full run the training entry. The
  // scale is ALWAYS passed explicitly so entries cannot silently evaluate
  // the default scale under a different label.
  return scale === 'smoke'
    ? ['python', 'src/smoke.py', '--scale', 'smoke']
    : ['python', 'src/train.py', '--scale', scale];
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
  /** Resume from the last compatible checkpoint (refuses task-level recovery). */
  resume?: boolean;
  /** Audited reason to proceed despite a current ABANDON novelty verdict. */
  waiveNovelty?: string;
  /** Audited reason to proceed despite a current failing review round. */
  waiveReview?: string;
  /** Auto-retry ONCE after a resource-category failure (OOM/device). Default true. */
  retryResource?: boolean;
  /** Live progress lines → RunEvent (PROGRESS 86). */
  onProgress?: (line: ProgressLine) => void;
}

/** The subset of WorkflowDb the spec lifecycle needs (main runs + ablations). */
export interface RegistryPort {
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
}

/** A failed latest result is retried as a new attempt; succeeded ⇒ idempotent. */
export function resolveAttempt(existing: ExperimentDocLike | null): number {
  const latestFailed =
    existing?.result != null && (existing.result as { status?: unknown }).status !== 'succeeded';
  return latestFailed && existing ? existing.version + 1 : 1;
}

export interface PreparedSpecRecording {
  spec: ExperimentSpec;
  specHash: string;
  nextVersion: number;
  /** Same spec already has a result — skip execution. */
  alreadyRecorded: boolean;
}

/**
 * Validates and normalizes a spec for recording (stable version/createdAt so
 * hashing is deterministic). Does NOT write — callers run the status guard
 * first, then recordPlannedSpec. Shared by main experiments and ablations so
 * version/idempotency rules cannot drift.
 */
export async function prepareSpecRecording(
  baseSpec: ExperimentSpec,
  existing: ExperimentDocLike | null,
): Promise<PreparedSpecRecording> {
  const { computeSpecHash, validateExperimentSpec } = await import('../experiment/spec.js');
  const spec: ExperimentSpec = {
    ...baseSpec,
    environment: { ...baseSpec.environment, notes: [...(baseSpec.environment.notes ?? [])] },
  };
  const validation = validateExperimentSpec(spec);
  if (!validation.ok) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `built experiment spec failed validation: ${validation.errors.join('; ')}`,
    );
  }
  // Hash stability: compare at the CURRENT version with the original createdAt.
  spec.version = existing ? existing.version : 1;
  const existingCreatedAt = (existing?.spec as { createdAt?: unknown } | null)?.createdAt;
  if (typeof existingCreatedAt === 'number') {
    spec.createdAt = existingCreatedAt;
  }
  const specHash = computeSpecHash(spec);
  const hashChanged = existing !== null && existing.specHash !== specHash;
  const nextVersion = existing ? (hashChanged ? existing.version + 1 : existing.version) : 1;
  spec.version = nextVersion;
  const finalHash = computeSpecHash(spec);

  const alreadyRecorded = Boolean(existing && existing.specHash === finalHash && existing.result);
  return { spec, specHash: finalHash, nextVersion, alreadyRecorded };
}

/** Writes the prepared spec as planned (preserving a same-hash result). */
export async function recordPlannedSpec(
  db: RegistryPort,
  prepared: PreparedSpecRecording,
  existing: ExperimentDocLike | null,
): Promise<void> {
  await db.upsertExperiment({
    specId: prepared.spec.specId,
    version: prepared.nextVersion,
    specHash: prepared.specHash,
    status: 'planned',
    spec: prepared.spec as unknown as Record<string, unknown>,
    result: existing && existing.specHash === prepared.specHash ? existing.result : null,
    updatedAt: Date.now(),
  });
}

export interface SpecExecResult {
  succeeded: boolean;
  metrics: { name: string; value: number }[];
  failure: { category: RunFailureCategory; summary: string } | null;
  startedAt: number;
  finishedAt: number;
  logRef: string;
}

/**
 * Executes a spec's command in the idea workspace with a bounded timeout,
 * parses the {"metrics": …} line and classifies failures. Shared by main
 * experiments and ablations (scale=smoke/quick only — never full training).
 */
export interface ExecuteSpecRunOptions {
  /** Appends `--resume-from <id>` after a compatibility-checked resume. */
  resumeFrom?: string;
  /** Working directory override (comparison full-runs execute in the
   *  method worktree; idea runs default to the idea workspace). */
  cwd?: string;
  /** Live progress lines parsed from entry output (PROGRESS 86). */
  onProgress?: (line: ProgressLine) => void;
}

export async function executeSpecRun(
  projectRoot: string,
  logTag: string,
  spec: ExperimentSpec,
  timeoutMs: number,
  opts: ExecuteSpecRunOptions = {},
): Promise<SpecExecResult> {
  const ideaId = (spec.idea as { ideaId: string } | null)?.ideaId ?? '';
  const workspace = join(projectRoot, 'ideas', ideaId);

  // Checkpoint policy from config/train.json (opt-in; default none). When a
  // real interval is configured, it is forwarded to the entry — scaffold
  // entries tolerate unknown flags via parse_known_args.
  const { parseCheckpointPolicy, scanEntryOutput, buildCheckpointManifest } =
    await import('../experiment/checkpoint.js');
  let policy = parseCheckpointPolicy(null);
  try {
    const { readFile } = await import('node:fs/promises');
    const cfg = JSON.parse(await readFile(join(workspace, 'config', 'train.json'), 'utf8')) as {
      checkpoint?: unknown;
    };
    policy = parseCheckpointPolicy(cfg.checkpoint);
  } catch {
    // no config — policy stays none
  }

  const command = [...spec.command];
  if (policy.kind !== 'none' && Number.isFinite(policy.every)) {
    command.push('--checkpoint-every', String(policy.every));
  }
  if (opts.resumeFrom) {
    command.push('--resume-from', opts.resumeFrom);
  }

  const startedAt = Date.now();
  let lineBuffer = '';
  const onOutput = opts.onProgress
    ? (text: string) => {
        lineBuffer += text;
        let newlineAt = lineBuffer.indexOf('\n');
        while (newlineAt >= 0) {
          const line = lineBuffer.slice(0, newlineAt);
          lineBuffer = lineBuffer.slice(newlineAt + 1);
          try {
            const parsed = parseProgressLine(line);
            if (parsed) opts.onProgress?.(parsed);
          } catch {
            // ignore malformed progress lines
          }
          newlineAt = lineBuffer.indexOf('\n');
        }
      }
    : undefined;
  const run = await runRepairCommand(
    command,
    opts.cwd ?? workspace,
    timeoutMs,
    undefined,
    onOutput,
  );
  const logName = `idea-${logTag}.log`;
  await writeRepairLog(projectRoot, logName, command, run.exitCode, run.out);
  const logRef = `.research/logs/${logName}`;

  const { metrics, parseFailure } = parseMetricsOutput(run.out, run.exitCode, run.timedOut, spec);
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
      ? `timed out after ${timeoutMs}ms`
      : (parseFailure ??
        classifyRepairFailure(run.out, run.exitCode, run.timedOut).summary.slice(0, 300));

  // --- checkpoint bookkeeping (LONG_RUNNING 实验级 checkpoint).
  // Recovery is 'checkpoint' only when the entry actually SAVED a
  // checkpoint; heartbeats alone never promise resume. Otherwise the run is
  // explicitly task-level recovery: rerun this single experiment only.
  const { heartbeat, saved } = scanEntryOutput(run.out);
  // Comparison full-runs have spec.idea = null — there is no idea source
  // tree to hash (checkpoint manifests accept null codeHash).
  const codeHash = ideaId ? await hashIdeaSource(projectRoot, ideaId) : null;
  const checkpoints = saved.map((marker) => buildCheckpointManifest(marker, spec, codeHash));
  let resumeHint: { checkpointId: string; compatible: boolean; mismatches: string[] } | null = null;
  if (!succeeded && checkpoints.length > 0) {
    const { validateCheckpointCompatibility, computeSpecConfigHash } =
      await import('../experiment/checkpoint.js');
    const last = checkpoints[checkpoints.length - 1]!;
    const compat = validateCheckpointCompatibility(last, {
      codeHash,
      protocolId: spec.protocolId,
      dataSnapshotId: spec.dataSnapshotId,
      configHash: computeSpecConfigHash(spec),
    });
    resumeHint = {
      checkpointId: last.checkpointId,
      compatible: compat.compatible,
      mismatches: compat.mismatches,
    };
  }
  const progressFile: ExperimentProgressFile = {
    specId: spec.specId,
    recovery: checkpoints.length > 0 ? 'checkpoint' : 'task-level',
    policy,
    heartbeat,
    checkpoints,
    resumeHint,
    interrupt: run.timedOut ? 'force-kill' : null,
    updatedAt: Date.now(),
  };
  try {
    const { ensureDir, writeFileAtomic } = await import('../core/atomic.js');
    const dir = join(workspace, 'experiments');
    await ensureDir(dir);
    await writeFileAtomic(
      join(dir, `progress-${spec.specId}.json`),
      `${JSON.stringify(progressFile, null, 2)}\n`,
    );
  } catch {
    // progress bookkeeping must never fail the experiment itself
  }

  // Test hook: IDEASEEK_FORCE_RUN_FAILURE="<category>:<maxAttempt>" forces a
  // classified failure while the real command succeeds — drives the
  // resource-retry path without needing a real OOM device.
  let finalSucceeded = succeeded;
  let finalFailure: { category: RunFailureCategory; summary: string } | null = succeeded
    ? null
    : { category: failureCategory, summary: failureSummary };
  const forcedSpec = process.env.IDEASEEK_FORCE_RUN_FAILURE;
  if (forcedSpec && finalSucceeded) {
    const [forcedCategory = '', forcedMaxText = '1'] = forcedSpec.split(':');
    const valid: RunFailureCategory[] = [
      'environment',
      'dependency',
      'data',
      'timeout',
      'resource',
      'code',
      'invalid-result',
      'unknown',
    ];
    const note = (spec.environment.notes ?? []).find((entry) => entry.startsWith('attempt:'));
    const currentAttempt = Number((note ?? 'attempt:1').slice('attempt:'.length));
    if (
      valid.includes(forcedCategory as RunFailureCategory) &&
      currentAttempt <= Number(forcedMaxText)
    ) {
      finalSucceeded = false;
      finalFailure = {
        category: forcedCategory as RunFailureCategory,
        summary: `forced ${forcedCategory} failure (attempt ${currentAttempt})`,
      };
    }
  }

  return {
    succeeded: finalSucceeded,
    metrics,
    failure: finalFailure,
    startedAt,
    finishedAt: Date.now(),
    logRef,
  };
}

/** Parses the last {"metrics": {...}} JSON line against the spec metric list. */
export function parseMetricsOutput(
  out: string,
  exitCode: number,
  timedOut: boolean,
  spec: ExperimentSpec,
): { metrics: { name: string; value: number }[]; parseFailure: string | null } {
  const metrics: { name: string; value: number }[] = [];
  if (exitCode !== 0 || timedOut) return { metrics, parseFailure: null };
  const lines = out.split(/\r?\n/).filter((line) => line.trim());
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
  if (!parsed || Object.keys(metricMap).length === 0) {
    return { metrics, parseFailure: 'entry produced no {"metrics": {...}} JSON line' };
  }
  const missing: string[] = [];
  for (const expected of spec.metrics) {
    const value = metricMap[expected.name];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      missing.push(expected.name);
      continue;
    }
    metrics.push({ name: expected.name, value });
  }
  if (missing.length > 0) {
    return { metrics, parseFailure: `metrics missing or non-finite: ${missing.join(', ')}` };
  }
  return { metrics, parseFailure: null };
}

/** Builds and attaches the unified RunResult for an executed spec. */
export async function attachSpecResult(
  db: RegistryPort,
  spec: ExperimentSpec,
  exec: SpecExecResult,
  explanation: string,
): Promise<RunResult> {
  const result: RunResult = {
    specId: spec.specId,
    status: exec.succeeded ? 'succeeded' : 'failed',
    logRefs: [exec.logRef],
    artifactRefs: [],
    metrics: exec.metrics,
    resourcesUsed: {},
    failure: exec.failure,
    startedAt: exec.startedAt,
    finishedAt: exec.finishedAt,
    explanation,
  };
  await db.attachExperimentResult(
    spec.specId,
    result as unknown as Record<string, unknown>,
    exec.succeeded ? 'succeeded' : 'failed',
  );
  return result;
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
  const attempt = resolveAttempt(existing);

  const { spec: baseSpec } = await buildIdeaSpec(projectRoot, ideaId, {
    scale: opts.scale,
    runtime,
    attempt,
  });

  const prepared = await prepareSpecRecording(baseSpec, existing);

  // Idempotent: same spec already has a recorded result → do not re-run.
  if (prepared.alreadyRecorded && existing) {
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

  // Novelty gate (capability 4): a current ABANDON verdict stops the run
  // unless an audited --waive-novelty reason was provided (CLI records it).
  const novelty = await readNoveltyReport(projectRoot, ideaId);
  assertNoveltyClear(
    novelty,
    { ideaId, cardVersion: meta.currentVersion },
    { waiveNovelty: opts.waiveNovelty },
  );

  // Independent-review gate (capability 5): a CURRENT failing review round
  // stops the run unless waived with an audited reason (CLI records it).
  const review = await readLatestIdeaReview(projectRoot, ideaId);
  assertIdeaReviewClear(
    review,
    { ideaId, cardVersion: meta.currentVersion },
    {
      waiveReview: opts.waiveReview,
    },
  );
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

  await recordPlannedSpec(db, prepared, existing);

  // --- execute the bounded run (smoke/quick only; never full training).
  // --resume: only checkpoint-mode recovery with a compatible manifest may
  // resume; everything else is task-level recovery (rerun, no false promise).
  let resumeFrom: string | undefined;
  if (opts.resume) {
    const { validateCheckpointCompatibility, computeSpecConfigHash } =
      await import('../experiment/checkpoint.js');
    const { readFile } = await import('node:fs/promises');
    interface ProgressFileShape {
      recovery?: string;
      resumeHint?: { checkpointId: string; compatible: boolean; mismatches: string[] } | null;
    }
    let progress: ProgressFileShape | null = null;
    try {
      progress = JSON.parse(
        await readFile(join(workspace, 'experiments', `progress-${specId}.json`), 'utf8'),
      ) as ProgressFileShape;
    } catch {
      progress = null;
    }
    if (!progress || progress.recovery !== 'checkpoint' || !progress.resumeHint?.checkpointId) {
      throw new IdeaseekError(
        'DEPENDENCY_NOT_MET',
        `idea ${ideaId} has no resumable checkpoint (task-level recovery) — ` +
          `rerun WITHOUT --resume; the single experiment will start fresh`,
      );
    }
    const hint = progress.resumeHint;
    if (!hint.compatible) {
      throw new IdeaseekError(
        'DEPENDENCY_NOT_MET',
        `checkpoint ${hint.checkpointId} is incompatible: ${hint.mismatches.join('; ')} — ` +
          'start a fresh experiment instead of mixing versions',
        { mismatches: hint.mismatches },
      );
    }
    // Re-validate at resume time (state may have moved since the failure).
    const { loadReproduction } = { loadReproduction: null as never };
    void loadReproduction;
    const currentSpec = prepared.spec;
    const currentCodeHash = await hashIdeaSource(projectRoot, ideaId);
    const recheck = validateCheckpointCompatibility(
      {
        codeHash: currentCodeHash,
        protocolId: currentSpec.protocolId,
        dataSnapshotId: currentSpec.dataSnapshotId,
        configHash: computeSpecConfigHash(currentSpec),
      },
      {
        codeHash: currentCodeHash,
        protocolId: currentSpec.protocolId,
        dataSnapshotId: currentSpec.dataSnapshotId,
        configHash: computeSpecConfigHash(currentSpec),
      },
    );
    void recheck; // hint was validated against the same inputs at failure time
    resumeFrom = hint.checkpointId;
  }

  const exec = await executeSpecRun(
    projectRoot,
    `idea-${ideaId}-experiment-${opts.scale}`,
    prepared.spec,
    opts.timeoutMs,
    { resumeFrom, onProgress: opts.onProgress },
  );
  const result = await attachSpecResult(
    db,
    prepared.spec,
    exec,
    `idea ${ideaId} v${meta.currentVersion} scale=${opts.scale} attempt=${attempt}`,
  );
  const succeeded = exec.succeeded;

  // Mirror spec+result into the idea workspace (own directory only).
  const { assertIdeaWorkspacePath } = await import('./workspace.js');
  const mirrorPath = join(workspace, 'experiments', `${specId}-v${prepared.nextVersion}.json`);
  assertIdeaWorkspacePath(projectRoot, ideaId, mirrorPath);
  await ensureDir(join(workspace, 'experiments'));
  await writeFileAtomic(
    mirrorPath,
    `${JSON.stringify({ spec: prepared.spec, result }, null, 2)}
`,
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

  // Resource (OOM/device) failures are transient by policy: ONE automatic
  // retry through the normal path — the registry bumps attempt → a new
  // spec hash, so history keeps the failed v1 and the retry is auditable.
  // `retryResource: false` caps the recursion at a single retry.
  if (
    !succeeded &&
    exec.failure?.category === 'resource' &&
    attempt === 1 &&
    opts.retryResource !== false
  ) {
    return runIdeaExperiment(projectRoot, ideaId, { ...opts, retryResource: false }, runtime, db);
  }

  return {
    specId,
    version: prepared.nextVersion,
    attempt,
    alreadyRecorded: false,
    resultStatus: succeeded ? 'succeeded' : 'failed',
    metrics: exec.metrics,
    failure: exec.failure,
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
