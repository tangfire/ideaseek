import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, makeProjectDir, openRuntime } from './helpers.js';

/**
 * Exit-code contract for `ideaseek papers` (docs/CLI_SPEC: 1 = task failure).
 * The command previously returned a constant 0 (`failures > 0 ? 0 : 0`),
 * so any CI or script gating on `papers --json` treated total parse failure
 * as success — a fail-open exit code on the paper-indexing surface.
 */

function runCli(
  cwd: string,
  args: string[],
  timeoutMs = 60_000,
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
      reject(new Error(`papers ${args.join(' ')} timed out; stderr=${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end();
  });
}

describe('ideaseek papers exit code', () => {
  it('exits 1 when the latest run has failed paper.* tasks (json and text)', async () => {
    const root = await makeProjectDir('papers-exit');
    const runtime = await openRuntime(root);
    try {
      const run = await runtime.db.createRun({
        projectId: runtime.project.id,
        question: 'seed a failed paper task',
        config: runtime.config,
      });
      const { task } = await runtime.db.enqueueTask({
        runId: run.runId,
        type: 'paper.parse',
        idempotencyKey: 'paper-fail-1',
        maxAttempts: 1,
        payload: {},
      });
      const claim = await runtime.db.claimNextTask(run.runId, 'w1', { leaseMs: 60_000 });
      expect(claim?.taskId).toBe(task.taskId);
      const failed = await runtime.db.failAttempt(task.taskId, 'w1', {
        code: 'PARSE_FAILED',
        message: 'corrupt pdf stream',
        retryable: false,
        at: Date.now(),
      });
      expect(failed.willRetry).toBe(false);
      expect((await runtime.db.getTask(task.taskId))?.status).toBe('failed');
    } finally {
      await runtime.close();
    }

    const json = await runCli(root, ['papers', '--json']);
    expect(json.code, json.stdout + json.stderr).toBe(1);
    const payload = JSON.parse(json.stdout) as { failures: { code: string }[] };
    expect(payload.failures).toHaveLength(1);
    expect(payload.failures[0]!.code).toBe('PARSE_FAILED');

    const text = await runCli(root, ['papers']);
    expect(text.code, text.stdout + text.stderr).toBe(1);
    expect(text.stdout).toContain('parse failures: 1');
  }, 120_000);

  it('exits 0 on a project with no paper failures', async () => {
    const root = await makeProjectDir('papers-clean');
    const json = await runCli(root, ['papers', '--json']);
    expect(json.code, json.stdout + json.stderr).toBe(0);
    const payload = JSON.parse(json.stdout) as { failures: unknown[] };
    expect(payload.failures).toHaveLength(0);
  }, 60_000);
});
