import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeProtocolHash,
  lockProtocolProposal,
  validateProtocolProposal,
} from '../src/experiment/protocol.js';
import type { ProjectRuntime } from '../src/workflow/runtime.js';
import { CLI_BIN, createDemoRun, makeProjectDir, openRuntime } from './helpers.js';

function validProposal(overrides: Record<string, unknown> = {}) {
  return {
    protocolId: 'proto-abc123-v1',
    version: 1,
    taskDefinition: {
      value: 'binary classification of user churn',
      source: 'paper-evidence',
      confidence: 0.9,
    },
    sampleUnit: { value: 'one customer row', source: 'data-probe', confidence: 0.85 },
    labelSemantics: { value: 'churned = cancelled within 30 days', source: 'user', confidence: 1 },
    splitRules: {
      value: ['time-based 70/15/15 split on signup date'],
      source: 'adapter-rule',
      confidence: 0.8,
    },
    leakageChecks: ['no post-cutoff features in train split'],
    preprocessing: ['median imputation fit on train only'],
    baselineEntries: [
      {
        methodId: 'logreg',
        entry: 'python train.py --model logreg',
        source: 'code',
        confidence: 0.9,
      },
    ],
    primaryMetrics: [
      { name: 'AUROC', direction: 'higher', source: 'paper-evidence', confidence: 0.9 },
    ],
    secondaryMetrics: [
      { name: 'F1', direction: 'higher', source: 'paper-evidence', confidence: 0.8 },
    ],
    statisticalSummary: ['mean ± std over 5 seeds'],
    smokeTest: { value: '500 rows, 1 epoch', source: 'adapter-rule', confidence: 0.85 },
    resourceEstimate: {
      value: '1 GPU-hour per quick run',
      source: 'agent-inference',
      confidence: 0.6,
    },
    ablations: ['w/o reweighting head'],
    supportCriteria: ['AUROC ≥ baseline + 0.02 on quick slice'],
    refuteCriteria: ['AUROC < baseline on 3 seeds'],
    invalidRunCriteria: ['data loader produced NaN'],
    stopConditions: ['budget exhausted or 3 rounds without gain'],
    generatedAt: 1,
    generator: 'protocol-synth-v1',
    ...overrides,
  };
}

describe('validateProtocolProposal', () => {
  it('accepts a complete proposal and lists low-confidence confirmations', () => {
    const result = validateProtocolProposal(validProposal());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.confirmations.join(' ')).toContain('resourceEstimate');
    expect(result.confirmations.join(' ')).toContain('needs user confirmation');
  });

  it('fails on missing provenance and invalid sources', () => {
    const missing = validProposal();
    delete (missing as Record<string, unknown>).sampleUnit;
    const missingResult = validateProtocolProposal(missing);
    expect(missingResult.ok).toBe(false);
    expect(missingResult.errors.join(' ')).toContain('sampleUnit');

    const badSource = validProposal({
      taskDefinition: { value: 'x', source: 'vibes', confidence: 0.9 },
    });
    const sourceResult = validateProtocolProposal(badSource);
    expect(sourceResult.ok).toBe(false);
    expect(sourceResult.errors.join(' ')).toContain('taskDefinition.source');
  });

  it('fails on confidence out of range and empty criteria', () => {
    const badConfidence = validProposal({
      smokeTest: { value: 'x', source: 'agent-inference', confidence: 1.5 },
    });
    expect(validateProtocolProposal(badConfidence).ok).toBe(false);

    const emptyCriteria = validProposal({ supportCriteria: [] });
    const result = validateProtocolProposal(emptyCriteria);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('supportCriteria');
  });

  it('requires direction on metrics and at least one primary/baseline', () => {
    const badMetric = validProposal({
      primaryMetrics: [{ name: 'AUROC', direction: 'sideways', source: 'code', confidence: 0.9 }],
    });
    expect(validateProtocolProposal(badMetric).ok).toBe(false);

    expect(validateProtocolProposal(validProposal({ primaryMetrics: [] })).ok).toBe(false);
    expect(validateProtocolProposal(validProposal({ baselineEntries: [] })).ok).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(validateProtocolProposal(null).ok).toBe(false);
    expect(validateProtocolProposal('proto').ok).toBe(false);
    expect(validateProtocolProposal([]).ok).toBe(false);
  });
});

describe('protocol hashing and locking', () => {
  it('hash is deterministic and content-sensitive', async () => {
    const a = await computeProtocolHash(validProposal());
    const b = await computeProtocolHash(validProposal());
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    const c = await computeProtocolHash(validProposal({ version: 2 }));
    expect(c).not.toBe(a);
  });

  it('lock requires a valid proposal and records provenance', async () => {
    const lock = await lockProtocolProposal(validProposal(), { confirmedBy: 'user', now: 7 });
    expect(lock.protocolId).toBe('proto-abc123-v1');
    expect(lock.confirmedBy).toBe('user');
    expect(lock.lockedAt).toBe(7);
    expect(lock.protocolHash).toMatch(/^sha256:/);

    await expect(
      lockProtocolProposal(validProposal({ primaryMetrics: [] }), { confirmedBy: 'user', now: 8 }),
    ).rejects.toThrow(/cannot lock invalid protocol/);
  });
});

