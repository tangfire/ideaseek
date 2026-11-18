import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Reproducible CLI release pack (docs/PACKAGING.md 可复现 CLI 发行包):
 * pack.mjs ships only the package.json "files" set (dist), fingerprints
 * the tarball, and proves byte-identical repacks. version/update cover
 * the runtime version check and the source-linked upgrade path.
 */

function run(
  target: string[],
  timeoutMs = 180_000,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, target, {
      cwd: process.cwd(),
      env: { ...process.env, IDEASEEK_CLI: '1', ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${target.join(' ')} timed out; stderr=${stderr}`));
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

const runScript = (script: string, args: string[], timeoutMs?: number) =>
  run([join(process.cwd(), 'scripts', script), ...args], timeoutMs);
const runCli = (args: string[], timeoutMs?: number, extraEnv?: Record<string, string>) =>
  run([join(process.cwd(), 'dist', 'cli.js'), ...args], timeoutMs, extraEnv);

describe('release pack + version/update (packaging)', () => {
  it('packs a reproducible dist-only tarball with a sha256 fingerprint', async () => {
    const out = await mkdtemp(join(tmpdir(), 'ideaseek-pack-'));
    const packed = await runScript('pack.mjs', ['--json', '--out', out, '--verify-reproducible']);
    expect(packed.code, packed.stdout + packed.stderr).toBe(0);
    const report = JSON.parse(packed.stdout) as {
      ok: boolean;
      version: string;
      sha256: string;
      fileCount: number;
      reproducible: boolean;
      tarball: string;
    };
    expect(report.ok).toBe(true);
    expect(report.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(report.reproducible).toBe(true); // byte-identical repack
    expect(report.fileCount).toBeGreaterThan(0);
    expect(report.tarball.endsWith('.tgz')).toBe(true);
  }, 300_000);

  it('version reports the package version; update rebuilds and refreshes the install', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };

    const version = await runCli(['version', '--json']);
    expect(version.code, version.stdout + version.stderr).toBe(0);
    const reported = JSON.parse(version.stdout) as { version: string; node: string };
    expect(reported.version).toBe(pkg.version);
    expect(reported.node).toBe(process.version);

    const prefix = join(await mkdtemp(join(tmpdir(), 'ideaseek-update-')), 'prefix');
    // update rebuilds the SOURCE checkout's dist in place — mid-suite that
    // rewrites the very files sibling suites are spawning, and a reader can
    // catch a half-written module (torn dist: missing exports). Emit into a
    // throwaway outDir instead: tsc still type-checks the whole project, so
    // `build: ok` keeps its meaning, while the shared dist stays coherent.
    const buildOut = await mkdtemp(join(tmpdir(), 'ideaseek-update-build-'));
    const updated = await runCli(['update', '--prefix', prefix, '--json'], 300_000, {
      IDEASEEK_BUILD_OUT: buildOut,
    });
    expect(updated.code, updated.stdout + updated.stderr).toBe(0);
    const updateReport = JSON.parse(updated.stdout) as {
      ok: boolean;
      from: string;
      to: string;
      build: string;
    };
    expect(updateReport.ok).toBe(true);
    expect(updateReport.from).toBe(pkg.version);
    expect(updateReport.to).toBe(pkg.version);
    expect(updateReport.build).toBe('ok');

    // With IDEASEEK_PREFIX pointing at the refreshed install, version
    // reports the manifest and detects no drift.
    const after = await runCli(['version', '--json'], undefined, {
      IDEASEEK_PREFIX: prefix,
    });
    expect(after.code, after.stdout + after.stderr).toBe(0);
    const afterReport = JSON.parse(after.stdout) as {
      version: string;
      install: { version: string; fingerprint: string } | null;
    };
    expect(afterReport.version).toBe(pkg.version);
    expect(afterReport.install?.version).toBe(pkg.version);
    expect(afterReport.install?.fingerprint).toMatch(/^sha256:/);
  }, 300_000);
});
