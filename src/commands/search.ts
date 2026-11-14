import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { ProjectRuntime } from '../workflow/runtime.js';
import { refreshPaperIndex } from '../knowledge/search.js';
import {
  EVIDENCE_DISCLAIMER,
  LocalFastEmbedProvider,
  embeddingCacheDir,
  hybridSearch,
  probeEmbeddingEnvironment,
  refreshEmbeddings,
} from '../retrieval/embeddings.js';
import { action, jsonLine } from './shared.js';

/**
 * `ideaseek search` — retrieval over committed parsed papers. BM25/FTS is
 * the base layer (incremental index refresh, sanitized MATCH); when the
 * local embedding stack is installed, a vector pass is fused in via RRF and
 * every hit states its origin (`via`). Any embedding failure degrades to
 * FTS with an explicit note — search never fails because of the optional
 * vector layer. Output always reminds that similarity is recall-only:
 * conclusions must cite the source snippet and PaperCard evidence.
 */
export function registerSearchCommand(program: Command): void {
  program
    .command('search')
    .description('hybrid (FTS-first) search across parsed papers with page-level snippets')
    .argument('<query...>', 'search terms')
    .option('--limit <n>', 'maximum hits', (value) => Number(value))
    .option('--reindex', 'force a full FTS rebuild before searching')
    .option('--no-index', 'search without refreshing the index first')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (
          queryParts: string[],
          opts: { limit?: number; reindex?: boolean; index?: boolean; json?: boolean },
        ) => {
          const runtime = await ProjectRuntime.open({ cwd: process.cwd() });
          try {
            const query = queryParts.join(' ');
            if (!query.trim()) {
              throw new IdeaseekError('INVALID_ARGUMENT', 'search query must not be empty');
            }

            const refresh =
              opts.index === false
                ? { indexed: 0, skipped: 0, removed: 0 }
                : await refreshPaperIndex(runtime.db, runtime.store, { force: opts.reindex });

            // Optional local-embedding layer: FTS ran first and always works;
            // any embedding failure degrades to FTS with an explicit note.
            let provider: LocalFastEmbedProvider | null = null;
            let embeddingStats = { embedded: 0, skipped: 0, failed: 0 };
            let embeddingNote: string | undefined;
            if (runtime.config.runtime.useEmbeddings && opts.index !== false) {
              const cacheDir = embeddingCacheDir();
              try {
                const probe = await probeEmbeddingEnvironment(
                  cacheDir,
                  runtime.config.runtime.embeddingModel,
                );
                if (probe.packageInstalled && probe.modelCached) {
                  const local = new LocalFastEmbedProvider({
                    cacheDir,
                    modelId: runtime.config.runtime.embeddingModel,
                  });
                  embeddingStats = await refreshEmbeddings(runtime, local);
                  if (embeddingStats.failed === 0) provider = local;
                  else embeddingNote = 'embedding failed for pending pages: BM25/FTS only';
                } else if (probe.packageInstalled) {
                  // Search never triggers a model download implicitly — the
                  // one-time fetch belongs to the explicit install step
                  // (a silent multi-minute download made `search` hang).
                  embeddingNote =
                    'model not cached (one-time: ideaseek setup --install-embeddings): BM25/FTS only';
                } else {
                  embeddingNote =
                    'fastembed not installed (ideaseek setup --install-embeddings): BM25/FTS only';
                }
              } catch (error) {
                provider = null;
                embeddingNote = `embedding unavailable (${(error as Error).message.slice(0, 100)}): BM25/FTS only`;
              }
            }

            let hits;
            let retrieval: Awaited<ReturnType<typeof hybridSearch>>;
            try {
              retrieval = await hybridSearch(runtime, provider, {
                query,
                limit: Number.isFinite(opts.limit) ? opts.limit : 20,
              });
              hits = retrieval.hits;
            } catch (error) {
              throw new IdeaseekError(
                'INVALID_ARGUMENT',
                `query is not searchable: ${(error as Error).message}`,
              );
            }

            const note = retrieval.note ?? embeddingNote;
            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  query,
                  refresh,
                  hits,
                  retrieval: {
                    mode: retrieval.mode,
                    fusion: retrieval.fusion,
                    embeddings: embeddingStats,
                    note,
                    disclaimer: EVIDENCE_DISCLAIMER,
                  },
                }),
              );
              return 0; // no-hit searches are successful queries too
            }

            process.stdout.write(
              `search "${query}" → ${hits.length} hit(s) [retrieval ${retrieval.mode}] [indexed ${refresh.indexed}, reused ${refresh.skipped}, removed ${refresh.removed}]\n`,
            );
            if (note) process.stdout.write(`  note: ${note}\n`);
            for (const hit of hits) {
              const via = hit.via === 'vector' ? ' [vec]' : '';
              process.stdout.write(`  ${hit.source}:p${hit.page}${via}  ${hit.snippet}\n`);
            }
            if (hits.length === 0) {
              process.stdout.write(
                '  no matches (parse papers first: ideaseek run --paper <file.pdf>)\n',
              );
            } else {
              process.stdout.write(`  ⚠ ${EVIDENCE_DISCLAIMER}\n`);
            }
            return 0;
          } finally {
            await runtime.close();
          }
        },
      ),
    );
}
