import type { WorkflowDb } from '../workflow/db.js';
import type { ArtifactStore } from '../artifact/store.js';

export interface RefreshResult {
  indexed: number;
  skipped: number;
  removed: number;
}

interface ParsedPaperPayload {
  source: string;
  sourceHash: string;
  pageCount: number;
  pages: { page: number; text: string }[];
  parser: string;
}

/**
 * Incremental full-text index maintenance (docs/IMPLEMENTATION_ROADMAP.md
 * Phase 2): reads committed `parsed-paper` artifacts, indexes each paper by
 * its content hash, skips unchanged (hash, parser, pageCount) entries and
 * removes index rows whose source no longer has a committed artifact.
 * Safe to call before every search — it never re-parses files.
 */
export async function refreshPaperIndex(
  db: WorkflowDb,
  store: ArtifactStore,
  opts: { force?: boolean; now?: number } = {},
): Promise<RefreshResult> {
  const now = opts.now ?? Date.now();
  const artifacts = await db.listArtifactsByKind('parsed-paper');
  const existing = await db.listIndexedPapers();
  const existingByKey = new Map(existing.map((meta) => [meta.paperKey, meta]));
  const seenKeys = new Set<string>();
  const seenSources = new Set<string>();

  let indexed = 0;
  let skipped = 0;

  for (const artifact of artifacts) {
    let payload: ParsedPaperPayload;
    try {
      payload = JSON.parse(await store.readFinalText(artifact.contentHash)) as ParsedPaperPayload;
    } catch {
      continue; // unreadable artifact: keep previous index generation
    }
    if (!payload.sourceHash || !Array.isArray(payload.pages)) continue;
    seenKeys.add(payload.sourceHash);
    seenSources.add(payload.source);

    const meta = existingByKey.get(payload.sourceHash);
    if (
      !opts.force &&
      meta &&
      meta.parser === payload.parser &&
      meta.pageCount === payload.pageCount &&
      meta.source === payload.source
    ) {
      skipped += 1;
      continue;
    }
    await db.reindexPaper({
      paperKey: payload.sourceHash,
      source: payload.source,
      parser: payload.parser,
      pageCount: payload.pageCount,
      pages: payload.pages,
      indexedAt: now,
    });
    indexed += 1;
  }

  let removed = 0;
  for (const meta of existing) {
    if (seenKeys.has(meta.paperKey) && seenSources.has(meta.source)) continue;
    // Content changed (new hash for same source) or artifact disappeared.
    const sourceStillIndexed = seenSources.has(meta.source);
    if (!sourceStillIndexed || !seenKeys.has(meta.paperKey)) {
      const gone = await db.removePaperIndex(meta.paperKey);
      if (gone) removed += 1;
    }
  }

  return { indexed, skipped, removed };
}
