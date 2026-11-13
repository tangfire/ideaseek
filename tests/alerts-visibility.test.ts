import { spawn } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, createDemoRun, makeProjectDir, openRuntime } from './helpers.js';
import { shouldNotifyAlert } from '../src/runtime/notify.js';

/**
 * Alert visibility (PROGRESS 213): collectRuntimeAlerts stops being a
 * test-only helper — status (json+human), doctor and next surface the
 * non-terminal anomalies (disk/backup/quota/watchdog), and the
 * supervisor heartbeat notifies with a per-kind cooldown so a stuck disk
 * cannot spam the webhook.
 */

function runCli(
  cwd: string,
  args: string[],
  timeoutMs = 180_000,
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
    child.stdin.end();
  });
}

describe('alert notification cooldown (pure)', () => {
  it('same kind within the window is suppressed; older or new kinds notify', () => {
    const now = 1_000_000;
    const records = [{ kind: 'alert.disk-threshold', ts: now - 60_000 }];
    expect(shouldNotifyAlert(records, 'alert.disk-threshold', now)).toBe(false);
    expect(shouldNotifyAlert(records, 'alert.backup-failed', now)).toBe(true);
    expect(
      shouldNotifyAlert(
        [{ kind: 'alert.disk-threshold', ts: now - 31 * 60_000 }],
        'alert.disk-threshold',
        now,
      ),
    ).toBe(true);
    expect(shouldNotifyAlert([], 'alert.quota-exhausted', now)).toBe(true);
  });
});

describe('ideaseek status/doctor/next alert surfaces', () => {
  it('healthy project: status carries alerts.healthy and prints no alert lines', async () => {
    const dir = await makeProjectDir();
    const status = await runCli(dir, ['status', '--json']);
    expect(status.code, status.stdout + status.stderr).toBe(0);
    const payload = JSON.parse(status.stdout) as {
      alerts: { healthy: boolean; alerts: unknown[] };
    };
    expect(payload.alerts.healthy).toBe(true);
    expect(payload.alerts.alerts).toEqual([]);

    const human = await runCli(dir, ['status']);
    expect(human.code).toBe(0);
    expect(human.stdout).not.toContain('backup-failed');
    expect(human.stdout).not.toContain('quota-exhausted');
  }, 180_000);

  it('a failed backup surfaces in status (json+human), doctor and next', async () => {
    const dir = await makeProjectDir();
    await mkdir(join(dir, '.research'), { recursive: true });
    await appendFile(
      join(dir, '.research', 'backups.jsonl'),
      `${JSON.stringify({
        at: Date.now(),
        status: 'failed',
        dir: null,
        files: [],
        error: 'simulated disk failure during backup',
      })}\n`,
      'utf8',
    );

    const status = await runCli(dir, ['status', '--json']);
    expect(status.code, status.stdout + status.stderr).toBe(0);
    const payload = JSON.parse(status.stdout) as {
      alerts: { healthy: boolean; alerts: { kind: string; severity: string }[] };
    };
    expect(payload.alerts.healthy).toBe(false);
    const backup = payload.alerts.alerts.find((a) => a.kind === 'backup-failed');
    expect(backup?.severity).toBe('critical');

    const human = await runCli(dir, ['status']);
    expect(human.stdout).toContain('backup-failed');
    expect(human.stdout).toContain('simulated disk failure');

    const doctor = await runCli(dir, ['doctor'], 120_000);
    // doctor exits non-zero when an error-level check fires (by design).
    expect(doctor.code, doctor.stdout + doctor.stderr).not.toBe(0);
    expect(doctor.stdout).toContain('alerts');
    expect(doctor.stdout).toContain('backup-failed');

    const next = await runCli(dir, ['next', '--json']);
    const nextPayload = JSON.parse(next.stdout) as { blockers: string[] };
    expect(nextPayload.blockers.join(' ')).toContain('alert:backup-failed');
    expect(nextPayload.blockers.join(' ')).toContain('simulated disk failure');
  }, 240_000);

  it('a quota-parked run surfaces as a critical alert everywhere', async () => {
    const dir = await makeProjectDir();
    const rt = await openRuntime(dir, { recover: false });
    try {
      const run = await createDemoRun(rt, 'quota alert seed');
      const task = await rt.db.claimNextTask(run.runId, 'seed-worker', { leaseMs: 60_000 });
      await rt.db.blockExternal(
        task!.taskId,
        'seed-worker',
        {
          code: 'QUOTA_EXHAUSTED',
          message: 'injected quota exhaustion',
          retryable: true,
          at: Date.now(),
        },
        'QUOTA_EXHAUSTED',
      );
    } finally {
      await rt.close();
    }

    const status = await runCli(dir, ['status', '--json']);
    const payload = JSON.parse(status.stdout) as {
      alerts: { healthy: boolean; alerts: { kind: string; severity: string }[] };
      run: { status: string } | null;
    };
    expect(payload.run?.status).toBe('QUOTA_EXHAUSTED');
    expect(payload.alerts.healthy).toBe(false);
    const quota = payload.alerts.alerts.find((a) => a.kind === 'quota-exhausted');
    expect(quota?.severity).toBe('critical');

    const next = await runCli(dir, ['next', '--json']);
    const nextPayload = JSON.parse(next.stdout) as { blockers: string[] };
    expect(nextPayload.blockers.join(' ')).toContain('alert:quota-exhausted');
    expect(nextPayload.blockers.join(' ')).toContain('QUOTA_EXHAUSTED');
  }, 240_000);
});
