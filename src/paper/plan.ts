import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256OfFile, sha256Of } from '../core/hash.js';
import { IdeaseekError } from '../core/errors.js';
import { stableJson } from '../experiment/spec.js';
import type { LoadedArisSkill } from '../aris/skill.js';
import { renderArisSkill } from '../aris/skill.js';

/**
 * paper-plan capability (Phase 4.5C): the vendored ARIS paper-plan skill
 * becomes an IdeaSeek use-case bound to LOCKED, persisted state — the
 * context snapshot is assembled only from committed artifacts (protocol
 * locks, comparison registry, experiment results, idea analyses, research
 * map), so every claim the plan cites traces back to a real, hashable
 * source (ADR-002: rebuild from persisted state, never conversation).
 *
 * The cross-review step of the skill needs reviewer MCP backends IdeaSeek
 * does not host; the contract therefore requires REVIEW_UNAVAILABLE unless
 * the context actually carries reviewer notes — never a fabricated verdict.
 */

export const PAPER_PLAN_SCHEMA = 'paper-plan-v1';

export type PaperPlanVerdict = 'ACCEPT' | 'REVISE' | 'REVIEW_UNAVAILABLE';

export interface PaperPlanEvidence {
  source: string;
  location: string;
}

export interface PaperPlanClaim {
  claim: string;
  evidence: PaperPlanEvidence[];
  status: 'supported' | 'partial' | 'unadjudicated';
}

export interface PaperPlanSection {
  section: string;
  purpose: string;
  keyPoints: string[];
}

export interface PaperPlanFigure {
  id: string;
  kind: string;
  caption: string;
  supportsClaims: string[];
}

export interface PaperPlanCitation {
  topic: string;
  candidates: string[];
}

export interface PaperPlan {
  paperType: string;
  venue: string;
  maxPages: number;
  contribution: string;
  claimsEvidence: PaperPlanClaim[];
  structure: PaperPlanSection[];
  figurePlan: PaperPlanFigure[];
  citationPlan: PaperPlanCitation[];
  reviewerFeedback: { verdict: PaperPlanVerdict; notes: string[] };
  nextSteps: string[];
}

export const PAPER_VENUES = [
  'ICLR',
  'NeurIPS',
  'ICML',
  'CVPR',
  'ACL',
  'AAAI',
  'ACM',
  'IEEE_JOURNAL',
  'IEEE_CONF',
] as const;

