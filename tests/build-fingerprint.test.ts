import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { budget } from './helpers.js';
import {
  fingerprintPath,
  inputDigest,
  outputDigest,
  planBuild,
  readFingerprint,
  writeFingerprint,
} from '../scripts/build-fingerprint.mjs';

/**
 * Build freshness (scripts/build-fingerprint.mjs): the skip that turns a
 * repeat `pnpm build` / vitest startup from a ~25s full tsc into ~0.3s.
 * The truth table is pure, so it is driven against temp trees — no test
 * ever mutates the real dist (a mid-suite rebuild tears it for sibling
 * suites, the exact hazard the build lock documents).
 */
const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function makeTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ideaseek-fingerprint-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return root;
}

describe('build fingerprint', () => {
  it('input digest is stable and tracks every kind of input change', () => {
    const base = makeTree({
      'src/a.ts': 'export const a = 1;\n',
      'tsconfig.json': '{}',
      'tsconfig.build.json': '{}',
      'package.json': '{"type":"module"}',
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      'scripts/build.mjs': '// build\n',
      'scripts/build-fingerprint.mjs': '// fp\n',
    });
    const first = inputDigest(base);
    expect(inputDigest(base)).toBe(first); // same tree → same digest (skip stays stable)

    const renamed = makeTree({
      'src/a.ts': 'export const a = 2;\n', // content change
      'tsconfig.json': '{}',
      'tsconfig.build.json': '{}',
      'package.json': '{"type":"module"}',
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      'scripts/build.mjs': '// build\n',
      'scripts/build-fingerprint.mjs': '// fp\n',
    });
    expect(inputDigest(renamed)).not.toBe(first);

    const added = makeTree({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 1;\n', // file added
      'tsconfig.json': '{}',
      'tsconfig.build.json': '{}',
      'package.json': '{"type":"module"}',
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      'scripts/build.mjs': '// build\n',
      'scripts/build-fingerprint.mjs': '// fp\n',
    });
    expect(inputDigest(added)).not.toBe(first);

    const reconfigured = makeTree({
      'src/a.ts': 'export const a = 1;\n',
      'tsconfig.json': '{"compilerOptions":{"strict":true}}', // config change
      'tsconfig.build.json': '{}',
      'package.json': '{"type":"module"}',
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      'scripts/build.mjs': '// build\n',
      'scripts/build-fingerprint.mjs': '// fp\n',
    });
    expect(inputDigest(reconfigured)).not.toBe(first);
  });

  it('output digest covers every product and ignores the two cache files', () => {
    const root = makeTree({ 'dist/cli.js': 'run();\n', 'dist/core/env.js': 'export {};\n' });
    const products = outputDigest(root);
    // The cache files are written by the build itself; they must not change
    // the product digest or deleting .tsbuildinfo would look like a change.
    writeFileSync(join(root, 'dist', '.tsbuildinfo'), '{"cache":1}', 'utf8');
    writeFileSync(join(root, 'dist', '.build-fingerprint'), '{}', 'utf8');
    expect(outputDigest(root)).toBe(products);

    // A truncated product IS a change (the repair path's whole reason).
    writeFileSync(join(root, 'dist', 'cli.js'), 'ru', 'utf8');
    expect(outputDigest(root)).not.toBe(products);
  });

  it('planBuild truth table: force/no-record/output-damage → full, input drift → incremental, agreement → skip', () => {
    const inputs = 'sha256:in';
    const outputs = 'sha256:out';
    const fresh = { inputs, outputs };
    const cases: Array<[Parameters<typeof planBuild>[0], string]> = [
      [{ force: true, fingerprint: fresh, inputs, outputs }, 'full'],
      [{ fingerprint: null, inputs, outputs }, 'full'],
      [{ fingerprint: { inputs, outputs: 'sha256:old' }, inputs, outputs }, 'full'],
      [{ fingerprint: { inputs: 'sha256:old', outputs }, inputs, outputs }, 'incremental'],
      [{ fingerprint: fresh, inputs, outputs }, 'skip'],
    ];
    for (const [options, mode] of cases) {
      expect(planBuild(options).mode, JSON.stringify(options)).toBe(mode);
    }
    // "outputs changed" must outrank "inputs changed": a damaged dist is
    // repaired with a full emit, never papered over by an incremental one
    // that trusts .tsbuildinfo and re-emits nothing.
    expect(
      planBuild({ fingerprint: { inputs: 'sha256:old', outputs: 'sha256:gone' }, inputs, outputs })
        .mode,
    ).toBe('full');
  });

  it('fingerprint round-trip: corrupt or foreign content means rebuild', () => {
    const root = makeTree({ 'dist/cli.js': 'run();\n' });
    expect(readFingerprint(root)).toBeNull(); // missing → rebuild

    writeFingerprint(root, { inputs: 'sha256:in', outputs: 'sha256:out' });
    expect(readFingerprint(root)).toEqual({ inputs: 'sha256:in', outputs: 'sha256:out' });

    writeFileSync(fingerprintPath(root), '{not json', 'utf8');
    expect(readFingerprint(root)).toBeNull(); // torn write → rebuild, never a blind skip

    writeFileSync(fingerprintPath(root), '{"inputs":1}', 'utf8');
    expect(readFingerprint(root)).toBeNull(); // wrong shape → rebuild
  });

  it(
    'real build.mjs skips when the record agrees and never skips blind',
    () => {
      // Precondition, checked with the same pure functions build.mjs uses:
      // global-setup has already built this checkout in this run. If the
      // record is missing or stale, spawning would REBUILD — tearing dist
      // for sibling suites — so fail loudly here instead of guessing.
      const root = process.cwd();
      const fingerprint = readFingerprint(root);
      const inputs = inputDigest(root);
      expect(
        fingerprint && fingerprint.inputs === inputs && fingerprint.outputs === outputDigest(root),
        'dist fingerprint is missing or stale — global-setup should have built; refusing to spawn build.mjs mid-suite',
      ).toBe(true);

      const started = Date.now();
      const result = spawnSync(process.execPath, ['scripts/build.mjs'], {
        cwd: root,
        encoding: 'utf8',
        timeout: budget(120_000),
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('up to date');
      expect(Date.now() - started).toBeLessThan(budget(60_000));
    },
    budget(180_000),
  );
});
