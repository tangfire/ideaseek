import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, createDemoRun, makeProjectDir, openRuntime } from './helpers.js';
import { assertApprovable, type FullPlan } from '../src/full/plan.js';

/**
 * Full Research plan/approval (docs/FULL_RESEARCH_MODE.md): the plan is a
 * deterministic lock over persisted state; approval is a protected action
 * bound to the plan's inputHash. Execution stays external — this suite
 * never launches a full run.
 */

function runCli(
  cwd: string,
  args: string[],
  timeoutMs = 180_000,
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

function makeCard(ideaId: string): Record<string, unknown> {
  return {
    ideaId,
    version: 1,
    parentVersion: null,
    status: 'DRAFT_COMPOSITION',
    hypothesis: {
      statement: 'Drift term lifts rare-class recall.',
      targetProblem: 'rare-class gap',
    },
    paperEvidence: [{ paperRef: 'mcmahan17a', statement: 'FedAvg', evidence: 'p.1' }],
    contradictions: ['prior work disagrees'],
    novelty: { claim: 'drift term', uncertainty: 'thin', whyNotRestatement: 'adds a term' },
    mechanismChain: {
      designPrincipleLink: 'compensate drift',
      steps: [{ kind: 'observation', text: 'updates diverge' }],
    },
    nearestComparisons: [{ methodId: 'fedavg', difference: 'adds term', evidence: 'table 2' }],
    componentNecessity: [],
    competingExplanations: ['lr explains it'],
    boundaryConditions: ['label-skew only'],
    risks: ['noise'],
    minimalExperiment: {
      code: 'src/train.py',
      data: 'smoke',
      baselines: ['fedavg'],
      metrics: ['rare-class recall'],
      ablations: ['w/o term'],
    },
    falsification: { conditions: ['no gain'] },
    budget: { maxRounds: 3, maxGpuMinutes: 60 },
    stopConditions: ['budget'],
    createdAt: 1,
  };
}

/** Known-valid protocol proposal (same shape pending-approval seeds). */
function validProposal(): Record<string, unknown> {
  return {
    protocolId: 'proto-fullplan-v1',
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
        methodId: 'fedavg',
        entry: 'python train.py --model fedavg',
        source: 'code',
        confidence: 0.9,
      },
    ],
    primaryMetrics: [
      { name: 'rare-class recall', direction: 'higher', source: 'paper-evidence', confidence: 0.9 },
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
    supportCriteria: ['rare-class recall ≥ baseline + 0.02 on quick slice'],
    refuteCriteria: ['rare-class recall < baseline on 3 seeds'],
    invalidRunCriteria: ['data loader produced NaN'],
    stopConditions: ['budget exhausted or 3 rounds without gain'],
    generatedAt: 1,
    generator: 'protocol-synth-v1',
  };
}

