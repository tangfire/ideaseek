import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { sha256Of } from '../core/hash.js';
import { writeFileAtomic } from '../core/atomic.js';
import { stableJson } from '../experiment/spec.js';
import { renderArisSkill, type LoadedArisSkill } from '../aris/skill.js';

/**
 * Cross-model experiment audit (Phase 4.5 capability 6, ARIS
 * experiment-audit + analyze-results): the reviewer reads the raw artifact
 * bundle and must cite WHERE each check looked (field paths / artifact
 * refs — ARIS "exact file:line references" adapted to IdeaSeek's JSON
 * artifacts). IdeaSeek keeps its deterministic verdict ladder and failure
 * taxonomy; the audit adds an independent PASS|WARN|FAIL layer that gates
 * the HANDOFF delivery (WARN alerts, FAIL blocks — ARIS: audit never
 * silently passes a suspicious result).
 */

export const EXPERIMENT_AUDIT_SCHEMA = 'experiment-audit-v1';

export type AuditVerdict = 'PASS' | 'WARN' | 'FAIL';

export const AUDIT_CHECK_IDS = [
  'gt-provenance',
  'score-normalization',
  'result-existence',
  'dead-code',
  'scope',
  'eval-type',
] as const;

export type AuditCheckId = (typeof AUDIT_CHECK_IDS)[number];

export interface AuditCheck {
  id: AuditCheckId;
  verdict: 'PASS' | 'WARN' | 'FAIL';
  detail: string;
  /** Where the reviewer looked: artifact field path or file:line style ref. */
  evidence: string;
}

export interface ExperimentAudit {
  contract: typeof EXPERIMENT_AUDIT_SCHEMA;
  ideaId: string;
  cardVersion: number;
  inputHash: string;
  skills: { audit: { name: string; sha256: string }; analyze: { name: string; sha256: string } };
  generatedAt: number;
  harnessRuntime: string;
  reviewerModel: string | null;
  overallVerdict: AuditVerdict;
  checks: AuditCheck[];
  claims: { id: string; impact: 'none' | 'weaken' | 'block' }[];
  summary: string;
  evidenceDigest: string;
}

const OUTPUT_CONTRACT = `
# IdeaSeek output contract (${EXPERIMENT_AUDIT_SCHEMA})

Reply with ONE JSON object and nothing else:

{"overallVerdict": "PASS|WARN|FAIL",
 "checks": [{"id": "gt-provenance|score-normalization|result-existence|dead-code|scope|eval-type",
   "verdict": "PASS|WARN|FAIL", "detail": "...", "evidence": "<artifact field path, e.g. experiment.result.metrics[0]>"}],
 "claims": [{"id": "...", "impact": "none|weaken|block"}],
 "summary": "..."}

Rules:
- checks ≥ 1; each id unique; evidence MUST point at a field that exists
  in the bundle (never invent paths); overallVerdict = FAIL if any check
  FAILs, WARN if any WARNs, else PASS.
- Judge only the bundle: dataset provenance, metric normalization vs the
  plan, result existence, dead/unexecuted paths, scope drift, eval type.
- claims: which recorded claims the audit weakens (may be []).
- No prose, no markdown fence, no commentary outside the JSON object.
`.trim();

export interface AuditRequest {
  instruction: string;
  inputHash: string;
  idempotencyKey: string;
  evidenceDigest: string;
}

/** Digest of the artifact bundle the auditor actually saw. */
export function bundleDigest(bundle: unknown): string {
  return sha256Of(stableJson(bundle));
}

export function buildAuditRequest(
  skills: { audit: LoadedArisSkill; analyze: LoadedArisSkill },
  context: { ideaId: string; cardVersion: number; bundle: unknown },
): AuditRequest {
  const digest = bundleDigest(context.bundle);
  const inputHash = sha256Of(
    stableJson({
      contract: EXPERIMENT_AUDIT_SCHEMA,
      auditSkillSha256: skills.audit.sha256,
      analyzeSkillSha256: skills.analyze.sha256,
      ideaId: context.ideaId,
      cardVersion: context.cardVersion,
      evidenceDigest: digest,
    }),
  );
  const instruction = [
    renderArisSkill(skills.audit, {
      arguments: `IdeaSeek idea ${context.ideaId} experiment audit (card v${context.cardVersion})`,
    }),
    '',
    '---',
    '',
    renderArisSkill(skills.analyze, {
      arguments: `IdeaSeek idea ${context.ideaId} — statistics section over the same bundle`,
    }),
    '',
    '---',
    '',
    OUTPUT_CONTRACT,
    '',
    `Evidence bundle (digest ${digest}) — the only input you may audit:`,
    JSON.stringify(context.bundle, null, 2),
  ].join('\n');
  return {
    instruction,
    inputHash,
    idempotencyKey: `idea-audit:${inputHash}`,
    evidenceDigest: digest,
  };
}

export interface AuditValidation {
  ok: boolean;
  errors: string[];
}

