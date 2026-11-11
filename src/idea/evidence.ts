/**
 * Shared artifact bundle for independent model passes over an idea
 * (review, experiment audit): raw persisted artifacts ONLY — never an
 * executor summary — so each pass reads the same facts a human would open
 * from the workspace. Callers own runtime lifecycle; this only reads.
 */

export interface IdeaEvidenceBundle {
  card: unknown;
  checkReport: unknown;
  experiment: unknown;
  plan: unknown;
  novelty: unknown;
  review: unknown;
  ablations: unknown;
}

export interface EvidenceDb {
  getExperiment(specId: string): Promise<unknown | null>;
  listExperiments(): Promise<{ specId: string }[]>;
}

export interface CollectOptions {
  /** A reviewer must NOT see its own prior rounds (fresh context). */
  includeReviews?: boolean;
}

export async function collectIdeaEvidence(
  root: string,
  ideaId: string,
  card: unknown,
  db: EvidenceDb,
  opts: CollectOptions = {},
): Promise<IdeaEvidenceBundle> {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { readPlan } = await import('./plan.js');
  const { readNoveltyReport } = await import('./novelty.js');
  const { readLatestReview } = await import('./review.js');

  let checkReport: unknown = null;
  try {
    checkReport = JSON.parse(
      await readFile(join(root, 'ideas', ideaId, 'experiments', 'check-report.json'), 'utf8'),
    );
  } catch {
    checkReport = null;
  }

  const all = await db.listExperiments();
  const ablations = all.filter((doc) => doc.specId.startsWith(`idea-${ideaId}-abl-`));

  return {
    card,
    checkReport,
    experiment: await db.getExperiment(`idea-${ideaId}`),
    plan: await readPlan(root, ideaId),
    novelty: await readNoveltyReport(root, ideaId),
    review: opts.includeReviews === false ? null : await readLatestReview(root, ideaId),
    ablations,
  };
}
