#!/usr/bin/env node
/**
 * Vendoring tool for ARIS skills (docs/DEPENDENCY_POLICY, src/aris/manifest.ts).
 *
 * Why this exists: vendoring was a hand job — copy files, compute each
 * SHA-256, paste it into the TS table, and remember to move `ARIS_SOURCE.commit`
 * to match. Manual hash transcription is work that quietly goes stale, and the
 * integrity check used to verify only what the manifest CLAIMED, so a file
 * copied into `aris-skills/` with no entry was invisible to `ideaseek aris`
 * until load time, where `readVerified` would refuse it. This tool makes the
 * honest path the easy path: it copies from an upstream checkout, hashes what it
 * actually copied, and rewrites the manifest inside a declared region.
 *
 * It refuses to act without provable provenance: the upstream must be a clean
 * git tree, because a manifest pinned to a commit nobody can re-check-out is
 * decoration.
 *
 * Usage:
 *   node scripts/aris-vendor.mjs --check
 *   node scripts/aris-vendor.mjs --upstream <path> --skill <name> [--apply]
 *   node scripts/aris-vendor.mjs --upstream <path> --file <rel/path> [--apply]
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(REPO, 'src', 'aris', 'manifest.ts');
const TARGET_ROOT = join(REPO, 'aris-skills');
// Distinct strings that appear nowhere in the prose of the manifest comment:
// the first version of this tool wrote `aris-vendor:end` INSIDE the explanatory
// comment above the region, then searched for the first occurrence of that
// marker to find the insertion point — and spliced entries into the middle of a
// comment, producing a syntax error that `--check` had no way to see because it
// reads the file with regex, not as TypeScript. Locating a marker at the start
// of its own line is the difference between anchoring and guessing.
const BEGIN = 'BEGIN-REGISTERED-ENTRIES';
const END = 'END-REGISTERED-ENTRIES';
const NEWLINE = String.fromCharCode(10);
/** Ours rather than upstream's, so exempt from being listed: a declared set. */
const PLATFORM_AUTHORED = new Set(['LICENSE', 'NOTICE.md']);

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function walk(dir, prefix = '', out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === '.git' || entry === 'node_modules' || entry.startsWith('.')) continue;
    const abs = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(abs).isDirectory()) walk(abs, rel, out);
    else out.push(rel);
  }
  return out;
}

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reads both quote styles and both layouts — the one-line form and the
 * multi-line objects this table actually uses.
 *
 * A parser that understood only the format THIS tool writes would report every
 * hand-maintained entry as missing and call the result clean. That confident
 * half-look is the failure this repo keeps meeting (the read fence that resolved
 * to no roots, the docs config keys that were never regenerated, the language
 * guard whose first draft stripped the word it existed to catch).
 */
function parseManifestEntries(text) {
  const listed = new Map();
  const pattern =
    /\{[^{}]*?path:\s*['"]([^'"]+)['"][^{}]*?sha256:\s*['"]([0-9a-f]{64})['"][^{}]*?\}/gs;
  for (const match of text.matchAll(pattern)) listed.set(match[1], match[2]);
  return listed;
}

function upstreamCommit(upstream) {
  const head = execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const dirty = execFileSync('git', ['-C', upstream, 'status', '--porcelain'], {
    encoding: 'utf8',
  }).trim();
  if (dirty) {
    throw new Error(
      `upstream ${upstream} has uncommitted changes; vendor only from a committed tree, ` +
        'otherwise the manifest pins hashes to a state that cannot be re-created',
    );
  }
  return head;
}

/** Index of `marker` only where it begins a line, ignoring prose mentions. */
/**
 * Index of the line that carries `marker`, requiring it to be a comment line so
 * a prose mention inside another comment cannot be mistaken for the anchor.
 */
function lineIndexOf(text, marker) {
  const lines = text.split(NEWLINE);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line.includes(marker)) continue;
    if (!/^\s*\/\//.test(line)) continue;
    return i;
  }
  return -1;
}

function entryBlock(relPath, hash) {
  return [`  {`, `    path: '${relPath}',`, `    sha256: '${hash}',`, `  },`].join(NEWLINE);
}

function check() {
  const listed = parseManifestEntries(readFileSync(MANIFEST, 'utf8'));
  const onDisk = walk(TARGET_ROOT);
  let bad = 0;
  let seen = 0;
  for (const rel of onDisk) {
    if (PLATFORM_AUTHORED.has(rel)) continue;
    seen += 1;
    const expected = listed.get(rel);
    const actual = sha256(readFileSync(join(TARGET_ROOT, rel), 'utf8'));
    listed.delete(rel);
    if (!expected) {
      console.log(`FAIL  ${rel} — on disk but absent from the manifest, so unverified`);
      bad += 1;
    } else if (expected !== actual) {
      console.log(
        `FAIL  ${rel} — hash mismatch (manifest ${expected.slice(0, 12)}…, disk ${actual.slice(0, 12)}…)`,
      );
      bad += 1;
    } else {
      console.log(`ok    ${rel}`);
    }
  }
  for (const rel of listed.keys()) {
    seen += 1;
    console.log(`FAIL  ${rel} — listed in the manifest but missing from aris-skills/`);
    bad += 1;
  }
  console.log(`aris-vendor --check: ${seen - bad}/${seen} consistent`);
  return bad === 0 ? 0 : 2;
}

function parseArgs(argv) {
  const args = new Map();
  const flags = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--apply' || token === '--check') flags.add(token.slice(2));
    else if (token.startsWith('--')) args.set(token.slice(2), argv[i + 1]);
  }
  return { args, flags };
}

