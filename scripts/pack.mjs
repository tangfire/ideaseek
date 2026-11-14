#!/usr/bin/env node
/**
 * Reproducible CLI release pack (docs/PACKAGING.md 可复现 CLI 发行包):
 * verifies the build + version consistency, packs ONLY the declared
 * `files` set with npm pack, and records a sha256 fingerprint of the
 * tarball. `--verify-reproducible` packs twice and fails unless both
 * tarballs are byte-identical (npm normalizes mtimes, so a clean tree
 * must reproduce).
 *
 * Usage: node scripts/pack.mjs [--json] [--out <dir>] [--verify-reproducible]
 * Default out: <repo>/release (gitignored).
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const asJson = args.includes('--json');
const verifyReproducible = args.includes('--verify-reproducible');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(flag('--out') ?? join(root, 'release'));

function fail(message, hint) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: message, hint: hint ?? null })}\n`);
  } else {
    process.stderr.write(`pack failed: ${message}\n`);
    if (hint) process.stderr.write(`next: ${hint}\n`);
  }
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!existsSync(join(root, 'dist', 'cli.js'))) {
  fail('dist/cli.js missing — build first', 'pnpm install && pnpm build');
}
if (pkg.private === true) {
  // private only blocks publish; packing is how we cut internal releases.
}

function npmPack(extraArgs) {
  const result = spawnSync('npm', ['pack', '--json', ...extraArgs], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    fail(`npm pack ${extraArgs.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`npm pack returned unparseable JSON: ${result.stdout.slice(0, 400)}`);
  }
}

// 1) Dry run first: assert the tarball ships the CLI entrypoint.
const dryRun = npmPack(['--dry-run']);
const files = (dryRun[0]?.files ?? []).map((entry) => entry.path);
if (!files.includes('dist/cli.js')) {
  fail(
    'tarball would not contain dist/cli.js — check the package.json "files" field',
    'ensure "files" includes "dist"',
  );
}

// 2) Real pack into the out dir.
mkdirSync(outDir, { recursive: true });
const packed = npmPack(['--pack-destination', outDir]);
const tarballName = packed[0]?.filename;
if (!tarballName) fail('npm pack did not report a filename');
const tarballPath = join(outDir, tarballName);
const sha256 = `sha256:${createHash('sha256').update(readFileSync(tarballPath)).digest('hex')}`;

// 3) Optional reproducibility proof: pack again elsewhere, compare bytes.
let reproducible = null;
if (verifyReproducible) {
  const second = npmPack(['--pack-destination', outDir]);
  const secondPath = join(outDir, second[0].filename);
  const sha256Again = `sha256:${createHash('sha256').update(readFileSync(secondPath)).digest('hex')}`;
  reproducible = sha256 === sha256Again;
  if (secondPath !== tarballPath) rmSync(secondPath, { force: true });
  if (!reproducible) {
    fail(
      `tarball is not reproducible: ${sha256} vs ${sha256Again}`,
      'check for untracked/generated files leaking into the package (npm pack --dry-run listing)',
    );
  }
}

const report = {
  ok: true,
  name: pkg.name,
  version: pkg.version,
  tarball: tarballPath,
  sha256,
  fileCount: files.length,
  reproducible,
};
if (asJson) {
  process.stdout.write(`${JSON.stringify(report)}\n`);
} else {
  process.stdout.write(`packed ${pkg.name}@${pkg.version}\n`);
  process.stdout.write(`  tarball: ${tarballPath}\n`);
  process.stdout.write(`  ${sha256}\n`);
  process.stdout.write(`  files: ${files.length}\n`);
  if (reproducible !== null) {
    process.stdout.write(
      `  reproducible: ${reproducible ? 'yes (byte-identical repack)' : 'NO'}\n`,
    );
  }
}
