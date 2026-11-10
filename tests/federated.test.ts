import { spawn, spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { profileFederatedDataset } from '../src/knowledge/federated.js';
import {
  FEDERATED_SCALE_RULES,
  buildAllFederatedSlices,
  buildFederatedSlice,
} from '../src/experiment/federated-slices.js';
import type { FederatedDatasetProfile } from '../src/knowledge/federated.js';
import { CLI_BIN } from './helpers.js';

const REAL_DATASET = 'D:/FedLab04/FedPF/dataset/mnist';

function runCli(
  cwd: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli ${args.join(' ')} timed out; stderr=${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Builds a tiny synthetic federated npz dataset via the worker interpreter. */
async function makeSyntheticDataset(dir: string): Promise<string> {
  const root = join(dir, 'fedset');
  const script = [
    'import numpy as np, sys',
    'from pathlib import Path',
    'root = Path(sys.argv[1])',
    'rng = np.random.default_rng(7)',
    'for split, base in (("train", 60), ("test", 20)):',
    '    d = root / split',
    '    d.mkdir(parents=True, exist_ok=True)',
    '    for client in range(3):',
    '        n = base + client * 15',
    '        x = rng.random((n, 1, 28, 28)).astype(np.float32)',
    '        y = rng.integers(0, 4, size=n).astype(np.int64)',
    '        np.savez(d / f"{client}.npz", data=np.array({"x": x, "y": y}, dtype=object))',
    'print("ok")',
  ].join('\n');
  const result = spawnSync('python', ['-c', script, root], {
    encoding: 'utf8',
    timeout: 60_000,
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`synthetic dataset build failed: ${result.stderr?.slice(0, 300)}`);
  }
  return root;
}

async function treeFingerprint(root: string): Promise<string> {
  const { readdir } = await import('node:fs/promises');
  const entries: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else {
        const info = await stat(abs);
        const content = await readFile(abs);
        const { createHash } = await import('node:crypto');
        entries.push(
          `${entry.name}:${info.size}:${info.mtimeMs}:${createHash('sha256').update(content).digest('hex')}`,
        );
      }
    }
  };
  await walk(root);
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(entries.sort().join('|')).digest('hex');
}

describe('profileFederatedDataset', () => {
  it('produces the full checklist for a synthetic npz dataset (python-gated)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-fed-'));
    let root: string;
    try {
      root = await makeSyntheticDataset(dir);
    } catch {
      return; // python/numpy unavailable
    }
    const profile = await profileFederatedDataset(root);
    expect(profile.clientCount).toBe(3);
    expect(profile.splits.train!.clientCount).toBe(3);
    expect(profile.splits.train!.totalSamples).toBe(60 + 75 + 90);
    const client0 = profile.splits.train!.clients[0]!;
    expect(client0.xShape.slice(1)).toEqual([1, 28, 28]);
    expect(client0.xDtype).toBe('float32');
    expect(client0.yDtype).toBe('int64');
    expect(Object.keys(profile.splits.train!.labelDistribution).sort()).toEqual([
      '0',
      '1',
      '2',
      '3',
    ]);
    expect(profile.nonIid.tvDistanceMean).toBeGreaterThan(0);
    expect(profile.nonIid.interpretation).toContain('non-IID');
    expect(profile.rootHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(profile.fileCount).toBe(6); // 3 train + 3 test client archives
    expect(profile.readOnly.policy).toContain('read-only');
    expect(profile.parser).toBe('npz-pickle-v1');
  }, 300_000);

  it('reports a stable error for missing roots', async () => {
    await expect(
      profileFederatedDataset(join(tmpdir(), 'definitely-missing-fed')),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/FILE_NOT_FOUND|PARSE_FAILED|DATASET_LAYOUT/),
    });
  }, 60_000);
});

