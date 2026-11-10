import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import type { IdeaCard } from '../src/idea/card.js';
import { CLI_BIN } from './helpers.js';

function makeCard(ideaId: string): IdeaCard {
  return {
    ideaId,
    version: 1,
    parentVersion: null,
    status: 'CANDIDATE',
    hypothesis: {
      statement: 'reweighting by calibration error improves rare-class recall',
      targetProblem: 'FedAvg dilutes minority classes',
    },
    paperEvidence: [{ paperRef: 'fedavg-paper', statement: 'uniform averaging', evidence: 'p.5' }],
    contradictions: ['paper B reports no gain where paper A does'],
    novelty: {
      claim: 'calibration-error reweighting',
      uncertainty: 'may collapse with balanced clients',
      whyNotRestatement: 'measurable calibration signal instead of sample counts',
    },
    mechanismChain: {
      designPrincipleLink: 'inverts FedAvg weighting assumption',
      steps: [
        { kind: 'observation', text: 'skewed clients show high calibration error' },
        { kind: 'hypothesis', text: 'down-weighting them reduces dilution' },
        { kind: 'intervention', text: 'server weights by exp(-calibration error)' },
        { kind: 'expected-change', text: 'rare-class recall rises' },
        { kind: 'baseline-difference', text: 'vs sample-count weighting' },
        { kind: 'falsifier', text: 'no recall gain on 3 seeds' },
      ],
    },
    nearestComparisons: [{ methodId: 'fedavg', difference: 'weighting rule', evidence: 'p.3' }],
    componentNecessity: [
      { component: 'probe', role: 'necessary-mechanism', removeEffect: 'gain disappears' },
    ],
    competingExplanations: ['lower effective lr'],
    boundaryConditions: ['no benefit without skew'],
    risks: ['extra pass per round'],
    minimalExperiment: {
      code: 'src/train.py',
      data: 'data/synthetic.csv',
      baselines: ['fedavg'],
      metrics: ['rare-class recall'],
      ablations: ['no reweighting'],
    },
    falsification: { conditions: ['recall delta < 0 on 3 seeds'] },
    budget: { maxRounds: 3, maxGpuMinutes: 120 },
    stopConditions: ['budget exhausted'],
    createdAt: 1,
  } as IdeaCard;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[], timeoutMs = 60_000): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
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
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

