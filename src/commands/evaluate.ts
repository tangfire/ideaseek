import type { Command } from 'commander';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { writeFileAtomic } from '../core/atomic.js';
import { ProjectRuntime } from '../workflow/runtime.js';
import {
  aggregateEvaluations,
  evaluateSource,
  sampleSources,
  type SourceArtifacts,
} from '../evaluation/papers.js';
import { action, jsonLine } from './shared.js';

async function loadBySource(
  runtime: ProjectRuntime,
  kind: 'parsed-paper' | 'papercard',
): Promise<Map<string, unknown>> {
  const bySource = new Map<string, unknown>();
  for (const artifact of await runtime.db.listArtifactsByKind(kind)) {
    try {
      const payload = JSON.parse(await runtime.store.readFinalText(artifact.contentHash)) as
        | { source?: string }
        | { source?: { sourcePath?: string } };
      const source =
        kind === 'parsed-paper'
          ? (payload as { source?: string }).source
          : ((payload as { source?: { sourcePath?: string } }).source?.sourcePath ?? null);
      if (source) bySource.set(source, payload);
    } catch {
      continue;
    }
  }
  return bySource;
}

/**
 * `ideaseek evaluate` — literature-quality regression over a deterministic
 * sample of the scanned corpus (docs/EVALUATION.md). Measure-only: it reads
 * committed artifacts and reports coverage honestly; missing pipeline output
 * is a first-class metric (and prints the command that produces it).
 */
export function registerEvaluateCommand(program: Command): void {
  program
    .command('evaluate')
    .description('measure literature-quality metrics over a sampled gold set')
    .option('--sample <n>', 'papers to sample (default 5)', (value) => Number(value))
    .option('--seed <n>', 'sampling seed for reproducible gold sets', (value) => Number(value))
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { sample?: number; seed?: number; json?: boolean }) => {
        const runtime = await ProjectRuntime.open({ cwd: process.cwd() });
        try {
          const { readManifest } = await import('../knowledge/organize.js');
          const manifest = await readManifest(
            join(runtime.paths.knowledgeDir, 'input-manifest.json'),
          );
          const corpus = (manifest?.files ?? [])
            .filter((file) => file.role === 'paper' && file.ext === '.pdf')
            .map((file) => file.relPath);
          if (corpus.length === 0) {
            throw new IdeaseekError(
              'USER_INPUT_REQUIRED',
              'no scanned papers in the manifest; run: ideaseek scan',
            );
          }

          const seed = Number.isFinite(opts.seed) ? (opts.seed as number) : 42;
          const size = Number.isFinite(opts.sample) ? (opts.sample as number) : 5;
          const sample = sampleSources(corpus, size, seed);

          const parsed = await loadBySource(runtime, 'parsed-paper');
          const cards = await loadBySource(runtime, 'papercard');
          const reports = new Map<string, SourceArtifacts['report']>();
          for (const artifact of await runtime.db.listArtifactsByKind('evidence-report')) {
            if (!artifact.taskId) continue;
            const task = await runtime.db.getTask(artifact.taskId);
            const source = task?.payload.sourcePath;
            if (typeof source !== 'string' || !source) continue;
            try {
              const payload = JSON.parse(
                await runtime.store.readFinalText(artifact.contentHash),
              ) as SourceArtifacts['report'];
              reports.set(source, payload);
            } catch {
              continue;
            }
          }

          const sampled = sample.map((source) =>
            evaluateSource({
              source,
              parsed: (parsed.get(source) as { pageCount: number } | undefined) ?? null,
              card: (cards.get(source) as { card: Record<string, unknown> } | undefined) ?? null,
              report: reports.get(source) ?? null,
            }),
          );
          const evaluation = aggregateEvaluations(sampled, Date.now(), seed);

          const reportPath = join(runtime.paths.knowledgeDir, 'goldset-report.json');
          await writeFileAtomic(reportPath, `${JSON.stringify(evaluation, null, 2)}\n`);

          if (opts.json) {
            process.stdout.write(jsonLine({ reportPath, ...evaluation }));
            return 0;
          }
          const a = evaluation.aggregates;
          const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
          process.stdout.write(
            `evaluate: sample ${evaluation.sampled}/${corpus.length} (seed ${seed}) → ${reportPath}\n`,
          );
          process.stdout.write(
            `  coverage ${pct(a.coverage)} · card-valid ${pct(a.cardValidRate)} · evidence-support ${pct(a.evidenceSupportRate)} · page-accuracy ${pct(a.pageLocatingAccuracy)} · hash-binding ${pct(a.hashBindingRate)} · verdict-pass ${pct(a.verdictPassRate)} · avg-claims ${a.avgClaims.toFixed(1)}\n`,
          );
          if (evaluation.missing.length > 0) {
            process.stdout.write(
              `  missing pipeline output for ${evaluation.missing.length} paper(s); run: ideaseek ingest && ideaseek extract\n`,
            );
          }
          for (const item of evaluation.sampled) {
            process.stdout.write(
              `  ${item.processed ? '✓' : '·'} ${item.source}  ${item.processed ? `claims=${item.claims} verified=${item.verifiedQuotes}/${item.quotes} verdict=${item.verdict}` : 'not processed'}\n`,
            );
          }
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );
}
