import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN } from './helpers.js';

/**
 * `ideaseek repo` — Codebase Analyst product surface: read-only analysis
 * of an arbitrary directory, candidates with confidence + evidence, and an
 * honest needsConfirmation gate. Nothing in this command writes into the
 * analyzed repository.
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

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(root, ...relPath.split('/'));
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
}

async function listTree(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else
        out.push(
          abs
            .slice(root.length + 1)
            .split(/[\\/]/)
            .join('/'),
        );
    }
  }
  await walk(root);
  return out.sort();
}

const ARBITRARY_REPO: Record<string, string> = {
  'README.md': [
    '# ML Pipeline',
    '',
    'Trains and evaluates a baseline; api_key: sk-abcdefghijklmno123456 is required.',
    '',
    'Run pipeline/run_experiment.py.',
    '',
  ].join('\n'),
  'requirements.txt': 'numpy==1.26.4\nscikit-learn==1.5.0\n',
  'pipeline/run_experiment.py': [
    'import argparse',
    '',
    'def train_one_epoch(optimizer):',
    '    loss = 0',
    '    optimizer.step()',
    '    return loss',
    '',
    'def main():',
    '    parser = argparse.ArgumentParser()',
    '    parser.add_argument("--epochs", type=int, default=3)',
    '    args = parser.parse_args()',
    '    train_one_epoch(None)',
    '',
    'if __name__ == "__main__":',
    '    main()',
    '',
  ].join('\n'),
  'pipeline/evaluate.py': [
    'from sklearn.metrics import accuracy_score',
    '',
    'def evaluate(model):',
    '    return accuracy_score([0], [0])',
    '',
  ].join('\n'),
  'tests/test_pipeline.py': 'def test_ok():\n    assert True\n',
  'config.yaml': 'epochs: 3\nbatch_size: 32\n',
};

describe('ideaseek repo (Codebase Analyst CLI)', () => {
  it('analyzes an arbitrary directory read-only and gates on confirmation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-repo-cli-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    const repoRoot = join(dir, 'target-repo');
    await writeFiles(repoRoot, ARBITRARY_REPO);
    const before = await listTree(repoRoot);

    const text = await runCli(dir, ['repo', 'target-repo']);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('repo: ');
    expect(text.stdout).toContain('entrypoints (candidates — confirm before any run):');
    expect(text.stdout).toContain('train');
    expect(text.stdout).toContain('needsConfirmation: yes');
    expect(text.stdout).toContain('nothing runs from this analysis alone');
    // Secret redaction: the planted key never reaches the terminal.
    expect(text.stdout).not.toContain('sk-abcdefghijklmno123456');
    expect(text.stderr).not.toContain('sk-abcdefghijklmno123456');

    // Read-only guarantee: the analyzed tree is byte-for-byte untouched.
    expect(await listTree(repoRoot)).toEqual(before);
  }, 60_000);

  it('emits the full RepositoryUnderstanding with --json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-repo-json-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    await writeFiles(join(dir, 'target-repo'), ARBITRARY_REPO);

    const json = await runCli(dir, ['repo', 'target-repo', '--json']);
    expect(json.code).toBe(0);
    const payload = JSON.parse(json.stdout) as {
      understandingVersion: number;
      parserVersion: string;
      source: { snapshotHash: string; files: number };
      entrypoints: { training: { path: string; confidence: number }[]; evaluation: unknown[] };
      dependencies: { manifests: string[] };
      needsConfirmation: boolean;
      confidence: number;
      openQuestions: string[];
    };
    expect(payload.understandingVersion).toBe(1);
    expect(payload.parserVersion).toBe('ideaseek-repo-1');
    expect(payload.source.snapshotHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(payload.source.files).toBeGreaterThan(3);
    expect(payload.entrypoints.training.map((entry) => entry.path)).toContain(
      'pipeline/run_experiment.py',
    );
    expect(payload.dependencies.manifests).toContain('requirements.txt');
    expect(payload.needsConfirmation).toBe(true);
    expect(payload.confidence).toBeGreaterThan(0);
    expect(Array.isArray(payload.openQuestions)).toBe(true);
  }, 60_000);

  it('fails with a clear error for missing or non-directory targets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-repo-missing-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    await writeFile(join(dir, 'a-file.txt'), 'x');

    const missing = await runCli(dir, ['repo', 'no-such-dir']);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('repository not found');

    const notDir = await runCli(dir, ['repo', 'a-file.txt']);
    expect(notDir.code).not.toBe(0);
    expect(notDir.stderr).toContain('not a directory');
  }, 60_000);
});