function collectWanted(abs, args) {
  const wanted = [];
  if (args.get('skill')) {
    const root = join(abs, 'skills', args.get('skill'));
    if (!existsSync(root)) {
      console.error(`no such upstream skill: skills/${args.get('skill')}`);
      process.exit(2);
    }
    // Prefixed with the skill directory, because `walk` returns paths relative
    // to the directory it was handed. The first version of this joined them
    // against the checkout root instead, so `figure-spec`'s renderer resolved
    // to <checkout>/scripts/figure_renderer.py and died with a bare ENOENT
    // stack: manifest paths are checkout-relative, and this tool writes them,
    // so the two must agree by construction rather than by luck.
    for (const rel of walk(root)) wanted.push(`skills/${args.get('skill')}/${rel}`);
  }
  if (args.get('file')) {
    if (!existsSync(join(abs, args.get('file')))) {
      console.error(`no such upstream file: ${args.get('file')}`);
      process.exit(2);
    }
    wanted.push(args.get('file'));
  }
  if (wanted.length === 0) {
    console.error('nothing to vendor: pass --skill <name> and/or --file <rel/path>');
    process.exit(2);
  }
  return [...new Set(wanted.map((rel) => rel.split(sep).join('/')))];
}

function main(argv) {
  const { args, flags } = parseArgs(argv);
  if (flags.has('check')) process.exit(check());

  const upstream = args.get('upstream');
  if (!upstream) {
    console.error(
      'usage: node scripts/aris-vendor.mjs --upstream <path> (--skill <name> | --file <rel>) [--apply]',
    );
    console.error('       node scripts/aris-vendor.mjs --check');
    process.exit(2);
  }
  const abs = resolve(upstream);
  if (!existsSync(join(abs, 'skills')) && !existsSync(join(abs, '.git'))) {
    console.error(`--upstream ${upstream} is not an ARIS checkout (no skills/ and no .git)`);
    process.exit(2);
  }
  const relPaths = collectWanted(abs, args);
  const manifestText = readFileSync(MANIFEST, 'utf8');
  const listed = parseManifestEntries(manifestText);

  const planned = [];
  for (const rel of relPaths) {
    const source = join(abs, rel);
    let text;
    try {
      text = readFileSync(source, 'utf8');
    } catch (error) {
      // A missing file here means the tool's own path arithmetic disagreed
      // with the upstream layout. Say so with the resolved path instead of
      // dumping an ENOENT stack the operator has to decode.
      console.error(
        `cannot read ${rel} (resolved ${source}): ${error instanceof Error ? error.message : error}`,
      );
      console.error('this is a bug in this script, not in the upstream tree — report it');
      process.exit(2);
    }
    const hash = sha256(text);
    const status = listed.get(rel) === hash ? 'registered' : 'NEW/CHANGED';
    console.log(`${status.padEnd(12)} ${rel}`);
    planned.push({ rel, hash, text });
  }
  const toAdd = planned.filter((entry) => listed.get(entry.rel) !== entry.hash);
  if (toAdd.length === 0) {
    console.log(NEWLINE + 'nothing to do: every requested file is already registered at this hash.');
    process.exit(0);
  }
  if (!flags.has('apply')) {
    console.log(NEWLINE + `dry run: ${toAdd.length} file(s) would be written. Pass --apply.`);
    process.exit(0);
  }

  const commit = upstreamCommit(abs);
  for (const entry of planned) {
    const dest = join(TARGET_ROOT, entry.rel);
    const dir = dirname(dest);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(dest, entry.text, 'utf8');
  }

  const begin = lineIndexOf(manifestText, BEGIN);
  const end = lineIndexOf(manifestText, END);
  if (begin === -1 || end === -1 || end < begin) {
    console.error(
      NEWLINE +
        `manifest sentinels (${BEGIN} / ${END}) not found; refusing to splice the table with a ` +
        'guessed anchor. Restore the sentinels — this check exists because regex-splicing a ' +
        'generated table is exactly how a hash ends up written into the wrong place.',
    );
    process.exit(2);
  }
  let next = manifestText;
  for (const entry of toAdd) {
    // Drop any stale record of the same path, wherever it sits, so the tool
    // cannot leave two entries claiming different hashes for one file.
    next = next.replace(
      new RegExp(`\\{[^{}]*?path:\\s*'${escapeForRegExp(entry.rel)}'[^{}]*?\\},?`),
      '',
    );
  }
  // Line-based, not character-offset. The first version spliced at the offset
  // of the END marker, but that marker lives INSIDE a comment line
  // (`// >>> END-REGISTERED-ENTRIES`), so the splice split the comment and left
  // bare text in the middle of the array — a syntax error, while `--check`
  // happily reported 59/59 because its regex still matched the entries. That is
  // the lesson: a checker that reads the file with a regex cannot see that the
  // file is no longer valid TypeScript.
  const lines = next.split(NEWLINE);
  const endLine = lines.findIndex((line) => line.includes(END));
  if (endLine === -1) {
    // The stale-entry removal above could have eaten the marker along with an
    // entry. Refusing beats writing a table whose region anchor has vanished.
    console.error(
      NEWLINE +
        'the END marker disappeared while removing stale entries; nothing was written to the ' +
        'manifest (the copied files remain, unregistered). Restore the sentinels by hand.',
    );
    process.exit(2);
  }
  const block = toAdd
    .map((entry) => entryBlock(entry.rel, entry.hash))
    .join(NEWLINE)
    .split(NEWLINE);
  const candidateLines = [...lines.slice(0, endLine), ...block, ...lines.slice(endLine)];
  const candidate = candidateLines.join(NEWLINE);
  // Prove the result is still a table of well-formed entries before it lands:
  // the counts must go up by exactly the number of entries added. A splice that
  // produces prose-in-the-middle-of-an-array parses as nothing at all, and this
  // check is the only place that catches it before the tests do.
  const before = parseManifestEntries(next).size;
  const after = parseManifestEntries(candidate).size;
  const endAfter = lineIndexOf(candidate, END);
  const beginAfter = lineIndexOf(candidate, BEGIN);
  if (beginAfter === -1 || endAfter === -1 || endAfter <= beginAfter) {
    console.error(
      NEWLINE +
        'refusing to write: the marker lines are no longer intact comment lines after the ' +
        'splice, which means the insertion would corrupt the table. Nothing was written.',
    );
    process.exit(2);
  }
  if (after !== before + toAdd.length) {
    console.error(
      NEWLINE +
        `refusing to write the manifest: entry count would go ${before} → ${after} for ` +
        `${toAdd.length} addition(s). Nothing was written; inspect the region between the markers.`,
    );
    process.exit(2);
  }
  writeFileSync(`${MANIFEST}.bak`, manifestText, 'utf8');
  writeFileSync(MANIFEST, candidate, 'utf8');
  console.log(`(previous manifest preserved at src/aris/manifest.ts.bak)`);

  console.log(
    NEWLINE +
      `copied ${planned.length} file(s); wrote ${toAdd.length} manifest entry(ies); ` +
      `upstream commit ${commit}`,
  );
  console.log(
    'next: if the commit changed, update ARIS_SOURCE in src/aris/manifest.ts deliberately, ' +
      'then run: node scripts/aris-vendor.mjs --check',
  );
  process.exit(0);
}

main(process.argv.slice(2));
