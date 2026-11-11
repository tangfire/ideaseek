import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, createDemoRun, makeProjectDir, openRuntime } from './helpers.js';

/**
 * Pending approvals + REPL confirmation block (docs/TERMINAL_UX 审批界面):
 * `ideaseek pending` lists protocol locks, code revisions and
 * pending-approval Decisions; the REPL shows the block at startup and via
 * /pending, /approve [n] relays the existing commands, bare numbers pick
 * items, and decision items stay review-only.
 */

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[], timeoutMs = 60_000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli ${args.join(' ')} timed out`));
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

interface Repl {
  output(): string;
  write(data: string): void;
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<string>;
  quit(): Promise<{ code: number; stdout: string }>;
}

function startRepl(cwd: string): Repl {
  const child = spawn(process.execPath, [CLI_BIN, 'interactive'], {
    cwd,
    env: { ...process.env, IDEASEEK_CLI: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += String(chunk)));
  child.stderr.on('data', (chunk) => (stdout += String(chunk)));
  child.stdin.on('error', () => {});
  const output = () => stdout;
  const waitFor = (pattern: RegExp, timeoutMs = 20_000): Promise<string> =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (pattern.test(output())) {
          clearInterval(timer);
          resolve(output());
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`timeout waiting for ${pattern}; output:\n${output()}`));
        }
      }, 80);
    });
  const quit = (): Promise<{ code: number; stdout: string }> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`repl did not exit; output:\n${output()}`));
      }, 20_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout });
      });
      child.stdin.write('/quit\n');
      setTimeout(() => child.stdin.end(), 1_500);
    });
  return { output, write: (d) => child.stdin.write(d), waitFor, quit };
}

interface PendingItem {
  id: string;
  kind: string;
  summary: string;
  approve: { label: string; cliArgs: string[] } | null;
}

function validProposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

describe('ideaseek pending (CLI)', () => {
  it('reports nothing waiting on a fresh project', async () => {
    const dir = await makeProjectDir();
    const shown = await runCli(dir, ['pending']);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain('nothing waiting for approval');
    const json = await runCli(dir, ['pending', '--json']);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ pending: 0, items: [] });
  });

  it('lists an unlocked protocol proposal and clears after confirm', async () => {
    const dir = await makeProjectDir();
    await seedProposal(dir, validProposal());

    const pending = await runCli(dir, ['pending', '--json']);
    expect(pending.code).toBe(2);
    const payload = JSON.parse(pending.stdout) as { pending: number; items: PendingItem[] };
    expect(payload.pending).toBe(1);
    expect(payload.items[0]).toMatchObject({ kind: 'protocol', id: 'protocol:proto-abc123-v1' });
    expect(payload.items[0]!.approve?.cliArgs).toEqual(['confirm', 'protocol', '--by', 'user']);

    expect((await runCli(dir, ['confirm', 'protocol', '--by', 'user'])).code).toBe(0);
    const after = await runCli(dir, ['pending', '--json']);
    expect(after.code).toBe(0);
    expect(JSON.parse(after.stdout)).toMatchObject({ pending: 0 });
  }, 60_000);

  it('lists pending-approval decisions as review-only items', async () => {
    const dir = await makeProjectDir();
    expect((await runCli(dir, ['run', '--question', 'pending test', '--enqueue-only'])).code).toBe(
      0,
    );
    expect((await runCli(dir, ['decision', 'propose', 'raise', 'the', 'budget'])).code).toBe(0);

    const pending = await runCli(dir, ['pending', '--json']);
    expect(pending.code).toBe(2);
    const payload = JSON.parse(pending.stdout) as { items: PendingItem[] };
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toMatchObject({ kind: 'decision', approve: null });
    expect(payload.items[0]!.summary).toContain('raise the budget');
  }, 60_000);

  it('lists baseline code revisions awaiting acceptance', async () => {
    const dir = await makeProjectDir();
    const rt = await openRuntime(dir, { recover: false });
    try {
      await rt.db.upsertComparison({
        methodId: 'method-b',
        status: 'repairing',
        required: true,
        record: {
          methodId: 'method-b',
          status: 'repairing',
          repair: { outcome: 'confirmation-required', attempts: 2 },
          updatedAt: Date.now(),
        } as unknown as Record<string, unknown>,
        updatedAt: Date.now(),
      });
    } finally {
      await rt.close();
    }

    const pending = await runCli(dir, ['pending', '--json']);
    expect(pending.code).toBe(2);
    const payload = JSON.parse(pending.stdout) as { items: PendingItem[] };
    expect(payload.items[0]).toMatchObject({ kind: 'repair', id: 'repair:method-b' });
    expect(payload.items[0]!.approve?.cliArgs.slice(0, 3)).toEqual([
      'comparison',
      'set-status',
      'method-b',
    ]);
  }, 60_000);
});

describe('REPL confirmation block', () => {
  it('shows the block at startup and /approve locks the protocol', async () => {
    const dir = await makeProjectDir();
    await seedProposal(dir, validProposal());

    const repl = startRepl(dir);
    await repl.waitFor(/Confirmation required/);
    await repl.waitFor(/lock protocol proposal proto-abc123-v1/);
    await repl.waitFor(/ideaseek ›/);
    repl.write('/approve\n');
    await repl.waitFor(/locked protocol proto-abc123-v1/);
    repl.write('/pending\n');
    await repl.waitFor(/nothing waiting for approval/);
    const done = await repl.quit();
    expect(done.code).toBe(0);
    expect(done.stdout).not.toContain('unknown command: /pending');
  }, 90_000);

  it('bare number selects an item; decisions stay review-only', async () => {
    const dir = await makeProjectDir();
    expect((await runCli(dir, ['run', '--question', 'block test', '--enqueue-only'])).code).toBe(0);
    expect((await runCli(dir, ['decision', 'propose', 'boost', 'idea-001'])).code).toBe(0);

    const repl = startRepl(dir);
    await repl.waitFor(/Confirmation required/);
    await repl.waitFor(/decision {2}boost idea-001/);
    await repl.waitFor(/ideaseek ›/);
    repl.write('1\n');
    await repl.waitFor(/review-only: nothing changes on approve/);
    repl.write('/reject not now\n');
    await repl.waitFor(/recorded rejection/);
    const done = await repl.quit();
    expect(done.code).toBe(0);
    expect(done.stdout).not.toContain('unknown input');
  }, 90_000);

  it('multiple items require an explicit pick via /approve <n>', async () => {
    const dir = await makeProjectDir();
    await seedProposal(dir, validProposal());
    expect((await runCli(dir, ['decision', 'propose', 'swap', 'dataset'])).code).toBe(0);

    const repl = startRepl(dir);
    await repl.waitFor(/Confirmation required/);
    await repl.waitFor(/ideaseek ›/);
    repl.write('/approve\n');
    await repl.waitFor(/pick one: \/approve <n>/);
    repl.write('/approve 1\n');
    await repl.waitFor(/locked protocol proto-abc123-v1/);
    const done = await repl.quit();
    expect(done.code).toBe(0);
  }, 90_000);
});
