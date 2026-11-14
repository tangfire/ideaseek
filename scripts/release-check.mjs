#!/usr/bin/env node
/**
 * Release hygiene gate (Phase 8: 回归集、依赖、许可证和 secret 检查).
 *
 * 1. Regression suite — the declared `test` script and both suites exist.
 * 2. Dependencies     — lockfile present; every direct dependency resolves
 *                       to an installed package with a license.
 * 3. Licenses         — every installed direct dependency's license must be
 *                       on the permissive allowlist (no surprises at ship).
 * 4. Secrets          — tracked files (or a directory walk with --skip-git)
 *                       must contain no key-shaped material.
 * 5. Version          — semver package.json, bin points at dist/cli.js, and
 *    the built CLI's --version prints exactly the package version.
 *
 * Usage: node scripts/release-check.mjs [--root <dir>] [--skip-git] [--json]
 * Exit: 0 clean · 1 violations.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const has = (name) => args.includes(name);
const root = flag('--root') ?? process.cwd();
const useGit = !has('--skip-git');
const asJson = has('--json');

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.research',
  '__pycache__',
  '.venv',
  '.mypy_cache',
  '.pytest_cache',
]);

const BINARY_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.pdf',
  '.zip',
  '.gz',
  '.xz',
  '.woff',
  '.woff2',
  '.ttf',
  '.ico',
  '.icu',
  '.node',
  '.so',
  '.dll',
  '.exe',
  '.pyc',
  '.class',
  '.wasm',
]);

const ALLOWED_LICENSES = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'Unlicense',
  'CC0-1.0',
  'Python-2.0',
  'MIT-0',
  'BlueOak-1.0.0',
  'Artistic-2.0',
  'WTFPL',
  'CC-BY-4.0',
  'MIT AND ISC',
]);

const SECRET_PATTERNS = [
  { name: 'private-key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'openai/deepseek-style-key', re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    name: 'github-token',
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    name: 'high-entropy-credential-assignment',
    re: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*["'][A-Za-z0-9_\-/+=]{24,}["']/i,
  },
];

function listTrackedFiles() {
  const res = spawnSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`git ls-files failed: ${String(res.stderr).slice(0, 200)}`);
  return res.stdout.toString('utf8').split('\0').filter(Boolean);
}

function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (IGNORE_DIRS.has(name)) continue;
    const path = join(dir, name);
    const info = statSync(path);
    if (info.isDirectory()) walkFiles(path, out);
    else if (info.isFile() && info.size <= 2 * 1024 * 1024) out.push(path);
  }
  return out;
}

function isProbablyText(path, content) {
  const dot = path.lastIndexOf('.');
  const ext = dot === -1 ? '' : path.slice(dot).toLowerCase();
  if (BINARY_EXT.has(ext)) return false;
  return !content.includes('\0');
}

/**
 * Fixtures that must LOOK like credentials in order to prove they never leak
 * (the test writes the value into a session, then asserts it appears nowhere).
 * Renaming them to something inert would keep the assertion green while
 * quietly deleting what it was checking, so the scan is narrowed instead: an
 * exception is the exact file AND the exact literal, applied only when that
 * literal is the material the pattern matched. A real key on the same line,
 * or this fixture value in any other file, still fails the scan.
 */
const ALLOWED_SECRET_FIXTURES = [
  { file: 'tests/ink-interactive.test.ts', literal: 'sk-catalog-probe-secret-1' },
];

function isAllowedFixture(file, match) {
  // git prints forward slashes, the working-tree walk prints native ones; the
  // exception must mean the same file either way.
  const normalized = file.replace(/\\/g, '/');
  return ALLOWED_SECRET_FIXTURES.some(
    (allowed) => allowed.file === normalized && match.includes(allowed.literal),
  );
}

function scanSecrets(files) {
  const findings = [];
  for (const file of files) {
    const abs = join(root, file);
    let content;
    try {
      content = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (!isProbablyText(abs, content)) continue;
    for (const pattern of SECRET_PATTERNS) {
      const match = pattern.re.exec(content);
      if (match && !isAllowedFixture(file, match[0])) {
        const line = content.slice(0, match.index).split('\n').length;
        findings.push({ file, line, pattern: pattern.name });
        break; // one finding per file keeps reports tight
      }
    }
  }
  return findings;
}

function checkDependencies() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const direct = { ...pkg.dependencies, ...pkg.devDependencies };
  const problems = [];
  const licenses = {};
  for (const name of Object.keys(direct)) {
    let meta;
    try {
      meta = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8'));
    } catch {
      problems.push(`dependency not installed: ${name}`);
      continue;
    }
    const license =
      typeof meta.license === 'string'
        ? meta.license
        : Array.isArray(meta.licenses)
          ? meta.licenses.map((entry) => entry.type).join(' OR ')
          : 'UNKNOWN';
    licenses[name] = license;
    if (!ALLOWED_LICENSES.has(license)) {
      problems.push(`license not on allowlist: ${name} → ${license}`);
    }
  }
  return { directCount: Object.keys(direct).length, licenses, problems };
}