export function validateAuditOutput(
  value: unknown,
  expected: { ideaId: string; cardVersion: number },
): AuditValidation {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['audit must be a JSON object'] };
  }
  const record = value as Record<string, unknown>;
  if (record.ideaId !== expected.ideaId) errors.push(`ideaId must be "${expected.ideaId}"`);
  if (record.cardVersion !== expected.cardVersion) {
    errors.push(`cardVersion must be ${expected.cardVersion}`);
  }
  const overall = record.overallVerdict;
  if (!['PASS', 'WARN', 'FAIL'].includes(String(overall))) {
    errors.push('overallVerdict must be PASS|WARN|FAIL');
  }

  const checks = record.checks;
  const seen = new Set<string>();
  if (!Array.isArray(checks) || checks.length === 0) {
    errors.push('checks must have ≥ 1 entry');
  } else {
    for (const [i, entry] of checks.entries()) {
      const item = entry as Partial<AuditCheck>;
      const where = `checks[${i}]`;
      if (!AUDIT_CHECK_IDS.includes(item?.id as AuditCheckId)) {
        errors.push(`${where}.id must be one of ${AUDIT_CHECK_IDS.join('|')}`);
      } else if (seen.has(item.id!)) {
        errors.push(`${where}.id "${item.id}" is duplicated`);
      } else {
        seen.add(item.id!);
      }
      if (!['PASS', 'WARN', 'FAIL'].includes(String(item?.verdict))) {
        errors.push(`${where}.verdict must be PASS|WARN|FAIL`);
      }
      if (typeof item?.detail !== 'string' || !item.detail.trim()) {
        errors.push(`${where}.detail must be a non-empty string`);
      }
      if (typeof item?.evidence !== 'string' || !item.evidence.trim()) {
        errors.push(`${where}.evidence must cite where you looked (field path / file ref)`);
      }
    }
    // Overall verdict must agree with the individual checks (no whitewash).
    if (['PASS', 'WARN', 'FAIL'].includes(String(overall))) {
      const worst = checks.some((entry) => (entry as { verdict?: string }).verdict === 'FAIL')
        ? 'FAIL'
        : checks.some((entry) => (entry as { verdict?: string }).verdict === 'WARN')
          ? 'WARN'
          : 'PASS';
      if (worst !== overall) {
        errors.push(`overallVerdict "${String(overall)}" contradicts checks (worst is ${worst})`);
      }
    }
  }

  const claims = record.claims;
  if (!Array.isArray(claims)) {
    errors.push('claims must be an array (may be empty)');
  } else {
    for (const [i, entry] of claims.entries()) {
      const item = entry as { id?: unknown; impact?: unknown };
      if (typeof item?.id !== 'string' || !item.id.trim()) {
        errors.push(`claims[${i}].id must be a non-empty string`);
      }
      if (!['none', 'weaken', 'block'].includes(String(item?.impact))) {
        errors.push(`claims[${i}].impact must be none|weaken|block`);
      }
    }
  }
  if (typeof record.summary !== 'string' || !record.summary.trim()) {
    errors.push('summary must be a non-empty string');
  }
  return { ok: errors.length === 0, errors };
}

export function parseAuditOutput(
  output: string,
  expected: { ideaId: string; cardVersion: number },
  meta: {
    inputHash: string;
    skills: ExperimentAudit['skills'];
    harnessRuntime: string;
    reviewerModel: string | null;
    evidenceDigest: string;
  },
): ExperimentAudit {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `experiment audit is not JSON: ${output.slice(0, 160)}`,
    );
  }
  const validation = validateAuditOutput(parsed, expected);
  if (!validation.ok) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `experiment audit failed validation: ${validation.errors.slice(0, 4).join('; ')}`,
    );
  }
  const record = parsed as {
    overallVerdict: AuditVerdict;
    checks: AuditCheck[];
    claims: { id: string; impact: 'none' | 'weaken' | 'block' }[];
    summary: string;
  };
  return {
    contract: EXPERIMENT_AUDIT_SCHEMA,
    ideaId: expected.ideaId,
    cardVersion: expected.cardVersion,
    inputHash: meta.inputHash,
    skills: meta.skills,
    generatedAt: Date.now(),
    harnessRuntime: meta.harnessRuntime,
    reviewerModel: meta.reviewerModel,
    overallVerdict: record.overallVerdict,
    checks: record.checks,
    claims: record.claims,
    summary: record.summary,
    evidenceDigest: meta.evidenceDigest,
  };
}

export function auditPath(root: string, ideaId: string): string {
  return join(root, 'ideas', ideaId, 'experiments', 'audit.json');
}

/** Reads the persisted audit; wrong contract/idea → null. */
export async function readAudit(root: string, ideaId: string): Promise<ExperimentAudit | null> {
  try {
    const audit = JSON.parse(await readFile(auditPath(root, ideaId), 'utf8')) as ExperimentAudit;
    if (audit.contract !== EXPERIMENT_AUDIT_SCHEMA || audit.ideaId !== ideaId) return null;
    return audit;
  } catch {
    return null;
  }
}

export async function writeAudit(root: string, audit: ExperimentAudit): Promise<string> {
  const path = auditPath(root, audit.ideaId);
  await writeFileAtomic(path, `${JSON.stringify(audit, null, 2)}\n`);
  return path;
}