async function seedProtocolProposal(dir: string): Promise<void> {
  const rt = await openRuntime(dir, { recover: false });
  try {
    const run = await createDemoRun(rt, 'full-plan protocol seed');
    const task = await rt.db.claimNextTask(run.runId, 'seed-worker', { leaseMs: 60_000 });
    const staged = await rt.store.stage(
      'protocol-proposal',
      `${JSON.stringify(validProposal(), null, 2)}\n`,
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

function basePlan(overrides: Partial<FullPlan> = {}): FullPlan {
  return {
    contract: 'full-plan-v1',
    ideaId: 'alpha',
    ideaVersion: 1,
    inputHash: 'sha256:' + 'a'.repeat(64),
    generatedAt: 1,
    question: 'q',
    readiness: { ready: true, handoffLevel: 'HANDOFF_READY', blockers: [] },
    lock: {
      protocol: null,
      dataSnapshotId: null,
      sliceIds: [],
      codeCommit: null,
      seeds: [42, 7],
    },
    comparisons: { gateOk: true, required: [], inventory: [], blocking: [] },
    budget: { maxModelCost: 10, maxGpuHours: 100, ideaMaxGpuMinutes: 60, basis: 'test' },
    timeLimit: { ceilingHours: 100, basis: 'test' },
    network: { allowNetwork: false, externalSearch: false, basis: 'test' },
    resources: { gpus: 1, memoryGiB: 16, diskFreeGiB: 100, basis: 'test' },
    licenses: { kinds: ['MIT'], policyNote: 'ok' },
    fairness: {
      present: true,
      confirmed: true,
      current: true,
      inputHash: 'sha256:' + 'c'.repeat(64),
      blockers: [],
    },
    approvalsNeeded: ['confirm question'],
    boundaries: ['draft'],
    ...overrides,
  };
}

describe('assertApprovable (pure gates)', () => {
  it('accepts a fresh, ready plan', () => {
    const plan = basePlan();
    expect(() => assertApprovable(plan, plan.inputHash)).not.toThrow();
  });

  it('refuses a stale plan (state changed since)', () => {
    const plan = basePlan();
    expect(() => assertApprovable(plan, 'sha256:' + 'b'.repeat(64))).toThrow(/stale/);
  });

  it('refuses a not-ready plan with blockers listed', () => {
    const plan = basePlan({
      readiness: { ready: false, handoffLevel: 'PROMISING', blockers: ['seeds 1 < 2'] },
    });
    try {
      assertApprovable(plan, plan.inputHash);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as { code: string }).code).toBe('USER_INPUT_REQUIRED');
      expect((error as { message: string }).message).toContain('seeds 1 < 2');
    }
  });
});

describe('ideaseek full plan / approve (e2e)', () => {
  it('plans a fresh idea as NOT READY with blockers, then refuses approval', async () => {
    const dir = await makeProjectDir();
    const cardPath = join(dir, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard('alpha')), 'utf8');
    expect((await runCli(dir, ['idea', 'create', 'alpha', '--from-card', cardPath])).code).toBe(0);

    const plan = await runCli(dir, ['full', 'plan', '--idea', 'alpha', '--json']);
    expect(plan.code, plan.stdout + plan.stderr).toBe(0);
    const payload = JSON.parse(plan.stdout) as {
      plan: {
        readiness: { ready: boolean; blockers: string[] };
        approvalsNeeded: string[];
        question: string;
        network: { allowNetwork: boolean };
        resources: { gpus: number };
      };
    };
    expect(payload.plan.readiness.ready).toBe(false);
    expect(payload.plan.readiness.blockers.length).toBeGreaterThan(0);
    expect(payload.plan.approvalsNeeded.length).toBeGreaterThan(0);
    expect(payload.plan.question).toContain('Drift term');
    expect(typeof payload.plan.network.allowNetwork).toBe('boolean');
    expect(payload.plan.resources.gpus).toBeGreaterThanOrEqual(0);

    // Not ready → approval refuses with the blockers (after the mode gate).
    const approve = await runCli(dir, ['full', 'approve', '--idea', 'alpha', '--confirm']);
    expect(approve.code).not.toBe(0);
    expect(approve.stderr).toContain('not ready for full research');

    // Missing plan → actionable error.
    const missing = await runCli(dir, ['full', 'approve', '--idea', 'ghost', '--confirm']);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('ideaseek full plan');
  }, 180_000);

  it('guided approval requires --confirm before any readiness work', async () => {
    const dir = await makeProjectDir();
    const cardPath = join(dir, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard('alpha')), 'utf8');
    expect((await runCli(dir, ['idea', 'create', 'alpha', '--from-card', cardPath])).code).toBe(0);
    expect((await runCli(dir, ['full', 'plan', '--idea', 'alpha'])).code).toBe(0);

    const noConfirm = await runCli(dir, ['full', 'approve', '--idea', 'alpha']);
    expect(noConfirm.code).toBe(2);
    expect(noConfirm.stderr).toContain('--confirm');
  }, 180_000);

  it('review-only mode refuses full-research outright', async () => {
    const dir = await makeProjectDir();
    const cardPath = join(dir, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard('alpha')), 'utf8');
    expect((await runCli(dir, ['idea', 'create', 'alpha', '--from-card', cardPath])).code).toBe(0);
    expect((await runCli(dir, ['full', 'plan', '--idea', 'alpha'])).code).toBe(0);

    const configPath = join(dir, 'research.yaml');
    const config = await readFile(configPath, 'utf8');
    await writeFile(
      configPath,
      config.replace('autonomy_mode: guided', 'autonomy_mode: review-only'),
      'utf8',
    );

    const refused = await runCli(dir, ['full', 'approve', '--idea', 'alpha', '--confirm']);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('review-only');
    expect(refused.stderr).toContain('full-research');
  }, 180_000);

  it('approves a READY plan with --confirm and stamps the approval', async () => {
    const dir = await makeProjectDir();
    // Seeds ≥2 so the coverage ladder can pass.
    const cardPath = join(dir, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard('alpha')), 'utf8');
    expect((await runCli(dir, ['idea', 'create', 'alpha', '--from-card', cardPath])).code).toBe(0);
    expect((await runCli(dir, ['idea', 'set-status', 'alpha', 'IMPLEMENTING'])).code).toBe(0);
    expect((await runCli(dir, ['idea', 'scaffold', 'alpha'])).code).toBe(0);
    // The scaffold train.py stub emits names, not metric VALUES — quick
    // scale would (honestly) fail as not-implemented. Give it a real
    // metrics-emitting stub so two scales of evidence can exist.
    await writeFile(
      join(dir, 'ideas', 'alpha', 'src', 'train.py'),
      'import json\nprint(json.dumps({"metrics": {"rare-class recall": 0.5}}))\n',
      'utf8',
    );
    // The check ladder runs src/smoke.py, so this fixture also needs a real
    // smoke; it used to pass on the scaffold's self-declared synthetic one.
    await writeFile(
      join(dir, 'ideas', 'alpha', 'src', 'smoke.py'),
      'import json\nprint(json.dumps({"metrics": {"rare-class recall": 0.5}}))\n',
      'utf8',
    );
    const trainPath = join(dir, 'ideas', 'alpha', 'config', 'train.json');
    const train = JSON.parse(await readFile(trainPath, 'utf8')) as Record<string, unknown>;
    train.seeds = [42, 7];
    await writeFile(trainPath, JSON.stringify(train), 'utf8');
    expect((await runCli(dir, ['idea', 'check', 'alpha'])).code).toBe(0);

    // Two scales: smoke → ANALYZING → NEEDS_REVISION walk → quick.
    expect(
      (await runCli(dir, ['idea', 'experiment', 'alpha', '--scale', 'smoke', '--json'])).code,
    ).toBe(0);
    expect(
      (
        await runCli(dir, [
          'idea',
          'set-status',
          'alpha',
          'NEEDS_REVISION',
          '--reason',
          'second scale',
        ])
      ).code,
    ).toBe(0);
    expect((await runCli(dir, ['idea', 'set-status', 'alpha', 'IMPLEMENTING'])).code).toBe(0);
    expect((await runCli(dir, ['idea', 'check', 'alpha'])).code).toBe(0);
    const quick = await runCli(dir, ['idea', 'experiment', 'alpha', '--scale', 'quick', '--json']);
    expect(quick.code, quick.stdout + quick.stderr).toBe(0);

    // Weak baseline so the idea's 0.5 metric wins → supported verdict.
    const baselineSpec = {
      specId: 'base-fedavg',
      version: 1,
      idea: null,
      comparisonIds: ['fedavg'],
      codeCommit: null,
      dataSnapshotId: 'synthetic:baseline',
      sliceIds: [],
      environment: { python: 'v24', notes: ['scale:smoke'] },
      command: ['python', '-c', 'pass'],
      metrics: [{ name: 'rare-class recall', direction: 'higher' }],
      seeds: [42, 43],
      resources: {},
      budget: { maxRuns: 1, maxMinutes: 1 },
      protocolId: null,
      createdAt: 1,
    };
    await writeFile(join(dir, 'baseline-spec.json'), JSON.stringify(baselineSpec), 'utf8');
    expect((await runCli(dir, ['experiment', 'spec', 'baseline-spec.json'])).code).toBe(0);
    const baselineResult = {
      specId: 'base-fedavg',
      status: 'succeeded',
      logRefs: [],
      artifactRefs: [],
      metrics: [{ name: 'rare-class recall', value: 0.1 }],
      resourcesUsed: {},
      failure: null,
      startedAt: 1,
      finishedAt: 2,
    };
    await writeFile(join(dir, 'baseline-result.json'), JSON.stringify(baselineResult), 'utf8');
    expect((await runCli(dir, ['experiment', 'result', 'baseline-result.json'])).code).toBe(0);

    // Second baseline at the quick scale so BOTH idea scales pair with a
    // weaker control (mixed-scale pairing otherwise downgrades to
    // inconclusive — docs/PROGRESS Phase 6 analysis rules).
    const quickBaseline = {
      ...baselineSpec,
      specId: 'repro-fedavg-quick',
      environment: { python: 'v24', notes: ['scale:quick'] },
    };
    await writeFile(join(dir, 'baseline-quick-spec.json'), JSON.stringify(quickBaseline), 'utf8');
    expect((await runCli(dir, ['experiment', 'spec', 'baseline-quick-spec.json'])).code).toBe(0);
    const quickBaselineResult = { ...baselineResult, specId: 'repro-fedavg-quick' };
    await writeFile(
      join(dir, 'baseline-quick-result.json'),
      JSON.stringify(quickBaselineResult),
      'utf8',
    );
    expect((await runCli(dir, ['experiment', 'result', 'baseline-quick-result.json'])).code).toBe(
      0,
    );

    const analyze = await runCli(dir, ['idea', 'analyze', 'alpha', '--json']);
    expect(analyze.code, analyze.stdout + analyze.stderr).toBe(0);
    const analysis = JSON.parse(analyze.stdout) as { analysis: { verdict: string } };
    expect(analysis.analysis.verdict, analyze.stdout).toBe('supported');

    // A run exists so the approval Decision/Event is recorded.
    expect(
      (await runCli(dir, ['run', '--question', 'full approve run', '--enqueue-only'])).code,
    ).toBe(0);

    // Plan readiness requires a confirmed+current fairness lock, which in
    // turn requires a locked protocol and succeeded specs on both sides.
    await seedProtocolProposal(dir);
    expect((await runCli(dir, ['confirm', 'protocol', '--json'])).code).toBe(0);
    expect((await runCli(dir, ['full', 'fairness', '--idea', 'alpha', '--json'])).code).toBe(0);
    const fairness = await runCli(dir, [
      'full',
      'fairness',
      '--idea',
      'alpha',
      '--confirm',
      '--json',
    ]);
    expect(fairness.code, fairness.stdout + fairness.stderr).toBe(0);

    const plan = await runCli(dir, ['full', 'plan', '--idea', 'alpha', '--json']);
    expect(plan.code, plan.stdout + plan.stderr).toBe(0);
    const planned = JSON.parse(plan.stdout) as {
      plan: {
        readiness: { ready: boolean; blockers: string[] };
        inputHash: string;
        fairness: { current: boolean; confirmed: boolean };
      };
    };
    expect(planned.plan.fairness.confirmed).toBe(true);
    expect(planned.plan.fairness.current).toBe(true);
    expect(planned.plan.readiness.blockers).toEqual([]);
    expect(planned.plan.readiness.ready).toBe(true);

    // Guided: still needs --confirm even when ready.
    const noConfirm = await runCli(dir, ['full', 'approve', '--idea', 'alpha']);
    expect(noConfirm.code).toBe(2);
    expect(noConfirm.stderr).toContain('--confirm');

    const approved = await runCli(dir, [
      'full',
      'approve',
      '--idea',
      'alpha',
      '--confirm',
      '--json',
    ]);
    if (approved.code !== 0) console.error('APPROVE FAIL:', approved.stderr, approved.stdout);
    expect(approved.code, approved.stdout + approved.stderr).toBe(0);
    const approval = JSON.parse(approved.stdout) as {
      approved: boolean;
      decisionSeq: number | null;
      planInputHash: string;
    };
    expect(approval.approved).toBe(true);
    expect(approval.planInputHash).toBe(planned.plan.inputHash);
    expect(approval.decisionSeq).not.toBeNull(); // run exists → Decision recorded

    // Stale: a new comparison changes state → approval refuses until re-plan.
    expect(
      (
        await runCli(dir, [
          'comparison',
          'register',
          'stale-check',
          '--repo',
          'https://example.org/stale.git',
          '--reference-only', // must not flip the required-comparison gate
        ])
      ).code,
    ).toBe(0);
    const stale = await runCli(dir, ['full', 'approve', '--idea', 'alpha', '--confirm']);
    expect(stale.code).not.toBe(0);
    expect(stale.stderr).toContain('stale');

    // Re-plan refreshes the hash → approval works again.
    expect((await runCli(dir, ['full', 'plan', '--idea', 'alpha'])).code).toBe(0);
    const again = await runCli(dir, ['full', 'approve', '--idea', 'alpha', '--confirm']);
    expect(again.code, again.stdout + again.stderr).toBe(0);

    // Autonomous: no --confirm needed, but the Decision/Event is still
    // recorded (mode is not a plan input — only HOW you approve changes).
    const configPath = join(dir, 'research.yaml');
    const config = await readFile(configPath, 'utf8');
    await writeFile(
      configPath,
      config.replace('autonomy_mode: guided', 'autonomy_mode: autonomous'),
      'utf8',
    );
    const auto = await runCli(dir, ['full', 'approve', '--idea', 'alpha', '--json']);
    expect(auto.code, auto.stdout + auto.stderr).toBe(0);
    const autoPayload = JSON.parse(auto.stdout) as {
      approved: boolean;
      mode: string;
      decisionSeq: number | null;
    };
    expect(autoPayload.approved).toBe(true);
    expect(autoPayload.mode).toBe('autonomous');
    expect(autoPayload.decisionSeq).not.toBeNull();
  }, 600_000);
});
