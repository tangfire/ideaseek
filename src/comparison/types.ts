import { IdeaseekError } from '../core/errors.js';
import type { LicenseKind } from './discover.js';

/**
 * ComparisonMethod contract (docs/DATA_CONTRACTS.md §ComparisonMethod,
 * WORKFLOW_SPEC §Comparison 状态). The workflow DB is authoritative;
 * comparisons/<id>/method.yaml is the human-readable export.
 */
export type ComparisonStatus =
  | 'candidate'
  | 'accepted'
  | 'source-resolved'
  | 'implemented'
  | 'repairing'
  | 'smoke-tested'
  | 'evaluated'
  | 'validated'
  | 'partial'
  | 'blocked'
  | 'excluded';

/**
 * `asserted` = the registrant CLAIMS a source but nothing verified it — the
 * default, because `--source official-code` used to be asserted silently by
 * a flag default. official-code/paper-reimplementation stay available as
 * explicit declarations; a later agent verdict can promote assertions.
 */
export type ComparisonSourceKind = 'user' | 'official-code' | 'paper-reimplementation' | 'asserted';

export interface ComparisonRepo {
  /** Public HTTPS or local path; cloned anonymously into upstream/. */
  url: string;
  branch?: string;
  /** Exact commit recorded at import (provenance). */
  commit?: string;
  license?: string | null;
  /** Coarse license class for provenance/gating (see discover.classifyLicense). */
  licenseKind?: LicenseKind;
  clonedAt?: number;
}

export interface ComparisonSmoke {
  passed: boolean;
  at: number;
  durationMs: number;
  /** Truncated, secret-free stdout/stderr tail; full log under .research/logs. */
  tail: string;
  command: string[];
}

export interface ComparisonHistoryEntry {
  at: number;
  from: ComparisonStatus;
  to: ComparisonStatus;
  reason: string | null;
}

/** Deterministic failure taxonomy for baseline repair (docs/plan.md §C.5). */
export type RepairFailureKind =
  | 'missing-dependency'
  | 'path-error'
  | 'syntax-error'
  | 'permission-error'
  | 'device-error'
  | 'timeout'
  | 'unknown';

export interface RepairAttempt {
  round: number;
  at: number;
  durationMs: number;
  command: string[];
  exitCode: number;
  timedOut: boolean;
  /** Absent when the round passed. */
  failureKind?: RepairFailureKind;
  /** First matching log line, redacted and truncated. */
  failureSummary?: string;
  fixApplied: 'none' | 'venv-install' | 'venv-install-inferred' | 'pythonpath-root';
  /** Result of applying the planned fix (absent when none was planned). */
  fixOk?: boolean;
  fixDetail?: string;
  /** Full redacted log under .research/logs/. */
  logPath: string;
}

export type RepairRoundOutcome =
  'in-progress' | 'passed' | 'blocked-no-fix' | 'blocked-budget' | 'blocked-fix-failed';

/** Crash-safe per-round record persisted at comparisons/<id>/repair.json. */
export interface RepairRecord {
  methodId: string;
  budget: { maxRounds: number; timeoutMs: number };
  startedAt: number;
  updatedAt: number;
  attempts: RepairAttempt[];
  outcome: RepairRoundOutcome;
  /**
   * Environment changes earlier rounds applied (PYTHONPATH for an internal
   * module, for instance). Persisted so a resumed session does not repeat a
   * failure it had already worked around.
   */
  env?: Record<string, string>;
}

/** How the worktree diff relates to baseline trust (plan §C.7). */
export type RepairChangeClass = 'none' | 'environment' | 'code-review';

/** Summary mirrored into the method record after a repair session. */
export interface RepairSummary {
  outcome: 'smoke-tested' | 'blocked' | 'confirmation-required';
  attempts: number;
  lastFailureKind: RepairFailureKind | null;
  patchHash: string | null;
  changeClass: RepairChangeClass | null;
  updatedAt: number;
}

/** Paper-explicit content the reproduction is grounded in (plan §C.7). */
export interface ReproductionEvidence {
  statement: string;
  /** Citation locator: paper id + page/quote. */
  evidence: string;
}

export type ReproductionConfidence = 'high' | 'medium' | 'low';

/**
 * Structured reproduction plan authored from the papers (by an agent or the
 * user). The platform validates it, generates the worktree scaffold and
 * never lets it pose as official code (docs/DATA_CONTRACTS ComparisonMethod).
 */
export interface ReproductionBlueprint {
  methodId: string;
  paperExplicit: ReproductionEvidence[];
  assumptions: string[];
  missingDetails: string[];
  confidence: ReproductionConfidence;
  algorithm: {
    /** Python implementation source; may be omitted when --code <file> is used. */
    source?: string;
    /** argv prefix; defaults to ['python', 'reproduce.py']. */
    entry?: string[];
    /**
     * pip requirement specs the implementation needs, declared explicitly so
     * the runner can build a method venv instead of letting the code fail into
     * a fake pass. Validated as specs, never as shell.
     */
    requirements?: string[];
    dataInterface: { description: string };
    metrics: { name: string; direction: 'higher' | 'lower' }[];
    hyperparameters?: Record<string, unknown>;
  };
}

export type ReproductionPhase =
  'brief' | 'generate' | 'check-code' | 'check-data' | 'check-metrics' | 'smoke' | 'record';

export type ReproductionOutcome = 'in-progress' | 'validated' | 'failed';

export interface ReproductionPhaseResult {
  phase: ReproductionPhase;
  at: number;
  durationMs: number;
  exitCode: number;
  ok: boolean;
  /** Classified from the phase log (reuse of the repair taxonomy). */
  failureKind?: RepairFailureKind;
  /** Redacted, truncated diagnosis. */
  summary?: string;
  logPath?: string;
}

