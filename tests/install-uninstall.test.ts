import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * One-command install/uninstall (docs/PACKAGING.md): source-linked
 * launcher into a prefix, shows source/version/fingerprint/path before
 * writing, idempotent, refuses foreign directories, uninstall removes
 * only what it created. No sudo, no network.
 */

function run(
  script: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), 'scripts', script), ...args], {
      cwd: process.cwd(),
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function runLauncher(launcher: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(launcher, ['--version'], { shell: process.platform === 'win32' });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout }));
  });
}

describe('ideaseek install / uninstall (one command)', () => {
  it('installs a working launcher, is idempotent, and uninstalls cleanly', async () => {
    const prefix = join(await mkdtemp(join(tmpdir(), 'ideaseek-install-')), 'prefix');

    const installed = await run('install.mjs', ['--prefix', prefix, '--json']);
    expect(installed.code, installed.stdout + installed.stderr).toBe(0);
    const report = JSON.parse(installed.stdout) as {
      ok: boolean;
      version: string;
      fingerprint: string;
      launcherPath: string;
    };
    expect(report.ok).toBe(true);
    expect(report.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(report.fingerprint.startsWith('sha256:')).toBe(true);
    expect(existsSync(report.launcherPath)).toBe(true);
    expect(existsSync(join(prefix, 'install-manifest.json'))).toBe(true);

    // The launcher runs the built CLI and reports the same version.
    const version = await runLauncher(report.launcherPath);
    expect(version.code, version.stdout).toBe(0);
    expect(version.stdout.trim()).toContain(report.version);

    // Idempotent reinstall refreshes rather than failing.
    const again = await run('install.mjs', ['--prefix', prefix, '--json']);
    expect(again.code, again.stdout + again.stderr).toBe(0);

    // Uninstall removes launcher + manifest, preserves the source tree.
    const removed = await run('uninstall.mjs', ['--prefix', prefix, '--json']);
    expect(removed.code, removed.stdout + removed.stderr).toBe(0);
    const removal = JSON.parse(removed.stdout) as { ok: boolean; sourcePreserved: string | null };
    expect(removal.ok).toBe(true);
    expect(removal.sourcePreserved).toContain(process.cwd());
    expect(existsSync(join(prefix, 'install-manifest.json'))).toBe(false);

    // Second uninstall refuses (nothing to remove).
    const again2 = await run('uninstall.mjs', ['--prefix', prefix, '--json']);
    expect(again2.code).not.toBe(0);
    expect(again2.stdout).toContain('no ideaseek install manifest');
  }, 120_000);

  it('refuses to write into a foreign non-empty directory', async () => {
    const prefix = await mkdtemp(join(tmpdir(), 'ideaseek-foreign-'));
    mkdirSync(join(prefix, 'someone-elses'), { recursive: true });
    writeFileSync(join(prefix, 'someone-elses', 'keep.txt'), 'do not touch', 'utf8');

    const refused = await run('install.mjs', ['--prefix', prefix, '--json']);
    expect(refused.code).not.toBe(0);
    expect(refused.stdout).toContain('refusing to write');
    // Nothing of ours was created; their file survives.
    expect(existsSync(join(prefix, 'install-manifest.json'))).toBe(false);
    expect(existsSync(join(prefix, 'someone-elses', 'keep.txt'))).toBe(true);
    expect(readdirSync(prefix)).toEqual(['someone-elses']);
  }, 60_000);
});
