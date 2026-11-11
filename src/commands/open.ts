import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { action, jsonLine } from './shared.js';

/**
 * `ideaseek open [name]` — read-only document browser for knowledge/ and
 * reports/: no argument lists available documents; a name fuzzy-matches one
 * document and prints its path plus the first lines. Never writes.
 */

interface DocEntry {
  relPath: string;
  absolutePath: string;
  bytes: number;
}

async function listDocuments(root: string): Promise<DocEntry[]> {
  const { readdir, stat } = await import('node:fs/promises');
  const { join: joinPath } = await import('node:path');
  const entries: DocEntry[] = [];
  for (const dir of ['knowledge', 'reports']) {
    const base = joinPath(root, dir);
    let names: string[];
    try {
      names = await readdir(base);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!/\.(md|json|txt|csv)$/i.test(name)) continue;
      const absolutePath = joinPath(base, name);
      const info = await stat(absolutePath).catch(() => null);
      if (!info?.isFile()) continue;
      entries.push({ relPath: `${dir}/${name}`, absolutePath, bytes: info.size });
    }
  }
  return entries;
}

export function registerOpenCommand(program: Command): void {
  program
    .command('open')
    .description('list or open knowledge/report documents (read-only)')
    .argument('[name]', 'fuzzy document name, e.g. research-map or dataset-card')
    .option('--lines <n>', 'lines to show when opening', (value) => Number(value), 40)
    .option('--json', 'machine-readable output')
    .action(
      action(async (name: string | undefined, opts: { lines: number; json?: boolean }) => {
        const root = await findRoot();
        const docs = await listDocuments(root);

        if (!name) {
          if (opts.json) {
            process.stdout.write(jsonLine({ documents: docs.map((d) => d.relPath) }));
            return 0;
          }
          if (docs.length === 0) {
            process.stdout.write('no documents yet (knowledge/ and reports/ are empty)\n');
            return 0;
          }
          process.stdout.write(`${docs.length} document(s):\n`);
          for (const doc of docs) {
            process.stdout.write(`  ${doc.relPath}  (${doc.bytes} bytes)\n`);
          }
          process.stdout.write('next: ideaseek open <name>\n');
          return 0;
        }

        const needle = name.toLowerCase().replace(/\.(md|json|txt|csv)$/i, '');
        const matches = docs.filter((doc) => doc.relPath.toLowerCase().includes(needle));
        if (matches.length === 0) {
          throw new IdeaseekError(
            'FILE_NOT_FOUND',
            `no document matches "${name}" — run ideaseek open to list available documents`,
          );
        }
        if (matches.length > 1) {
          if (opts.json) {
            process.stdout.write(
              jsonLine({ ambiguous: true, matches: matches.map((m) => m.relPath) }),
            );
            return 2;
          }
          process.stdout.write(`ambiguous: "${name}" matches ${matches.length} documents:\n`);
          for (const doc of matches) process.stdout.write(`  ${doc.relPath}\n`);
          return 2;
        }

        const doc = matches[0]!;
        const { readFile } = await import('node:fs/promises');
        const content = await readFile(doc.absolutePath, 'utf8');
        const head = content.split(/\r?\n/).slice(0, Math.max(1, opts.lines));
        if (opts.json) {
          process.stdout.write(
            jsonLine({ path: doc.relPath, bytes: doc.bytes, head: head.join('\n') }),
          );
          return 0;
        }
        process.stdout.write(`${doc.relPath} (${doc.bytes} bytes)\n`);
        for (const line of head) process.stdout.write(`${line}\n`);
        if (content.split(/\r?\n/).length > head.length) {
          process.stdout.write(`… (${content.split(/\r?\n/).length - head.length} more lines)\n`);
        }
        return 0;
      }),
    );
}

async function findRoot(): Promise<string> {
  const { findProjectRoot } = await import('../config/paths.js');
  const root = await findProjectRoot(process.cwd());
  if (!root) {
    throw new IdeaseekError('NOT_INITIALIZED', 'no IdeaSeek project here; run: ideaseek init');
  }
  return root;
}
