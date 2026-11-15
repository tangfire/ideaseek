import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN } from './helpers.js';

function runCli(
  cwd: string,
  args: string[],
  timeoutMs = 120_000,
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
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * The guidance layer, tested the way a user meets it.
 *
 * `ideaseek next` exists to answer "what do I do now", and it was written when
 * the only thing the product could do was a fake-worker demo pipeline. Once the
 * real chain existed the answer stayed wrong in three places: a project holding
 * papers was told to `run`, a finished skeleton run was reported as "all done",
 * and `start` duplicated the routing so the two could drift.
 */
async function freshProject(withPapers: boolean): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ideaseek-guidance-'));
  expect((await runCli(dir, ['init'])).code).toBe(0);
  if (withPapers) {
    await mkdir(join(dir, 'papers'), { recursive: true });
    await writeFile(join(dir, 'papers', 'one.pdf'), '%PDF-1.4\n%%EOF\n');
  }
  return dir;
}

describe('ideaseek next routes the research chain, not the demo pipeline', () => {
  it('never suggests the fake-worker run when there is input material', async () => {
    const dir = await freshProject(true);
    const out = await runCli(dir, ['next']);
    expect(out.stdout).not.toContain('demo 管线');
    expect(out.stdout).not.toMatch(/下一条命令：ideaseek run\b/);
    // A blocking gap is missing input, not a failed task (docs/CLI_SPEC).
    expect(out.code).toBe(2);
    expect(out.stdout).toContain('MATERIAL_INCOMPLETE');
    expect(out.stdout).toContain('下一条命令：');
  });

  it('names the research question as the first thing it needs', async () => {
    const dir = await freshProject(true);
    const out = await runCli(dir, ['next', '--json']);
    const advice = JSON.parse(out.stdout.trim().split(/\r?\n/).pop() ?? '{}') as {
      blockers: string[];
      command: string;
    };
    expect(advice.blockers.join(' ')).toMatch(/question/i);
  });

  it('a completed skeleton run is not reported as the end of the work', async () => {
    const dir = await freshProject(false);
    const started = await runCli(dir, ['run', '--question', 'q?']);
    expect(started.code, started.stderr).toBe(0);
    const out = await runCli(dir, ['next']);
    // Before, this said 所有任务已完成 with no hint that research had barely
    // started. The run's task count is a fact, not a conclusion.
    expect(out.stdout).toContain('RUN_DONE_');
    expect(out.stdout).toContain('研究链尚未走完');
  });
});
