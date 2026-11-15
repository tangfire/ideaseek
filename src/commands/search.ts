import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { ProjectRuntime } from '../workflow/runtime.js';
import { refreshPaperIndex } from '../knowledge/search.js';
import { EVIDENCE_DISCLAIMER, hybridSearch } from '../retrieval/search.js';
import { action, jsonLine } from './shared.js';

/**
 * `ideaseek search` — retrieval over committed parsed papers: BM25/FTS5
 * only (incremental index refresh, sanitized MATCH). The embedding layer
 * was removed by product decision; agent-style grep/read over the parsed
 * corpus covers semantic lookup. Output always reminds that search is
 * recall-only: conclusions must cite the source snippet and PaperCard
 * evidence.
 */
export function registerSearchCommand(program: Command): void {
  program
    .command('search')
    .description('full-text (FTS5/BM25) search across parsed papers with page-level snippets')
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

            let hits;
            let retrieval: Awaited<ReturnType<typeof hybridSearch>>;
            try {
              retrieval = await hybridSearch(runtime, {
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

            const note = retrieval.note;
            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  query,
                  refresh,
                  hits,
                  retrieval: {
                    mode: retrieval.mode,
                    fusion: retrieval.fusion,
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
              const via = '';
              process.stdout.write(`  ${hit.source}:p${hit.page}${via}  ${hit.snippet}\n`);
            }
            if (hits.length === 0) {
              process.stdout.write(
                '  no matches (parse the papers first: ideaseek ingest, then ideaseek search)\n',
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
