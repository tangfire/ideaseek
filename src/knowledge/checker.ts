import { validatePaperCard, type PaperCard } from './papercard.js';

/**
 * Deterministic evidence verification (docs/plan.md §阶段 C step6 — the part
 * that does not need a model): every claim quote must actually appear in the
 * parsed source pages, claimed pages must exist, and the card's platform-
 * stamped document hash must match the parsed artifact it was extracted from.
 *
 * Verdicts:
 * - `pass`: structure valid, hash bound, every quote found (page matches
 *   when a page locator is present);
 * - `fail`: structural errors, hash mismatch, or a quote/page not found;
 * - weak locators (page-only, no quote) do not fail the verdict but are
 *   counted so reports can show confidence.
 */
export interface EvidenceSpanCheck {
  claimIndex: number;
  spanIndex: number;
  quote: string | null;
  claimedPage: number | null;
  foundPage: number | null;
  ok: boolean;
  weak: boolean;
  detail: string;
}

export interface EvidenceReport {
  paperId: string;
  documentHash: string | null;
  verdict: 'pass' | 'fail';
  structureErrors: string[];
  hashMatch: boolean | null;
  stats: {
    claims: number;
    spans: number;
    verified: number;
    weak: number;
    failed: number;
  };
  spanChecks: EvidenceSpanCheck[];
  checkedAt: number;
}

export interface VerifyEvidenceInput {
  card: unknown;
  /** Parsed pages of the source document (PDF flow), if available. */
  pages: { page: number; text: string }[] | null;
  /** Raw source text when there is no parsed PDF (text excerpt flow). */
  sourceText: string | null;
  /** Platform-computed sha256 of the source file, for binding checks. */
  sourceHash: string | null;
  now: number;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Finds `quote` in the source; returns the 1-based page when paged input exists. */
function locateQuote(
  quote: string,
  pages: { page: number; text: string }[] | null,
  sourceText: string | null,
): { found: boolean; page: number | null } {
  const needle = normalize(quote);
  if (needle.length === 0) return { found: false, page: null };
  if (pages) {
    for (const entry of pages) {
      if (normalize(entry.text).includes(needle)) return { found: true, page: entry.page };
    }
    return { found: false, page: null };
  }
  if (sourceText) {
    return { found: normalize(sourceText).includes(needle), page: null };
  }
  return { found: false, page: null };
}

export function verifyPaperEvidence(input: VerifyEvidenceInput): EvidenceReport {
  const structure = validatePaperCard(input.card);
  const card = (structure.ok ? input.card : null) as PaperCard | null;

  const hashMatch =
    input.sourceHash && card
      ? card.document_hash === input.sourceHash
      : input.sourceHash && !card
        ? null
        : null;

  const spanChecks: EvidenceSpanCheck[] = [];
  let verified = 0;
  let weak = 0;
  let failed = 0;

  if (card) {
    card.claims.forEach((claim, claimIndex) => {
      claim.evidence.forEach((span, spanIndex) => {
        const quote = typeof span.quote === 'string' && span.quote.trim() ? span.quote : null;
        const claimedPage = typeof span.page === 'number' ? span.page : null;
        if (claimedPage != null) {
          const maxPage = input.pages?.length ?? null;
          if (maxPage != null && (claimedPage < 1 || claimedPage > maxPage)) {
            failed += 1;
            spanChecks.push({
              claimIndex,
              spanIndex,
              quote,
              claimedPage,
              foundPage: null,
              ok: false,
              weak: false,
              detail: `claimed page ${claimedPage} outside document range 1..${maxPage}`,
            });
            return;
          }
        }
        if (quote) {
          const located = locateQuote(quote, input.pages, input.sourceText);
          const pageMatches =
            located.found && (claimedPage == null || located.page === claimedPage);
          if (pageMatches) {
            verified += 1;
            spanChecks.push({
              claimIndex,
              spanIndex,
              quote,
              claimedPage,
              foundPage: located.page,
              ok: true,
              weak: false,
              detail:
                claimedPage == null
                  ? 'quote found in source'
                  : `quote found on page ${located.page}`,
            });
          } else if (!located.found) {
            failed += 1;
            spanChecks.push({
              claimIndex,
              spanIndex,
              quote,
              claimedPage,
              foundPage: null,
              ok: false,
              weak: false,
              detail: 'quote not found in parsed source text',
            });
          } else {
            failed += 1;
            spanChecks.push({
              claimIndex,
              spanIndex,
              quote,
              claimedPage,
              foundPage: located.page,
              ok: false,
              weak: false,
              detail: `quote found on page ${located.page}, claim says page ${claimedPage}`,
            });
          }
          return;
        }
        // Page-only locator: plausible but unverifiable without a quote.
        weak += 1;
        spanChecks.push({
          claimIndex,
          spanIndex,
          quote: null,
          claimedPage,
          foundPage: claimedPage,
          ok: true,
          weak: true,
          detail: 'page-only locator (weak: no quote to verify)',
        });
      });
    });
  }

  const structureErrors = structure.errors;
  const hashFailed = hashMatch === false;
  const verdict: 'pass' | 'fail' =
    structureErrors.length === 0 && failed === 0 && !hashFailed ? 'pass' : 'fail';

  return {
    paperId: card?.paper_id ?? 'unknown',
    documentHash: card?.document_hash ?? null,
    verdict,
    structureErrors,
    hashMatch,
    stats: {
      claims: card?.claims.length ?? 0,
      spans: spanChecks.length,
      verified,
      weak,
      failed,
    },
    spanChecks,
    checkedAt: input.now,
  };
}
