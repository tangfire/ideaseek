#!/usr/bin/env node
/**
 * One-command uninstall companion to scripts/install.mjs: removes ONLY
 * the files the installer created (launcher + manifest + empty bin/),
 * never the source checkout and never anything it cannot attribute to
 * the install manifest.
 *
 * Usage: node scripts/uninstall.mjs [--prefix <dir>] [--json]
 */
import { existsSync, readFileSync, rmSync, rmdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const asJson = args.includes('--json');
const prefix = resolve(
  flag('--prefix') ?? process.env.IDEASEEK_PREFIX ?? join(homedir(), '.ideaseek'),
);
const manifestPath = join(prefix, 'install-manifest.json');

function fail(message, hint) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: message, hint: hint ?? null })}\n`);
  } else {
    process.stderr.write(`uninstall failed: ${message}\n`);
    if (hint) process.stderr.write(`next: ${hint}\n`);
  }
  process.exit(1);
}

if (!existsSync(manifestPath)) {
  fail(
    `no ideaseek install manifest at ${manifestPath}`,
    'nothing to remove — if you installed elsewhere, pass the same --prefix you used',
  );
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest.contract !== 'ideaseek-install-v1') {
  fail(`unexpected manifest contract ${manifest.contract} — refusing to delete`);
}

const removed = [];
if (manifest.launcherPath && existsSync(manifest.launcherPath)) {
  rmSync(manifest.launcherPath, { force: true });
  removed.push(manifest.launcherPath);
}
// npm global-bin shims (attribution via the manifest — same trust rule).
// `npmShims` is the array form; `npmShimPath` was the single-file form.
const npmShims = manifest.npmShims ?? (manifest.npmShimPath ? [manifest.npmShimPath] : []);
for (const shim of npmShims) {
  if (shim && existsSync(shim)) {
    rmSync(shim, { force: true });
    removed.push(shim);
  }
}
rmSync(manifestPath, { force: true });
removed.push(manifestPath);

// Remove bin/ (and the prefix itself) only when empty — anything else
// in there was not created by the installer and stays untouched.
const binDir = join(prefix, 'bin');
if (existsSync(binDir) && readdirSync(binDir).length === 0) {
  rmdirSync(binDir);
  removed.push(binDir);
}
if (existsSync(prefix) && readdirSync(prefix).length === 0) {
  rmdirSync(prefix);
  removed.push(prefix);
}

const report = { ok: true, prefix, removed, sourcePreserved: manifest.sourceRoot ?? null };
if (asJson) {
  process.stdout.write(`${JSON.stringify(report)}\n`);
} else {
  process.stdout.write(`uninstalled ideaseek from ${prefix}\n`);
  for (const path of removed) process.stdout.write(`  removed ${path}\n`);
  if (manifest.sourceRoot) {
    process.stdout.write(`  source untouched: ${manifest.sourceRoot}\n`);
  }
}
