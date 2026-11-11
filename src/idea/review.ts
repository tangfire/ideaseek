import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { sha256Of } from '../core/hash.js';
import { writeFileAtomic } from '../core/atomic.js';
import { stableJson } from '../experiment/spec.js';
import { renderArisSkill, type LoadedArisSkill } from '../aris/skill.js';

/**
 * Fresh-context independent reviewer (Phase 4.5 capability 5, ARIS
 * auto-review-loop): every round is a NEW harness task whose instruction
 * contains ONLY the artifact bundle (card, check report, experiment
 * results, plan, novelty) — never an executor summary and never the
 * previous round's reasoning, so the reviewer cannot continue a
 * self-justifying thread (docs/ARIS_INTEGRATION_PLAN 交叉评审原则).
 * The reviewer model id is stamped by IdeaSeek from the harness result
 * (never model-invented). STOP mirrors ARIS: score ≥ 6 AND verdict ∈
 * {ready, almost}; a current failing review blocks experiments unless
 * waived with an audited reason.
 */

export const IDEA_REVIEW_SCHEMA = 'idea-review-v1';
export const REVIEW_STOP_SCORE = 6;

export type ReviewVerdict = 'ready' | 'almost' | 'not ready';

export interface ReviewWeakness {
  severity: 'major' | 'minor';
  text: string;
}

export interface IdeaReviewRound {
  contract: typeof IDEA_REVIEW_SCHEMA;
  ideaId: string;
  cardVersion: number;
  /** 1-based review round (fresh context each time). */
  round: number;
  inputHash: string;
  skill: { name: string; sha256: string };
  generatedAt: number;
  harnessRuntime: string;
  /** Stamped from HarnessTaskResult.model — never trusted from output. */
  reviewerModel: string | null;
  score: number;
  verdict: ReviewVerdict;
  summary: string;
  weaknesses: ReviewWeakness[];
  questions: string[];
  /** Digest of the artifact bundle the reviewer actually saw. */
  evidenceDigest: string;
}

/** Artifact bundle: the ONLY things the reviewer may read (fresh context). */
export interface ReviewEvidenceBundle {
  card: unknown;
  checkReport: unknown;
  experiment: unknown;
  plan: unknown;
  novelty: unknown;
  ablations: unknown;
}

export function evidenceDigest(bundle: ReviewEvidenceBundle): string {
  return sha256Of(stableJson(bundle));
}

const OUTPUT_CONTRACT = `
# IdeaSeek output contract (${IDEA_REVIEW_SCHEMA})

You are an INDEPENDENT reviewer: you receive only the artifact bundle below
(no executor claims about its quality). Reply with ONE JSON object:

{"score": <1-10>, "verdict": "ready|almost|not ready", "summary": "...",
 "weaknesses": [{"severity": "major|minor", "text": "..."}],
 "questions": ["..."]}

Rules:
- score: 1-10; STOP = score ≥ 6 AND verdict ∈ {ready, almost}.
- weaknesses ≥ 1 (a review that finds nothing is not a review); rank the
  most important first.
- Judge ONLY the artifacts: check-report freshness, result metrics vs the
  plan's primary metric, novelty overlap, mechanism-chain support. Never
  take "it should work" as evidence; demand numbers that exist.
- No prose, no markdown fence, no commentary outside the JSON object.
`.trim();

export interface ReviewRequest {
  instruction: string;
  inputHash: string;
  idempotencyKey: string;
}

export function buildReviewRequest(
  skill: LoadedArisSkill,
  context: { ideaId: string; cardVersion: number; round: number; bundle: ReviewEvidenceBundle },
): ReviewRequest {
  const digest = evidenceDigest(context.bundle);
  // Round is deliberately NOT part of inputHash: a rerun over unchanged
  // evidence reuses the latest round; --force issues a NEW round id with a
  // fresh idempotencyKey (an independent re-review of the same artifacts).
  const inputHash = sha256Of(
    stableJson({
      contract: IDEA_REVIEW_SCHEMA,
      skillSha256: skill.sha256,
      ideaId: context.ideaId,
      cardVersion: context.cardVersion,
      evidenceDigest: digest,
    }),
  );
  const instruction = [
    renderArisSkill(skill, {
      arguments: `IdeaSeek idea ${context.ideaId} review round ${context.round} (card v${context.cardVersion})`,
    }),
    '',
    '---',
    '',
    OUTPUT_CONTRACT,
    '',
    `Evidence bundle (digest ${digest}) — the only input you may judge:`,
    JSON.stringify(context.bundle, null, 2),
  ].join('\n');
  return {
    instruction,
    inputHash,
    idempotencyKey: `idea-review:r${context.round}:${inputHash}`,
  };
}

export interface ReviewValidation {
  ok: boolean;
  errors: string[];
}

