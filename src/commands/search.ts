import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { ProjectRuntime } from '../workflow/runtime.js';
import { refreshPaperIndex } from '../knowledge/search.js';
import { action, jsonLine } from './shared.js';

/**
 * `ideaseek search` — full-text search over committed parsed papers.
 * Refreshes the incremental FTS index first (skips unchanged papers), then
 * runs a sanitized MATCH query. Snippets are bounded and secret-free; the
 * index lives in the workflow DB (migration v2) and is rebuildable from
 * artifacts at any time (`--reindex`).
 */
export function registerSearchCommand(program: Command): void {
  program
    .command('search')
    .description('full-text search across parsed papers (page-level hits with snippets)')
    .argument('<query...>', 'search terms')
    .option('--limit <n>', 'maximum hits', (value) => Number(value))
    .option('--reindex', 'force a full rebuild before searching')
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
            try {
              hits = await runtime.db.searchPapers(query, {
                limit: Number.isFinite(opts.limit) ? opts.limit : 20,
              });
            } catch (error) {
              throw new IdeaseekError(
                'INVALID_ARGUMENT',
                `query is not searchable: ${(error as Error).message}`,
              );
            }

            if (opts.json) {
              process.stdout.write(jsonLine({ query, refresh, hits }));
              return 0; // no-hit searches are successful queries too
            }
            process.stdout.write(
              `search "${query}" → ${hits.length} hit(s) [indexed ${refresh.indexed}, reused ${refresh.skipped}, removed ${refresh.removed}]\n`,
            );
            for (const hit of hits) {
              process.stdout.write(`  ${hit.source}:p${hit.page}  ${hit.snippet}\n`);
            }
            if (hits.length === 0) {
              process.stdout.write(
                '  no matches (parse papers first: ideaseek run --paper <file.pdf>)\n',
              );
            }
            return 0;
          } finally {
            await runtime.close();
          }
        },
      ),
    );
}
