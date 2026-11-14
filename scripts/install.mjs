#!/usr/bin/env node
/**
 * One-command install (docs/PACKAGING.md 一键安装): source-linked
 * launcher into a prefix — no sudo, no network, no privilege escalation.
 *
 * Shows exactly what PACKAGING requires before writing anything: source
 * (the checkout), version, a sha256 fingerprint over dist/, and the
 * install path. Idempotent (reinstall refreshes); refuses to write into
 * a non-empty directory it does not own (no manifest → not ours).
 *
 * Usage: node scripts/install.mjs [--prefix <dir>] [--json] [--no-path]
 * Default prefix: $HOME/.ideaseek (override with --prefix or IDEASEEK_PREFIX).
 * Uninstall: node scripts/uninstall.mjs --prefix <same dir>
 *
 * Fresh checkouts are bootstrapped in-place (pnpm install when
 * node_modules is missing, then the locked build), so after `git clone`
 * the whole install is this ONE command.
 */
import { execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendProfilePath } from './profile-path.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const asJson = args.includes('--json');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const prefix = resolve(
  flag('--prefix') ?? process.env.IDEASEEK_PREFIX ?? join(homedir(), '.ideaseek'),
);

function fail(message, hint) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: message, hint: hint ?? null })}\n`);
  } else {
    process.stderr.write(`install failed: ${message}\n`);
    if (hint) process.stderr.write(`next: ${hint}\n`);
  }
  process.exit(1);
}

const pkgPath = join(root, 'package.json');
if (!existsSync(pkgPath)) fail('no package.json next to scripts/install.mjs');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const cliPath = join(root, 'dist', 'cli.js');

// Fresh-checkout bootstrap — this is what makes the flow ONE command:
// deps when missing, then the locked build, then the install below.
if (!existsSync(join(root, 'node_modules'))) {
  if (!asJson)
    process.stdout.write('node_modules missing — running pnpm install --frozen-lockfile\n');
  const installPkg = spawnSync('pnpm', ['install', '--frozen-lockfile'], {
    cwd: root,
    stdio: asJson ? 'ignore' : 'inherit',
    shell: process.platform === 'win32',
  });
  if (installPkg.error || installPkg.status !== 0) {
    // No pnpm on the machine: corepack ships with Node ≥ 16 and runs a
    // pinned pnpm without installing it — keeps the flow one command.
    if (!asJson) process.stdout.write('pnpm not found — retrying via corepack pnpm\n');
    const viaCorepack = spawnSync('corepack', ['pnpm', 'install', '--frozen-lockfile'], {
      cwd: root,
      stdio: asJson ? 'ignore' : 'inherit',
      shell: process.platform === 'win32',
    });
    if (viaCorepack.error || viaCorepack.status !== 0) {
      fail(
        'pnpm install failed (pnpm and corepack both unavailable or errored)',
        'install pnpm (npm i -g pnpm / corepack enable) and retry',
      );
    }
  }
}
if (!existsSync(cliPath)) {
  if (!asJson) process.stdout.write('dist missing — running the locked build\n');
  const build = spawnSync(process.execPath, [join(root, 'scripts', 'build.mjs')], {
    cwd: root,
    stdio: asJson ? 'ignore' : 'inherit',
  });
  if (build.status !== 0) fail('build failed', 'node scripts/build.mjs');
}
if (!existsSync(cliPath)) fail('dist/cli.js still missing after build');

// Fingerprint: sha256 over sorted "relpath sha256(file)" lines of dist/.
function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
const hash = createHash('sha256');
for (const file of walk(join(root, 'dist'))) {
  hash.update(
    `${relative(root, file)} ${createHash('sha256').update(readFileSync(file)).digest('hex')}\n`,
  );
}
const fingerprint = `sha256:${hash.digest('hex')}`;

// Safety: never write into a directory containing files ideaseek did
// not create. The default prefix doubles as the user-data home
// (config.yaml + projects.json, written by normal usage) — a directory
// made ONLY of well-known ideaseek files is adopted (we only ADD the
// manifest/bin); anything foreign keeps the refusal.
const manifestPath = join(prefix, 'install-manifest.json');
const KNOWN_IDEASEEK_FILES = new Set([
  'config.yaml',
  'projects.json',
  'install-manifest.json',
  'bin',
]);
if (existsSync(prefix)) {
  const entries = readdirSync(prefix);
  if (entries.length > 0 && !existsSync(manifestPath)) {
    const foreign = entries.filter((name) => !KNOWN_IDEASEEK_FILES.has(name));
    if (foreign.length > 0) {
      fail(
        `prefix ${prefix} contains files ideaseek did not create (${foreign.join(', ')}) — refusing to write`,
        'choose a different --prefix or remove the directory yourself after review',
      );
    }
    // Recognizable ideaseek user-data dir — adopt it.
    if (!asJson) {
      process.stdout.write(`adopting existing ideaseek data directory ${prefix}\n`);
    }
  }
}

mkdirSync(prefix, { recursive: true });
const binDir = join(prefix, 'bin');
mkdirSync(binDir, { recursive: true });
const launcherPath = join(binDir, process.platform === 'win32' ? 'ideaseek.cmd' : 'ideaseek');
if (process.platform === 'win32') {
  writeFileSync(launcherPath, `@echo off\r\nnode "${cliPath}" %*\r\n`, 'utf8');
} else {
  writeFileSync(launcherPath, `#!/bin/sh\nexec node "${cliPath}" "$@"\n`, 'utf8');
  chmodSync(launcherPath, 0o755);
}
// npm global-bin shim: `npm prefix -g`'s directory is where npm puts
// package bins, so it is already on PATH wherever `npm i -g` works —
// dropping a second launcher there makes `ideaseek` global instantly,
// with no PATH editing. IDEASEEK_NPM_BIN overrides the target (tests).
let npmShims = [];
let npmShimDir = null;
{
  let dir = process.env.IDEASEEK_NPM_BIN ?? null;
  if (!dir) {
    try {
      // String command (not args + shell) — avoids Node's DEP0190 warning;
      // .cmd resolution needs the shell on Windows.
      const npmPrefix = execSync('npm prefix -g', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (npmPrefix) dir = process.platform === 'win32' ? npmPrefix : join(npmPrefix, 'bin');
    } catch {
      dir = null; // npm absent → PATH flow below
    }
  }
  if (dir) {
    try {
      mkdirSync(dir, { recursive: true });
      // Mirror npm's own Windows convention: sh (Git Bash/MSYS), .cmd
      // (cmd) and .ps1 (PowerShell) — one shim per shell family.
      const cliPosix = cliPath.replace(/\\/g, '/');
      const files =
        process.platform === 'win32'
          ? [
              [join(dir, 'ideaseek'), `#!/bin/sh\nexec node "${cliPosix}" "$@"\n`, 0o755],
              [join(dir, 'ideaseek.cmd'), `@echo off\r\nnode "${cliPath}" %*\r\n`, null],
              [join(dir, 'ideaseek.ps1'), `& node "${cliPath}" $args\nexit $LASTEXITCODE\n`, null],
            ]
          : [[join(dir, 'ideaseek'), `#!/bin/sh\nexec node "${cliPath}" "$@"\n`, 0o755]];
      for (const [file, content, mode] of files) {
        writeFileSync(file, content, 'utf8');
        if (mode !== null) chmodSync(file, mode);
        npmShims.push(file);
      }
      npmShimDir = dir;
    } catch {
      npmShims = []; // read-only / unusable dir → fall back to the PATH flow
    }
  }
}

const manifest = {
  contract: 'ideaseek-install-v1',
  name: pkg.name,
  version: pkg.version,
  sourceRoot: root,
  cliPath,
  fingerprint,
  launcherPath,
  ...(npmShims.length > 0 ? { npmShims } : {}),
  installedAt: new Date().toISOString(),
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

// PATH resolution order: the npm global-bin shim (already on PATH on
// most machines — zero configuration) beats editing shell profiles.
// Profile edits stay confirmation-gated (PACKAGING: never change the
// environment without user confirmation).
let pathAction = 'printed';
const shimOnPath =
  npmShimDir !== null &&
  (process.env.PATH ?? '')
    .split(delimiter)
    .some((entry) => entry && resolve(entry) === resolve(npmShimDir));
if (npmShims.length > 0 && shimOnPath) {
  pathAction = 'npm-shim';
} else if (npmShims.length > 0) {
  pathAction = 'npm-shim-needs-path';
} else if (process.platform !== 'win32' && !args.includes('--no-path')) {
  const profilePath = join(homedir(), '.profile');
  try {
    const profileText = existsSync(profilePath) ? readFileSync(profilePath, 'utf8') : '';
    if (profileText.includes('# ideaseek install')) {
      pathAction = 'already';
    } else if (!asJson && process.stdin.isTTY) {
      const readline = await import('node:readline/promises');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question(`add ${binDir} to PATH in ${profilePath}? [Y/n] `))
        .trim()
        .toLowerCase();
      rl.close();
      if (answer === '' || answer === 'y' || answer === 'yes') {
        appendProfilePath(profilePath, binDir);
        pathAction = 'added';
      } else {
        pathAction = 'declined';
      }
    }
  } catch {
    pathAction = 'printed'; // never fail the install over PATH wiring
  }
}

const report = {
  ok: true,
  source: root,
  version: pkg.version,
  fingerprint,
  prefix,
  launcherPath,
  manifestPath,
  path: pathAction,
};
if (asJson) {
  process.stdout.write(`${JSON.stringify(report)}\n`);
} else {
  process.stdout.write(`installed ${pkg.name}@${pkg.version}\n`);
  process.stdout.write(`  source:    ${root}\n`);
  process.stdout.write(`  fingerprint: ${fingerprint}\n`);
  process.stdout.write(`  path:      ${prefix}\n`);
  process.stdout.write(`  launcher:  ${launcherPath}\n`);
  if (pathAction === 'npm-shim') {
    process.stdout.write(`  global:    ${npmShimDir} (npm bin dir already on PATH)\n`);
    process.stdout.write('next: ideaseek doctor\n');
  } else if (pathAction === 'npm-shim-needs-path') {
    process.stdout.write(`  global:    ${npmShimDir}\n`);
    process.stdout.write(
      `             add ${npmShimDir} to PATH (it hosts your npm -g bins), then: ideaseek doctor\n`,
    );
  } else if (pathAction === 'added') {
    process.stdout.write(`  PATH:      block added to ${join(homedir(), '.profile')}\n`);
    process.stdout.write('next: open a new shell (or source ~/.profile), then: ideaseek doctor\n');
  } else if (pathAction === 'already') {
    process.stdout.write('  PATH:      already configured\n');
    process.stdout.write('next: ideaseek doctor\n');
  } else if (pathAction === 'declined') {
    process.stdout.write(`  PATH:      not changed — export PATH="${binDir}:$PATH" when needed\n`);
    process.stdout.write('next: ideaseek doctor\n');
  } else {
    process.stdout.write(
      process.platform === 'win32'
        ? `next: add ${binDir} to PATH, then: ideaseek doctor\n`
        : `next: export PATH="${binDir}:$PATH", then: ideaseek doctor\n`,
    );
  }
}