let runtime: ProjectRuntime;

beforeEach(async () => {
  runtime = await openRuntime(await makeProjectDir(), { recover: false });
});

afterEach(async () => {
  await runtime.close();
});

describe('protocol lock registry (db)', () => {
  it('round-trips, is idempotent, and rejects hash conflicts', async () => {
    const proposal = validProposal();
    const lock = await lockProtocolProposal(proposal, { confirmedBy: 'tester', now: 10 });
    await runtime.db.lockProtocol({ ...lock, record: proposal as Record<string, unknown> });

    const fetched = await runtime.db.getProtocolLock(lock.protocolId);
    expect(fetched).toMatchObject({ protocolHash: lock.protocolHash, confirmedBy: 'tester' });
    expect(await runtime.db.listProtocolLocks()).toHaveLength(1);

    // Same content re-lock is a no-op.
    await runtime.db.lockProtocol({ ...lock, record: proposal as Record<string, unknown> });
    expect(await runtime.db.listProtocolLocks()).toHaveLength(1);

    // Different hash for the same id is a conflict.
    await expect(
      runtime.db.lockProtocol({
        ...lock,
        protocolHash: `sha256:${'0'.repeat(64)}`,
        record: proposal as Record<string, unknown>,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
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

describe('CLI: confirm protocol', () => {
  async function seedProposal(dir: string, proposal: unknown): Promise<void> {
    const rt = await openRuntime(dir, { recover: false });
    try {
      const run = await createDemoRun(rt, 'protocol seed');
      const task = await rt.db.claimNextTask(run.runId, 'seed-worker', { leaseMs: 60_000 });
      const staged = await rt.store.stage(
        'protocol-proposal',
        `${JSON.stringify(proposal, null, 2)}\n`,
        { filename: 'protocol-proposal.json' },
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
        result: { summary: 'seeded proposal', artifacts: [] },
      });
      await rt.store.promote([staged]);
      await rt.db.finalizeCommit({ taskId: task!.taskId, workerId: 'seed-worker' });
    } finally {
      await rt.close();
    }
  }

  it('locks a valid proposal, is idempotent, and refuses invalid ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-confirm-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);

    // No proposal yet → actionable error.
    const empty = await runCli(dir, ['confirm', 'protocol', '--json']);
    expect(empty.code).toBe(2);
    expect(empty.stderr).toContain('no protocol proposal found');

    await seedProposal(dir, validProposal());

    const first = await runCli(dir, ['confirm', 'protocol', '--by', 'researcher', '--json']);
    expect(first.code).toBe(0);
    const payload = JSON.parse(first.stdout) as {
      locked: boolean;
      alreadyLocked: boolean;
      protocolHash: string;
      confirmedBy: string;
      confirmations: string[];
    };
    expect(payload.locked).toBe(true);
    expect(payload.alreadyLocked).toBe(false);
    expect(payload.confirmedBy).toBe('researcher');
    expect(payload.protocolHash).toMatch(/^sha256:/);
    expect(payload.confirmations.length).toBeGreaterThan(0);

    const again = await runCli(dir, ['confirm', 'protocol', '--json']);
    expect(again.code).toBe(0);
    expect((JSON.parse(again.stdout) as { alreadyLocked: boolean }).alreadyLocked).toBe(true);

    // Replace with an invalid proposal → refuse with exit 2.
    const rt = await openRuntime(dir, { recover: false });
    try {
      const bad = validProposal();
      delete (bad as Record<string, unknown>).leakageChecks;
      const run2 = await rt.db.createRun({
        projectId: rt.project.id,
        question: 'bad protocol',
        config: rt.config,
      });
      await rt.db.enqueueTask({
        runId: run2.runId,
        type: 'demo.ingest',
        idempotencyKey: 'seed-bad',
        payload: {},
      });
      const task = await rt.db.claimNextTask(run2.runId, 'seed-worker', { leaseMs: 60_000 });
      const staged = await rt.store.stage(
        'protocol-proposal',
        `${JSON.stringify(bad, null, 2)}\n`,
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
        result: { summary: 'bad proposal', artifacts: [] },
      });
      await rt.store.promote([staged]);
      await rt.db.finalizeCommit({ taskId: task!.taskId, workerId: 'seed-worker' });
    } finally {
      await rt.close();
    }

    const invalid = await runCli(dir, ['confirm', 'protocol', '--json']);
    expect(invalid.code).toBe(2);
    const invalidPayload = JSON.parse(invalid.stdout) as { locked: boolean; errors: string[] };
    expect(invalidPayload.locked).toBe(false);
    expect(invalidPayload.errors.join(' ')).toContain('leakageChecks');
  }, 60_000);
});
