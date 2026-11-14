import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, createDemoRun, makeProjectDir, openRuntime } from './helpers.js';
import { performScan } from '../src/commands/inputs.js';
import {
  detectInputDrift,
  driftConsequences,
  hasInputDrift,
  renderDriftReport,
} from '../src/knowledge/input-drift.js';

/**
 * Input drift detection (docs/MODES.md「不禁止写入，但侦测写入」): the agent entry
 * runs on DSH's workspace-write preset and is allowed to edit anything, so what
 * protects research conclusions is noticing a change to a hashed input — papers/,
 * datasets/, comparisons/upstream/ — and saying which downstream results stop
 * being verifiable. Working material (project code, comparison work copies) must
 * NOT be flagged, or the warning becomes noise.
 */

function runCli(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  timeoutMs = 60_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1', ...extraEnv },
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
    child.stdin.end();
  });
}

/** A scanned project with one anchor file per root plus non-anchor material. */
async function scannedProject(): Promise<string> {
  const dir = await makeProjectDir('drift-project');
  await writeFile(join(dir, 'papers', 'alpha.pdf'), '%PDF-1.4 alpha');
  await mkdir(join(dir, 'datasets', 'd1'), { recursive: true });
  await writeFile(join(dir, 'datasets', 'd1', 'train.csv'), 'a,b\n1,2\n');
  await mkdir(join(dir, 'comparisons', 'upstream', 'method-a'), { recursive: true });
  await writeFile(join(dir, 'comparisons', 'upstream', 'method-a', 'model.py'), 'print(1)\n');
  await mkdir(join(dir, 'comparisons', 'work'), { recursive: true });
  await writeFile(join(dir, 'comparisons', 'work', 'notes.md'), 'working copy\n');
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'keep.ts'), 'export const a = 1;\n');
  await performScan(dir);
  return dir;
}

describe('detectInputDrift', () => {
  it('reports a clean tree and covers exactly the anchor roots', async () => {
    const dir = await scannedProject();
    const report = await detectInputDrift(dir);
    expect(report.hasBaseline).toBe(true);
    expect(report.drifted).toEqual([]);
    expect(report.checked).toBe(3);
    expect(report.roots).toEqual(['papers', 'datasets', 'comparisons/upstream']);
    expect(renderDriftReport(report)).toEqual([]);
  });

  it('does not flag project code or non-upstream comparison material', async () => {
    const dir = await scannedProject();
    await writeFile(join(dir, 'src', 'keep.ts'), 'export const a = 2;\n');
    await writeFile(join(dir, 'comparisons', 'work', 'notes.md'), 'agent edited a work copy\n');
    const report = await detectInputDrift(dir);
    expect(hasInputDrift(report)).toBe(false);
  });

  it('flags a modified dataset with both the recorded and the current hash', async () => {
    const dir = await scannedProject();
    await writeFile(join(dir, 'datasets', 'd1', 'train.csv'), 'a,b\n1,999\n');
    const report = await detectInputDrift(dir);
    expect(report.drifted).toHaveLength(1);
    const [file] = report.drifted;
    expect(file!.relPath).toBe('datasets/d1/train.csv');
    expect(file!.change).toBe('modified');
    expect(file!.recorded).toMatch(/^sha256:/);
    expect(file!.current).toMatch(/^sha256:/);
    expect(file!.current).not.toBe(file!.recorded);
    expect(driftConsequences(report.drifted).join(' ')).toContain('DatasetCard');
  });

  it('flags a deleted paper and a never-hashed new paper', async () => {
    const dir = await scannedProject();
    await rm(join(dir, 'papers', 'alpha.pdf'));
    await writeFile(join(dir, 'papers', 'beta.pdf'), '%PDF-1.4 beta');
    const report = await detectInputDrift(dir);
    const byPath = new Map(report.drifted.map((file) => [file.relPath, file.change]));
    expect(byPath.get('papers/alpha.pdf')).toBe('removed');
    expect(byPath.get('papers/beta.pdf')).toBe('added');
    expect(report.checked).toBe(2);
    const lines = renderDriftReport(report);
    expect(lines.join('\n')).toContain('papers/alpha.pdf — deleted');
    expect(lines.join('\n')).toContain('ideaseek scan');
  });

  it('flags a changed comparison upstream file under comparisons/<methodId>/upstream (real import layout)', async () => {
    const dir = await makeProjectDir('drift-real-layout');
    await mkdir(join(dir, 'comparisons', 'fedavg', 'upstream'), { recursive: true });
    await writeFile(join(dir, 'comparisons', 'fedavg', 'upstream', 'train.py'), 'print(1)\n');
    await mkdir(join(dir, 'comparisons', 'fedavg', 'worktree'), { recursive: true });
    await writeFile(join(dir, 'comparisons', 'fedavg', 'worktree', 'train.py'), 'print(1)\n');
    await performScan(dir);

    // Editing worktree is working material — must remain clean.
    await writeFile(join(dir, 'comparisons', 'fedavg', 'worktree', 'train.py'), 'print(2)\n');
    expect(hasInputDrift(await detectInputDrift(dir))).toBe(false);

    // Editing upstream/ or adding a new file under another method's upstream/ must trigger drift.
    await writeFile(join(dir, 'comparisons', 'fedavg', 'upstream', 'train.py'), 'print("dirty")\n');
    await mkdir(join(dir, 'comparisons', 'fedprox', 'upstream'), { recursive: true });
    await writeFile(join(dir, 'comparisons', 'fedprox', 'upstream', 'new.py'), 'x = 1\n');
    const report = await detectInputDrift(dir);
    expect(report.drifted.map((file) => file.relPath)).toEqual([
      'comparisons/fedavg/upstream/train.py',
      'comparisons/fedprox/upstream/new.py',
    ]);
    expect(driftConsequences(report.drifted).join(' ')).toContain('upstream');
  });

  it('flags a changed comparison upstream file (not merely anything under comparisons)', async () => {
    const dir = await scannedProject();
    await writeFile(
      join(dir, 'comparisons', 'upstream', 'method-a', 'model.py'),
      'print("agent fixed it")\n',
    );
    const report = await detectInputDrift(dir);
    expect(report.drifted.map((file) => file.relPath)).toEqual([
      'comparisons/upstream/method-a/model.py',
    ]);
    expect(driftConsequences(report.drifted).join(' ')).toContain('upstream');
  });

  it('has nothing to compare before the first scan (no baseline, no claims)', async () => {
    const dir = await makeProjectDir('drift-nobaseline');
    await writeFile(join(dir, 'papers', 'alpha.pdf'), '%PDF-1.4 alpha');
    const report = await detectInputDrift(dir);
    expect(report.hasBaseline).toBe(false);
    expect(report.drifted).toEqual([]);
    expect(renderDriftReport(report).join('\n')).toContain('scan');
  });
});

