import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { assertAgainstSchema } from '../core/schema/index.js';
import { action, jsonLine } from './shared.js';

/**
 * `ideaseek wiki` — build the research wiki (Phase 4.5B, ARIS
 * research-wiki): deterministic extraction of papers/ideas/experiments/
 * claims into typed edges with evidence, materialized in the ARIS wiki
 * layout; the vendored helper produces index/query_pack and reports stats.
 */
export function registerWikiCommand(program: Command): void {
  program
    .command('wiki')
    .description(
      'build the research wiki graph (papers/ideas/experiments/claims, typed edges with evidence)',
    )
    .option('--no-helper', 'skip ARIS helper materialization (pages and edges only)')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { helper?: boolean; json?: boolean }) => {
        const { findProjectRoot } = await import('../config/paths.js');
        const root = await findProjectRoot(process.cwd());
        if (!root) {
          throw new IdeaseekError(
            'NOT_INITIALIZED',
            'no IdeaSeek project here; run: ideaseek init',
          );
        }
        const { buildResearchWiki, WIKI_SCHEMA } = await import('../knowledge/wiki.js');
        const result = await buildResearchWiki(root, { helper: opts.helper !== false });

        if (opts.json) {
          const payload = {
            schema: WIKI_SCHEMA,
            root: result.root,
            nodes: result.nodes,
            edges: result.edges,
            pages: result.pages.length,
            helper: result.helper,
            stats: result.stats,
          };
          // This command is the writer of the TAGGED payload, and the writer
          // whose `pages` is a COUNT (src/knowledge/wiki.ts emits the relPath
          // list — the contract admits both shapes on purpose), so this is the
          // only place the count shape gets gated. Checked before the byte
          // reaches stdout: a --json consumer must never receive a
          // contract-tagged report the schema rejects. The pages and edges are
          // already materialized and idempotent, so a failure here reports a
          // platform bug instead of discarding user work.
          assertAgainstSchema(WIKI_SCHEMA, payload);
          process.stdout.write(jsonLine(payload));
          return 0;
        }

        process.stdout.write(
          `research wiki: ${result.nodes} node(s), ${result.edges} edge(s) → ${result.root}\n`,
        );
        process.stdout.write(
          `  materialized ${result.pages.length} file(s) (pages + edges.jsonl)\n`,
        );
        process.stdout.write(`  helper: ${result.helper}\n`);
        for (const line of result.stats) process.stdout.write(`  ${line}\n`);
        process.stdout.write(
          'next: knowledge/research-wiki/index.md · query_pack.md feeds ideate (when helper ran)\n',
        );
        return 0;
      }),
    );
}
