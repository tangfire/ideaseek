import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCsv, serializeCsv, buildCsvSlices } from '../src/experiment/slice-csv.js';
import { selectRows, SLICE_RULE_VERSION } from '../src/experiment/slices.js';
import type { ProjectRuntime } from '../src/workflow/runtime.js';
import { CLI_BIN, makeProjectDir, openRuntime } from './helpers.js';

function csvFixture(rows: number): string {
  const lines = ['id,label,note'];
  for (let i = 1; i <= rows; i += 1) {
    lines.push(`${i},class-${i % 3},"row, with ${i}"`);
  }
  return `${lines.join('\n')}\n`;
}

describe('selectRows', () => {
  it('is deterministic for the same seed and total', () => {
    const a = selectRows({ scale: 'quick', totalRows: 100, seed: 42 });
    const b = selectRows({ scale: 'quick', totalRows: 100, seed: 42 });
    expect(a.indices).toEqual(b.indices);
    expect(a.indices).toHaveLength(10); // quick = 10%
    // Sorted so slices are reproducible row sets, not shuffle order.
    expect([...a.indices].sort((x, y) => x - y)).toEqual(a.indices);
  });

  it('different seeds select different subsets', () => {
    const a = selectRows({ scale: 'quick', totalRows: 100, seed: 1 });
    const b = selectRows({ scale: 'quick', totalRows: 100, seed: 2 });
    expect(a.indices).not.toEqual(b.indices);
  });

  it('honors scale fractions with a minimum of one row', () => {
    expect(selectRows({ scale: 'smoke', totalRows: 10, seed: 7 }).indices).toHaveLength(1);
    expect(selectRows({ scale: 'quick', totalRows: 10, seed: 7 }).indices).toHaveLength(1);
    expect(selectRows({ scale: 'standard', totalRows: 10, seed: 7 }).indices).toEqual(
      Array.from({ length: 10 }, (_, i) => i),
    );
    expect(selectRows({ scale: 'standard', totalRows: 0, seed: 7 }).indices).toEqual([]);
  });

  it('records the rule text with seed and version', () => {
    const selection = selectRows({ scale: 'quick', totalRows: 50, seed: 9 });
    expect(selection.rule).toContain('seed=9');
    expect(selection.rule).toContain(`rule v${SLICE_RULE_VERSION}`);
  });
});

describe('parseCsv / serializeCsv', () => {
  it('handles quotes, escaped quotes, embedded commas and newlines', () => {
    const text = 'a,b\n1,"x,y"\n2,"say ""hi"""\n3,"line\nbreak"\n';
    const { header, rows } = parseCsv(text);
    expect(header).toEqual(['a', 'b']);
    expect(rows).toEqual([
      ['1', 'x,y'],
      ['2', 'say "hi"'],
      ['3', 'line\nbreak'],
    ]);
    const roundTrip = parseCsv(serializeCsv(header, rows));
    expect(roundTrip.rows).toEqual(rows);
  });

  it('strips a UTF-8 BOM', () => {
    const { header } = parseCsv(`\uFEFFid,name\n1,x\n`);
    expect(header).toEqual(['id', 'name']);
  });

  it('rejects empty input loudly', () => {
    expect(() => parseCsv('')).toThrow(/no rows/);
  });
});

describe('buildCsvSlices', () => {
  it('writes deterministic slices with hashes and boundary notes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-slices-'));
    const csvPath = join(dir, 'source.csv');
    await writeFile(csvPath, csvFixture(50));

    const outDir = join(dir, 'out');
    const first = await buildCsvSlices({
      csvPath,
      datasetSnapshotId: 'data-test',
      outDir,
      seed: 7,
      generatedBy: 'unit',
      now: 123,
    });
    expect(first.map((slice) => slice.scale)).toEqual(['smoke', 'quick', 'standard']);
    expect(first[0]!.stats).toEqual({ totalRows: 50, selectedRows: 1 }); // 2% → min 1
    expect(first[1]!.stats.selectedRows).toBe(5); // 10%
    expect(first[2]!.stats.selectedRows).toBe(50);
    expect(first[0]!.boundaries[0]).toContain('row-level selection');
    expect(first[0]!.limits.join(' ')).toContain('domain adapter');

    const body = await readFile(join(outDir, `${first[1]!.sliceId}.csv`), 'utf8');
    expect(first[1]!.outputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(body.split('\n').filter(Boolean)).toHaveLength(6); // header + 5 rows

    // Rebuild with the same input yields identical ids and bytes.
    const second = await buildCsvSlices({
      csvPath,
      datasetSnapshotId: 'data-test',
      outDir,
      scales: ['quick'],
      seed: 7,
      generatedBy: 'unit',
      now: 456,
    });
    expect(second[0]!.sliceId).toBe(first[1]!.sliceId);
    expect(second[0]!.outputHash).toBe(first[1]!.outputHash);
  });
});

