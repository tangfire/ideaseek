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
  listArtifactsByKind(kind: string): Promise<{ contentHash: string }[]>;
}

export interface EvidenceRuntime {
  db: EvidenceDb;
  store: { readFinalText(hash: string): Promise<string> };
}

export interface CollectOptions {
  /** A reviewer must NOT see its own prior rounds (fresh context). */
  includeReviews?: boolean;
}

export async function collectIdeaEvidence(
  root: string,
  ideaId: string,
  card: unknown,
  runtime: EvidenceRuntime,
  opts: CollectOptions = {},
): Promise<IdeaEvidenceBundle> {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { loadStoredPlan } = await import('../experiment/plan.js');
  const { readNoveltyReport } = await import('./novelty.js');
  const { readLatestIdeaReview } = await import('./gates.js');

  let checkReport: unknown = null;
  try {
    checkReport = JSON.parse(
      await readFile(join(root, 'ideas', ideaId, 'experiments', 'check-report.json'), 'utf8'),
    );
  } catch {
    checkReport = null;
  }

  const all = await runtime.db.listExperiments();
  const ablations = all.filter((doc) => doc.specId.startsWith(`idea-${ideaId}-abl-`));

  return {
    card,
    checkReport,
    experiment: await runtime.db.getExperiment(`idea-${ideaId}`),
    plan: await loadStoredPlan(runtime, ideaId),
    novelty: await readNoveltyReport(root, ideaId),
    review: opts.includeReviews === false ? null : await readLatestIdeaReview(root, ideaId),
    ablations,
  };
}
