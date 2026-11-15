import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN } from './helpers.js';

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

describe('ideaseek start', () => {
  it('bootstraps a project end to end and stays idempotent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-start-'));

    const first = await runCli(dir, ['start', '--question', '如何减少遗忘？', '--json']);
    expect(first.code).toBe(0);
    const payload = JSON.parse(first.stdout) as {
      created: boolean;
      name: string;
      question: string | null;
      setup: { wrote: boolean };
      scan: { files: number; manifest: string };
      environment: { node: { supported: boolean } };
      next: string;
    };
    expect(payload.created).toBe(true);
    expect(payload.question).toBe('如何减少遗忘？');
    expect(payload.environment.node.supported).toBe(true);
    expect(payload.scan.files).toBe(0); // fresh project has no inputs yet
    // A brand-new project is routed into the research chain, not the fake
    // worker demo: `run` was the Phase 0 skeleton's answer and would have sent
    // a user with papers into a pipeline that reads their inputs as nothing.
    expect(payload.next).not.toContain('ideaseek run');
    // With no inputs at all the assessment's own gap routing answers, so the
    // exact command is its business — being off the demo pipeline is the rule.
    expect(payload.next).toMatch(/ideaseek /);

    // Full workspace + question persisted + manifest written.
    for (const entry of [
      'papers',
      'datasets',
      'comparisons',
      'incoming',
      'knowledge',
      '.research',
    ]) {
      await access(join(dir, entry));
    }
    await access(payload.scan.manifest);
    const config = await readFile(join(dir, 'research.yaml'), 'utf8');
    expect(config).toContain('如何减少遗忘？');
    expect(config).toContain('config_version: 1');

    // Re-run: nothing destroyed, still exit 0.
    const second = await runCli(dir, ['start', '--json']);
    expect(second.code).toBe(0);
    const secondPayload = JSON.parse(second.stdout) as {
      created: boolean;
      question: string | null;
    };
    expect(secondPayload.created).toBe(false);
    // The persisted question survives a re-run without --question.
    const configAgain = await readFile(join(dir, 'research.yaml'), 'utf8');
    expect(configAgain).toContain('如何减少遗忘？');

    // With papers present, the advice must come from the material assessment —
    // the missing question is the real blocker, not "no run exists yet".
    await writeFile(join(dir, 'papers', 'a.pdf'), '%PDF-1.4');
    const third = await runCli(dir, ['start', '--json']);
    expect(third.code).toBe(0);
    const thirdPayload = JSON.parse(third.stdout) as {
      scan: { files: number };
      next: string;
    };
    expect(thirdPayload.scan.files).toBe(1);
    expect(thirdPayload.next).not.toContain('ideaseek run');

    const text = await runCli(dir, ['start']);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('ideaseek start');
    expect(text.stdout).toContain('next:');
  }, 60_000);

  it('start outside any directory bootstraps the current dir like init', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-start-'));
    const plain = await runCli(dir, ['start']);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain('project:');
    await access(join(dir, '.research', 'workflow.db'));
  }, 40_000);
});
