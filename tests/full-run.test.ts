import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, createDemoRun, makeProjectDir, openRuntime } from './helpers.js';

/**
 * Platform-executed Full Research run (docs/FULL_RESEARCH_MODE.md 全量
 * 实验, docs/DATA_SCALE_POLICY 平台内执行路线): `full run` enqueues ONE
 * `full.run` task on the existing ResearchRun — same worker, FaultSpec,
 * quota/network blocking, pause semantics and registry as everything
 * else. Approval + fairness + entries are re-verified at enqueue and
 * inside the handler. Fake harness + local fixture repos only: no GPU,
 * no network, no real training.
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

function git(cwd: string, args: string[]): void {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr ?? ''}`);
  }
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
    protocolId: 'proto-fullrun-v1',
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
        entry: 'python eval.py',
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
    const run = await createDemoRun(rt, 'full-run protocol seed');
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

async function seedBaseline(dir: string, specId: string, scaleNote: string): Promise<void> {
  const spec = {
    specId,
    version: 1,
    idea: null,
    comparisonIds: ['fedavg'],
    codeCommit: null,
    dataSnapshotId: 'synthetic:baseline',
    sliceIds: [],
    environment: { python: 'v24', notes: [scaleNote] },
    command: ['python', '-c', 'pass'],
    metrics: [{ name: 'rare-class recall', direction: 'higher' }],
    seeds: [42, 43],
    resources: {},
    budget: { maxRuns: 1, maxMinutes: 1 },
    protocolId: null,
    createdAt: 1,
  };
  const specPath = join(dir, `${specId}-spec.json`);
  await writeFile(specPath, JSON.stringify(spec), 'utf8');
  expect((await runCli(dir, ['experiment', 'spec', specPath])).code).toBe(0);
  const result = {
    specId,
    status: 'succeeded',
    logRefs: [],
    artifactRefs: [],
    metrics: [{ name: 'rare-class recall', value: 0.1 }],
    resourcesUsed: {},
    failure: null,
    startedAt: 1,
    finishedAt: 2,
  };
  const resultPath = join(dir, `${specId}-result.json`);
  await writeFile(resultPath, JSON.stringify(result), 'utf8');
  expect((await runCli(dir, ['experiment', 'result', resultPath])).code).toBe(0);
}

/** Builds a local git fixture repo whose eval.py prints protocol metrics. */
async function makeMethodRepo(dir: string): Promise<string> {
  const repo = join(dir, 'method-repo');
  mkdirSync(repo, { recursive: true });
  await writeFile(
    join(repo, 'eval.py'),
    'import json\nprint(json.dumps({"metrics": {"rare-class recall": 0.42, "F1": 0.4}}))\n',
    'utf8',
  );
  await writeFile(join(repo, 'LICENSE'), 'MIT License\n\nPermission is hereby granted\n', 'utf8');
  git(repo, ['init']);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'fixture']);
  return repo;
}

/** Full HANDOFF_READY project (mirrors the full-plan READY walk). */
async function setupApprovedFullProject(dir: string): Promise<void> {
  const cardPath = join(dir, 'card.json');
  await writeFile(cardPath, JSON.stringify(makeCard('alpha')), 'utf8');
  expect((await runCli(dir, ['idea', 'create', 'alpha', '--from-card', cardPath])).code).toBe(0);
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
  expect((await runCli(dir, ['idea', 'set-status', 'alpha', 'IMPLEMENTING'])).code).toBe(0);
  expect((await runCli(dir, ['idea', 'scaffold', 'alpha'])).code).toBe(0);
  await writeFile(
    join(dir, 'ideas', 'alpha', 'src', 'train.py'),
    'import json\nprint(json.dumps({"metrics": {"rare-class recall": 0.5}}))\n',
    'utf8',
  );
  // The check ladder runs src/smoke.py, not train.py: this fixture used to
  // pass on the scaffold's self-declared synthetic smoke.
  await writeFile(
    join(dir, 'ideas', 'alpha', 'src', 'smoke.py'),
    'import json\nprint(json.dumps({"metrics": {"rare-class recall": 0.5}}))\n',
    'utf8',
  );
  const trainPath = join(dir, 'ideas', 'alpha', 'config', 'train.json');
  const train = JSON.parse(await readFile(trainPath, 'utf8')) as Record<string, unknown>;
  train.seeds = [42, 7];
  // Modest declared resources: the full-run admission gate needs
  // headroom + this request under the host's free memory — keep the
  // fixture friendly to small-RAM CI boxes (gpus 0 → no GPU required).
  train.resources = { gpus: 0, memoryGiB: 0.5 };
  await writeFile(trainPath, JSON.stringify(train), 'utf8');
  expect((await runCli(dir, ['idea', 'check', 'alpha'])).code).toBe(0);
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

  await seedBaseline(dir, 'base-fedavg', 'scale:smoke');
  await seedBaseline(dir, 'repro-fedavg-quick', 'scale:quick');

  const analyze = await runCli(dir, ['idea', 'analyze', 'alpha', '--json']);
  expect(analyze.code, analyze.stdout + analyze.stderr).toBe(0);
  const analysis = JSON.parse(analyze.stdout) as { analysis: { verdict: string } };
  expect(analysis.analysis.verdict, analyze.stdout).toBe('supported');

  expect((await runCli(dir, ['run', '--question', 'full run test', '--enqueue-only'])).code).toBe(
    0,
  );

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
    plan: { readiness: { ready: boolean; blockers: string[] }; inputHash: string };
  };
  expect(planned.plan.readiness.ready, JSON.stringify(planned.plan.readiness.blockers)).toBe(true);

  const approved = await runCli(dir, ['full', 'approve', '--idea', 'alpha', '--confirm', '--json']);
  expect(approved.code, approved.stdout + approved.stderr).toBe(0);
}

