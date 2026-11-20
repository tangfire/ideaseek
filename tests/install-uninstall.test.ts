import { spawn } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), 'scripts', script), ...args], {
      cwd: process.cwd(),
      // Default OFF so tests never write into the machine's real npm
      // global bin; the shim e2e opts in with a temp dir.
      env: { ...process.env, IDEASEEK_NPM_BIN: '', ...extraEnv },
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

  it('adopts the ideaseek user-data home without touching its files', async () => {
    // ~/.ideaseek doubles as the runtime's user-data home (config.yaml +
    // projects.json from normal usage) — a dir made ONLY of well-known
    // ideaseek files must install, never be treated as foreign.
    const prefix = join(await mkdtemp(join(tmpdir(), 'ideaseek-adopt-')), 'prefix');
    mkdirSync(prefix, { recursive: true });
    writeFileSync(join(prefix, 'config.yaml'), 'notifications:\n  enabled: false\n', 'utf8');
    writeFileSync(join(prefix, 'projects.json'), '{"registry":{"contract":"x"}}\n', 'utf8');

    const installed = await run('install.mjs', ['--prefix', prefix, '--json']);
    expect(installed.code, installed.stderr).toBe(0);
    // Original data byte-identical; we only ADDED install files.
    expect(readFileSync(join(prefix, 'config.yaml'), 'utf8')).toBe(
      'notifications:\n  enabled: false\n',
    );
    expect(readFileSync(join(prefix, 'projects.json'), 'utf8')).toBe(
      '{"registry":{"contract":"x"}}\n',
    );
    expect(existsSync(join(prefix, 'install-manifest.json'))).toBe(true);
    expect(existsSync(join(prefix, 'bin'))).toBe(true);
  }, 60_000);
});