function fakeProfile(): FederatedDatasetProfile {
  const clients = Array.from({ length: 10 }, (_, index) => ({
    id: String(index),
    file: `train/${index}.npz`,
    samples: 100 + index * 10,
    xShape: [100 + index * 10, 1, 28, 28],
    xDtype: 'float32',
    yShape: [100 + index * 10],
    yDtype: 'int64',
    labelCounts: { '0': 50, '1': 50 },
  }));
  return {
    parser: 'npz-pickle-v1',
    root: 'X:/fed/mnist',
    splits: {
      train: {
        dir: 'train',
        clients,
        clientCount: 10,
        totalSamples: clients.reduce((sum, client) => sum + client.samples, 0),
        sampleStats: { min: 100, max: 190, mean: 145, std: 28 },
        labelDistribution: { '0': 500, '1': 500 },
      },
      test: {
        dir: 'test',
        clients: clients.slice(0, 5),
        clientCount: 5,
        totalSamples: 700,
        sampleStats: { min: 100, max: 190, mean: 140, std: 30 },
        labelDistribution: { '0': 350, '1': 350 },
      },
    },
    clientCount: 10,
    nonIid: {
      tvDistanceMean: 0.5,
      tvDistanceMax: 0.7,
      samplesCv: 0.3,
      classesPerClientMean: 2,
      interpretation: 'test',
    },
    files: [{ rel: 'train/0.npz', bytes: 10, sha256: 'sha256:aa' }],
    fileCount: 1,
    rootHash: `sha256:${'c'.repeat(64)}`,
    readOnly: {
      rootWritableByProcess: false,
      sampleWritableByProcess: false,
      policy: 'test policy',
    },
  };
}

describe('buildFederatedSlice selection rules', () => {
  it('applies per-scale client/sample caps deterministically', () => {
    const profile = fakeProfile();
    const smoke = buildFederatedSlice({
      profile,
      scale: 'smoke',
      split: 'train',
      seed: 42,
      generatedBy: 'unit',
      now: 1,
    });
    expect(smoke.clients.length).toBe(Math.ceil(10 * FEDERATED_SCALE_RULES.smoke.clientFraction));
    expect(smoke.clients.length).toBe(1);
    expect(smoke.clients[0]!.keptSamples).toBe(50);
    expect(smoke.clients[0]!.indices).toHaveLength(50);
    expect([...smoke.clients[0]!.indices!].sort((a, b) => a - b)).toEqual(
      smoke.clients[0]!.indices,
    );
    expect(smoke.stats.rowsSelected).toBe(50);
    expect(smoke.sliceId).toContain('-train-smoke-r2');
    expect(smoke.rule).toContain('seed=42');

    const quick = buildFederatedSlice({
      profile,
      scale: 'quick',
      split: 'train',
      seed: 42,
      generatedBy: 'unit',
      now: 1,
    });
    expect(quick.clients.length).toBe(2);
    expect(quick.stats.rowsSelected).toBeLessThanOrEqual(2 * 100);

    const standard = buildFederatedSlice({
      profile,
      scale: 'standard',
      split: 'train',
      seed: 42,
      generatedBy: 'unit',
      now: 1,
    });
    expect(standard.clients.length).toBe(10);
    expect(standard.clients.every((client) => client.indices === null)).toBe(true);
    expect(standard.stats.rowsSelected).toBe(standard.stats.rowsTotal);
  });

  it('is deterministic for the same seed and differs across seeds', () => {
    const profile = fakeProfile();
    const a = buildFederatedSlice({
      profile,
      scale: 'quick',
      split: 'train',
      seed: 7,
      generatedBy: 'u',
      now: 1,
    });
    const b = buildFederatedSlice({
      profile,
      scale: 'quick',
      split: 'train',
      seed: 7,
      generatedBy: 'u',
      now: 2,
    });
    const c = buildFederatedSlice({
      profile,
      scale: 'quick',
      split: 'train',
      seed: 8,
      generatedBy: 'u',
      now: 1,
    });
    expect(a.clients.map((client) => client.id)).toEqual(b.clients.map((client) => client.id));
    expect(a.clients[0]!.indices).toEqual(b.clients[0]!.indices);
    expect(a.generatedAt).not.toBe(b.generatedAt); // only timestamp differs
    expect(JSON.stringify(a.clients)).not.toBe(JSON.stringify(c.clients));
  });

  it('builds the full train/test × scale matrix', () => {
    const slices = buildAllFederatedSlices(fakeProfile(), {
      seed: 42,
      generatedBy: 'u',
      now: 1,
    });
    expect(slices).toHaveLength(6);
    expect(new Set(slices.map((slice) => slice.sliceId)).size).toBe(6);
    expect(slices.every((slice) => slice.limits.join(' ').includes('ORIGINAL'))).toBe(true);
    expect(slices.every((slice) => slice.boundaries.length > 0)).toBe(true);
  });
});

