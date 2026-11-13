import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { sha256Of } from '../core/hash.js';
import { writeFileAtomic } from '../core/atomic.js';
import { stableJson } from '../experiment/spec.js';
import { renderArisSkill, type LoadedArisSkill } from '../aris/skill.js';
import { assertAgainstSchema } from '../core/schema/index.js';

/**
 * ARIS novelty-check + prior-art-search backend (Phase 4.5 capability 4).
 * The vendored skills supply the review methodology; IdeaSeek binds the
 * verdict to the local PaperCard index: `closestPaperRef` must reference a
 * paper actually returned by the project's FTS search (anti-hallucination,
 * ARIS verify_papers discipline), ABANDON must name specific papers, and
 * the prior-art section is explicitly degraded when no web tools exist.
 * A current ABANDON verdict blocks experiments until a --force regeneration
 * or an audited --waive-novelty Decision.
 */

export const NOVELTY_SCHEMA = 'novelty-check-v1';

export type NoveltyVerdict = 'PROCEED' | 'PROCEED_WITH_CAUTION' | 'ABANDON';

export interface NoveltyClaim {
  claim: string;
  /** paperKey from the local candidates (null = nothing close found). */
  closestPaperRef: string | null;
  overlap: string;
  delta: string;
}

export interface PatentHit {
  patentNumber: string;
  overlapRisk: 'HIGH' | 'MEDIUM' | 'LOW';
  notes: string;
}

export interface NoveltyReport {
  contract: typeof NOVELTY_SCHEMA;
  ideaId: string;
  cardVersion: number;
  inputHash: string;
  skills: { novelty: { name: string; sha256: string }; priorArt: { name: string; sha256: string } };
  generatedAt: number;
  harnessRuntime: string;
  verdict: NoveltyVerdict;
  score: number;
  positioning: string;
  claims: NoveltyClaim[];
  patents: PatentHit[];
  /** True when patent/NPL search ran without web access (honest degrade). */
  priorArtDegraded: boolean;
  notes: string[];
  /** Candidate paperKeys offered to the model (audit of what it could cite). */
  candidateRefs: string[];
}

export interface NoveltyCandidate {
  paperKey: string;
  source: string;
  snippet: string;
}

const OUTPUT_CONTRACT = `
# IdeaSeek output contract (${NOVELTY_SCHEMA})

Reply with ONE JSON object and nothing else:

{"verdict": "PROCEED|PROCEED_WITH_CAUTION|ABANDON", "score": <1-10>,
 "positioning": "...",
 "claims": [{"claim": "...", "closestPaperRef": "<paperKey from Candidates or null>",
   "overlap": "...", "delta": "..."}],
 "patents": [{"patentNumber": "...", "overlapRisk": "HIGH|MEDIUM|LOW", "notes": "..."}],
 "priorArtDegraded": <true|false>, "notes": ["..."]}

Rules:
- claims ≥ 1. closestPaperRef MUST be one of the Candidates paperKeys listed
  below, or null when nothing close exists — never invent a paper id.
- ABANDON requires EVERY claim to name a specific candidate paper
  (closestPaperRef non-null) — a vague "not novel" is not allowed.
- score: 1-10 (10 = clearly novel vs the candidate set).
- patents: prior-art hits you can name; with no web tools set
  priorArtDegraded=true and patents may be [] (honest degradation).
- positioning: one paragraph of how to frame the work against the closest
  candidate.
- No prose, no markdown fence, no commentary outside the JSON object.
`.trim();

export interface NoveltyRequest {
  instruction: string;
  inputHash: string;
  idempotencyKey: string;
}