describe('slice registry (db)', () => {
  let runtime: ProjectRuntime;

  beforeEach(async () => {
    runtime = await openRuntime(await makeProjectDir(), { recover: false });
  });

  afterEach(async () => {
    await runtime.close();
  });
  it('round-trips records and filters by dataset/scale', async () => {
    const record = {
      sliceId: 'ds-x-smoke-r1',
      datasetSnapshotId: 'data-x',
      scale: 'smoke',
      stats: { totalRows: 10, selectedRows: 1 },
    };
    await runtime.db.upsertSlice({
      sliceId: record.sliceId,
      datasetSnapshotId: record.datasetSnapshotId,
      scale: record.scale,
      record,
      createdAt: 1,
    });
    await runtime.db.upsertSlice({
      sliceId: 'ds-x-quick-r1',
      datasetSnapshotId: 'data-x',
      scale: 'quick',
      record: { sliceId: 'ds-x-quick-r1' },
      createdAt: 2,
    });
    await runtime.db.upsertSlice({
      sliceId: 'ds-y-smoke-r1',
      datasetSnapshotId: 'data-y',
      scale: 'smoke',
      record: { sliceId: 'ds-y-smoke-r1' },
      createdAt: 3,
    });

    expect(await runtime.db.getSlice(record.sliceId)).toMatchObject({
      scale: 'smoke',
      datasetSnapshotId: 'data-x',
    });
    expect(await runtime.db.listSlices({ datasetSnapshotId: 'data-x' })).toHaveLength(2);
    expect(await runtime.db.listSlices({ scale: 'smoke' })).toHaveLength(2);
    expect(
      await runtime.db.listSlices({ datasetSnapshotId: 'data-x', scale: 'quick' }),
    ).toHaveLength(1);

    // Upsert replaces rather than duplicating.
    await runtime.db.upsertSlice({
      sliceId: record.sliceId,
      datasetSnapshotId: 'data-x',
      scale: 'smoke',
      record: { ...record, rebuilt: true },
      createdAt: 9,
    });
    expect(await runtime.db.listSlices({ datasetSnapshotId: 'data-x' })).toHaveLength(2);
    expect((await runtime.db.getSlice(record.sliceId))!.record.rebuilt).toBe(true);
  });
});

function runCli(
  cwd: string,
  args: string[],
  timeoutMs = 30_000,
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

describe('CLI: data slices --prune-invalid', () => {
  it('removes only records whose hashes violate the contract', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-prune-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    await mkdir(join(dir, 'datasets', 'toy'), { recursive: true });
    await writeFile(join(dir, 'datasets', 'toy', 'train.csv'), csvFixture(30));
    expect((await runCli(dir, ['scan'])).code).toBe(0);
    expect(
      (
        await runCli(dir, [
          'data',
          'slices',
          '--build-from',
          'datasets/toy/train.csv',
          '--seed',
          '5',
        ])
      ).code,
    ).toBe(0);

    // A record as the fold-collision bug produced it: doubled `sha256:` prefix.
    const runtime = await openRuntime(dir, { recover: false });
    try {
      await runtime.db.upsertSlice({
        sliceId: 'ds-toysmoke-sha256',
        datasetSnapshotId: 'data-toy',
        scale: 'smoke',
        record: {
          sliceId: 'ds-toysmoke-sha256',
          inputHash: 'sha256:sha256:deadbeef',
          outputHash: 'sha256:sha256:cafebabe',
        } as unknown as Record<string, unknown>,
        createdAt: Date.now(),
      });
      expect((await runtime.db.listSlices()).length).toBe(4);
    } finally {
      await runtime.close();
    }

    const pruned = await runCli(dir, ['data', 'slices', '--prune-invalid', '--json']);
    expect(pruned.code).toBe(0);
    const payload = JSON.parse(pruned.stdout) as { removed: number; sliceIds: string[] };
    expect(payload.removed).toBe(1);
    expect(payload.sliceIds).toEqual(['ds-toysmoke-sha256']);

    const after = await openRuntime(dir, { recover: false });
    try {
      const remaining = await after.db.listSlices();
      expect(remaining.length).toBe(3);
      expect(remaining.map((record) => record.sliceId)).not.toContain('ds-toysmoke-sha256');
    } finally {
      await after.close();
    }
  }, 120_000);
});

