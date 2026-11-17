import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, createDemoRun, makeProjectDir, openRuntime } from './helpers.js';
import { assertFairnessApprovable, type FairnessLock } from '../src/full/fairness.js';

/**
 * Full-run comparison fairness lock (docs/FULL_RESEARCH_MODE.md 锁定前
 * 逐方法对齐): machine-checked dimensions derive from recorded specs,
 * declared dimensions ride on the researcher's --confirm, missing inputs
 * are blockers with recovery commands, and confirmation binds to
 * inputHash — state changes force a re-build + re-confirm. The full plan
 * requires the lock to be confirmed+current. Nothing here launches runs.
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

function validProposal(): Record<string, unknown> {
  return {
    protocolId: 'proto-fullfair-v1',
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
    const run = await createDemoRun(rt, 'full-fairness protocol seed');
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

function baseLock(overrides: Partial<FairnessLock> = {}): FairnessLock {
  return {
    contract: 'fairness-lock-v1',
    ideaId: 'alpha',
    inputHash: 'sha256:' + 'a'.repeat(64),
    generatedAt: 1,
    protocol: { protocolId: 'proto-1', protocolHash: 'sha256:' + 'b'.repeat(64) },
    reference: {
      specId: 'idea-alpha',
      dataSnapshotId: 'synthetic:x',
      sliceIds: ['s1'],
      seeds: [42, 7],
      metrics: ['rare-class recall'],
    },
    methods: [],
    blockers: [],
    ...overrides,
  };
}

/** Creates the idea + a succeeded experiment spec for its own run. */
async function setupIdeaWithSpec(dir: string): Promise<void> {
  const cardPath = join(dir, 'card.json');
  await writeFile(cardPath, JSON.stringify(makeCard('alpha')), 'utf8');
  expect((await runCli(dir, ['idea', 'create', 'alpha', '--from-card', cardPath])).code).toBe(0);
  expect((await runCli(dir, ['idea', 'set-status', 'alpha', 'IMPLEMENTING'])).code).toBe(0);
  expect((await runCli(dir, ['idea', 'scaffold', 'alpha'])).code).toBe(0);
  await writeFile(
    join(dir, 'ideas', 'alpha', 'src', 'train.py'),
    'import json\nprint(json.dumps({"metrics": {"rare-class recall": 0.5}}))\n',
    'utf8',
  );
  // The check ladder runs src/smoke.py; these fixtures used to pass on the
  // scaffold's self-declared synthetic smoke.
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
  expect(
    (await runCli(dir, ['idea', 'experiment', 'alpha', '--scale', 'smoke', '--json'])).code,
  ).toBe(0);
}

/** Records a succeeded experiment covering `methodId` (baseline pattern). */
async function seedMethodSpec(dir: string, methodId: string, createdAt: number): Promise<void> {
  const spec = {
    specId: `base-${methodId}`,
    version: 1,
    idea: null,
    comparisonIds: [methodId],
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
    createdAt,
  };
  const specPath = join(dir, `baseline-${methodId}-spec.json`);
  await writeFile(specPath, JSON.stringify(spec), 'utf8');
  expect((await runCli(dir, ['experiment', 'spec', specPath])).code).toBe(0);
  const result = {
    specId: `base-${methodId}`,
    status: 'succeeded',
    logRefs: [],
    artifactRefs: [],
    metrics: [{ name: 'rare-class recall', value: 0.1 }],
    resourcesUsed: {},
    failure: null,
    startedAt: 1,
    finishedAt: 2,
  };
  const resultPath = join(dir, `baseline-${methodId}-result.json`);
  await writeFile(resultPath, JSON.stringify(result), 'utf8');
  expect((await runCli(dir, ['experiment', 'result', resultPath])).code).toBe(0);
}

describe('assertFairnessApprovable (pure gates)', () => {
  it('accepts a fresh, blocker-free lock', () => {
    const lock = baseLock();
    expect(() => assertFairnessApprovable(lock, lock.inputHash)).not.toThrow();
  });

  it('refuses a stale lock (state changed since review)', () => {
    const lock = baseLock();
    expect(() => assertFairnessApprovable(lock, 'sha256:' + 'f'.repeat(64))).toThrow(/stale/);
  });

  it('refuses a lock with blockers and lists them', () => {
    const lock = baseLock({ blockers: ['no locked protocol — run: ideaseek confirm protocol'] });
    try {
      assertFairnessApprovable(lock, lock.inputHash);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as { code: string }).code).toBe('USER_INPUT_REQUIRED');
      expect((error as { message: string }).message).toContain('no locked protocol');
    }
  });
});