describe('npm global-bin shim (instant ideaseek on PATH)', () => {
  it('replaces an npm-link symlink instead of writing through it', async () => {
    // npm link leaves <npm-bin>/ideaseek as a symlink INTO this checkout.
    // writeFileSync would follow it and overwrite dist/cli.js with the shim
    // body — the CLI then dies with SyntaxError on every invocation (the
    // server full-suite failure: 170+ tests failed on `init` exit 1).
    const prefix = join(await mkdtemp(join(tmpdir(), 'ideaseek-symlink-prefix-')), 'prefix');
    const npmBin = join(await mkdtemp(join(tmpdir(), 'ideaseek-symlink-bin-')), 'bin');
    mkdirSync(npmBin, { recursive: true });
    const target = join(await mkdtemp(join(tmpdir(), 'ideaseek-symlink-target-')), 'cli.js');
    writeFileSync(target, '// the real bundle\n', 'utf8');
    const shim = join(npmBin, 'ideaseek');
    symlinkSync(target, shim);

    const installed = await run('install.mjs', ['--prefix', prefix, '--json'], {
      IDEASEEK_NPM_BIN: npmBin,
    });
    expect(installed.code, installed.stdout + installed.stderr).toBe(0);

    // The link target (stand-in for dist/cli.js) is byte-identical …
    expect(readFileSync(target, 'utf8')).toBe('// the real bundle\n');
    // … and the shim is now our own regular file, not a link.
    expect(lstatSync(shim).isSymbolicLink()).toBe(false);
    expect(readFileSync(shim, 'utf8')).toContain('#!/bin/sh');
    expect(readFileSync(shim, 'utf8')).toContain('exec node');
  }, 60_000);

  it('honours an explicitly empty IDEASEEK_NPM_BIN as "no shim"', async () => {
    // The suite default is IDEASEEK_NPM_BIN='' — meant to keep test runs
    // away from the machine's real npm global bin. An empty value must
    // disable the shim, not fall back to `npm prefix -g`.
    const prefix = join(await mkdtemp(join(tmpdir(), 'ideaseek-noshim-')), 'prefix');
    const installed = await run('install.mjs', ['--prefix', prefix, '--json']);
    expect(installed.code, installed.stdout + installed.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(join(prefix, 'install-manifest.json'), 'utf8')) as {
      npmShims?: string[];
    };
    expect(manifest.npmShims).toBeUndefined();
  }, 60_000);

  it('writes the shim, reports PATH state, and uninstalls it with the manifest', async () => {
    const prefix = join(await mkdtemp(join(tmpdir(), 'ideaseek-shim-')), 'prefix');
    const npmBin = join(await mkdtemp(join(tmpdir(), 'ideaseek-npmbin-')), 'bin');
    const shimName = process.platform === 'win32' ? 'ideaseek.cmd' : 'ideaseek';
    const shim = join(npmBin, shimName);

    // Shim dir NOT on PATH → honest needs-path report, shim still written.
    const installed = await run('install.mjs', ['--prefix', prefix, '--json'], {
      IDEASEEK_NPM_BIN: npmBin,
    });
    expect(installed.code, installed.stderr).toBe(0);
    const report = JSON.parse(installed.stdout) as { ok: boolean; path: string };
    expect(report.ok).toBe(true);
    expect(report.path).toBe('npm-shim-needs-path');
    expect(existsSync(shim)).toBe(true);
    // npm's Windows convention: sh + .cmd + .ps1 — one per shell family
    // (Git Bash executes the extension-less sh shim).
    const expectedShims =
      process.platform === 'win32'
        ? [join(npmBin, 'ideaseek'), join(npmBin, 'ideaseek.cmd'), join(npmBin, 'ideaseek.ps1')]
        : [join(npmBin, 'ideaseek')];
    if (process.platform === 'win32') {
      expect(readFileSync(join(npmBin, 'ideaseek'), 'utf8')).toContain('#!/bin/sh');
    }
    const manifest = JSON.parse(readFileSync(join(prefix, 'install-manifest.json'), 'utf8')) as {
      npmShims?: string[];
    };
    expect(manifest.npmShims).toEqual(expectedShims);

    // Shim dir ON PATH → zero-configuration "ready" state.
    const prefix2 = join(await mkdtemp(join(tmpdir(), 'ideaseek-shim2-')), 'prefix');
    const npmBin2 = join(await mkdtemp(join(tmpdir(), 'ideaseek-npmbin2-')), 'bin');
    const installed2 = await run('install.mjs', ['--prefix', prefix2, '--json'], {
      IDEASEEK_NPM_BIN: npmBin2,
      PATH: `${npmBin2}${delimiter}${process.env.PATH ?? ''}`,
    });
    expect(installed2.code, installed2.stderr).toBe(0);
    expect((JSON.parse(installed2.stdout) as { path: string }).path).toBe('npm-shim');

    // Uninstall removes every shim via manifest attribution.
    const removed = await run('uninstall.mjs', ['--prefix', prefix, '--json']);
    expect(removed.code, removed.stderr).toBe(0);
    for (const file of expectedShims) expect(existsSync(file)).toBe(false);
    expect(existsSync(join(prefix, 'install-manifest.json'))).toBe(false);
  }, 60_000);
});

describe('shell profile PATH wiring (confirmation-gated, idempotent)', () => {
  it('creates a missing profile, preserves existing lines, and never duplicates the block', async () => {
    const { appendProfilePath, hasProfileMarker, renderProfileBlock } =
      await import('../scripts/profile-path.mjs');
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-profile-'));
    const profile = join(dir, '.profile');

    const block = renderProfileBlock('/home/u/.ideaseek/bin');
    expect(block).toContain('# ideaseek install');
    expect(block).toContain('export PATH="/home/u/.ideaseek/bin:$PATH"');

    // Missing profile → created with just our block.
    expect(appendProfilePath(profile, '/home/u/.ideaseek/bin')).toBe('added');
    const created = readFileSync(profile, 'utf8');
    expect(created).toContain('# ideaseek install');
    expect(hasProfileMarker(created)).toBe(true);

    // Existing foreign content is preserved (newline-normalized) …
    const profile2 = join(dir, '.bashrc');
    writeFileSync(profile2, 'export EDITOR=vim', 'utf8');
    expect(appendProfilePath(profile2, '/opt/is/bin')).toBe('added');
    const merged = readFileSync(profile2, 'utf8');
    expect(merged.startsWith('export EDITOR=vim')).toBe(true);
    expect(merged).toContain('/opt/is/bin');

    // … and the second append is a no-op (idempotent reinstall).
    expect(appendProfilePath(profile2, '/opt/is/bin')).toBe('already');
    expect(readFileSync(profile2, 'utf8')).toBe(merged);
  });
});