/** Output contract appended to the rendered skill (prompt-side rules). */
export const PAPER_PLAN_OUTPUT_CONTRACT = [
  `OUTPUT CONTRACT (${PAPER_PLAN_SCHEMA}) — return ONLY one JSON object, no prose, no fences:`,
  '{',
  '  "paperType": string, // empirical-study | method | survey | position | other (non-empty)',
  `  "venue": string,     // one of ${PAPER_VENUES.join(' | ')}`,
  '  "maxPages": integer ≥ 1, // per the skill Constants for the chosen venue',
  '  "contribution": string, // one-sentence contribution',
  '  "claimsEvidence": [{"claim": string, "evidence": [{"source": string, "location": string}], "status": "supported"|"partial"|"unadjudicated"}] — at least 1',
  '  "structure": [{"section": string, "purpose": string, "keyPoints": [string]}] — at least 1 (§0 Abstract … §5 Conclusion)',
  '  "figurePlan": [{"id": string, "kind": string, "caption": string, "supportsClaims": [string]}] — at least 1',
  '  "citationPlan": [{"topic": string, "candidates": [string]}] — at least 1',
  '  "reviewerFeedback": {"verdict": "ACCEPT"|"REVISE"|"REVIEW_UNAVAILABLE", "notes": [string]}',
  '  "nextSteps": [string] — at least 1',
  '}',
  'Rules:',
  '- Every evidence.source must come from the provided context (protocol id, comparison id, specId, idea id, research-map hash) — never invent sources.',
  '- This harness hosts no reviewer backend: verdict must be REVIEW_UNAVAILABLE unless the context carries reviewer notes.',
  '- Claims without evidence in the context are "unadjudicated", never "supported".',
].join('\n');

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Structural validation mirroring the output contract (fail = zero writes). */
export function validatePaperPlan(value: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isObject(value)) return { ok: false, errors: ['plan must be an object'] };

  if (!nonEmpty(value.paperType)) errors.push('paperType must be a non-empty string');
  if (
    typeof value.venue !== 'string' ||
    !(PAPER_VENUES as readonly string[]).includes(value.venue)
  ) {
    errors.push(`venue must be one of ${PAPER_VENUES.join(' | ')}`);
  }
  if (
    typeof value.maxPages !== 'number' ||
    !Number.isInteger(value.maxPages) ||
    value.maxPages < 1
  ) {
    errors.push('maxPages must be an integer >= 1');
  }
  if (!nonEmpty(value.contribution)) errors.push('contribution must be a non-empty string');

  if (!Array.isArray(value.claimsEvidence) || value.claimsEvidence.length === 0) {
    errors.push('claimsEvidence must be a non-empty array');
  } else {
    value.claimsEvidence.forEach((claim, index) => {
      if (!isObject(claim)) {
        errors.push(`claimsEvidence[${index}] must be an object`);
        return;
      }
      if (!nonEmpty(claim.claim)) errors.push(`claimsEvidence[${index}].claim must be non-empty`);
      if (!Array.isArray(claim.evidence) || claim.evidence.length === 0) {
        errors.push(`claimsEvidence[${index}].evidence must contain at least one source`);
      } else {
        claim.evidence.forEach((item, e) => {
          if (!isObject(item) || !nonEmpty(item.source) || !nonEmpty(item.location)) {
            errors.push(
              `claimsEvidence[${index}].evidence[${e}] needs non-empty source and location`,
            );
          }
        });
      }
      if (!['supported', 'partial', 'unadjudicated'].includes(String(claim.status))) {
        errors.push(`claimsEvidence[${index}].status must be supported | partial | unadjudicated`);
      }
    });
  }

  if (!Array.isArray(value.structure) || value.structure.length === 0) {
    errors.push('structure must be a non-empty array');
  } else {
    value.structure.forEach((section, index) => {
      if (!isObject(section) || !nonEmpty(section.section) || !nonEmpty(section.purpose)) {
        errors.push(`structure[${index}] needs non-empty section and purpose`);
      } else if (
        !Array.isArray(section.keyPoints) ||
        section.keyPoints.some((point) => !nonEmpty(point))
      ) {
        errors.push(`structure[${index}].keyPoints must be non-empty strings`);
      }
    });
  }

  if (!Array.isArray(value.figurePlan) || value.figurePlan.length === 0) {
    errors.push('figurePlan must be a non-empty array');
  } else {
    value.figurePlan.forEach((figure, index) => {
      if (
        !isObject(figure) ||
        !nonEmpty(figure.id) ||
        !nonEmpty(figure.kind) ||
        !nonEmpty(figure.caption)
      ) {
        errors.push(`figurePlan[${index}] needs non-empty id, kind and caption`);
      } else if (
        !Array.isArray(figure.supportsClaims) ||
        figure.supportsClaims.some((claim) => !nonEmpty(claim))
      ) {
        errors.push(`figurePlan[${index}].supportsClaims must be non-empty strings`);
      }
    });
  }

  if (!Array.isArray(value.citationPlan) || value.citationPlan.length === 0) {
    errors.push('citationPlan must be a non-empty array');
  } else {
    value.citationPlan.forEach((entry, index) => {
      if (!isObject(entry) || !nonEmpty(entry.topic)) {
        errors.push(`citationPlan[${index}] needs a non-empty topic`);
      } else if (!Array.isArray(entry.candidates)) {
        errors.push(`citationPlan[${index}].candidates must be an array`);
      }
    });
  }

  const feedback = value.reviewerFeedback;
  if (!isObject(feedback)) {
    errors.push('reviewerFeedback must be an object');
  } else {
    if (!['ACCEPT', 'REVISE', 'REVIEW_UNAVAILABLE'].includes(String(feedback.verdict))) {
      errors.push('reviewerFeedback.verdict must be ACCEPT | REVISE | REVIEW_UNAVAILABLE');
    }
    if (!Array.isArray(feedback.notes) || feedback.notes.some((note) => !nonEmpty(note))) {
      errors.push('reviewerFeedback.notes must be non-empty strings');
    }
  }

  if (!Array.isArray(value.nextSteps) || value.nextSteps.length === 0) {
    errors.push('nextSteps must be a non-empty array');
  } else if (value.nextSteps.some((step) => !nonEmpty(step))) {
    errors.push('nextSteps entries must be non-empty strings');
  }

  return { ok: errors.length === 0, errors };
}

/** Read-only snapshot of persisted state feeding the plan (ADR-002). */
export interface PaperPlanSnapshot {
  question: string;
  protocol: { protocolId: string; protocolHash: string; lockedAt: number } | null;
  comparisons: { methodId: string; status: string; required: boolean }[];
  experiments: {
    specId: string;
    version: number;
    status: string;
    metrics: { name: string; value: number }[];
  }[];
  ideas: { ideaId: string; verdict: string | null }[];
  researchMapHash: string | null;
}

