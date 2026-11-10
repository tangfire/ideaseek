import type { DatasetSlice } from './slices.js';
import type { ExperimentPortfolio } from './scenarios.js';

/**
 * Handoff manifest contract (docs/plan.md §4, CLI `experiment handoff`):
 * everything a user needs to run FULL-scale experiments themselves outside
 * IdeaSeek — code entry, environment, exact commands, split manifests and
 * provenance hashes. IdeaSeek never executes full-scale training; the
 * manifest only describes and cites it (docs: 不把 full-scale 放进自动流程).
 */
export interface HandoffEnvironment {
  /** e.g. python version, key dependency pins, container image if any. */
  requirements: string[];
  /** Exact run commands, one per line, in execution order. */
  commands: string[];
}

export interface HandoffEntry {
  /** idea or comparison id this handoff belongs to. */
  subjectId: string;
  /** pf-... portfolio governing the runs (optional for baseline handoffs). */
  portfolioId: string | null;
  /** Slice ids + file hashes the quick/standard runs must reproduce. */
  slices: { sliceId: string; outputHash: string; scale: string }[];
  environment: HandoffEnvironment;
  /** Provenance chain a reviewer can re-verify. */
  provenance: {
    inputHashes: string[];
    protocolHash: string | null;
    codeCommit: string | null;
  };
  generatedAt: number;
  generatedBy: string;
  /** Explicit statement of what IdeaSeek did NOT run. */
  boundaries: string[];
}

export interface HandoffValidation {
  ok: boolean;
  errors: string[];
}

export function validateHandoff(value: unknown): HandoffValidation {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['handoff manifest must be an object'] };
  }
  const h = value as Record<string, unknown>;
  if (typeof h.subjectId !== 'string' || !h.subjectId) {
    errors.push('subjectId is required');
  }
  if (h.portfolioId !== null && typeof h.portfolioId !== 'string') {
    errors.push('portfolioId must be a string or null');
  }
  const slices = h.slices;
  if (!Array.isArray(slices) || slices.length === 0) {
    errors.push('slices must reference at least one dataset slice');
  } else {
    slices.forEach((slice, index) => {
      const typed = slice as { sliceId?: string; outputHash?: string; scale?: string };
      if (!typed.sliceId || !typed.outputHash || !typed.scale) {
        errors.push(`slices[${index}] needs sliceId, outputHash and scale`);
      } else if (!/^sha256:[0-9a-f]{64}$/.test(typed.outputHash)) {
        errors.push(`slices[${index}].outputHash must be sha256:<hex>`);
      }
    });
  }
  const env = h.environment as HandoffEnvironment | undefined;
  if (!env || !Array.isArray(env.requirements) || env.requirements.length === 0) {
    errors.push('environment.requirements must be a non-empty list');
  }
  if (!env || !Array.isArray(env.commands) || env.commands.length === 0) {
    errors.push('environment.commands must be a non-empty list');
  }
  const provenance = h.provenance as HandoffEntry['provenance'] | undefined;
  if (!provenance || !Array.isArray(provenance.inputHashes)) {
    errors.push('provenance.inputHashes must be an array');
  } else {
    for (const [index, hash] of provenance.inputHashes.entries()) {
      if (!/^sha256:[0-9a-f]{64}$/.test(hash)) {
        errors.push(`provenance.inputHashes[${index}] must be sha256:<hex>`);
      }
    }
  }
  const boundaries = h.boundaries;
  if (!Array.isArray(boundaries) || boundaries.length === 0) {
    errors.push('boundaries must state what IdeaSeek did not run');
  } else if (!boundaries.some((item) => typeof item === 'string' && item.length > 0)) {
    errors.push('boundaries must be non-empty strings');
  }
  return { ok: errors.length === 0, errors };
}

export interface BuildHandoffOptions {
  subjectId: string;
  portfolio: ExperimentPortfolio | null;
  slices: DatasetSlice[];
  requirements: string[];
  commands: string[];
  inputHashes: string[];
  protocolHash: string | null;
  codeCommit: string | null;
  generatedAt: number;
  generatedBy: string;
}

/** Builds a handoff manifest from already-validated artifacts. */
export function buildHandoff(opts: BuildHandoffOptions): HandoffEntry {
  return {
    subjectId: opts.subjectId,
    portfolioId: opts.portfolio?.portfolioId ?? null,
    slices: opts.slices.map((slice) => ({
      sliceId: slice.sliceId,
      outputHash: slice.outputHash,
      scale: slice.scale,
    })),
    environment: { requirements: opts.requirements, commands: opts.commands },
    provenance: {
      inputHashes: opts.inputHashes,
      protocolHash: opts.protocolHash,
      codeCommit: opts.codeCommit,
    },
    generatedAt: opts.generatedAt,
    generatedBy: opts.generatedBy,
    boundaries: [
      'IdeaSeek did not run full-scale training; commands below are for the user to execute',
      'quick/standard slices cited here are derived artifacts — originals were never modified',
    ],
  };
}