describe('CLI: external dataset integration (hermetic fixture)', () => {
  it('registers a readonly dataset, profiles it and builds idempotent slices without touching sources', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-fedcli-'));
    let fixture: string;
    try {
      fixture = await makeSyntheticDataset(dir);
    } catch {
      return; // python/numpy unavailable
    }
    expect((await runCli(dir, ['init'])).code).toBe(0);
    const { readFile: rf, writeFile: wf } = await import('node:fs/promises');
    const configPath = join(dir, 'research.yaml');
    const config = await rf(configPath, 'utf8');
    await wf(
      configPath,
      config.replace(
        '  comparisons_dir: comparisons',
        `  comparisons_dir: comparisons\n  readonly_datasets:\n    - ${fixture.replace(/\\/g, '/')}`,
      ),
      'utf8',
    );

    const before = await treeFingerprint(fixture);

    // scan → describe → slices (the required command sequence).
    expect((await runCli(dir, ['scan'])).code).toBe(0);
    const describeRun = await runCli(dir, ['data', 'describe', '--json']);
    expect(describeRun.code).toBe(0);
    const described = JSON.parse(describeRun.stdout) as {
      datasetManifestPath: string;
      externalDatasets: { clientCount: number; rootHash: string }[];
    };
    expect(described.externalDatasets[0]!.clientCount).toBe(3);
    expect(described.externalDatasets[0]!.rootHash).toMatch(/^sha256:/);
    await access(described.datasetManifestPath);

    const slicesRun = await runCli(dir, ['data', 'slices', '--json']);
    expect(slicesRun.code).toBe(0);
    const built = JSON.parse(slicesRun.stdout) as { slices: { sliceId: string }[] };
    expect(built.slices).toHaveLength(6);

    const rerun = await runCli(dir, ['data', 'slices', '--json']);
    expect((JSON.parse(rerun.stdout) as { slices: unknown[] }).slices).toHaveLength(6);

    // Originals untouched: byte+hash+mtime fingerprint identical.
    expect(await treeFingerprint(fixture)).toBe(before);

    // Slice manifests are platform-managed, outside the fixture tree.
    const sliceFiles = await rf(join(dir, '.research', 'slices'), 'utf8').catch(() => null);
    void sliceFiles;
    const { readdir } = await import('node:fs/promises');
    const sliceDirs = await readdir(join(dir, '.research', 'slices'));
    expect(sliceDirs.length).toBeGreaterThan(0);

    // Config explain surfaces the registered path.
    const explain = await runCli(dir, ['config', 'explain']);
    expect(explain.stdout).toContain('readonly_datasets');
    expect(explain.stdout).toContain('fedset');
  }, 300_000);
});

describe('real FL dataset (this machine only)', () => {
  it('profiles the FedPF mnist dataset when present', async () => {
    if (!existsSync(REAL_DATASET)) return; // dataset lives on the lab machine only
    const profile = await profileFederatedDataset(REAL_DATASET);
    expect(profile.clientCount).toBe(20);
    expect(profile.splits.train!.totalSamples).toBeGreaterThan(50_000);
    expect(profile.splits.test!.clientCount).toBe(20);
    const first = profile.splits.train!.clients[0]!;
    expect(first.xShape).toEqual([expect.any(Number), 1, 28, 28]);
    expect(first.xDtype).toBe('float32');
    expect(first.yDtype).toBe('int64');
    expect(Object.keys(profile.splits.train!.labelDistribution)).toHaveLength(10);
    // Strong non-IID: mean total-variation far above the0.1 threshold.
    expect(profile.nonIid.tvDistanceMean).toBeGreaterThan(0.1);
    expect(profile.nonIid.samplesCv).toBeGreaterThan(0.1);
    expect(profile.fileCount).toBe(40);
    expect(profile.rootHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(profile.readOnly.policy).toContain('read-only');
    // Profile is pure-read: root fingerprint must not change.
    const before = await treeFingerprint(REAL_DATASET);
    await profileFederatedDataset(REAL_DATASET);
    expect(await treeFingerprint(REAL_DATASET)).toBe(before);
  }, 300_000);
});
