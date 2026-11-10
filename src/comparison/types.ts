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

export type ComparisonSourceKind = 'user' | 'official-code' | 'paper-reimplementation';

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
  fixApplied: 'none' | 'venv-install';
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
  smoke?: ComparisonSmoke;
  repair?: RepairSummary;
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
      `status ${to} requires --reason (no silent skips; docs: EXCLUDED 必须有用户或配置原因)`,
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
  if (!['user', 'official-code', 'paper-reimplementation'].includes(m.sourceKind as string)) {
    errors.push('sourceKind must be user | official-code | paper-reimplementation');
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
