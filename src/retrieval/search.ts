import type { ProjectRuntime } from '../workflow/runtime.js';
import type { PaperSearchHit } from '../workflow/db.js';

/**
 * FTS-only retrieval over committed parsed papers (BM25 via SQLite FTS5).
 *
 * The optional local-embedding layer was REMOVED (product decision:
 * Claude-Code-style agentic grep/read plus FTS covers IdeaSeek's
 * corpus — tens of parsed papers with structured PaperCards — while the
 * embedding supply chain (fastembed/ONNX/venv/model downloads) cost more
 * than it returned and never worked reliably on target machines).
 * `ideaseek search` therefore always runs pure FTS and says so.
 */

export const EVIDENCE_DISCLAIMER =
  'search only re-ranks recall — always verify claims against the returned source snippet and PaperCard evidence';

export interface HybridSearchOptions {
  query: string;
  limit?: number;
}

export interface HybridSearchResult {
  mode: 'fts';
  hits: (PaperSearchHit & { via: 'fts' })[];
  fusion: { ftsHits: number; vectorHits: 0 };
  note: string;
}

/** BM25/FTS search — the single retrieval path. */
export async function hybridSearch(
  runtime: ProjectRuntime,
  opts: HybridSearchOptions,
): Promise<HybridSearchResult> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const ftsHits = await runtime.db.searchPapers(opts.query, { limit: limit * 2 });
  return {
    mode: 'fts',
    hits: ftsHits.map((hit) => ({ ...hit, via: 'fts' as const })),
    fusion: { ftsHits: ftsHits.length, vectorHits: 0 },
    note: 'FTS5/BM25 only (the embedding layer was removed — agent grep/read covers semantic lookup)',
  };
}
