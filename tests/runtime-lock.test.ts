import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './helpers.js';

/**
 * Compatibility guard (docs/AGENTS.md §DSH 约束): the DSH developer-preview
 * commit must stay pinned. This test fails when runtime-lock.json is removed,
 * malformed or emptied, so upgrades become an explicit, reviewed change.
 */
describe('DSH runtime lock', () => {
  it('pins a concrete DSH commit with provenance', async () => {
    const raw = await readFile(join(REPO_ROOT, 'runtime-lock.json'), 'utf8');
    const lock = JSON.parse(raw) as {
      dsh: { repository: string; commit: string; gitDescribe: string; recordedAt: string };
    };
    expect(lock.dsh.repository).toContain('deepseek-harness');
    expect(lock.dsh.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(lock.dsh.gitDescribe.length).toBeGreaterThan(0);
    expect(lock.dsh.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('the pinned commit exists in the local DSH reference clone', async () => {
    const { execFileSync } = await import('node:child_process');
    const lock = JSON.parse(await readFile(join(REPO_ROOT, 'runtime-lock.json'), 'utf8')) as {
      dsh: { commit: string; localReferencePath: string };
    };
    // Local clone is optional (CI may not have it): skip softly when absent.
    const { access } = await import('node:fs/promises');
    try {
      await access(join(lock.dsh.localReferencePath, '.git'));
    } catch {
      return;
    }
    const head = execFileSync(
      'git',
      ['-C', lock.dsh.localReferencePath, 'cat-file', '-t', lock.dsh.commit],
      {
        encoding: 'utf8',
      },
    ).trim();
    expect(head).toBe('commit');
  }, 15_000);
});
