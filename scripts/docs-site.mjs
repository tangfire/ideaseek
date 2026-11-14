#!/usr/bin/env node
/**
 * Docs site build/check pipeline (PROGRESS 231: 版本化、搜索索引、发布
 * 流程、与 CLI/config schema 的自动同步).
 *
 * build:
 *   1. version stamp  — footer <span data-site-version> ← package.json
 *   2. search index   — per-section {id,title,search,excerpt} JSON
 *   3. config keys    — effective research.yaml key table generated from
 *                       `config explain --json` in a scratch project
 *                       (the schema authority, not a hand-kept list)
 * check:
 *   - regenerated artifacts match the committed ones (stale → fail)
 *   - every `ideaseek <cmd> [sub]` mentioned in the manual exists in the
 *     real CLI (--help probes, cached) — drift fails the check
 *
 * Usage:
 *   node scripts/docs-site.mjs build [--html <path>] [--out <dir>]
 *   node scripts/docs-site.mjs check [--html <path>] [--out <dir>]
 * Exit: 0 ok · 1 stale/drift.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);
const mode = args[0];
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = resolve(flag('--html') ?? join(root, 'docs', 'site', 'index.html'));
const outDir = resolve(flag('--out') ?? join(root, 'docs', 'site'));

if (mode !== 'build' && mode !== 'check') {
  process.stderr.write('usage: docs-site.mjs <build|check> [--html <path>] [--out <dir>]\n');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const html = readFileSync(htmlPath, 'utf8');

function fail(message) {
  process.stderr.write(`docs-site ${mode} FAILED: ${message}\n`);
  process.exit(1);
}

// ---------- 1. version stamp ----------
function withVersion(source) {
  const stamp = `v${pkg.version}`;
  if (/<span data-site-version>[^<]*<\/span>/.test(source)) {
    return source.replace(
      /<span data-site-version>[^<]*<\/span>/,
      `<span data-site-version>${stamp}</span>`,
    );
  }
  if (source.includes('data-site-version')) {
    // attribute present without a value span — leave untouched (build cannot guess placement)
    return source;
  }
  fail('index.html has no <span data-site-version> anchor — add one to the footer');
}

// ---------- 2. search index ----------
function buildSearchIndex(source) {
  const sections = [];
  const re = /<section\s+id="([^"]+)"([^>]*)>([\s\S]*?)<\/section>/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const [, id, attrs, body] = match;
    const search = /data-search="([^"]*)"/.exec(attrs)?.[1] ?? '';
    const title = /<h2>([^<]*)<\/h2>/.exec(body)?.[1]?.trim() ?? id;
    const text = body
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 400);
    sections.push({ id, title, search, excerpt: text });
  }
  if (sections.length === 0) fail('no <section> elements found for the search index');
  return `${JSON.stringify({ contract: 'docs-search-v1', version: pkg.version, sections }, null, 2)}\n`;
}

// ---------- 3. config keys (schema authority = config explain --json) ----------
function buildConfigKeys() {
  const scratch = mkdtempSync(join(tmpdir(), 'ideaseek-docsite-'));
  try {
    execFileSync(process.execPath, [join(root, 'dist', 'cli.js'), 'init'], {
      cwd: scratch,
      stdio: 'pipe',
      timeout: 60_000,
    });
    const out = execFileSync(
      process.execPath,
      [join(root, 'dist', 'cli.js'), 'config', 'explain', '--json'],
      { cwd: scratch, stdio: 'pipe', timeout: 60_000, encoding: 'utf8' },
    );
    const payload = JSON.parse(out);
    const keys = [];
    const visit = (value, path) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [k, v] of Object.entries(value)) {
          const next = path ? `${path}.${k}` : k;
          if (v && typeof v === 'object' && !Array.isArray(v)) visit(v, next);
          else keys.push(next);
        }
      }
    };
    // explain --json shape: { sources: { 'a.b': origin }, ... } — prefer sources
    if (payload.sources && typeof payload.sources === 'object') {
      for (const key of Object.keys(payload.sources).sort()) keys.push(key);
    } else {
      visit(payload.effective ?? payload, '');
    }
    const unique = [...new Set(keys)].sort();
    if (unique.length === 0) fail('config explain --json produced no keys');
    return `${JSON.stringify({ contract: 'docs-config-keys-v1', version: pkg.version, keys: unique }, null, 2)}\n`;
  } catch (error) {
    fail(`config explain failed: ${String(error.message ?? error).slice(0, 300)}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------- CLI sync ----------
function mentionedCommands(source) {
  const mentions = new Set();
  // Same line only: a shell block ending in "ideaseek" then a "cd" line
  // must not pair across the newline.
  const re = /ideaseek[ \t]+([a-z][a-z0-9-]*)(?:[ \t]+([a-z][a-z0-9-]*))?/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const first = match[1];
    if (['the', 'and', 'or', 'a', 'to', 'in', 'for'].includes(first)) continue;
    mentions.add(match[2] ? `${first} ${match[2]}` : first);
  }
  return [...mentions].sort();
}

const helpCache = new Map();
function helpText(command) {
  if (helpCache.has(command)) return helpCache.get(command);
  let text = '';
  try {
    text = execFileSync(
      process.execPath,
      [join(root, 'dist', 'cli.js'), ...command.split(' '), '--help'],
      { stdio: 'pipe', timeout: 30_000, encoding: 'utf8' },
    );
  } catch (error) {
    text = String(error.stdout ?? '') + String(error.stderr ?? '');
  }
  helpCache.set(command, text);
  return text;
}

function checkCliSync(source) {
  const problems = [];
  const mentions = mentionedCommands(source);
  if (mentions.length === 0) problems.push('no `ideaseek …` mentions found (parser broken?)');
  for (const mention of mentions) {
    const [first, second] = mention.split(' ');
    const topHelp = helpText('');
    if (!new RegExp(`\\b${first}\\b`).test(topHelp)) {
      problems.push(`unknown top-level command: ideaseek ${first}`);
      continue;
    }
    if (second) {
      const subHelp = helpText(first);
      if (!new RegExp(`\\b${second}\\b`).test(subHelp)) {
        problems.push(`unknown subcommand: ideaseek ${first} ${second}`);
      }
    }
  }
  return { mentions, problems };
}

// ---------- run ----------
const versioned = withVersion(html);
const searchIndex = buildSearchIndex(versioned);
const configKeys = buildConfigKeys();

if (mode === 'build') {
  mkdirSync(outDir, { recursive: true });
  if (resolve(htmlPath) !== resolve(join(outDir, 'index.html'))) {
    writeFileSync(join(outDir, 'index.html'), versioned);
  } else if (versioned !== html) {
    writeFileSync(htmlPath, versioned);
  }
  writeFileSync(join(outDir, 'search-index.json'), searchIndex);
  writeFileSync(join(outDir, 'config-keys.json'), configKeys);
  const cli = checkCliSync(versioned);
  process.stdout.write(
    `docs-site build: v${pkg.version} · ${JSON.parse(searchIndex).sections.length} section(s) · ` +
      `${JSON.parse(configKeys).keys.length} config key(s) · ${cli.mentions.length} CLI mention(s)\n`,
  );
  if (cli.problems.length > 0) {
    for (const problem of cli.problems) process.stderr.write(`  drift: ${problem}\n`);
    fail(`${cli.problems.length} CLI drift problem(s) — fix the manual or the command`);
  }
  process.exit(0);
}

// check: committed artifacts must match a fresh regeneration + CLI sync.
// Line endings are normalized first: Windows/WSL checkouts with
// core.autocrlf=true produce CRLF copies of committed LF files, which
// must not read as "stale" (regenerated content is always LF).
const lf = (text) => text.split('\r\n').join('\n');
const problems = [];
const committedSearch = existsSync(join(outDir, 'search-index.json'))
  ? lf(readFileSync(join(outDir, 'search-index.json'), 'utf8'))
  : null;
if (committedSearch !== lf(searchIndex)) {
  problems.push('search-index.json is stale — run: node scripts/docs-site.mjs build');
}
const committedKeys = existsSync(join(outDir, 'config-keys.json'))
  ? lf(readFileSync(join(outDir, 'config-keys.json'), 'utf8'))
  : null;
if (committedKeys !== lf(configKeys)) {
  problems.push('config-keys.json is stale — run: node scripts/docs-site.mjs build');
}
const committedHtml = readFileSync(htmlPath, 'utf8');
if (!committedHtml.includes(`v${pkg.version}`) && committedHtml.includes('data-site-version')) {
  problems.push('version stamp is stale — run: node scripts/docs-site.mjs build');
}
const cli = checkCliSync(committedHtml);
problems.push(...cli.problems);

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`  ${problem}\n`);
  fail(`${problems.length} problem(s)`);
}
process.stdout.write(
  `docs-site check OK: v${pkg.version} · index/config fresh · ${cli.mentions.length} CLI mention(s) verified\n`,
);