describe('ideaseek idea experiment (CLI)', () => {
  let project: string;

  /** create → IMPLEMENTING → scaffold → check (passes → SMOKE_TESTED). */
  async function setupCheckedIdea(id = 'calib-reweight'): Promise<void> {
    const cardPath = join(project, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard(id), null, 2), 'utf8');
    expect((await runCli(project, ['idea', 'create', id, '--from-card', cardPath])).code).toBe(0);
    expect((await runCli(project, ['idea', 'set-status', id, 'IMPLEMENTING'])).code).toBe(0);
    expect((await runCli(project, ['idea', 'scaffold', id])).code).toBe(0);
    const check = await runCli(project, ['idea', 'check', id, '--json']);
    expect(check.code, check.stdout + check.stderr).toBe(0);
    expect((JSON.parse(check.stdout) as { outcome: string }).outcome).toBe('passed');
  }

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'ideaseek-iexp-'));
    const init = await runCli(project, ['init']);
    expect(init.code).toBe(0);
  }, 60_000);

  it('runs a smoke experiment, records spec+result and moves to ANALYZING', async () => {
    await setupCheckedIdea();

    const run = await runCli(project, ['idea', 'experiment', 'calib-reweight', '--json']);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const payload = JSON.parse(run.stdout) as {
      specId: string;
      version: number;
      alreadyRecorded: boolean;
      resultStatus: string;
      metrics: { name: string; value: number }[];
      statusAfter: string;
    };
    expect(payload).toMatchObject({
      specId: 'idea-calib-reweight',
      version: 1,
      alreadyRecorded: false,
      resultStatus: 'succeeded',
      statusAfter: 'ANALYZING',
    });
    expect(payload.metrics).toEqual([{ name: 'rare-class recall', value: 0.5 }]);

    // Unified registry: spec bound to idea version, code hash and scale.
    const shown = await runCli(project, ['experiment', 'show', 'idea-calib-reweight', '--json']);
    expect(shown.code).toBe(0);
    const doc = JSON.parse(shown.stdout) as {
      status: string;
      spec: {
        idea: { ideaId: string; version: number };
        environment: { notes: string[] };
        comparisonIds: string[];
      };
      result: { metrics: { name: string; value: number }[]; explanation: string } | null;
    };
    expect(doc.status).toBe('succeeded');
    expect(doc.spec.idea).toEqual({ ideaId: 'calib-reweight', version: 1 });
    expect(doc.spec.environment.notes.join(' ')).toContain('scale:smoke');
    expect(doc.spec.environment.notes.join(' ')).toContain('idea-code:');
    expect(doc.spec.comparisonIds).toEqual(['fedavg']);
    expect(doc.result?.metrics).toEqual([{ name: 'rare-class recall', value: 0.5 }]);

    // Workspace mirror inside the idea's own experiments/ directory.
    const mirror = await readFile(
      join(project, 'ideas', 'calib-reweight', 'experiments', 'idea-calib-reweight-v1.json'),
      'utf8',
    );
    expect(JSON.parse(mirror)).toHaveProperty('spec');
    expect(JSON.parse(mirror)).toHaveProperty('result');

    const status = await runCli(project, ['idea', 'show', 'calib-reweight', '--json']);
    expect((JSON.parse(status.stdout) as { status: string }).status).toBe('ANALYZING');
  }, 120_000);

  it('is idempotent for an identical successful experiment', async () => {
    await setupCheckedIdea();
    const first = await runCli(project, ['idea', 'experiment', 'calib-reweight', '--json']);
    expect(first.code).toBe(0);

    const second = await runCli(project, ['idea', 'experiment', 'calib-reweight', '--json']);
    expect(second.code).toBe(0);
    const payload = JSON.parse(second.stdout) as {
      alreadyRecorded: boolean;
      version: number;
      resultStatus: string;
      statusAfter: string;
    };
    expect(payload).toMatchObject({
      alreadyRecorded: true,
      version: 1,
      resultStatus: 'succeeded',
      statusAfter: 'ANALYZING',
    });
  }, 120_000);

  it('refuses experiments without a passing current check report', async () => {
    // Fresh workspace: no check report at all.
    const cardPath = join(project, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard('no-check')), 'utf8');
    await runCli(project, ['idea', 'create', 'no-check', '--from-card', cardPath]);
    const noReport = await runCli(project, ['idea', 'experiment', 'no-check']);
    expect(noReport.code).not.toBe(0);
    expect(noReport.stderr).toContain('idea check');

    // Stale report: run v1 first, then a revision invalidates the report.
    await setupCheckedIdea();
    const first = await runCli(project, ['idea', 'experiment', 'calib-reweight', '--json']);
    expect(first.code, first.stdout + first.stderr).toBe(0);

    // Walk back (ANALYZING → NEEDS_REVISION → IMPLEMENTING), revise to v2.
    expect(
      (
        await runCli(project, [
          'idea',
          'set-status',
          'calib-reweight',
          'NEEDS_REVISION',
          '--reason',
          'clip gradients',
        ])
      ).code,
    ).toBe(0);
    expect(
      (await runCli(project, ['idea', 'set-status', 'calib-reweight', 'IMPLEMENTING'])).code,
    ).toBe(0);
    const revised = await runCli(project, [
      'idea',
      'revise',
      'calib-reweight',
      '--kind',
      'engineering',
      '--summary',
      'clip gradients',
      '--json',
    ]);
    expect(revised.code).toBe(0);

    const stale = await runCli(project, ['idea', 'experiment', 'calib-reweight']);
    expect(stale.code).not.toBe(0);
    expect(stale.stderr).toContain('stale');

    // Re-check (version bumped) unblocks the experiment at v2.
    const recheck = await runCli(project, ['idea', 'check', 'calib-reweight', '--json']);
    expect(recheck.code).toBe(0);
    expect((JSON.parse(recheck.stdout) as { status: string }).status).toBe('SMOKE_TESTED');
    const run = await runCli(project, ['idea', 'experiment', 'calib-reweight', '--json']);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const payload = JSON.parse(run.stdout) as { version: number };
    expect(payload.version).toBe(2); // idea-v:2 note changes the spec hash
  }, 180_000);

  it('records a failed quick run with failure category and allows retry as a new version', async () => {
    await setupCheckedIdea();

    // Scaffold train.py exits 0 WITHOUT metrics → invalid-result on quick scale
    // (smoke passes via smoke.py; quick honestly fails until the code exists).
    const failed = await runCli(project, [
      'idea',
      'experiment',
      'calib-reweight',
      '--scale',
      'quick',
      '--json',
    ]);
    expect(failed.code).toBe(1);
    const failPayload = JSON.parse(failed.stdout) as {
      resultStatus: string;
      failure: { category: string };
      statusAfter: string;
      version: number;
    };
    expect(failPayload.resultStatus).toBe('failed');
    expect(failPayload.failure.category).toBe('invalid-result');
    expect(failPayload.statusAfter).toBe('RUNNING'); // failures stay RUNNING for retry
    expect(failPayload.version).toBe(1);

    // Retry without code changes: new attempt, new version, still failing.
    const retry = await runCli(project, [
      'idea',
      'experiment',
      'calib-reweight',
      '--scale',
      'quick',
      '--json',
    ]);
    expect(retry.code).toBe(1);
    const retryPayload = JSON.parse(retry.stdout) as { version: number; attempt: number };
    expect(retryPayload.version).toBe(2);
    expect(retryPayload.attempt).toBe(2);

    // The failed result is attached and inspectable.
    const shown = await runCli(project, ['experiment', 'show', 'idea-calib-reweight', '--json']);
    const doc = JSON.parse(shown.stdout) as {
      version: number;
      status: string;
      result: { failure: { category: string } } | null;
    };
    expect(doc.version).toBe(2);
    expect(doc.status).toBe('failed');
    expect(doc.result?.failure.category).toBe('invalid-result');
  }, 180_000);

  it('enforces scale and lifecycle discipline', async () => {
    await setupCheckedIdea();

    const badScale = await runCli(project, [
      'idea',
      'experiment',
      'calib-reweight',
      '--scale',
      'full',
    ]);
    expect(badScale.code).toBe(2);
    expect(badScale.stderr).toContain('smoke | quick');

    // After a successful run the idea is ANALYZING: a changed spec must walk
    // back through NEEDS_REVISION (covered implicitly by the stale test);
    // REJECTED ideas can never run experiments.
    const rejected = await runCli(project, [
      'idea',
      'set-status',
      'calib-reweight',
      'REJECTED',
      '--reason',
      'superseded',
    ]);
    expect(rejected.code).toBe(0);
    const afterReject = await runCli(project, ['idea', 'experiment', 'calib-reweight']);
    expect(afterReject.code).not.toBe(0);
    expect(afterReject.stderr).toContain('REJECTED');
  }, 120_000);
});