function checkRegressionSuite(pkg) {
  const problems = [];
  if (!pkg.scripts?.test) problems.push('package.json scripts.test is missing');
  const vitestFiles = walkFiles(join(root, 'tests')).filter((f) => f.endsWith('.test.ts'));
  if (vitestFiles.length === 0) problems.push('no tests/*.test.ts files found');
  const pythonFiles = walkFiles(join(root, 'worker', 'python', 'tests')).filter((f) => {
    const bslash = 92; // '' via char code — avoids escape pitfalls
    const cut = Math.max(f.lastIndexOf('/'), f.lastIndexOf(String.fromCharCode(bslash)));
    const base = f.slice(cut + 1);
    return base.startsWith('test_') && base.endsWith('.py');
  });
  if (pythonFiles.length === 0) problems.push('no worker/python/tests/test_*.py files found');
  let lockfile = false;
  try {
    statSync(join(root, 'pnpm-lock.yaml'));
    lockfile = true;
  } catch {
    problems.push('pnpm-lock.yaml missing (dependencies are not reproducible)');
  }
  return { vitestFiles: vitestFiles.length, pythonFiles: pythonFiles.length, lockfile, problems };
}

function checkVersionConsistency(pkg) {
  const problems = [];
  if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(pkg.version)) {
    problems.push(`package.json version "${pkg.version}" is not semver`);
  }
  // bin target only applies to the ideaseek package itself (fixtures and
  // consumers legitimately have no bin.ideaseek).
  if (pkg.name === 'ideaseek') {
    const binPath = pkg.bin?.ideaseek;
    if (binPath !== './dist/cli.js') {
      problems.push(
        `package.json bin.ideaseek must be ./dist/cli.js (got ${binPath ?? 'missing'})`,
      );
    }
  }
  const cli = join(root, 'dist', 'cli.js');
  const cliChecked = existsSync(cli);
  if (cliChecked) {
    const result = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
    const printed = (result.stdout ?? '').trim();
    if (result.status !== 0 || printed !== pkg.version) {
      problems.push(
        `dist/cli.js --version prints "${printed}" but package.json says "${pkg.version}"`,
      );
    }
  }
  return { cliChecked, problems };
}

function main() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const suite = checkRegressionSuite(pkg);
  const deps = checkDependencies();
  const version = checkVersionConsistency(pkg);

  let files;
  try {
    files = useGit ? listTrackedFiles() : walkFiles(root).map((path) => relative(root, path));
  } catch (error) {
    process.stderr.write(`release-check: ${error.message}\n`);
    return 1;
  }
  const secrets = scanSecrets(files);

  const problems = [
    ...suite.problems.map((text) => ({ kind: 'regression', text })),
    ...deps.problems.map((text) => ({ kind: 'dependency', text })),
    ...version.problems.map((text) => ({ kind: 'version', text })),
    ...secrets.map((finding) => ({
      kind: 'secret',
      text: `${finding.file}:${finding.line} matches ${finding.pattern}`,
    })),
  ];
  const report = {
    regression: {
      vitestFiles: suite.vitestFiles,
      pythonFiles: suite.pythonFiles,
      lockfile: suite.lockfile,
    },
    dependencies: { direct: deps.directCount, licenses: deps.licenses },
    version: { package: pkg.version, cliChecked: version.cliChecked },
    scannedFiles: files.length,
    secrets: secrets.length,
    problems,
    ok: problems.length === 0,
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `release-check: ${report.regression.vitestFiles} vitest + ${report.regression.pythonFiles} python test file(s), ` +
        `${report.dependencies.direct} direct dependencies, ${report.scannedFiles} file(s) scanned\n`,
    );
    if (problems.length === 0) {
      process.stdout.write(
        'OK — regression suite present, licenses allowlisted, no secrets found\n',
      );
    } else {
      process.stdout.write(`${problems.length} problem(s):\n`);
      for (const problem of problems) process.stdout.write(`  [${problem.kind}] ${problem.text}\n`);
    }
  }
  return problems.length === 0 ? 0 : 1;
}

process.exit(main());