export function validateReviewOutput(
  value: unknown,
  expected: { ideaId: string; cardVersion: number; round: number },
): ReviewValidation {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['review must be a JSON object'] };
  }
  const record = value as Record<string, unknown>;
  if (record.ideaId !== expected.ideaId) errors.push(`ideaId must be "${expected.ideaId}"`);
  if (record.cardVersion !== expected.cardVersion)
    errors.push(`cardVersion must be ${expected.cardVersion}`);
  if (record.round !== expected.round) errors.push(`round must be ${expected.round}`);
  if (
    typeof record.score !== 'number' ||
    !Number.isInteger(record.score) ||
    record.score < 1 ||
    record.score > 10
  ) {
    errors.push('score must be an integer 1-10');
  }
  if (!['ready', 'almost', 'not ready'].includes(String(record.verdict))) {
    errors.push('verdict must be ready|almost|not ready');
  }
  if (typeof record.summary !== 'string' || !record.summary.trim()) {
    errors.push('summary must be a non-empty string');
  }
  const weaknesses = record.weaknesses;
  if (!Array.isArray(weaknesses) || weaknesses.length === 0) {
    errors.push('weaknesses must have ≥ 1 entry');
  } else {
    for (const [i, entry] of weaknesses.entries()) {
      const item = entry as Partial<ReviewWeakness>;
      if (!['major', 'minor'].includes(String(item?.severity))) {
        errors.push(`weaknesses[${i}].severity must be major|minor`);
      }
      if (typeof item?.text !== 'string' || !item.text.trim()) {
        errors.push(`weaknesses[${i}].text must be a non-empty string`);
      }
    }
  }
  if (!Array.isArray(record.questions)) errors.push('questions must be an array');
  return { ok: errors.length === 0, errors };
}

export function parseReviewOutput(
  output: string,
  expected: { ideaId: string; cardVersion: number; round: number },
  meta: {
    inputHash: string;
    skill: { name: string; sha256: string };
    harnessRuntime: string;
    reviewerModel: string | null;
    evidenceDigest: string;
  },
): IdeaReviewRound {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new IdeaseekError('PARSE_FAILED', `idea review is not JSON: ${output.slice(0, 160)}`);
  }
  const validation = validateReviewOutput(parsed, expected);
  if (!validation.ok) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `idea review failed validation: ${validation.errors.slice(0, 4).join('; ')}`,
    );
  }
  const record = parsed as {
    score: number;
    verdict: ReviewVerdict;
    summary: string;
    weaknesses: ReviewWeakness[];
    questions: string[];
  };
  return {
    contract: IDEA_REVIEW_SCHEMA,
    ideaId: expected.ideaId,
    cardVersion: expected.cardVersion,
    round: expected.round,
    inputHash: meta.inputHash,
    skill: meta.skill,
    generatedAt: Date.now(),
    harnessRuntime: meta.harnessRuntime,
    reviewerModel: meta.reviewerModel,
    score: record.score,
    verdict: record.verdict,
    summary: record.summary,
    weaknesses: record.weaknesses,
    questions: record.questions,
    evidenceDigest: meta.evidenceDigest,
  };
}

export function reviewsDir(root: string, ideaId: string): string {
  return join(root, 'ideas', ideaId, 'reviews');
}

export function reviewRoundPath(root: string, ideaId: string, round: number): string {
  return join(reviewsDir(root, ideaId), `round-${round}.json`);
}

/** Reads one review round; wrong contract/idea/round → null. */
export async function readReviewRound(
  root: string,
  ideaId: string,
  round: number,
): Promise<IdeaReviewRound | null> {
  try {
    const review = JSON.parse(
      await readFile(reviewRoundPath(root, ideaId, round), 'utf8'),
    ) as IdeaReviewRound;
    if (
      review.contract !== IDEA_REVIEW_SCHEMA ||
      review.ideaId !== ideaId ||
      review.round !== round
    ) {
      return null;
    }
    return review;
  } catch {
    return null;
  }
}

/** Highest existing round (0 when none). */
export async function latestReviewRound(root: string, ideaId: string): Promise<number> {
  try {
    const names = await readdir(reviewsDir(root, ideaId));
    let max = 0;
    for (const name of names) {
      const match = /^round-(\d+)\.json$/.exec(name);
      if (match) max = Math.max(max, Number(match[1]));
    }
    return max;
  } catch {
    return 0;
  }
}

/** The latest persisted review (null when none). */
export async function readLatestReview(
  root: string,
  ideaId: string,
): Promise<IdeaReviewRound | null> {
  const round = await latestReviewRound(root, ideaId);
  if (round === 0) return null;
  return readReviewRound(root, ideaId, round);
}

export async function writeReviewRound(root: string, review: IdeaReviewRound): Promise<string> {
  const path = reviewRoundPath(root, review.ideaId, review.round);
  await writeFileAtomic(path, `${JSON.stringify(review, null, 2)}\n`);
  return path;
}

/** ARIS STOP rule: score ≥ 6 AND verdict ∈ {ready, almost}. */
export function isReviewPassing(review: Pick<IdeaReviewRound, 'score' | 'verdict'>): boolean {
  return (
    review.score >= REVIEW_STOP_SCORE && (review.verdict === 'ready' || review.verdict === 'almost')
  );
}

/**
 * Experiment gate: a CURRENT failing review blocks runs unless waived with
 * an audited reason (the CLI records the Decision/Event before running).
 */
export function assertReviewClear(
  review: IdeaReviewRound | null,
  expected: { ideaId: string; cardVersion: number },
  opts: { waiveReview?: string } = {},
): { applied: boolean; waived: boolean } {
  if (!review || review.cardVersion !== expected.cardVersion)
    return { applied: false, waived: false };
  if (isReviewPassing(review)) return { applied: true, waived: false };
  if (opts.waiveReview && opts.waiveReview.trim()) return { applied: true, waived: true };
  throw new IdeaseekError(
    'USER_INPUT_REQUIRED',
    `independent review round ${review.round} is failing (score ${review.score}, verdict "${review.verdict}") ` +
      `and blocks experiments for ${expected.ideaId} — address the weaknesses: ` +
      `ideaseek idea review ${expected.ideaId} --force, or waive with an audited reason: ` +
      `ideaseek idea experiment ${expected.ideaId} --waive-review "<reason>"`,
    { score: review.score, verdict: review.verdict },
  );
}