describe('ideaseek full fairness (e2e)', () => {
  it('reports blockers with recovery commands instead of failing the draft build', async () => {
    const dir = await makeProjectDir();
    const cardPath = join(dir, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard('alpha')), 'utf8');
    expect((await runCli(dir, ['idea', 'create', 'alpha', '--from-card', cardPath])).code).toBe(0);

    const draft = await runCli(dir, ['full', 'fairness', '--idea', 'alpha', '--json']);
    expect(draft.code, draft.stdout + draft.stderr).toBe(0);
    const payload = JSON.parse(draft.stdout) as {
      confirmed: boolean;
      blockers: string[];
      methods: unknown[];
    };
    expect(payload.confirmed).toBe(false);
    expect(payload.blockers.join(' ')).toContain('no locked protocol');
    expect(payload.blockers.join(' ')).toContain('no experiment spec');
    expect(payload.methods).toEqual([]);

    // Confirm without any reviewed draft (second idea, never drafted) →
    // actionable error pointing at the draft command.
    const cardPath2 = join(dir, 'card2.json');
    await writeFile(cardPath2, JSON.stringify(makeCard('beta')), 'utf8');
    expect((await runCli(dir, ['idea', 'create', 'beta', '--from-card', cardPath2])).code).toBe(0);
    const missing = await runCli(dir, ['full', 'fairness', '--idea', 'beta', '--confirm']);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('ideaseek full fairness --idea beta');

    // Draft exists but blockers remain → confirm refuses with them.
    const blocked = await runCli(dir, ['full', 'fairness', '--idea', 'alpha', '--confirm']);
    expect(blocked.code).not.toBe(0);
    expect(blocked.stderr).toContain('blockers');
    expect(blocked.stderr).toContain('no locked protocol');
  }, 180_000);

  it('review-only mode refuses --confirm but still allows the read-only draft', async () => {
    const dir = await makeProjectDir();
    const cardPath = join(dir, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard('alpha')), 'utf8');
    expect((await runCli(dir, ['idea', 'create', 'alpha', '--from-card', cardPath])).code).toBe(0);

    const configPath = join(dir, 'research.yaml');
    const config = await readFile(configPath, 'utf8');
    await writeFile(
      configPath,
      config.replace('autonomy_mode: guided', 'autonomy_mode: review-only'),
      'utf8',
    );

    const draft = await runCli(dir, ['full', 'fairness', '--idea', 'alpha']);
    expect(draft.code, draft.stdout + draft.stderr).toBe(0);

    const refused = await runCli(dir, ['full', 'fairness', '--idea', 'alpha', '--confirm']);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('review-only');
    expect(refused.stderr).toContain('lock-fairness');
  }, 180_000);

  it('locks, gates the plan, and forces re-confirm when a required comparison appears', async () => {
    const dir = await makeProjectDir();
    await setupIdeaWithSpec(dir);

    // Required comparison with a succeeded experiment + locked protocol.
    expect(
      (
        await runCli(dir, [
          'comparison',
          'register',
          'fedavg',
          '--repo',
          'https://example.org/fedavg.git',
        ])
      ).code,
    ).toBe(0);
    await seedMethodSpec(dir, 'fedavg', 1);
    await seedProtocolProposal(dir);
    expect((await runCli(dir, ['confirm', 'protocol', '--json'])).code).toBe(0);

    // A run exists so the lock Decision/Event is recorded.
    expect(
      (await runCli(dir, ['run', '--question', 'fairness lock run', '--enqueue-only'])).code,
    ).toBe(0);

    const draft = await runCli(dir, ['full', 'fairness', '--idea', 'alpha', '--json']);
    expect(draft.code, draft.stdout + draft.stderr).toBe(0);
    const draftPayload = JSON.parse(draft.stdout) as {
      confirmed: boolean;
      blockers: string[];
      methods: { methodId: string; deviations: string[]; unknowns: string[] }[];
    };
    expect(draftPayload.blockers).toEqual([]);
    expect(draftPayload.confirmed).toBe(false);
    const fedavg = draftPayload.methods.find((entry) => entry.methodId === 'fedavg');
    expect(fedavg).toBeDefined();
    expect(fedavg!.unknowns).toContain('preprocessing'); // declared dimension
    expect(fedavg!.unknowns).toContain('resources');
    // Baseline seeds/snapshot differ from the idea spec → recorded, not hidden.
    expect(fedavg!.deviations.length).toBeGreaterThan(0);

    const confirmed = await runCli(dir, [
      'full',
      'fairness',
      '--idea',
      'alpha',
      '--confirm',
      '--json',
    ]);
    expect(confirmed.code, confirmed.stdout + confirmed.stderr).toBe(0);
    const confirmedPayload = JSON.parse(confirmed.stdout) as {
      confirmed: boolean;
      decisionSeq: number | null;
      inputHash: string;
    };
    expect(confirmedPayload.confirmed).toBe(true);
    expect(confirmedPayload.decisionSeq).not.toBeNull();

    // Plan sees the lock as confirmed+current (readiness may still be
    // false for OTHER reasons — dual-scale/handoff — not fairness).
    const plan = await runCli(dir, ['full', 'plan', '--idea', 'alpha', '--json']);
    expect(plan.code, plan.stdout + plan.stderr).toBe(0);
    const planned = JSON.parse(plan.stdout) as {
      plan: { fairness: { current: boolean; confirmed: boolean } };
    };
    expect(planned.plan.fairness.confirmed).toBe(true);
    expect(planned.plan.fairness.current).toBe(true);

    // A NEW required comparison without an experiment: stored lock is
    // stale first, then the rebuilt draft blocks with a recovery command
    // (a required method can never be skipped silently).
    expect(
      (
        await runCli(dir, [
          'comparison',
          'register',
          'zz-late',
          '--repo',
          'https://example.org/late.git',
        ])
      ).code,
    ).toBe(0);
    const stale = await runCli(dir, ['full', 'fairness', '--idea', 'alpha', '--confirm']);
    expect(stale.code).not.toBe(0);
    expect(stale.stderr).toContain('stale');

    const rebuilt = await runCli(dir, ['full', 'fairness', '--idea', 'alpha', '--json']);
    expect(rebuilt.code, rebuilt.stdout + rebuilt.stderr).toBe(0);
    const rebuiltPayload = JSON.parse(rebuilt.stdout) as { blockers: string[] };
    expect(rebuiltPayload.blockers.join(' ')).toContain('zz-late');
    expect(rebuiltPayload.blockers.join(' ')).toContain('no succeeded experiment');

    const blockedConfirm = await runCli(dir, ['full', 'fairness', '--idea', 'alpha', '--confirm']);
    expect(blockedConfirm.code).not.toBe(0);
    expect(blockedConfirm.stderr).toContain('zz-late');

    // Recovery: give zz-late a succeeded experiment, rebuild the draft
    // (confirm never auto-rebuilds — the researcher re-reviews), confirm.
    await seedMethodSpec(dir, 'zz-late', 2);
    expect((await runCli(dir, ['full', 'fairness', '--idea', 'alpha', '--json'])).code).toBe(0);
    const recovered = await runCli(dir, [
      'full',
      'fairness',
      '--idea',
      'alpha',
      '--confirm',
      '--json',
    ]);
    expect(recovered.code, recovered.stdout + recovered.stderr).toBe(0);
    expect((JSON.parse(recovered.stdout) as { confirmed: boolean }).confirmed).toBe(true);
  }, 300_000);
});