export async function collectPaperPlanSnapshot(root: string): Promise<PaperPlanSnapshot> {
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  try {
    const project = runtime.project;
    const latestRun = await runtime.db.getLatestRun(project.id);
    const locks = await runtime.db.listProtocolLocks();
    const lock = locks.length > 0 ? locks[locks.length - 1]! : null;
    const comparisons = await runtime.db.listComparisons();
    const experiments = await runtime.db.listExperiments();

    const ideas: { ideaId: string; verdict: string | null }[] = [];
    try {
      const entries = await readdir(join(root, 'ideas'), { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const ideaDir = join(root, 'ideas', entry.name);
        let versions: string[] = [];
        try {
          versions = (await readdir(ideaDir)).filter((name) => /^analysis-v\d+\.json$/.test(name));
        } catch {
          continue;
        }
        versions.sort();
        const latest = versions[versions.length - 1];
        let verdict: string | null = null;
        if (latest) {
          try {
            const parsed = JSON.parse(await readFile(join(ideaDir, latest), 'utf8')) as {
              verdict?: unknown;
            };
            verdict = typeof parsed.verdict === 'string' ? parsed.verdict : null;
          } catch {
            verdict = null;
          }
        }
        ideas.push({ ideaId: entry.name, verdict });
      }
    } catch {
      // no ideas/ workspace yet — empty list is honest
    }
    ideas.sort((a, b) => a.ideaId.localeCompare(b.ideaId));

    let researchMapHash: string | null = null;
    try {
      researchMapHash = await sha256OfFile(join(root, 'knowledge', 'research-map.md'));
    } catch {
      researchMapHash = null;
    }

    return {
      question: latestRun?.question ?? '(no run yet)',
      protocol: lock
        ? { protocolId: lock.protocolId, protocolHash: lock.protocolHash, lockedAt: lock.lockedAt }
        : null,
      comparisons: comparisons
        .map((doc) => ({
          methodId: doc.methodId,
          status: doc.status,
          required: doc.required,
        }))
        .sort((a, b) => a.methodId.localeCompare(b.methodId)),
      experiments: experiments
        .map((doc) => {
          const rawMetrics = (doc.result as { metrics?: unknown } | null)?.metrics;
          const metrics = Array.isArray(rawMetrics)
            ? rawMetrics
                .filter(
                  (metric): metric is { name: string; value: number } =>
                    typeof metric === 'object' &&
                    metric !== null &&
                    typeof (metric as { name?: unknown }).name === 'string' &&
                    typeof (metric as { value?: unknown }).value === 'number',
                )
                .map((metric) => ({ name: metric.name, value: metric.value }))
            : [];
          return {
            specId: doc.specId,
            version: doc.version,
            status: doc.status,
            metrics,
          };
        })
        .sort((a, b) => a.specId.localeCompare(b.specId)),
      ideas,
      researchMapHash,
    };
  } finally {
    await runtime.close();
  }
}

function renderSnapshot(snapshot: PaperPlanSnapshot): string {
  const lines = [`Research question: ${snapshot.question}`];
  lines.push(
    snapshot.protocol
      ? `Locked protocol: ${snapshot.protocol.protocolId} (${snapshot.protocol.protocolHash}) lockedAt=${snapshot.protocol.lockedAt}`
      : 'Locked protocol: none',
  );
  lines.push(
    snapshot.comparisons.length > 0
      ? `Comparisons: ${snapshot.comparisons
          .map((entry) => `${entry.methodId}:${entry.status}${entry.required ? '' : '(ref)'}`)
          .join(', ')}`
      : 'Comparisons: none',
  );
  if (snapshot.experiments.length > 0) {
    lines.push('Experiment results:');
    for (const entry of snapshot.experiments) {
      lines.push(
        `  - ${entry.specId} v${entry.version} [${entry.status}]` +
          (entry.metrics.length > 0
            ? ` ${entry.metrics.map((metric) => `${metric.name}=${metric.value}`).join(', ')}`
            : ''),
      );
    }
  } else {
    lines.push('Experiment results: none');
  }
  lines.push(
    snapshot.ideas.length > 0
      ? `Ideas: ${snapshot.ideas.map((entry) => `${entry.ideaId}:${entry.verdict ?? 'unanalyzed'}`).join(', ')}`
      : 'Ideas: none',
  );
  lines.push(`Research map: ${snapshot.researchMapHash ?? 'absent'}`);
  return lines.join('\n');
}

export interface PaperPlanRequest {
  instruction: string;
  context: string;
  inputHash: string;
  idempotencyKey: string;
}

export function buildPaperPlanRequest(
  skill: LoadedArisSkill,
  snapshot: PaperPlanSnapshot,
): PaperPlanRequest {
  const context = renderSnapshot(snapshot);
  const inputHash = sha256Of(
    stableJson({
      contract: PAPER_PLAN_SCHEMA,
      skillSha256: skill.sha256,
      snapshot,
    }),
  );
  const instruction = [
    renderArisSkill(skill, { arguments: context }),
    '',
    '---',
    '',
    PAPER_PLAN_OUTPUT_CONTRACT,
    '',
    'Context (persisted, hashable sources only):',
    context,
  ].join('\n');
  return {
    instruction,
    context,
    inputHash,
    idempotencyKey: `paper-plan:${inputHash}`,
  };
}

/** Parses + validates harness output; throws PARSE_FAILED on any violation. */
export function parsePaperPlanOutput(output: string): PaperPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `paper-plan output is not valid JSON: ${(error as Error).message}`,
    );
  }
  const validation = validatePaperPlan(parsed);
  if (!validation.ok) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `paper-plan output violates ${PAPER_PLAN_SCHEMA}: ${validation.errors.slice(0, 5).join('; ')}`,
      { errors: validation.errors },
    );
  }
  return parsed as PaperPlan;
}