describe('CLI: data slices / describe', () => {
  it('builds slices from a CSV and lists them (Phase 3 vertical)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-data-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    await mkdir(join(dir, 'datasets', 'toy'), { recursive: true });
    await writeFile(join(dir, 'datasets', 'toy', 'train.csv'), csvFixture(30));

    expect((await runCli(dir, ['scan'])).code).toBe(0);
    const describe = await runCli(dir, ['data', 'describe', '--json']);
    expect(describe.code).toBe(0);
    const describePayload = JSON.parse(describe.stdout) as {
      dataFiles: number;
      slices: number;
    };
    expect(describePayload.dataFiles).toBe(1);
    expect(describePayload.slices).toBe(0);

    const build = await runCli(dir, [
      'data',
      'slices',
      '--build-from',
      'datasets/toy/train.csv',
      '--json',
      '--seed',
      '5',
    ]);
    expect(build.code).toBe(0);
    const buildPayload = JSON.parse(build.stdout) as {
      built: number;
      datasetSnapshotId: string;
      slices: { scale: string; selectedRows: number }[];
    };
    expect(buildPayload.built).toBe(3);
    expect(buildPayload.slices.map((slice) => slice.scale)).toEqual(['smoke', 'quick', 'standard']);

    const list = await runCli(dir, ['data', 'slices', '--json']);
    expect(list.code).toBe(0);
    const listPayload = JSON.parse(list.stdout) as { slices: { sliceId: string }[] };
    expect(listPayload.slices).toHaveLength(3);

    const filtered = await runCli(dir, ['data', 'slices', '--scale', 'quick', '--json']);
    expect((JSON.parse(filtered.stdout) as { slices: unknown[] }).slices).toHaveLength(1);

    // Source CSV untouched.
    expect(await readFile(join(dir, 'datasets', 'toy', 'train.csv'), 'utf8')).toBe(csvFixture(30));

    const badScale = await runCli(dir, [
      'data',
      'slices',
      '--scales',
      'enormous',
      '--build-from',
      'datasets/toy/train.csv',
    ]);
    expect(badScale.code).toBe(2);
    expect(badScale.stderr).toContain('unknown scale');
  }, 60_000);
});

describe('CLI: data materialize guards', () => {
  it('refuses to write inside the read-only datasets directory but allows a sibling', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-matguard-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    await mkdir(join(dir, 'datasets'), { recursive: true });
    await writeFile(join(dir, 'datasets', 'corpus.parquet'), 'not a parquet', 'utf8');

    // The containment check must be path-aware: `datasets-derived` starts with
    // `datasets` as a string and was once rejected by mistake.
    const inside = await runCli(dir, [
      'data',
      'materialize',
      'datasets/corpus.parquet',
      '--out',
      'datasets/nested',
    ]);
    expect(inside.stderr + inside.stdout).toContain('read-only datasets directory');

    const sibling = await runCli(dir, [
      'data',
      'materialize',
      'datasets/corpus.parquet',
      '--out',
      'datasets-derived/smoke',
    ]);
    // Accepted by the guard; fails later on the fake bytes, which is correct.
    expect(sibling.stderr + sibling.stdout).not.toContain('read-only datasets directory');
  }, 120_000);
});

describe('worker check-syntax gate', () => {
  it('rejects an implementation that cannot compile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-syntax-'));
    const bad = join(dir, 'bad.py');
    const good = join(dir, 'good.py');
    await writeFile(bad, 'x = [1, 2\n', 'utf8');
    await writeFile(good, 'x = [1, 2]\nprint(x)\n', 'utf8');
    const { checkPythonSyntax } = await import('../src/knowledge/materialize.js');
    const broken = await checkPythonSyntax(bad);
    expect(broken.ok).toBe(false);
    expect(broken.line).toBe(1);
    expect(broken.message).toContain('never closed');
    const fine = await checkPythonSyntax(good);
    expect(fine.ok).toBe(true);
  }, 120_000);
});
