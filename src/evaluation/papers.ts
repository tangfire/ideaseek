import { validatePaperCard } from '../knowledge/papercard.js';

/**
 * Literature-quality metrics for the gold set (docs/EVALUATION.md §文献质量):
 * field validity, evidence support rate, page-locating accuracy, parse/extract
 * coverage and failure identification — all computed from committed artifacts,
 * so a model/prompt/parser upgrade re-running the same sample is comparable.
 */
export interface PaperEvaluation {
  source: string;
  processed: boolean;
  pageCount: number | null;
  cardValid: boolean;
  cardErrors: number;
  claims: number;
  quotes: number;
  quotesWithPage: number;
  verifiedQuotes: number;
  pageLocatingCorrect: number;
  hashBound: boolean | null;
  verdict: 'pass' | 'fail' | null;
}

export interface PaperSetEvaluation {
  sampleSeed: number;
  sampleSize: number;
  sampled: PaperEvaluation[];
  aggregates: {
    sampled: number;
    processed: number;
    coverage: number;
    cardValidRate: number;
    evidenceSupportRate: number;
    pageLocatingAccuracy: number;
    hashBindingRate: number;
    verdictPassRate: number;
    avgClaims: number;
  };
  /** Sources from the sample with no committed pipeline output. */
  missing: string[];
  evaluatedAt: number;
}

/**
 * Deterministic sample: seeded shuffle over sorted sources (same seed +
 * corpus ⇒ identical sample, so regression runs are comparable).
 */
export function sampleSources(sources: string[], n: number, seed: number): string[] {
  const sorted = [...new Set(sources)].sort();
  const take = Math.max(1, Math.min(sorted.length, Math.floor(n)));
  let a = seed >>> 0;
  const random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const order = sorted.map((_, index) => index);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order.slice(0, take).map((index) => sorted[index]!);
}

export interface SourceArtifacts {
  source: string;
  parsed: { pageCount: number } | null;
  card: { card: Record<string, unknown> } | null;
  report: {
    verdict: 'pass' | 'fail';
    hashMatch: boolean | null;
    stats: { claims: number; spans: number; verified: number; weak: number; failed: number };
    spanChecks: { claimedPage: number | null; foundPage: number | null; ok: boolean; weak: boolean; quote: string | null }[];
  } | null;
}

/** Evaluates one source's committed artifacts (missing ⇒ processed: false). */
export function evaluateSource(input: SourceArtifacts): PaperEvaluation {
  const base: PaperEvaluation = {
    source: input.source,
    processed: Boolean(input.parsed && input.card && input.report),
    pageCount: input.parsed?.pageCount ?? null,
    cardValid: false,
    cardErrors: 0,
    claims: 0,
    quotes: 0,
    quotesWithPage: 0,
    verifiedQuotes: 0,
    pageLocatingCorrect: 0,
    hashBound: null,
    verdict: null,
  };
  if (!input.card) return base;

  const validation = validatePaperCard(input.card.card);
  base.cardValid = validation.ok;
  base.cardErrors = validation.errors.length;
  const claims = Array.isArray(input.card.card.claims) ? (input.card.card.claims as unknown[]) : [];
  base.claims = claims.length;

  if (input.report) {
    const { stats, spanChecks, hashMatch, verdict } = input.report;
    base.verdict = verdict;
    base.hashBound = hashMatch;
    base.quotes = stats.spans - stats.weak;
    base.verifiedQuotes = stats.verified;
    base.quotesWithPage = spanChecks.filter((check) => check.quote && check.claimedPage != null)
      .length;
    base.pageLocatingCorrect = spanChecks.filter(
      (check) => check.quote && check.claimedPage != null && check.ok,
    ).length;
  }
  return base;
}

export function aggregateEvaluations(
  sampled: PaperEvaluation[],
  evaluatedAt: number,
  sampleSeed: number,
): PaperSetEvaluation {
  const processed = sampled.filter((item) => item.processed);
  const quotes = processed.reduce((sum, item) => sum + item.quotes, 0);
  const verified = processed.reduce((sum, item) => sum + item.verifiedQuotes, 0);
  const withPage = processed.reduce((sum, item) => sum + item.quotesWithPage, 0);
  const pageCorrect = processed.reduce((sum, item) => sum + item.pageLocatingCorrect, 0);
  const hashed = processed.filter((item) => item.hashBound !== null);
  const passed = processed.filter((item) => item.verdict === 'pass');
  const verdicts = processed.filter((item) => item.verdict !== null);

  return {
    sampleSeed,
    sampleSize: sampled.length,
    sampled,
    aggregates: {
      sampled: sampled.length,
      processed: processed.length,
      coverage: sampled.length === 0 ? 0 : processed.length / sampled.length,
      cardValidRate:
        processed.length === 0 ? 0 : processed.filter((item) => item.cardValid).length / processed.length,
      evidenceSupportRate: quotes === 0 ? 0 : verified / quotes,
      pageLocatingAccuracy: withPage === 0 ? 0 : pageCorrect / withPage,
      hashBindingRate: hashed.length === 0 ? 0 : hashed.filter((item) => item.hashBound === true).length / hashed.length,
      verdictPassRate: verdicts.length === 0 ? 0 : passed.length / verdicts.length,
      avgClaims: processed.length === 0 ? 0 : processed.reduce((sum, item) => sum + item.claims, 0) / processed.length,
    },
    missing: sampled.filter((item) => !item.processed).map((item) => item.source),
    evaluatedAt,
  };
}
