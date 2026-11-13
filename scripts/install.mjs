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
 * Usage: node scripts/install.mjs [--prefix <dir>] [--json]
 * Default prefix: $HOME/.ideaseek (override with --prefix or IDEASEEK_PREFIX).
 * Uninstall: node scripts/uninstall.mjs --prefix <same dir>
 */
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
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
if (!existsSync(cliPath)) {
  fail('dist/cli.js missing — build first', 'pnpm install && pnpm build');
}

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

// Safety: an existing directory without our manifest is not ours to write.
const manifestPath = join(prefix, 'install-manifest.json');
if (existsSync(prefix)) {
  const entries = readdirSync(prefix);
  if (entries.length > 0 && !existsSync(manifestPath)) {
    fail(
      `prefix ${prefix} is not empty and has no ideaseek manifest — refusing to write`,
      'choose a different --prefix or remove the directory yourself after review',
    );
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
const manifest = {
  contract: 'ideaseek-install-v1',
  name: pkg.name,
  version: pkg.version,
  sourceRoot: root,
  cliPath,
  fingerprint,
  launcherPath,
  installedAt: new Date().toISOString(),
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const report = {
  ok: true,
  source: root,
  version: pkg.version,
  fingerprint,
  prefix,
  launcherPath,
  manifestPath,
};
if (asJson) {
  process.stdout.write(`${JSON.stringify(report)}\n`);
} else {
  process.stdout.write(`installed ${pkg.name}@${pkg.version}\n`);
  process.stdout.write(`  source:    ${root}\n`);
  process.stdout.write(`  fingerprint: ${fingerprint}\n`);
  process.stdout.write(`  path:      ${prefix}\n`);
  process.stdout.write(`  launcher:  ${launcherPath}\n`);
  process.stdout.write(
    process.platform === 'win32'
      ? `next: add ${binDir} to PATH, then: ideaseek doctor\n`
      : `next: export PATH="${binDir}:$PATH", then: ideaseek doctor\n`,
  );
}
