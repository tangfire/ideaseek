import { spawn } from 'node:child_process';
import { appendFile, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN } from './helpers.js';

/**
 * Backup/restore drill (USER_JOURNEY_ACCEPTANCE Journey F/H): snapshot
 * workflow DB + config + artifacts with a sha256 manifest, restore into
 * a FRESH directory only after every file verifies, refuse to touch an
 * existing project (rollback keeps the old directory).
 */

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
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

describe('backup / restore drill (Journey F/H)', () => {
  it('backups verify, tampering fails closed, fresh restore carries the run', async () => {
    const source = await mkdtemp(join(tmpdir(), 'journey-h-src-'));
    expect((await runCli(source, ['init'])).code).toBe(0);
    const run = await runCli(source, [
      'run',
      '--question',
      'backup drill question',
      '--enqueue-only',
      '--json',
    ]);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const runPayload = JSON.parse(run.stdout) as { runId?: string; run?: { runId: string } };
    const runId = runPayload.runId ?? runPayload.run?.runId;
    expect(runId).toBeTruthy();

    // --- backup: manifest lists and hash-verifies DB + config -----------
    const backup1 = await runCli(source, ['backup', '--json']);
    expect(backup1.code, backup1.stdout + backup1.stderr).toBe(0);
    const record1 = JSON.parse(backup1.stdout) as {
      status: string;
      dir: string;
      files: { path: string; sha256: string }[];
    };
    expect(record1.status).toBe('ok');
    const backupRoot = join(source, record1.dir);
    const manifest = JSON.parse(await readFile(join(backupRoot, 'manifest.json'), 'utf8')) as {
      files: { path: string; sha256: string }[];
    };
    expect(manifest.files.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(['research.yaml', 'workflow.db']),
    );
    for (const entry of manifest.files) {
      const content = await readFile(join(backupRoot, ...entry.path.split('/')));
      const { createHash } = await import('node:crypto');
      expect(`sha256:${createHash('sha256').update(content).digest('hex')}`).toBe(entry.sha256);
    }

    // --- tampered backup fails closed BEFORE writing anything -----------
    const tamperTarget = await mkdtemp(join(tmpdir(), 'journey-h-tamper-'));
    await appendFile(join(backupRoot, 'workflow.db'), 'EXTRA');
    const refused = await runCli(tamperTarget, ['restore', backupRoot]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('tampered backup');
    expect(await exists(join(tamperTarget, '.research'))).toBe(false); // zero writes

    // --- fresh restore carries the run; doctor/status work --------------
    const backup2 = await runCli(source, ['backup', '--json']);
    expect(backup2.code).toBe(0);
    const record2 = JSON.parse(backup2.stdout) as { dir: string };
    const fresh = await mkdtemp(join(tmpdir(), 'journey-h-fresh-'));
    const restored = await runCli(fresh, ['restore', join(source, record2.dir)]);
    expect(restored.code, restored.stdout + restored.stderr).toBe(0);
    expect(restored.stdout).toContain('hash-verified');
    expect(restored.stdout).toContain('ideaseek doctor');

    const status = await runCli(fresh, ['status', '--json']);
    // Exit 3 is the documented "queued work pending" status code; the run
    // and project must be intact either way.
    expect([0, 3]).toContain(status.code);
    const statusPayload = JSON.parse(status.stdout) as {
      run: { runId: string } | null;
      project: string;
      tasks: Record<string, number>;
    };
    expect(statusPayload.run?.runId).toBe(runId);
    expect(statusPayload.tasks.queued ?? 0).toBeGreaterThan(0);

    const doctor = await runCli(fresh, ['doctor']);
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).not.toContain('no .research/');

    // --- rollback story: restore never overwrites an existing project ---
    const overwrite = await runCli(source, ['restore', join(source, record2.dir)]);
    expect(overwrite.code).not.toBe(0);
    expect(overwrite.stderr).toContain('refuses to overwrite');
  }, 300_000);
});
