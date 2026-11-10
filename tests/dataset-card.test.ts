import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { profileCsv, renderDatasetCard } from '../src/experiment/dataset-card.js';
import { CLI_BIN } from './helpers.js';

const CSV = [
  'id,label,age,income,note',
  '1,0,34,1200,ok',
  '2,1,41,,missing-income',
  '3,0,34,1200,ok', // duplicate row of row1 except note? differs — craft true dup below
  '3,0,34,1200,ok',
  '4,1,,900,',
  '5,0,29,1500,ok',
].join('\n');

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

describe('profileCsv', () => {
  it('computes rows, columns, quality metrics and label candidates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-card-'));
    const csvPath = join(dir, 'train.csv');
    await writeFile(csvPath, CSV);
    await writeFile(join(dir, 'LICENSE'), 'MIT License\n\nPermission is hereby granted...');

    const profile = await profileCsv(csvPath, { now: 5, generatedBy: 'unit' });
    expect(profile.rows).toBe(6);
    expect(profile.columns.map((column) => column.name)).toEqual([
      'id',
      'label',
      'age',
      'income',
      'note',
    ]);

    const label = profile.columns.find((column) => column.name === 'label')!;
    expect(label.distinct).toBe(2);
    expect(profile.labelCandidates).toHaveLength(1);
    expect(profile.labelCandidates[0]!.column).toBe('label');
    expect(profile.labelCandidates[0]!.confidence).toBeLessThan(1);
    expect(profile.labelCandidates[0]!.basis).toContain('needs user confirmation');

    const income = profile.columns.find((column) => column.name === 'income')!;
    expect(income.missing).toBe(1); // row 2 has an empty income cell
    expect(profile.quality.missingCells).toBe(3); // income + age + note blanks
    expect(profile.quality.duplicateRows).toBe(1); // exact duplicate row
    expect(profile.licenseHint).toContain('MIT License');

    expect(profile.source.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(profile.datasetSnapshotId).toMatch(/^data-[0-9a-f]{12}$/);
  });

  it('marks constant columns and numeric typing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-card-'));
    const csvPath = join(dir, 'const.csv');
    await writeFile(csvPath, 'a,b\n1,x\n2,x\n3,x\n');
    const profile = await profileCsv(csvPath, { now: 1, generatedBy: 'unit' });
    expect(profile.quality.constantColumns).toEqual(['b']);
    expect(profile.columns[0]!.numeric).toBe(true);
    expect(profile.columns[1]!.numeric).toBe(false);
    expect(profile.labelCandidates).toHaveLength(0);
    expect(profile.licenseHint).toBeNull();
  });

  it('renders a markdown card with the confirmation disclaimer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-card-'));
    const csvPath = join(dir, 'train.csv');
    await writeFile(csvPath, CSV);
    const profile = await profileCsv(csvPath, { now: 2, generatedBy: 'unit' });
    const md = renderDatasetCard([profile], 3);
    expect(md).toContain('# Dataset Card');
    expect(md).toContain('label candidates (need confirmation)');
    expect(md).toContain('needs user confirmation');
    expect(md).toContain('| column | missing | distinct | numeric | samples |');
  });
});

describe('CLI: data describe', () => {
  it('profiles scanned CSVs and writes knowledge/dataset-card.{json,md}', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-card-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    await mkdir(join(dir, 'datasets', 'toy'), { recursive: true });
    await writeFile(join(dir, 'datasets', 'toy', 'train.csv'), CSV);

    expect((await runCli(dir, ['scan'])).code).toBe(0);
    const described = await runCli(dir, ['data', 'describe', '--json']);
    expect(described.code).toBe(0);
    const payload = JSON.parse(described.stdout) as {
      dataFiles: number;
      profiles: {
        rows: number;
        labelCandidates: { column: string }[];
        quality: { duplicateRows: number };
      }[];
      cardPath: string;
    };
    expect(payload.dataFiles).toBe(1);
    expect(payload.profiles).toHaveLength(1);
    expect(payload.profiles[0]!.rows).toBe(6);
    expect(payload.profiles[0]!.labelCandidates[0]!.column).toBe('label');
    expect(payload.profiles[0]!.quality.duplicateRows).toBe(1);

    const cardJson = JSON.parse(await readFile(payload.cardPath, 'utf8')) as {
      profiles: unknown[];
    };
    expect(cardJson.profiles).toHaveLength(1);
    const md = await readFile(join(dir, 'knowledge', 'dataset-card.md'), 'utf8');
    expect(md).toContain('Dataset Card');

    const text = await runCli(dir, ['data', 'describe']);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('rows ×');
    expect(text.stdout).toContain('label candidate: label');
  }, 60_000);
});