export function buildNoveltyRequest(
  skills: { novelty: LoadedArisSkill; priorArt: LoadedArisSkill },
  context: {
    ideaId: string;
    cardVersion: number;
    cardJson: string;
    constraints: string[];
    candidates: NoveltyCandidate[];
    question: string | null;
  },
): NoveltyRequest {
  const inputHash = sha256Of(
    stableJson({
      contract: NOVELTY_SCHEMA,
      noveltySkillSha256: skills.novelty.sha256,
      priorArtSkillSha256: skills.priorArt.sha256,
      ideaId: context.ideaId,
      cardVersion: context.cardVersion,
      card: JSON.parse(context.cardJson),
      constraints: context.constraints,
      candidateRefs: context.candidates.map((candidate) => candidate.paperKey),
      question: context.question,
    }),
  );
  const instruction = [
    renderArisSkill(skills.novelty, {
      arguments: `IdeaSeek idea ${context.ideaId} (card v${context.cardVersion})`,
    }),
    '',
    '---',
    '',
    renderArisSkill(skills.priorArt, {
      arguments: `IdeaSeek idea ${context.ideaId} prior-art section (no web tools: degrade honestly)`,
    }),
    '',
    '---',
    '',
    OUTPUT_CONTRACT,
    '',
    'IdeaCard (authoritative input):',
    context.cardJson,
    '',
    `Research question: ${context.question ?? '(none)'}`,
    'Novelty constraints from the ideation round:',
    ...(context.constraints.length > 0
      ? context.constraints.map((entry) => `  - ${entry}`)
      : ['  (none)']),
    'Candidates (the ONLY allowed closestPaperRef values):',
    ...(context.candidates.length > 0
      ? context.candidates.map(
          (candidate) =>
            `  - ${candidate.paperKey}  source=${candidate.source}  snippet=${candidate.snippet.slice(0, 240)}`,
        )
      : ['  (local paper index is empty — closestPaperRef must be null, priorArtDegraded=true)']),
  ].join('\n');
  return { instruction, inputHash, idempotencyKey: `novelty:${inputHash}` };
}

export interface NoveltyValidation {
  ok: boolean;
  errors: string[];
}

export function validateNoveltyReport(
  value: unknown,
  expected: { ideaId: string; cardVersion: number; candidateRefs: string[] },
): NoveltyValidation {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['report must be a JSON object'] };
  }
  const record = value as Record<string, unknown>;
  if (record.ideaId !== expected.ideaId) errors.push(`ideaId must be "${expected.ideaId}"`);
  if (record.cardVersion !== expected.cardVersion)
    errors.push(`cardVersion must be ${expected.cardVersion}`);

  const verdict = record.verdict;
  if (!['PROCEED', 'PROCEED_WITH_CAUTION', 'ABANDON'].includes(String(verdict))) {
    errors.push('verdict must be PROCEED|PROCEED_WITH_CAUTION|ABANDON');
  }
  if (
    typeof record.score !== 'number' ||
    !Number.isInteger(record.score) ||
    record.score < 1 ||
    record.score > 10
  ) {
    errors.push('score must be an integer 1-10');
  }
  if (typeof record.positioning !== 'string' || !record.positioning.trim()) {
    errors.push('positioning must be a non-empty string');
  }

  const refs = new Set(expected.candidateRefs);
  const claims = record.claims;
  if (!Array.isArray(claims) || claims.length === 0) {
    errors.push('claims must have ≥ 1 entry');
  } else {
    for (const [i, entry] of claims.entries()) {
      const item = entry as Partial<NoveltyClaim>;
      const where = `claims[${i}]`;
      if (typeof item?.claim !== 'string' || !item.claim.trim()) {
        errors.push(`${where}.claim must be a non-empty string`);
      }
      const ref = item?.closestPaperRef;
      if (ref !== null && ref !== undefined) {
        if (typeof ref !== 'string' || !refs.has(ref)) {
          errors.push(
            `${where}.closestPaperRef "${String(ref)}" is not among the provided candidates (never invent papers)`,
          );
        }
      } else if (verdict === 'ABANDON') {
        errors.push(`${where}.closestPaperRef must name a specific candidate paper for ABANDON`);
      }
      if (typeof item?.overlap !== 'string' || !item.overlap.trim()) {
        errors.push(`${where}.overlap must be a non-empty string`);
      }
      if (typeof item?.delta !== 'string' || !item.delta.trim()) {
        errors.push(`${where}.delta must be a non-empty string`);
      }
    }
  }

  const patents = record.patents;
  if (!Array.isArray(patents)) {
    errors.push('patents must be an array (may be empty)');
  } else {
    for (const [i, entry] of patents.entries()) {
      const item = entry as Partial<PatentHit>;
      const where = `patents[${i}]`;
      if (typeof item?.patentNumber !== 'string' || !item.patentNumber.trim()) {
        errors.push(`${where}.patentNumber must be a non-empty string (no fabricated numbers)`);
      }
      if (!['HIGH', 'MEDIUM', 'LOW'].includes(String(item?.overlapRisk))) {
        errors.push(`${where}.overlapRisk must be HIGH|MEDIUM|LOW`);
      }
      if (typeof item?.notes !== 'string' || !item.notes.trim()) {
        errors.push(`${where}.notes must be a non-empty string`);
      }
    }
  }
  if (typeof record.priorArtDegraded !== 'boolean') {
    errors.push('priorArtDegraded must be a boolean (honest degradation flag)');
  }
  if (!Array.isArray(record.notes)) errors.push('notes must be an array');
  return { ok: errors.length === 0, errors };
}

