import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, makeProjectDir } from './helpers.js';
import { buildEntrySuggestions } from '../src/comparison/entry-suggest.js';
import type { RepositoryUnderstanding } from '../src/knowledge/repository.js';

/**
 * Wrapper/smoke flow (Phase 4): the Codebase Analyst's entry candidates
 * become BOUNDED smoke commands — test entries → pytest, everything else
 * an argparse `--help` probe that never trains — and only an explicit
 * `--apply` persists one. Smoke without an entry keeps the placeholder but
 * now points at the discovery command instead of silently proving nothing.
 */

function runCli(
  cwd: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli ${args.join(' ')} timed out; stderr=${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function fakeUnderstanding(
  overrides: Partial<RepositoryUnderstanding['entrypoints']> = {},
): RepositoryUnderstanding {
  return {
    understandingVersion: 1,
    parserVersion: 'ideaseek-repo-1',
    analyzedAt: 0,
    source: {
      root: '/repo',
      relPath: null,
      snapshotHash: `sha256:${'a'.repeat(64)}`,
      files: 3,
      bytes: 100,
    },
    languages: [],
    readme: { path: null, headings: [], summary: null },
    dependencies: { manifests: [], records: [], unparsedManifests: [] },
    entrypoints: {
      training: [],
      evaluation: [],
      test: [],
      other: [],
      ...overrides,
    },
    configs: [],
    dataInterfaces: [],
    metrics: [],
    evidence: [],
    confidence: 0.5,
    openQuestions: [],
    needsConfirmation: true,
  };
}

describe('buildEntrySuggestions (unit)', () => {
  it('orders test → eval → train → other with bounded wrappers', () => {
    const suggestions = buildEntrySuggestions(
      fakeUnderstanding({
        training: [entry('scripts/run_train.py', 0.9)],
        evaluation: [entry('eval.py', 0.7)],
        test: [entry('tests/test_core.py', 0.8)],
        other: [entry('demo.py', 0.6)],
      }),
    );
    expect(suggestions.map((s) => s.kind)).toEqual(['test', 'eval', 'train', 'other']);
    expect(suggestions[0]!.argv).toEqual([
      'python',
      '-m',
      'pytest',
      'tests/test_core.py',
      '-x',
      '-q',
    ]);
    expect(suggestions[2]!.argv).toEqual(['python', 'scripts/run_train.py', '--help']);
    expect(suggestions[2]!.verifies).toContain('never trains');
    expect(suggestions[0]!.verifies).toContain('no training');
  });

  it('caps the list and stays deterministic on ties', () => {
    const two = [entry('b.py', 0.5), entry('a.py', 0.5)];
    const first = buildEntrySuggestions(fakeUnderstanding({ training: two }), 1);
    const second = buildEntrySuggestions(fakeUnderstanding({ training: two }), 1);
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0]!.path).toBe('a.py'); // confidence tie → path order
    expect(buildEntrySuggestions(fakeUnderstanding())).toEqual([]);
  });
});

function entry(path: string, confidence: number) {
  return { path, kind: 'train' as const, confidence, signals: ['filename'], evidence: [] };
}

async function makeFixtureRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ideaseek-entry-fixture-'));
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: 'fixture',
        GIT_AUTHOR_EMAIL: 'fixture@test',
        GIT_COMMITTER_NAME: 'fixture',
        GIT_COMMITTER_EMAIL: 'fixture@test',
      },
      encoding: 'utf8',
    });
  git(['init']);
  await writeFile(join(dir, 'README.md'), '# fixture baseline\n', 'utf8');
  await writeFile(join(dir, 'LICENSE'), 'MIT License\n\nPermission is hereby granted.\n', 'utf8');
  await writeFile(join(dir, 'requirements.txt'), 'numpy==1.26.4\n', 'utf8');
  await writeFile(
    join(dir, 'train.py'),
    [
      'import argparse',
      '',
      'def main():',
      '    parser = argparse.ArgumentParser()',
      '    parser.add_argument("--epochs", type=int, default=3)',
      '    parser.parse_args()',
      '',
      'if __name__ == "__main__":',
      '    main()',
      '',
    ].join('\n'),
    'utf8',
  );
  await mkdir(join(dir, 'tests'), { recursive: true });
  await writeFile(join(dir, 'tests', 'test_basic.py'), 'def test_ok():\n    assert True\n', 'utf8');
  git(['add', '.']);
  git(['commit', '-m', 'fixture']);
  return dir;
}

describe('comparison suggest-entry (worktree → bounded entry → smoke)', () => {
  it('suggests, keeps the placeholder visible, applies on request and smoke follows it', async () => {
    const project = await makeProjectDir();
    expect((await runCli(project, ['init'])).code).toBe(0);
    const fixture = await makeFixtureRepo();

    const registered = await runCli(project, [
      'comparison',
      'register',
      'fedavg',
      '--repo',
      fixture,
      '--json',
    ]);
    expect(registered.code).toBe(0);
    const imported = await runCli(project, ['comparison', 'import', 'fedavg', '--json']);
    expect(imported.code).toBe(0);

    // Discovery is read-only: suggestions + explicit apply hint.
    const suggested = await runCli(project, ['comparison', 'suggest-entry', 'fedavg', '--json']);
    expect(suggested.code).toBe(0);
    const payload = JSON.parse(suggested.stdout) as {
      currentEntry: string[] | null;
      needsConfirmation: boolean;
      suggestions: { kind: string; path: string; argv: string[]; verifies: string }[];
    };
    expect(payload.currentEntry).toBeNull();
    expect(payload.needsConfirmation).toBe(true);
    const train = payload.suggestions.find((item) => item.path === 'train.py');
    expect(train).toBeDefined();
    expect(train!.kind).toBe('train');
    expect(train!.argv).toEqual(['python', 'train.py', '--help']);
    expect(train!.verifies).toContain('never trains');

    // Smoke without an entry: placeholder passes but says so and points on.
    const beforeText = await runCli(project, ['comparison', 'smoke', 'fedavg']);
    expect(beforeText.code).toBe(0);
    expect(beforeText.stdout).toContain('placeholder ran');
    expect(beforeText.stdout).toContain('ideaseek comparison suggest-entry fedavg');
    const beforeJson = await runCli(project, ['comparison', 'smoke', 'fedavg', '--json']);
    expect(JSON.parse(beforeJson.stdout)).toMatchObject({ entryConfigured: false });

    // Apply the train suggestion (explicit confirmation), then smoke runs it.
    const index = payload.suggestions.findIndex((item) => item.path === 'train.py') + 1;
    const applied = await runCli(project, [
      'comparison',
      'suggest-entry',
      'fedavg',
      '--apply',
      String(index),
      '--json',
    ]);
    expect(applied.code).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      applied: { path: 'train.py', argv: ['python', 'train.py', '--help'] },
      entryConfigured: true,
    });

    const after = await runCli(project, ['comparison', 'suggest-entry', 'fedavg', '--json']);
    expect(JSON.parse(after.stdout).currentEntry).toEqual(['python', 'train.py', '--help']);

    // The applied entry is an argparse --help probe: bounded, exit 0.
    const smoke = await runCli(project, ['comparison', 'smoke', 'fedavg', '--json']);
    expect(smoke.code).toBe(0);
    expect(JSON.parse(smoke.stdout)).toMatchObject({
      passed: true,
      entryConfigured: true,
    });

    // Bad apply indices are refused without changing anything.
    const bad = await runCli(project, ['comparison', 'suggest-entry', 'fedavg', '--apply', '99']);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain('--apply must be');
  }, 120_000);
});