describe('a baseline row must come from a run whose subject is that baseline', () => {
  it('refuses to grade the idea against itself', async () => {
    // The defect: `covering` indexed experiments by comparisonIds, and the
    // idea's own experiment lists the baselines it faces. Being the newest
    // succeeded run, it always won — so the fairness lock compared
    // `idea-alpha` to `idea-alpha`: identical seeds, identical snapshot, and
    // `aligned` on every dimension. A full run would have been authorised with
    // no baseline evidence behind the lock at all. This is #23's contamination
    // in the gate that is supposed to prevent exactly that.
    const dir = await makeProjectDir();
    await setupIdeaWithSpec(dir);
    expect(
      (
        await runCli(dir, [
          'comparison',
          'register',
          'fedavg',
          '--repo',
          'https://example.org/fedavg.git',
        ])
      ).code,
    ).toBe(0);
    await seedProtocolProposal(dir);
    expect((await runCli(dir, ['confirm', 'protocol', '--json'])).code).toBe(0);
    expect(
      (await runCli(dir, ['run', '--question', 'fairness self-compare run', '--enqueue-only']))
        .code,
    ).toBe(0);

    // Only the idea's own run exists, so the lock must NOT claim fedavg is
    // aligned: there is no run whose subject is fedavg.
    const draft = await runCli(dir, ['full', 'fairness', '--idea', 'alpha', '--json']);
    const payload = JSON.parse(draft.stdout) as {
      blockers: string[];
      methods: { methodId: string; deviations: string[]; unknowns: string[] }[];
    };
    const fedavg = payload.methods.find((entry) => entry.methodId === 'fedavg');
    expect(fedavg).toBeDefined();
    expect(payload.blockers.join(' ')).toContain('no succeeded experiment');
    // The honest shape: nothing to compare is reported as *unknown*, not
    // invented as a deviation and not smoothed into alignment. A gate that
    // manufactures either flavour teaches the operator to ignore it.
    expect(fedavg!.deviations).toEqual([]);
    // Every fairness dimension is unknown here — including the two that the
    // old code claimed were aligned by reading the idea's own spec.
    // Asserted by content, not by an exact array: what matters for this defect
    // is that the two dimensions the old code claimed were aligned by reading
    // the idea's own spec are now honestly unknown.
    expect(fedavg!.unknowns).toContain('data-split');
    expect(fedavg!.unknowns).toContain('seeds-repeats');
    expect(fedavg!.unknowns.join(' ')).not.toContain('same slices');
  }, 180_000);
});
