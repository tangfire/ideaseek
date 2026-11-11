import { sha256Of, type ContentHash } from '../core/hash.js';
import { stableJson } from './spec.js';
import type { ExperimentSpec } from './spec.js';

/**
 * Experiment-level checkpoint contract (docs/LONG_RUNNING_WORKFLOWS
 * 实验级 checkpoint): a unified interface every ExperimentRunner entry may
 * adopt. Entries that do NOT emit progress/checkpoint events are explicitly
 * downgraded to task-level recovery — the platform reruns the single
 * experiment after a crash and never claims in-experiment progress restore.
 */

export type CheckpointPolicyKind = 'none' | 'steps' | 'seconds' | 'epoch';

export interface CheckpointPolicy {
  kind: CheckpointPolicyKind;
  /** Interval for steps/seconds policies; ignored for none/epoch. */
  every?: number;
}

export interface CheckpointManifest {
  checkpointId: string;
  specId: string;
  /** Code hash of the idea workspace at save time. */
  codeHash: string | null;
  protocolId: string | null;
  dataSnapshotId: string;
  /** Hash of execution-relevant spec fields (command/metrics/seeds/scale). */
  configHash: ContentHash;
  step: number;
  epoch: number | null;
  savedAt: number;
  /** State file references (model/optimizer/sampler), entry-declared. */
  files: { path: string; sha256?: string }[];
  /** Optional RNG state reference (entry-declared). */
  rngState?: string;
}

export interface ProgressHeartbeat {
  step: number;
  epoch: number | null;
  checkpointId: string | null;
  at: number;
}

/**
 * Recovery classification per LONG_RUNNING: entries that emitted progress
 * can resume from a checkpoint; everything else is task-level recovery
 * (rerun this single experiment only — no in-experiment progress promises).
 */
export type RecoveryMode = 'checkpoint' | 'task-level';

export interface ResumeHint {
  checkpointId: string;
  compatible: boolean;
  mismatches: string[];
}

export interface ExperimentProgressFile {
  specId: string;
  recovery: RecoveryMode;
  policy: CheckpointPolicy;
  heartbeat: ProgressHeartbeat | null;
  checkpoints: CheckpointManifest[];
  resumeHint: ResumeHint | null;
  /** How the run ended: null when it exited cleanly. */
  interrupt: 'force-kill' | 'timeout' | null;
  updatedAt: number;
}

/** Parses `config/train.json`'s optional checkpoint policy (default none). */
export function parseCheckpointPolicy(raw: unknown): CheckpointPolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'none' };
  const kind = (raw as { kind?: unknown }).kind;
  if (kind === 'none' || kind === 'steps' || kind === 'seconds' || kind === 'epoch') {
    const every = (raw as { every?: unknown }).every;
    return {
      kind,
      ...(typeof every === 'number' && Number.isFinite(every) && every > 0
        ? { every: Math.floor(every) }
        : {}),
    };
  }
  return { kind: 'none' };
}

/**
 * Hash of the execution-relevant spec fields.createdAt/version are excluded
 * so re-recording the same spec keeps the same config identity; command,
 * metrics, seeds, data snapshot, protocol and scale notes all change it.
 */
export function computeSpecConfigHash(spec: ExperimentSpec): ContentHash {
  return sha256Of(
    stableJson({
      command: spec.command,
      metrics: spec.metrics,
      seeds: spec.seeds,
      dataSnapshotId: spec.dataSnapshotId,
      protocolId: spec.protocolId,
      scaleNotes: (spec.environment.notes ?? []).filter((n) => n.startsWith('scale:')),
    }),
  );
}

export interface CompatibilityInputs {
  codeHash: string | null;
  protocolId: string | null;
  dataSnapshotId: string;
  configHash: ContentHash;
}

export interface CompatibilityResult {
  compatible: boolean;
  mismatches: string[];
}

/**
 * resume_from compatibility gate: a checkpoint may only resume when code,
 * protocol, data snapshot and execution config all still match. Anything
 * that changed (inputs, protocol re-lock, code edits) blocks the resume —
 * the user starts a fresh experiment instead of silently mixing versions.
 */
