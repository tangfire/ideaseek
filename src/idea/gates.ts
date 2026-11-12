import { IdeaseekError } from '../core/errors.js';
import { listReviews, type ReviewArtifact } from '../review/review.js';

/**
 * Experiment/handoff gates over the SINGLE default review backend
 * (src/review — ADR-009: the ARIS-aligned fresh-context reviewer owns
 * execution and storage; these helpers only interpret the latest artifact
 * for gating, keeping the same audited --waive-* semantics).
 */

type IdeaReviewArtifact = Extract<ReviewArtifact, { kind: 'idea-review' }>;
type ExperimentAuditArtifact = Extract<ReviewArtifact, { kind: 'experiment-audit' }>;

async function latestOf<T extends ReviewArtifact['kind']>(
  root: string,
  ideaId: string,
  kind: T,
): Promise<ReviewArtifact | null> {
  const reviews = await listReviews(root, ideaId);
  const hits = reviews.filter((review) => review.kind === kind);
  return hits.length > 0 ? hits[hits.length - 1]! : null;
}

/** Latest idea review for an idea (null when never reviewed). */
export async function readLatestIdeaReview(
  root: string,
  ideaId: string,
): Promise<IdeaReviewArtifact | null> {
  const artifact = await latestOf(root, ideaId, 'idea-review');
  return artifact as IdeaReviewArtifact | null;
}

/** Latest experiment audit for an idea (null when never audited). */
export async function readLatestExperimentAudit(
  root: string,
  ideaId: string,
): Promise<ExperimentAuditArtifact | null> {
  const artifact = await latestOf(root, ideaId, 'experiment-audit');
  return artifact as ExperimentAuditArtifact | null;
}

/** ARIS STOP rule on the artifact: score ≥ 6 AND verdict ∈ {ready, almost}. */
export function isIdeaReviewPassing(
  review: Pick<IdeaReviewArtifact, 'score' | 'verdict'>,
): boolean {
  return review.score >= 6 && (review.verdict === 'ready' || review.verdict === 'almost');
}

/**
 * Experiment gate: a CURRENT failing idea review blocks runs unless waived
 * with an audited reason (the CLI records the Decision/Event first).
 */
export function assertIdeaReviewClear(
  review: IdeaReviewArtifact | null,
  expected: { ideaId: string; cardVersion: number },
  opts: { waiveReview?: string } = {},
): { applied: boolean; waived: boolean } {
  if (!review || review.target.cardVersion !== expected.cardVersion) {
    return { applied: false, waived: false };
  }
  if (isIdeaReviewPassing(review)) return { applied: true, waived: false };
  if (opts.waiveReview && opts.waiveReview.trim()) return { applied: true, waived: true };
  throw new IdeaseekError(
    'USER_INPUT_REQUIRED',
    `independent review v${review.version} is failing (score ${review.score}, verdict "${review.verdict}") ` +
      `and blocks experiments for ${expected.ideaId} — address the weaknesses: ` +
      `ideaseek idea review ${expected.ideaId} --force, or waive with an audited reason: ` +
      `ideaseek idea experiment ${expected.ideaId} --waive-review "<reason>"`,
    { score: review.score, verdict: review.verdict, version: review.version },
  );
}

/**
 * Handoff gate input: the CURRENT audit's verdict (null when absent or
 * stale). FAIL blocks HANDOFF_READY; WARN stays visible but non-blocking.
 */
export function currentExperimentAuditVerdict(
  audit: ExperimentAuditArtifact | null,
  expected: { ideaId: string; cardVersion: number },
): { verdict: 'FAIL' | 'WARN' | 'PASS' | null; summary: string } {
  if (!audit || audit.target.cardVersion !== expected.cardVersion) {
    return { verdict: null, summary: '' };
  }
  return { verdict: audit.overall, summary: audit.summary };
}
