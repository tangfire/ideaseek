import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN } from './helpers.js';

function runCli(
  cwd: string,
  args: string[],
  timeoutMs = 20_000,
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
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

describe('strategy selection and report wording', () => {
  it('an empty starter project runs with the starter strategy and reports its wording', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-report-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);

    const run = await runCli(dir, ['run', '--question', 'report test', '--json']);
    expect(run.code).toBe(0);

    const status = await runCli(dir, ['status']);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('策略：starter');

    const report = await runCli(dir, ['report', '--json']);
    expect(report.code).toBe(0);
    const payload = JSON.parse(report.stdout) as {
      run: { runId: string; strategy: string };
      reportPath: string;
      wording: { label: string; disclaimer: string };
    };
    expect(payload.run.strategy).toBe('starter');
    expect(payload.wording.disclaimer).toContain('方向筛选');

    await access(payload.reportPath);
    const content = await readFile(payload.reportPath, 'utf8');
    expect(content).toContain('# IdeaSeek Run Report');
    expect(content).toContain('## Strategy wording');
    expect(content).toContain('方向筛选');
    expect(content).toContain(payload.run.runId);
    expect(content).toContain('demo.report'); // task table is factual
    // No fabricated claims in a Phase 0 report.
    expect(content).toContain('no model-generated claims');
  }, 40_000);

  it('explicit research.mode overrides the scale heuristic', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-report-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    const { readFile: rf, writeFile: wf } = await import('node:fs/promises');
    const configPath = join(dir, 'research.yaml');
    const config = await rf(configPath, 'utf8');
    await wf(configPath, config.replace('mode: auto', 'mode: research'), 'utf8');

    const run = await runCli(dir, ['run', '--question', 'forced research', '--json']);
    expect(run.code).toBe(0);
    const status = await runCli(dir, ['status']);
    expect(status.stdout).toContain('策略：research');

    const report = await runCli(dir, ['report', '--json']);
    const payload = JSON.parse(report.stdout) as { wording: { disclaimer: string } };
    expect(payload.wording.disclaimer).toContain('未覆盖');
  }, 40_000);

  it('report without any run is a friendly no-op', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-report-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    const report = await runCli(dir, ['report']);
    expect(report.code).toBe(0);
    expect(report.stdout).toContain('尚无 run');
  }, 30_000);
});
