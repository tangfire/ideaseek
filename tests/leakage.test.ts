import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkLeakage } from '../src/experiment/leakage.js';
import type { DatasetSlice } from '../src/experiment/slices.js';
import { CLI_BIN, createDemoRun, openRuntime } from './helpers.js';

function slice(overrides: Partial<DatasetSlice> = {}): DatasetSlice {
  return {
    sliceId: 'ds-abc-smoke-r1',
    datasetSnapshotId: 'data-abc',
    scale: 'smoke',
    rule: 'seeded shuffle take 1/100',
    ruleVersion: 1,
    inputHash: `sha256:${'a'.repeat(64)}`,
    outputHash: `sha256:${'b'.repeat(64)}`,
    stats: { totalRows: 100, selectedRows: 1 },
    seed: 7,
    boundaries: ['row-level selection (rule v1)'],
    generatedBy: 'test',
    generatedAt: 1,
    limits: ['fraction for smoke is 0.02'],
    ...overrides,
  };
}

describe('checkLeakage', () => {
  it('blocks when there is nothing to validate', () => {
    const report = checkLeakage({ slices: [], now: 1 });
    expect(report.ok).toBe(false);
    expect(report.findings[0]!.check).toBe('slices-present');
    expect(report.findings[0]!.severity).toBe('blocker');
  });

  it('passes a consistent smoke/quick/standard set with pending boundary note', () => {
    const report = checkLeakage({
      slices: [
        slice({
          sliceId: 'ds-a-smoke-r1',
          scale: 'smoke',
          stats: { totalRows: 100, selectedRows: 2 },
        }),
        slice({
          sliceId: 'ds-a-quick-r1',
          scale: 'quick',
          stats: { totalRows: 100, selectedRows: 10 },
        }),
        slice({
          sliceId: 'ds-a-standard-r1',
          scale: 'standard',
          stats: { totalRows: 100, selectedRows: 100 },
        }),
      ],
      now: 2,
    });
    expect(report.ok).toBe(true);
    const checks = report.findings.map((finding) => finding.check);
    expect(checks).toContain('single-snapshot');
    expect(checks).toContain('scale-nesting');
    expect(checks).toContain('group-time-boundary');
    const pending = report.findings.filter((finding) => finding.severity === 'pending');
    expect(pending.length).toBeGreaterThan(0);
    expect(report.findings.find((f) => f.check === 'group-time-boundary')!.ok).toBe(false);
  });

  it('blocks mixed snapshots and empty selections', () => {
    const mixed = checkLeakage({
      slices: [
        slice(),
        slice({ sliceId: 'ds-b-quick-r1', datasetSnapshotId: 'data-b', scale: 'quick' }),
      ],
      now: 3,
    });
    expect(mixed.ok).toBe(false);
    expect(
      mixed.findings.some((f) => f.check === 'single-snapshot' && f.severity === 'blocker'),
    ).toBe(true);

    const empty = checkLeakage({
      slices: [slice({ stats: { totalRows: 10, selectedRows: 0 } })],
      now: 4,
    });
    expect(empty.ok).toBe(false);
    expect(empty.findings.some((f) => f.check.startsWith('nonempty'))).toBe(true);

    const overshoot = checkLeakage({
      slices: [slice({ stats: { totalRows: 10, selectedRows: 11 } })],
      now: 5,
    });
    expect(overshoot.ok).toBe(false);
    expect(overshoot.findings.some((f) => f.check.startsWith('row-bounds'))).toBe(true);
  });

  it('warns on mixed seeds without blocking, and tracks required rules as pending', () => {
    const report = checkLeakage({
      slices: [slice({ seed: 1 }), slice({ sliceId: 'x-quick', scale: 'quick', seed: 2 })],
      requiredRules: ['time-split-before-shuffle'],
      now: 6,
    });
    expect(report.ok).toBe(true); // warnings do not block
    expect(
      report.findings.some((f) => f.check === 'uniform-seed-rule' && f.severity === 'warning'),
    ).toBe(true);
    const required = report.findings.find(
      (f) => f.check === 'required-rule:time-split-before-shuffle',
    );
    expect(required?.severity).toBe('pending');
  });

  it('flags missing provenance hashes as blockers', () => {
    const report = checkLeakage({
      slices: [slice({ inputHash: 'not-a-hash' as never })],
      now: 7,
    });
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.check.startsWith('provenance') && !f.ok)).toBe(true);
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

async function validProposal(): Promise<Record<string, unknown>> {
  const { validateProtocolProposal } = await import('../src/experiment/protocol.js');
  const proposal = {
    protocolId: 'proto-leak-v1',
    version: 1,
    taskDefinition: { value: 'classification', source: 'paper-evidence', confidence: 0.9 },
    sampleUnit: { value: 'row', source: 'data-probe', confidence: 0.9 },
    labelSemantics: { value: 'label = y', source: 'user', confidence: 1 },
    splitRules: { value: ['70/15/15'], source: 'adapter-rule', confidence: 0.8 },
    leakageChecks: ['no future rows in train'],
    preprocessing: ['scale on train'],
    baselineEntries: [{ methodId: 'm1', entry: 'run.py', source: 'code', confidence: 0.9 }],
    primaryMetrics: [
      { name: 'acc', direction: 'higher', source: 'paper-evidence', confidence: 0.9 },
    ],
    secondaryMetrics: [],
    statisticalSummary: ['mean over 3 seeds'],
    smokeTest: { value: '100 rows', source: 'adapter-rule', confidence: 0.9 },
    resourceEstimate: { value: 'cpu only', source: 'agent-inference', confidence: 0.8 },
    ablations: ['w/o x'],
    supportCriteria: ['acc > baseline'],
    refuteCriteria: ['acc <= baseline'],
    invalidRunCriteria: ['nan loss'],
    stopConditions: ['budget out'],
    generatedAt: 1,
    generator: 'test',
  };
  expect(validateProtocolProposal(proposal).errors).toEqual([]);
  return proposal;
}

describe('CLI: confirm protocol leakage gate', () => {
  async function seed(dir: string, proposal: unknown, slices: DatasetSlice[]): Promise<void> {
    const rt = await openRuntime(dir, { recover: false });
    try {
      for (const entry of slices) {
        await rt.db.upsertSlice({
          sliceId: entry.sliceId,
          datasetSnapshotId: entry.datasetSnapshotId,
          scale: entry.scale,
          record: entry as unknown as Record<string, unknown>,
          createdAt: entry.generatedAt,
        });
      }
      const run = await createDemoRun(rt, 'leak seed');
      const task = await rt.db.claimNextTask(run.runId, 'seed-worker', { leaseMs: 60_000 });
      const staged = await rt.store.stage(
        'protocol-proposal',
        `${JSON.stringify(proposal, null, 2)}\n`,
        {},
      );
      await rt.db.beginCommit({
        taskId: task!.taskId,
        workerId: 'seed-worker',
        attempt: task!.attempt,
        artifacts: [
          {
            kind: 'protocol-proposal',
            tempPath: staged.tempPath,
            contentHash: staged.contentHash,
            size: staged.size,
            meta: staged.meta,
          },
        ],
        result: { summary: 'seeded', artifacts: [] },
      });
      await rt.store.promote([staged]);
      await rt.db.finalizeCommit({ taskId: task!.taskId, workerId: 'seed-worker' });
    } finally {
      await rt.close();
    }
  }

  it('refuses to lock when leakage blockers exist; locks with pending notes otherwise', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-leak-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    const proposal = await validProposal();

    // Mixed snapshots → blocker → confirm refuses.
    await seed(dir, proposal, [
      slice(),
      slice({ sliceId: 'ds-other-quick', datasetSnapshotId: 'data-other', scale: 'quick' }),
    ]);
    const blocked = await runCli(dir, ['confirm', 'protocol', '--json']);
    expect(blocked.code).toBe(2);
    const blockedPayload = JSON.parse(blocked.stdout) as {
      locked: boolean;
      errors: string[];
    };
    expect(blockedPayload.locked).toBe(false);
    expect(blockedPayload.errors.join(' ')).toContain('mixed snapshots');

    // Fresh project for the passing case (blockers are immutable history).
    const dir2 = await mkdtemp(join(tmpdir(), 'ideaseek-leak-'));
    expect((await runCli(dir2, ['init'])).code).toBe(0);
    await seed(dir2, proposal, [
      slice({ sliceId: 'ok-smoke', scale: 'smoke', stats: { totalRows: 50, selectedRows: 1 } }),
      slice({ sliceId: 'ok-quick', scale: 'quick', stats: { totalRows: 50, selectedRows: 5 } }),
    ]);
    const passed = await runCli(dir2, ['confirm', 'protocol', '--by', 'researcher', '--json']);
    expect(passed.code).toBe(0);
    const passedPayload = JSON.parse(passed.stdout) as {
      locked: boolean;
      confirmations: string[];
    };
    expect(passedPayload.locked).toBe(true);
    expect(passedPayload.confirmations.join(' ')).toContain('row-level rule v1');
  }, 60_000);
});
