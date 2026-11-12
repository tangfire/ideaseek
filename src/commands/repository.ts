import type { Command } from 'commander';
import { resolve } from 'node:path';
import { findProjectRoot } from '../config/paths.js';
import { analyzeRepository, type RepositoryUnderstanding } from '../knowledge/repository.js';
import { action, jsonLine } from './shared.js';

/**
 * `ideaseek repo [path]` — the Codebase Analyst's product surface
 * (docs/DATA_CONTRACTS.md RepositoryUnderstanding): structure-agnostic,
 * read-only analysis of ANY directory. Entry points are candidates with
 * confidence and evidence, never commands — needsConfirmation is always
 * true, so nothing downstream may run them without an explicit confirm.
 */

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function renderSummary(u: RepositoryUnderstanding): string[] {
  const lines: string[] = [];
  lines.push(
    `repo: ${u.source.root}  ${u.source.files} files · ${formatBytes(u.source.bytes)} · snapshot ${u.source.snapshotHash.slice(0, 19)}…`,
  );
  lines.push(
    `languages: ${
      u.languages.length > 0
        ? u.languages
            .slice(0, 6)
            .map((lang) => `${lang.language} ${lang.files} files ${formatBytes(lang.bytes)}`)
            .join(' · ')
        : '(no recognized source files)'
    }`,
  );
  lines.push(
    u.readme.path
      ? `readme: ${u.readme.path}${u.readme.summary ? ` — ${u.readme.summary}` : ''}`
      : 'readme: missing',
  );
  const manifests = u.dependencies.manifests;
  lines.push(
    `dependencies: ${
      manifests.length > 0
        ? `${manifests.join(', ')} → ${u.dependencies.records.length} record(s)${
            u.dependencies.unparsedManifests.length > 0
              ? ` (+${u.dependencies.unparsedManifests.length} unparsed)`
              : ''
          }`
        : 'none found'
    }`,
  );

  const entryGroups: [string, typeof u.entrypoints.training][] = [
    ['train', u.entrypoints.training],
    ['eval', u.entrypoints.evaluation],
    ['test', u.entrypoints.test],
    ['other', u.entrypoints.other],
  ];
  const hasEntries = entryGroups.some(([, entries]) => entries.length > 0);
  lines.push('entrypoints (candidates — confirm before any run):');
  if (!hasEntries) {
    lines.push('  (none discovered)');
  }
  for (const [label, entries] of entryGroups) {
    for (const entry of entries.slice(0, 3)) {
      lines.push(
        `  ${label.padEnd(5)} ${entry.path}  conf=${entry.confidence.toFixed(2)}  [${entry.signals.join(', ')}]`,
      );
    }
  }
  if (u.configs.length > 0) lines.push(`configs: ${u.configs.slice(0, 8).join(', ')}`);
  if (u.dataInterfaces.length > 0) {
    lines.push(
      `data: ${u.dataInterfaces
        .slice(0, 5)
        .map(
          (candidate) =>
            `${candidate.path} (${candidate.kind}, conf=${candidate.confidence.toFixed(2)})`,
        )
        .join(' · ')}`,
    );
  }
  if (u.metrics.length > 0) {
    lines.push(
      `metrics: ${u.metrics
        .slice(0, 5)
        .map((candidate) => `${candidate.path}: ${candidate.names.join('/') || '(unnamed)'}`)
        .join(' · ')}`,
    );
  }
  lines.push(
    `confidence: ${u.confidence.toFixed(2)} · needsConfirmation: ${u.needsConfirmation ? 'yes' : 'no'} (entries must be confirmed before any automatic run)`,
  );
  if (u.openQuestions.length > 0) {
    lines.push('open questions:');
    for (const question of u.openQuestions.slice(0, 10)) lines.push(`  - ${question}`);
  }
  lines.push(
    'next: review entrypoints, then wire them explicitly (comparison import / smoke) — nothing runs from this analysis alone',
  );
  return lines;
}

export function registerRepositoryCommand(program: Command): void {
  program
    .command('repo')
    .description(
      'analyze a code repository read-only: languages, deps, entry candidates, data/metrics',
    )
    .argument('[path]', 'directory to analyze (default: current directory)', '.')
    .option('--json', 'machine-readable output')
    .action(
      action(async (path: string, opts: { json?: boolean }) => {
        const target = resolve(process.cwd(), path);
        const projectRoot = await findProjectRoot(process.cwd()).catch(() => null);
        const understanding = await analyzeRepository(target, projectRoot ? { projectRoot } : {});
        if (opts.json) {
          process.stdout.write(jsonLine(understanding));
          return 0;
        }
        for (const line of renderSummary(understanding)) {
          process.stdout.write(`${line}\n`);
        }
        return 0;
      }),
    );
}
