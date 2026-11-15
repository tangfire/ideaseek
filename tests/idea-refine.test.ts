import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectEnvironmentBlock } from '../src/idea/env-block.js';
import { clearGeneratedIdeaFiles, GENERATED_MANIFEST } from '../src/idea/implement-clean.js';
import type { IdeaCheckReport } from '../src/idea/check.js';

function reportWith(phases: IdeaCheckReport['phases']): IdeaCheckReport {
  return {
    ideaId: 'x',
    version: 1,
    codeHash: null,
    startedAt: 0,
    finishedAt: 0,
    outcome: 'failed',
    phases,
  };
}

const failed = (phase: string, kind: string, summary: string) =>
  ({
    phase,
    ok: false,
    skipped: false,
    exitCode: 1,
    durationMs: 1,
    command: ['python', `src/${phase}.py`],
    failureKind: kind,
    summary,
  }) as IdeaCheckReport['phases'][number];

describe('detectEnvironmentBlock (ARIS preparation stop, compute-env-contract §5)', () => {
  it('stops before the code loop on access, network and driver blockers', () => {
    for (const summary of [
      'HTTP 429 Too Many Requests from provider',
      'NETWORK_BLOCKED: no route to hf-mirror.com',
      'CUDA error: no CUDA GPUs are available',
      'docker: command not found',
    ]) {
      const found = detectEnvironmentBlock(reportWith([failed('smoke', 'unknown', summary)]));
      expect(found ?? `NO MATCH: ${summary}`).toContain('environment/preparation blocker');
      expect(found ?? '').toContain('rewriting the program cannot fix');
    }
  });

  it('does not call a code fault an environment fault', () => {
    expect(
      detectEnvironmentBlock(
        reportWith([failed('smoke', 'syntax-error', 'line 12: unexpected indent')]),
      ),
    ).toBeNull();
    expect(
      detectEnvironmentBlock(
        reportWith([failed('smoke', 'unknown', 'smoke produced no metrics JSON line')]),
      ),
    ).toBeNull();
  });

  it('ignores phases that passed or were skipped', () => {
    const passed = { ...failed('smoke', 'unknown', 'docker not found'), ok: true };
    expect(detectEnvironmentBlock(reportWith([passed]))).toBeNull();
  });
});

describe('clearGeneratedIdeaFiles (only the generator owns files)', () => {
  it('removes listed files and nothing else', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'idea-clean-'));
    await mkdir(join(dir, 'src'), { recursive: true });
    for (const name of ['smoke.py', 'geometry.py', 'human.py']) {
      await writeFile(join(dir, 'src', name), '# code\n', 'utf8');
    }
    await writeFile(
      join(dir, GENERATED_MANIFEST),
      JSON.stringify({ schemaVersion: 1, files: ['src/smoke.py', 'src/geometry.py'] }),
      'utf8',
    );
    const removed = await clearGeneratedIdeaFiles(dir);
    expect(removed.sort()).toEqual(['src/geometry.py', 'src/smoke.py']);
    expect(await readFile(join(dir, 'src', 'human.py'), 'utf8')).toBe('# code\n');
    expect(await readFile(join(dir, GENERATED_MANIFEST), 'utf8').catch(() => null)).toBeNull();
  });

  it('refuses to act on a manifest that names anything outside src/', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'idea-clean-evil-'));
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'research.yaml'), 'project:\n  name: keep\n', 'utf8');
    await writeFile(
      join(dir, GENERATED_MANIFEST),
      JSON.stringify({ files: ['../research.yaml', '/etc/passwd', 'src/ok.py'] }),
      'utf8',
    );
    await writeFile(join(dir, 'src', 'ok.py'), 'x = 1\n', 'utf8');
    const removed = await clearGeneratedIdeaFiles(dir);
    expect(removed).toEqual(['src/ok.py']);
    expect(await readFile(join(dir, 'research.yaml'), 'utf8')).toContain('keep');
  });

  it('is a no-op without a manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'idea-clean-none-'));
    expect(await clearGeneratedIdeaFiles(dir)).toEqual([]);
  });
});
