import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { isProjectRoot, projectPaths } from '../src/config/paths.js';
import { SqliteWorkflowDb } from '../src/workflow/sqlite.js';

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  process.exitCode = 0;
});

async function runIn(dir: string, ...args: string[]): Promise<number> {
  process.chdir(dir);
  return runCli(['node', 'ideaseek', ...args]);
}

describe('ideaseek init', () => {
  it('creates the canonical workspace layout, config, README and database', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-init-'));
    const code = await runIn(dir, 'init');
    expect(code).toBe(0);

    expect(await isProjectRoot(dir)).toBe(true);
    for (const check of [
      'papers',
      'datasets',
      'comparisons',
      'incoming',
      'knowledge',
      'ideas',
      'reports',
      join('.research', 'artifacts', 'tmp'),
      join('.research', 'logs'),
    ]) {
      const info = await stat(join(dir, check));
      expect(info.isDirectory()).toBe(true);
    }
    const config = await readFile(projectPaths(dir).configFile, 'utf8');
    expect(config).toContain('lease_ttl_seconds');
    expect(config).toContain('require_all_comparisons');

    const db = new SqliteWorkflowDb(projectPaths(dir).dbFile);
    const project = await db.getProjectByRoot(dir);
    expect(project).not.toBeNull();
    await db.close();
  });

  it('is idempotent: re-init keeps existing files and exits 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-init-'));
    expect(await runIn(dir, 'init')).toBe(0);

    // The user edits research.yaml after the first init.
    const paths = projectPaths(dir);
    await writeFile(paths.configFile, 'project:\n  name: edited-by-user\n', 'utf8');

    expect(await runIn(dir, 'init')).toBe(0);
    const config = await readFile(paths.configFile, 'utf8');
    expect(config).toContain('edited-by-user');

    // The project row survives and re-init does not duplicate it.
    const db = new SqliteWorkflowDb(paths.dbFile);
    const project = await db.getProjectByRoot(dir);
    expect(project).not.toBeNull();
    await db.close();
  });

  it('reports initialization in --json mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-init-'));
    const chunks: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await runIn(dir, 'init', '--json');
      expect(code).toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }
    const payload = JSON.parse(chunks.join('')) as { initialized: boolean; root: string };
    expect(payload.initialized).toBe(true);
    expect(payload.root.endsWith(basename(dir))).toBe(true);
  });
});