describe('ideaseek stale inputs row', () => {
  it('stays current after a scan and turns stale (exit 2) when an input changes', async () => {
    const dir = await scannedProject();

    const clean = await runCli(dir, ['stale', '--json']);
    const cleanRows = (JSON.parse(clean.stdout) as { rows: { id: string; status: string }[] }).rows;
    expect(cleanRows.find((row) => row.id === 'inputs')?.status).toBe('current');

    await writeFile(join(dir, 'datasets', 'd1', 'train.csv'), 'a,b\n1,2,3\n');
    const dirty = await runCli(dir, ['stale', '--json']);
    expect(dirty.code).toBe(2);
    const dirtyPayload = JSON.parse(dirty.stdout) as {
      rows: { id: string; status: string; invalidates: string[]; recovery: string }[];
    };
    const row = dirtyPayload.rows.find((entry) => entry.id === 'inputs');
    expect(row?.status).toBe('stale');
    expect(row?.invalidates.length).toBeGreaterThan(0);
    expect(row?.recovery).toContain('ideaseek scan');
  });
});

describe('agent turn provenance check', () => {
  it('surfaces drift in human and json output without blocking the turn', async () => {
    const dir = await scannedProject();
    await writeFile(join(dir, 'papers', 'alpha.pdf'), '%PDF-1.4 tampered');

    const human = await runCli(dir, ['agent', 'fix the preprocessing'], {
      IDEASEEK_FAKE_AGENT_TURN: '1',
    });
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('漂移');
    expect(human.stdout).toContain('papers/alpha.pdf — modified');
    expect(human.stdout).toContain('ideaseek scan');

    const json = await runCli(dir, ['agent', 'fix the preprocessing', '--json'], {
      IDEASEEK_FAKE_AGENT_TURN: '1',
    });
    expect(json.code).toBe(0);
    const payload = JSON.parse(json.stdout) as {
      inputDrift: { drifted: number; hashMatched: number; changes: { path: string }[] };
    };
    expect(payload.inputDrift.drifted).toBe(1);
    expect(payload.inputDrift.changes[0]?.path).toBe('papers/alpha.pdf');
    expect(payload.inputDrift.hashMatched).toBe(2);
  });

  it('records an input_drift RunEvent when a run exists', async () => {
    const dir = await scannedProject();
    let runId = '';
    {
      const runtime = await openRuntime(dir, { recover: false });
      const run = await createDemoRun(runtime);
      runId = run.runId;
      await runtime.close();
    }
    await writeFile(join(dir, 'datasets', 'd1', 'train.csv'), 'a,b\n9,9\n');

    const turn = await runCli(dir, ['agent', 'clean the dataset'], {
      IDEASEEK_FAKE_AGENT_TURN: '1',
    });
    expect(turn.code).toBe(0);

    const runtime = await openRuntime(dir, { recover: false });
    try {
      const events = await runtime.db.listEvents(runId);
      const drift = events.find((event) => event.eventType === 'input_drift');
      expect(drift?.status).toBe('stale');
      expect(drift?.summary).toContain('modified=1');
    } finally {
      await runtime.close();
    }
  });
});
