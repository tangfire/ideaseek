import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Dependency-direction guards (docs/ARCHITECTURE.md + ADR-001..006).
 * These are static checks over import statements: they fail the build when a
 * module reaches across a layer boundary instead of going through a port.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

async function collectTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'dsh-plugins') continue; // DSH plugins legitimately import the SDK
      out.push(...(await collectTsFiles(full)));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  const re = /(?:from\s+|import\s*\(\s*|require\(\s*)['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    specifiers.push(match[1]!);
  }
  return specifiers;
}

async function violations(
  files: string[],
  predicate: (file: string, specifier: string) => boolean,
): Promise<string[]> {
  const out: string[] = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const specifier of importsOf(source)) {
      if (predicate(file, specifier)) {
        out.push(`${relative(ROOT, file)} → ${specifier}`);
      }
    }
  }
  return out;
}

describe('architecture: dependency direction (ADR-001..006)', () => {
  it('only the SQLite adapter imports node:sqlite (ports/adapters)', async () => {
    const files = await collectTsFiles(SRC);
    const bad = await violations(files, (file, spec) => {
      if (spec !== 'node:sqlite') return false;
      const rel = relative(ROOT, file).replace(/\\/g, '/');
      return rel !== 'src/workflow/sqlite.ts';
    });
    expect(bad).toEqual([]);
  });

  it('only the DSH adapter layer imports the DSH SDK (ADR-001)', async () => {
    const files = await collectTsFiles(SRC);
    const bad = await violations(files, (file, spec) => {
      if (!spec.startsWith('@deepseek-ai/')) return false;
      const rel = relative(ROOT, file).replace(/\\/g, '/');
      return !rel.startsWith('src/dsh/');
    });
    expect(bad).toEqual([]);
  });

  it('domain modules never depend on Commander, DSH SDK or the command layer', async () => {
    const domainFiles = [
      'src/idea/card.ts',
      'src/idea/analysis.ts',
      'src/comparison/types.ts',
      'src/comparison/gate.ts',
      'src/experiment/spec.ts',
      'src/experiment/protocol.ts',
      'src/experiment/leakage.ts',
      'src/workflow/types.ts',
      'src/workflow/autonomy.ts',
    ].map((rel) => join(ROOT, rel));
    const bad = await violations(domainFiles, (_file, spec) => {
      return (
        spec === 'commander' ||
        spec.startsWith('@deepseek-ai/') ||
        spec.includes('/commands/') ||
        spec === 'node:sqlite'
      );
    });
    expect(bad).toEqual([]);
  });

  it('CLI commands never talk to SQLite or the DSH SDK directly (go through ports)', async () => {
    const commandFiles = (await collectTsFiles(join(SRC, 'commands'))).concat(
      await collectTsFiles(join(SRC, 'cli')),
    );
    const bad = await violations(commandFiles, (_file, spec) => {
      return spec === 'node:sqlite' || spec.startsWith('@deepseek-ai/');
    });
    expect(bad).toEqual([]);
  });

  it('the REPL shares use-cases by relaying the CLI instead of touching the DB (ADR-006)', async () => {
    const repl = await readFile(join(SRC, 'cli', 'repl.ts'), 'utf8');
    const specifiers = importsOf(repl);
    expect(specifiers).not.toContain('node:sqlite');
    expect(specifiers.some((s) => s.includes('workflow/db'))).toBe(false);
    expect(specifiers.some((s) => s.includes('workflow/runtime'))).toBe(false);
    // Slash commands dispatch through the runner (same code path as CLI).
    expect(specifiers.some((s) => s === './runner.js' || s.includes('cli/runner'))).toBe(true);
  });

  it('workflow state machine lives outside presentation (types module has no CLI deps)', async () => {
    const types = await readFile(join(SRC, 'workflow', 'types.ts'), 'utf8');
    expect(importsOf(types)).not.toContain('commander');
    const comparisonTypes = await readFile(join(SRC, 'comparison', 'types.ts'), 'utf8');
    expect(importsOf(comparisonTypes)).not.toContain('commander');
  });
});
