/**
 * Build freshness for scripts/build.mjs (shared by setup.sh, vitest's
 * global-setup, `pnpm build`, `ideaseek update`): a full `tsc` costs ~25s
 * and used to run on every invocation even when nothing changed. The skip
 * is cargo-style content addressing — hash the compile INPUTS, remember
 * what a successful build EMITTED, and let the next call do zero work when
 * both still agree:
 *
 *   inputs  = sorted "relpath sha256(file)" lines over src/**, the two
 *             tsconfigs, package.json, pnpm-lock.yaml (pins the tsc
 *             version) and the build scripts themselves;
 *   outputs = the same digest over dist/** minus the two cache files
 *             (.build-fingerprint, .tsbuildinfo — cache, not product).
 *
 * The fingerprint lives INSIDE dist/ so `rm -rf dist` kills it with the
 * artifacts it describes, and it is deleted BEFORE tsc and written only
 * after exit 0 — so "fingerprint exists" always means "these inputs built
 * successfully into this dist", and a killed/failed build can never leave
 * a skip behind. An output digest (not mere existence) also catches a
 * truncated file from an interrupted write, which an existence check would
 * wave through.
 *
 * Deciding is pure (planBuild) so tests can drive the truth table against
 * temp trees without ever touching the real dist.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const EMPTY_SHA = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** Sorted "relpath sha256(file)" digest of every file under `dir`
 * (excluding entries named in `skip`), as `sha256:<hex>`. Paths are
 * normalized to forward slashes so the digest is platform-stable. */
function hashTree(dir, skip = new Set()) {
  if (!existsSync(dir)) return EMPTY_SHA;
  const files = [];
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (!skip.has(name)) files.push(full);
    }
  };
  walk(dir);
  const outer = createHash('sha256');
  for (const file of files.sort()) {
    const rel = relative(dir, file).split(sep).join('/');
    outer.update(`${rel} ${createHash('sha256').update(readFileSync(file)).digest('hex')}\n`);
  }
  return `sha256:${outer.digest('hex')}`;
}

/** Digest of everything `tsc -p tsconfig.build.json` reads. */
export function inputDigest(root) {
  const entries = [];
  for (const rel of [
    'tsconfig.json',
    'tsconfig.build.json',
    'package.json',
    'pnpm-lock.yaml',
    'scripts/build.mjs',
    'scripts/build-fingerprint.mjs',
  ]) {
    entries.push([rel, join(root, rel)]);
  }
  const src = join(root, 'src');
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else entries.push([relative(root, full).split(sep).join('/'), full]);
    }
  };
  walk(src);
  const outer = createHash('sha256');
  for (const [rel, file] of entries.sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    outer.update(`${rel} ${createHash('sha256').update(readFileSync(file)).digest('hex')}\n`);
  }
  return `sha256:${outer.digest('hex')}`;
}

/** Digest of dist/ products (the two cache files are not products). */
export function outputDigest(root) {
  return hashTree(join(root, 'dist'), new Set(['.build-fingerprint', '.tsbuildinfo']));
}

export function fingerprintPath(root) {
  return join(root, 'dist', '.build-fingerprint');
}

/** null = missing or unreadable (any parse failure means "rebuild"). */
export function readFingerprint(root) {
  try {
    const parsed = JSON.parse(readFileSync(fingerprintPath(root), 'utf8'));
    if (typeof parsed?.inputs !== 'string' || typeof parsed?.outputs !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeFingerprint(root, { inputs, outputs }) {
  writeFileSync(fingerprintPath(root), `${JSON.stringify({ inputs, outputs })}\n`);
}

/**
 * The whole skip decision as a pure function:
 *   forced / no fingerprint / outputs differ → full rebuild (repair, or
 *     trust nothing when the record is gone);
 *   inputs differ, outputs intact            → incremental rebuild;
 *   everything agrees                        → skip.
 * "Outputs differ" outranks "inputs differ": a missing or truncated file
 * must not be papered over by an incremental tsc that trusts .tsbuildinfo
 * and re-emits nothing.
 */
export function planBuild({ force = false, fingerprint, inputs, outputs }) {
  if (force) return { mode: 'full', reason: 'forced' };
  if (!fingerprint) return { mode: 'full', reason: 'no fingerprint' };
  if (fingerprint.outputs !== outputs) return { mode: 'full', reason: 'outputs changed' };
  if (fingerprint.inputs !== inputs) return { mode: 'incremental', reason: 'inputs changed' };
  return { mode: 'skip', reason: 'up to date' };
}