/** Crash-safe per-phase record at comparisons/<id>/reproduction.json. */
export interface ReproductionRecord {
  methodId: string;
  /** sha256 over the algorithm block (stableJson) — semantic-change detector. */
  fingerprint: string;
  outcome: ReproductionOutcome;
  startedAt: number;
  updatedAt: number;
  /** Phases already OK in this session (resume skips them). */
  completedPhases: ReproductionPhase[];
  phases: ReproductionPhaseResult[];
  paperExplicit: ReproductionEvidence[];
  assumptions: string[];
  missingDetails: string[];
  confidence: ReproductionConfidence;
  algorithmModified: boolean;
  algorithmModifiedReason?: string;
  cardSources: string[];
  protocolId: string | null;
  patchHash: string | null;
  specId: string | null;
  /** Parsed smoke metrics (kept for resume + ExperimentSpec attachment). */
  smokeMetrics?: { name: string; value: number }[];
}

/** Summary mirrored into the method record after a reproduction run. */
export interface ReproductionSummary {
  outcome: 'validated' | 'failed';
  failedPhase: ReproductionPhase | null;
  failureKind: RepairFailureKind | null;
  confidence: ReproductionConfidence;
  algorithmModified: boolean;
  fingerprint: string;
  patchHash: string | null;
  specId: string | null;
  updatedAt: number;
}

export interface ComparisonMethod {
  methodId: string;
  /** Paper references (hashes or ids) this method answers to. */
  paperRefs: string[];
  required: boolean;
  sourceKind: ComparisonSourceKind;
  repo?: ComparisonRepo;
  /** Run entry inside the worktree (argv array preferred; whitespace-split string tolerated). */
  entry?: string | string[];
  status: ComparisonStatus;
  statusReason?: string;
  /**
   * Historical labels this method was recorded under (an old spelling after
   * a rename). A control printed under an alias is THIS method, not a second
   * one: the analysis ladder collapses declared aliases to the canonical
   * methodId before comparing control values, so renaming a label cannot
   * read as "one computation reported twice under two method ids". Only
   * labels recorded here collapse — two genuinely different methods never
   * share an alias, so the duplicate-value check keeps its full reach.
   */
  aliases?: string[];
  smoke?: ComparisonSmoke;
  repair?: RepairSummary;
  reproduction?: ReproductionSummary;
  history?: ComparisonHistoryEntry[];
  notes: string[];
  createdAt: number;
  updatedAt: number;
}

/** Legal status transitions (docs/WORKFLOW_SPEC comparison graph). */
export const COMPARISON_TRANSITIONS: Record<ComparisonStatus, readonly ComparisonStatus[]> = {
  candidate: ['accepted', 'excluded'],
  accepted: ['source-resolved', 'excluded'],
  'source-resolved': ['implemented', 'blocked', 'excluded'],
  implemented: ['repairing', 'smoke-tested', 'blocked', 'excluded'],
  repairing: ['smoke-tested', 'blocked', 'excluded'],
  'smoke-tested': ['evaluated', 'repairing', 'blocked'],
  evaluated: ['validated', 'partial', 'repairing', 'blocked'],
  validated: [],
  partial: ['repairing', 'excluded'],
  blocked: ['source-resolved', 'repairing', 'excluded'],
  excluded: [],
};

/** Statuses that must carry a reason (no silent skips of required methods). */
export const REASON_REQUIRED: readonly ComparisonStatus[] = ['excluded', 'blocked', 'partial'];

export function assertTransition(
  from: ComparisonStatus,
  to: ComparisonStatus,
  reason: string | undefined,
): void {
  if (!COMPARISON_TRANSITIONS[from].includes(to)) {
    throw new IdeaseekError(
      'INVALID_STATE',
      `illegal comparison transition ${from} → ${to} (allowed: ${COMPARISON_TRANSITIONS[from].join(', ') || 'none'})`,
      { from, to },
    );
  }
  if (REASON_REQUIRED.includes(to) && !(reason && reason.trim())) {
    throw new IdeaseekError(
      'USER_INPUT_REQUIRED',
      `status ${to} requires --reason: excluding a comparison is a decision, and the record must say who made it and why (docs/AUTONOMY_POLICY)`,
      { status: to },
    );
  }
}

/** Structural validation for imported/registered methods. */
export function validateComparisonMethod(value: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['comparison method must be an object'] };
  }
  const m = value as Record<string, unknown>;
  if (typeof m.methodId !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(m.methodId)) {
    errors.push('methodId must be kebab-case');
  }
  if (typeof m.required !== 'boolean') errors.push('required must be boolean');
  if (
    !['user', 'official-code', 'paper-reimplementation', 'asserted'].includes(
      m.sourceKind as string,
    )
  ) {
    errors.push('sourceKind must be user | official-code | paper-reimplementation | asserted');
  }
  if (!Array.isArray(m.paperRefs)) errors.push('paperRefs must be an array');
  if (!Array.isArray(m.notes)) errors.push('notes must be an array');
  if (typeof m.status !== 'string' || !(m.status in COMPARISON_TRANSITIONS)) {
    errors.push('status must be a valid comparison status');
  }
  if (m.repo !== undefined) {
    const repo = m.repo as { url?: unknown; commit?: unknown };
    if (typeof repo.url !== 'string' || !repo.url)
      errors.push('repo.url is required when repo is set');
  }
  if (typeof m.status === 'string' && REASON_REQUIRED.includes(m.status as never)) {
    if (typeof m.statusReason !== 'string' || !m.statusReason.trim()) {
      errors.push(`status ${m.status} requires a non-empty statusReason`);
    }
  }
  return { ok: errors.length === 0, errors };
}