describe('ideaseek full run (platform-executed full research)', () => {
  it('refuses launch without confirm, without approval, and in review-only mode', async () => {
    const dir = await makeProjectDir();
    const cardPath = join(dir, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard('alpha')), 'utf8');
    expect((await runCli(dir, ['idea', 'create', 'alpha', '--from-card', cardPath])).code).toBe(0);

    // Guided launch needs --confirm (cheapest refusal — before any db work).
    const noConfirm = await runCli(dir, ['full', 'run', '--idea', 'alpha']);
    expect(noConfirm.code).toBe(2);
    expect(noConfirm.stderr).toContain('--confirm');

    // Plan exists but is not approved → actionable refusal.
    expect((await runCli(dir, ['full', 'plan', '--idea', 'alpha'])).code).toBe(0);
    const unapproved = await runCli(dir, ['full', 'run', '--idea', 'alpha', '--confirm']);
    expect(unapproved.code).not.toBe(0);
    expect(unapproved.stderr).toContain('full approve');

    // review-only refuses the protected full-research launch outright.
    const configPath = join(dir, 'research.yaml');
    const config = await readFile(configPath, 'utf8');
    await writeFile(
      configPath,
      config.replace('autonomy_mode: guided', 'autonomy_mode: review-only'),
      'utf8',
    );
    const refused = await runCli(dir, ['full', 'run', '--idea', 'alpha', '--confirm']);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('review-only');
    expect(refused.stderr).toContain('full-research');
  }, 180_000);

  it('executes the approved work list idempotently with faults and stale guards', async () => {
    const dir = await makeProjectDir();
    await setupApprovedFullProject(dir);

    // Required method without a runnable entry → refuse with recovery.
    const noEntry = await runCli(dir, [
      'full',
      'run',
      '--idea',
      'alpha',
      '--confirm',
      '--enqueue-only',
    ]);
    expect(noEntry.code).not.toBe(0);
    expect(noEntry.stderr).toContain('no runnable entry');
    expect(noEntry.stderr).toContain('baseline repair');

    // Give fedavg a real worktree + metrics-printing entry.
    const repo = await makeMethodRepo(dir);
    expect((await runCli(dir, ['comparison', 'import', 'fedavg', repo, '--json'])).code).toBe(0);
    expect((await runCli(dir, ['comparison', 'set-status', 'fedavg', 'implemented'])).code).toBe(0);
    const repair = await runCli(dir, [
      'baseline',
      'repair',
      '--method',
      'fedavg',
      '--entry',
      'python eval.py',
      '--json',
    ]);
    expect(repair.code, repair.stdout + repair.stderr).toBe(0);

    // Comparison state changed → fairness + plan must be re-confirmed.
    expect((await runCli(dir, ['full', 'fairness', '--idea', 'alpha', '--json'])).code).toBe(0);
    const reFairness = await runCli(dir, [
      'full',
      'fairness',
      '--idea',
      'alpha',
      '--confirm',
      '--json',
    ]);
    expect(reFairness.code, reFairness.stdout + reFairness.stderr).toBe(0);
    expect((await runCli(dir, ['full', 'plan', '--idea', 'alpha', '--json'])).code).toBe(0);
    const reapprove1 = await runCli(dir, [
      'full',
      'approve',
      '--idea',
      'alpha',
      '--confirm',
      '--json',
    ]);
    expect(reapprove1.code, reapprove1.stdout + reapprove1.stderr).toBe(0);

    // A further comparison change → the approved plan is stale.
    expect(
      (
        await runCli(dir, [
          'comparison',
          'register',
          'stale-check',
          '--repo',
          'https://example.org/stale.git',
          '--reference-only',
        ])
      ).code,
    ).toBe(0);
    const stale = await runCli(dir, [
      'full',
      'run',
      '--idea',
      'alpha',
      '--confirm',
      '--enqueue-only',
    ]);
    expect(stale.code, stale.stdout + stale.stderr).not.toBe(0);
    expect(stale.stderr).toContain('stale');

    // Re-plan + re-approve (same dance as full plan/approve).
    expect((await runCli(dir, ['full', 'plan', '--idea', 'alpha', '--json'])).code).toBe(0);
    const reapproved = await runCli(dir, [
      'full',
      'approve',
      '--idea',
      'alpha',
      '--confirm',
      '--json',
    ]);
    expect(reapproved.code, reapproved.stdout + reapproved.stderr).toBe(0);

    // Enqueue-only shows the work list without executing.
    const queued = await runCli(dir, [
      'full',
      'run',
      '--idea',
      'alpha',
      '--confirm',
      '--enqueue-only',
      '--json',
    ]);
    expect(queued.code, queued.stdout + queued.stderr).toBe(0);
    const queuePayload = JSON.parse(queued.stdout) as {
      enqueued: boolean;
      work: { kind: string; id: string }[];
      decisionSeq: number | null;
    };
    expect(queuePayload.work.map((item) => `${item.kind}:${item.id}`)).toEqual([
      'comparison:fedavg',
      'idea:alpha',
    ]);
    expect(queuePayload.decisionSeq).not.toBeNull();

    // Inline execution: full-fedavg + idea-alpha run through the shared
    // runner; report artifact lands; Decision recorded.
    const executed = await runCli(
      dir,
      ['full', 'run', '--idea', 'alpha', '--confirm', '--json'],
      300_000,
    );
    if (executed.code !== 0) {
      const execEarly = JSON.parse(executed.stdout) as { runId: string };
      const dbg = await openRuntime(dir, { recover: false });
      try {
        const tasks = await dbg.db.listTasks(execEarly.runId);
        console.error(
          'FULL RUN TASK ERRORS:',
          tasks
            .filter((task) => task.error)
            .map((task) => `${task.type}: ${task.error!.code} ${task.error!.message}`)
            .join(' | '),
        );
      } finally {
        await dbg.close();
      }
    }
    expect(executed.code, executed.stdout + executed.stderr).toBe(0);
    const execPayload = JSON.parse(executed.stdout) as {
      runId: string;
      status: string;
      exitReason: string;
      decisionSeq: number | null;
      planInputHash: string;
    };
    expect(execPayload.exitReason).toBe('completed');
    expect(execPayload.status).toBe('COMPLETED');
    expect(execPayload.decisionSeq).not.toBeNull();
    expect(execPayload.planInputHash.startsWith('sha256:')).toBe(true);

    const rt = await openRuntime(dir, { recover: false });
    try {
      const comparison = await rt.db.getExperiment('full-fedavg');
      expect(comparison?.status).toBe('succeeded');
      const compMetrics = (comparison?.result as { metrics?: { name: string; value: number }[] })
        .metrics!;
      expect(compMetrics.map((m) => m.name).sort()).toEqual(['F1', 'rare-class recall']);
      const idea = await rt.db.getExperiment('idea-alpha');
      expect(idea?.status).toBe('succeeded');
      const reports = await rt.db.listArtifactsByKind('full-run-report');
      expect(reports.length).toBeGreaterThan(0);
      // listArtifactsByKind is oldest-first — the latest report is last.
      const report = JSON.parse(
        await rt.store.readFinalText(reports[reports.length - 1]!.contentHash),
      ) as {
        items: { id: string; status: string }[];
      };
      expect(report.items.map((item) => `${item.status}:${item.id}`)).toEqual([
        'succeeded:fedavg',
        'succeeded:alpha',
      ]);
    } finally {
      await rt.close();
    }

    // Executing changed registry state (new succeeded specs) → fairness
    // and plan are stale BY DESIGN; re-confirm before re-running.
    expect((await runCli(dir, ['full', 'fairness', '--idea', 'alpha', '--json'])).code).toBe(0);
    const postFairness = await runCli(dir, [
      'full',
      'fairness',
      '--idea',
      'alpha',
      '--confirm',
      '--json',
    ]);
    expect(postFairness.code, postFairness.stdout + postFairness.stderr).toBe(0);
    expect((await runCli(dir, ['full', 'plan', '--idea', 'alpha', '--json'])).code).toBe(0);
    const postApprove = await runCli(dir, [
      'full',
      'approve',
      '--idea',
      'alpha',
      '--confirm',
      '--json',
    ]);
    expect(postApprove.code, postApprove.stdout + postApprove.stderr).toBe(0);

    // Idempotent re-run: unchanged specs are skipped, nothing re-executes.
    const again = await runCli(
      dir,
      ['full', 'run', '--idea', 'alpha', '--confirm', '--json'],
      300_000,
    );
    expect(again.code, again.stdout + again.stderr).toBe(0);
    const rt2 = await openRuntime(dir, { recover: false });
    try {
      const reports = await rt2.db.listArtifactsByKind('full-run-report');
      const report = JSON.parse(
        await rt2.store.readFinalText(reports[reports.length - 1]!.contentHash),
      ) as {
        items: { id: string; status: string }[];
      };
      expect(report.items.every((item) => item.status === 'skipped')).toBe(true);
    } finally {
      await rt2.close();
    }

    // Retryable injected failure: attempt 1 fails, the retry succeeds.
    const retried = await runCli(
      dir,
      [
        'full',
        'run',
        '--idea',
        'alpha',
        '--confirm',
        '--fault',
        '{"full.run":{"failTimes":1}}',
        '--json',
      ],
      300_000,
    );
    expect(retried.code, retried.stdout + retried.stderr).toBe(0);
    const retryPayload = JSON.parse(retried.stdout) as { exitReason: string };
    expect(retryPayload.exitReason).toBe('completed');

    // Injected quota exhaustion parks the run (existing blocker machinery).
    const blocked = await runCli(
      dir,
      [
        'full',
        'run',
        '--idea',
        'alpha',
        '--confirm',
        '--fault',
        '{"full.run":{"blockCode":"QUOTA_EXHAUSTED"}}',
        '--json',
      ],
      300_000,
    );
    expect(blocked.code, blocked.stdout + blocked.stderr).toBe(2);
    const blockedPayload = JSON.parse(blocked.stdout) as {
      status: string;
      blockReason: string | null;
    };
    expect(blockedPayload.status).toBe('QUOTA_EXHAUSTED');
    expect(blockedPayload.blockReason ?? '').toContain('quota');
  }, 600_000);

  it('handler re-verifies authorization: a stale enqueue never executes', async () => {
    const dir = await makeProjectDir();
    await setupApprovedFullProject(dir);

    // fedavg needs a runnable entry before the enqueue gate passes.
    const repo = await makeMethodRepo(dir);
    expect((await runCli(dir, ['comparison', 'import', 'fedavg', repo, '--json'])).code).toBe(0);
    expect((await runCli(dir, ['comparison', 'set-status', 'fedavg', 'implemented'])).code).toBe(0);
    const repair = await runCli(dir, [
      'baseline',
      'repair',
      '--method',
      'fedavg',
      '--entry',
      'python eval.py',
      '--json',
    ]);
    expect(repair.code, repair.stdout + repair.stderr).toBe(0);
    expect((await runCli(dir, ['full', 'fairness', '--idea', 'alpha', '--json'])).code).toBe(0);
    expect(
      (await runCli(dir, ['full', 'fairness', '--idea', 'alpha', '--confirm', '--json'])).code,
    ).toBe(0);
    expect((await runCli(dir, ['full', 'plan', '--idea', 'alpha', '--json'])).code).toBe(0);
    const reapproved = await runCli(dir, [
      'full',
      'approve',
      '--idea',
      'alpha',
      '--confirm',
      '--json',
    ]);
    expect(reapproved.code, reapproved.stdout + reapproved.stderr).toBe(0);

    const queued = await runCli(dir, [
      'full',
      'run',
      '--idea',
      'alpha',
      '--confirm',
      '--enqueue-only',
      '--json',
    ]);
    expect(queued.code, queued.stdout + queued.stderr).toBe(0);
    const queuePayload = JSON.parse(queued.stdout) as { runId: string; planInputHash: string };

    // State moves after enqueue (new required comparison, no entry) — the
    // handler's re-verification must refuse instead of running stale.
    expect(
      (
        await runCli(dir, [
          'comparison',
          'register',
          'late-method',
          '--repo',
          'https://example.org/late.git',
        ])
      ).code,
    ).toBe(0);

    const executed = await runCli(dir, ['run', '--run', queuePayload.runId, '--json'], 300_000);
    expect(executed.code, executed.stdout + executed.stderr).not.toBe(0);

    const rt = await openRuntime(dir, { recover: false });
    try {
      const tasks = await rt.db.listTasks(queuePayload.runId);
      const fullTask = tasks.find((task) => task.type === 'full.run');
      expect(fullTask?.status).toBe('failed');
      expect(fullTask?.error?.message ?? '').toMatch(/plan changed|no runnable entry|stale/);
    } finally {
      await rt.close();
    }
  }, 600_000);
});
