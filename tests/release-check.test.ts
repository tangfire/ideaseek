import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './helpers.js';

/**
 * Phase 8 release hygiene gate: regression-suite presence, dependency
 * license allowlist and a tracked-file secret scan (scripts/release-check.mjs).
 */

interface CheckResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCheck(args: string[], cwd = REPO_ROOT): Promise<CheckResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(REPO_ROOT, 'scripts', 'release-check.mjs'), ...args],
      {
        cwd,
        env: { ...process.env },
      },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('release-check timed out'));
    }, 60_000);
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function fixtureProject(secret: string | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ideaseek-relcheck-'));
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.0.0', scripts: { test: 'vitest run' } }),
    'utf8',
  );
  await writeFile(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');
  await mkdir(join(dir, 'tests'), { recursive: true });
  await writeFile(join(dir, 'tests', 'fixture.test.ts'), 'export {};\n', 'utf8');
  await mkdir(join(dir, 'worker', 'python', 'tests'), { recursive: true });
  await writeFile(join(dir, 'worker', 'python', 'tests', 'test_fixture.py'), 'pass\n', 'utf8');
  if (secret) await writeFile(join(dir, 'notes.txt'), `${secret}\n`, 'utf8');
  return dir;
}

describe('scripts/release-check (release hygiene gate)', () => {
  it('passes on this repository with an allowlisted dependency set', async () => {
    const result = await runCheck(['--json']);
    expect(result.code, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      secrets: number;
      regression: { vitestFiles: number; pythonFiles: number; lockfile: boolean };
      dependencies: { direct: number; licenses: Record<string, string> };
    };
    expect(report.ok).toBe(true);
    expect(report.secrets).toBe(0);
    expect(report.regression.vitestFiles).toBeGreaterThan(50);
    expect(report.regression.pythonFiles).toBeGreaterThanOrEqual(1);
    expect(report.regression.lockfile).toBe(true);
    expect(report.dependencies.direct).toBeGreaterThan(10);
    expect(report.dependencies.licenses['commander']).toBe('MIT');
  }, 60_000);

  it('flags a key-shaped secret in a scanned file (exit 1)', async () => {
    // Assembled at runtime so this test file itself never contains a
    // contiguous key-shaped literal (the scanner must stay strict).
    const fakeKey = `sk-${'a1b2c3d4'.repeat(5)}`;
    const dir = await fixtureProject(`api_token = "${fakeKey}"`);
    const result = await runCheck(['--skip-git', '--root', dir, '--json']);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      secrets: number;
      problems: { kind: string; text: string }[];
    };
    expect(report.ok).toBe(false);
    expect(report.secrets).toBe(1);
    const secretProblem = report.problems.find((problem) => problem.kind === 'secret');
    expect(secretProblem?.text).toContain('notes.txt');
    expect(secretProblem?.text).toContain('openai/deepseek-style-key');
  }, 60_000);

  it('passes a clean fixture project', async () => {
    const dir = await fixtureProject(null);
    const result = await runCheck(['--skip-git', '--root', dir]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('OK');
  }, 60_000);
});