export function parseNoveltyOutput(
  output: string,
  expected: { ideaId: string; cardVersion: number; candidateRefs: string[] },
  meta: {
    inputHash: string;
    skills: NoveltyReport['skills'];
    harnessRuntime: string;
  },
): NoveltyReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new IdeaseekError('PARSE_FAILED', `novelty report is not JSON: ${output.slice(0, 160)}`);
  }
  const validation = validateNoveltyReport(parsed, expected);
  if (!validation.ok) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `novelty report failed validation: ${validation.errors.slice(0, 4).join('; ')}`,
    );
  }
  // Defense in depth (JSON Schema authority): context-bound checks ran
  // first; the shared contract re-checks structure as a subset gate.
  assertAgainstSchema('novelty-check-v1', parsed);
  const record = parsed as Omit<
    NoveltyReport,
    'contract' | 'inputHash' | 'skills' | 'generatedAt' | 'harnessRuntime' | 'candidateRefs'
  >;
  return {
    contract: NOVELTY_SCHEMA,
    ideaId: expected.ideaId,
    cardVersion: expected.cardVersion,
    inputHash: meta.inputHash,
    skills: meta.skills,
    generatedAt: Date.now(),
    harnessRuntime: meta.harnessRuntime,
    verdict: record.verdict,
    score: record.score,
    positioning: record.positioning,
    claims: record.claims,
    patents: record.patents,
    priorArtDegraded: record.priorArtDegraded,
    notes: record.notes,
    candidateRefs: expected.candidateRefs,
  };
}

export function noveltyPath(root: string, ideaId: string): string {
  return join(root, 'ideas', ideaId, 'novelty.json');
}

export async function readNoveltyReport(
  root: string,
  ideaId: string,
): Promise<NoveltyReport | null> {
  try {
    const report = JSON.parse(await readFile(noveltyPath(root, ideaId), 'utf8')) as NoveltyReport;
    if (report.contract !== NOVELTY_SCHEMA || report.ideaId !== ideaId) return null;
    return report;
  } catch {
    return null;
  }
}

export async function writeNoveltyReport(root: string, report: NoveltyReport): Promise<string> {
  const path = noveltyPath(root, report.ideaId);
  await writeFileAtomic(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

/**
 * Experiment gate: a CURRENT ABANDON verdict blocks runs unless the caller
 * explicitly waives with a reason (the CLI records the Decision/Event).
 */
export function assertNoveltyClear(
  report: NoveltyReport | null,
  expected: { ideaId: string; cardVersion: number },
  opts: { waiveNovelty?: string } = {},
): { applied: boolean; waived: boolean } {
  if (!report || report.cardVersion !== expected.cardVersion)
    return { applied: false, waived: false };
  if (report.verdict !== 'ABANDON') return { applied: true, waived: false };
  if (opts.waiveNovelty && opts.waiveNovelty.trim()) return { applied: true, waived: true };
  throw new IdeaseekError(
    'USER_INPUT_REQUIRED',
    `novelty verdict ABANDON (score ${report.score}) blocks experiments for ${expected.ideaId} — ` +
      `address it: ideaseek idea novelty ${expected.ideaId} --force, or waive with an audited reason: ` +
      `ideaseek idea experiment ${expected.ideaId} --waive-novelty "<reason>"`,
    { verdict: report.verdict, score: report.score },
  );
}