export function validateCheckpointCompatibility(
  checkpoint: Pick<CheckpointManifest, 'codeHash' | 'protocolId' | 'dataSnapshotId' | 'configHash'>,
  current: CompatibilityInputs,
): CompatibilityResult {
  const mismatches: string[] = [];
  if ((checkpoint.codeHash ?? null) !== (current.codeHash ?? null)) {
    mismatches.push('code changed since the checkpoint');
  }
  if ((checkpoint.protocolId ?? null) !== (current.protocolId ?? null)) {
    mismatches.push('protocol changed since the checkpoint');
  }
  if (checkpoint.dataSnapshotId !== current.dataSnapshotId) {
    mismatches.push('data snapshot changed since the checkpoint');
  }
  if (checkpoint.configHash !== current.configHash) {
    mismatches.push('execution config (command/metrics/seeds/scale) changed');
  }
  return { compatible: mismatches.length === 0, mismatches };
}

/** Progress line emitted by checkpoint-aware entries (parsed from stdout). */
export interface ProgressLine {
  step?: number;
  epoch?: number;
  checkpoint?: string;
}

export interface CheckpointSavedLine {
  checkpointId: string;
  step?: number;
  epoch?: number;
  files?: { path: string; sha256?: string }[];
  rngState?: string;
}

/** Parses `{"progress": {...}}` heartbeat lines from entry output. */
export function parseProgressLine(line: string): ProgressLine | null {
  try {
    const parsed = JSON.parse(line) as { progress?: unknown };
    if (!parsed || typeof parsed.progress !== 'object' || parsed.progress === null) return null;
    const progress = parsed.progress as Record<string, unknown>;
    const out: ProgressLine = {};
    if (typeof progress.step === 'number') out.step = progress.step;
    if (typeof progress.epoch === 'number') out.epoch = progress.epoch;
    if (typeof progress.checkpoint === 'string') out.checkpoint = progress.checkpoint;
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Parses `{"checkpoint_saved": {...}}` lines from entry output. */
export function parseCheckpointSavedLine(line: string): CheckpointSavedLine | null {
  try {
    const parsed = JSON.parse(line) as { checkpoint_saved?: unknown };
    if (
      !parsed ||
      typeof parsed.checkpoint_saved !== 'object' ||
      parsed.checkpoint_saved === null
    ) {
      return null;
    }
    const saved = parsed.checkpoint_saved as Record<string, unknown>;
    if (typeof saved.checkpointId !== 'string') return null;
    const out: CheckpointSavedLine = { checkpointId: saved.checkpointId };
    if (typeof saved.step === 'number') out.step = saved.step;
    if (typeof saved.epoch === 'number') out.epoch = saved.epoch;
    if (Array.isArray(saved.files)) out.files = saved.files as { path: string; sha256?: string }[];
    if (typeof saved.rngState === 'string') out.rngState = saved.rngState;
    return out;
  } catch {
    return null;
  }
}

/** Scans full entry output for heartbeats and saved-checkpoint markers. */
export function scanEntryOutput(output: string): {
  heartbeat: ProgressHeartbeat | null;
  saved: CheckpointSavedLine[];
} {
  const saved: CheckpointSavedLine[] = [];
  let sawProgress = false;
  let lastStep = 0;
  let lastEpoch: number | null = null;
  let lastCheckpointId: string | null = null;
  for (const rawLine of output.split(/\r?\n/)) {
    const progress = parseProgressLine(rawLine);
    if (progress) {
      sawProgress = true;
      if (progress.step !== undefined) lastStep = progress.step;
      if (progress.epoch !== undefined) lastEpoch = progress.epoch;
      if (progress.checkpoint !== undefined) lastCheckpointId = progress.checkpoint;
    }
    const savedLine = parseCheckpointSavedLine(rawLine);
    if (savedLine) saved.push(savedLine);
  }
  const heartbeat: ProgressHeartbeat | null = sawProgress
    ? { step: lastStep, epoch: lastEpoch, checkpointId: lastCheckpointId, at: Date.now() }
    : null;
  return { heartbeat, saved };
}

/** Builds a full manifest from an entry's checkpoint_saved marker. */
export function buildCheckpointManifest(
  saved: CheckpointSavedLine,
  spec: ExperimentSpec,
  codeHash: string | null,
): CheckpointManifest {
  return {
    checkpointId: saved.checkpointId,
    specId: spec.specId,
    codeHash,
    protocolId: spec.protocolId,
    dataSnapshotId: spec.dataSnapshotId,
    configHash: computeSpecConfigHash(spec),
    step: saved.step ?? 0,
    epoch: saved.epoch ?? null,
    savedAt: Date.now(),
    files: saved.files ?? [],
    ...(saved.rngState ? { rngState: saved.rngState } : {}),
  };
}
