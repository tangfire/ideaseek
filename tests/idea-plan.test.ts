import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IdeaCard } from '../src/idea/card.js';
import { CLI_BIN } from './helpers.js';

/**
 * Capability 2 (Phase 4.5): experiment-plan/experiment-bridge →
 * ExperimentSpec/RunResult. The ARIS experiment-plan skill backend writes
 * plan.json; the runner embeds the plan hash in environment.notes and
 * refuses a spec that would not answer the plan's primaryMetric.
 */

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

function runCli(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 90_000,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1', ...env },
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

interface PlanPayload {
  ideaId: string;
  reused: boolean;
  inputHash: string;
  primaryMetric: string;
  blocks: number;
  claims: number;
  path: string;
  eventSeq?: number | null;
  blocked?: string;
}

describe('ideaseek idea plan (ARIS experiment-plan backend)', () => {
  async function setupCheckedIdea(): Promise<string> {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-iplan-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    const cardPath = join(project, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard('calib-reweight'), null, 2), 'utf8');
    expect(
      (await runCli(project, ['idea', 'create', 'calib-reweight', '--from-card', cardPath])).code,
    ).toBe(0);
    expect(
      (await runCli(project, ['idea', 'set-status', 'calib-reweight', 'IMPLEMENTING'])).code,
    ).toBe(0);
    expect((await runCli(project, ['idea', 'scaffold', 'calib-reweight'])).code).toBe(0);
    const check = await runCli(project, ['idea', 'check', 'calib-reweight', '--json']);
    expect(check.code, check.stdout + check.stderr).toBe(0);
    return project;
  }

  const planFile = (project: string): string =>
    join(project, 'ideas', 'calib-reweight', 'experiments', 'plan.json');

  it('binds the plan hash into the spec and passes the metric guard', async () => {
    const project = await setupCheckedIdea();
    const run = await runCli(project, ['run', '--question', 'plan link', '--enqueue-only']);
    expect(run.code).toBe(0);

    const planned = await runCli(project, [
      'idea',
      'plan',
      'calib-reweight',
      '--harness',
      'fake',
      '--json',
    ]);
    expect(planned.code, planned.stderr).toBe(0);
    const payload = JSON.parse(planned.stdout) as PlanPayload;
    expect(payload).toMatchObject({
      ideaId: 'calib-reweight',
      reused: false,
      primaryMetric: 'rare-class recall',
      path: 'ideas/calib-reweight/experiments/plan.json',
    });
    expect(payload.eventSeq).toBeGreaterThan(0);

    const plan = JSON.parse(await readFile(planFile(project), 'utf8')) as {
      contract: string;
      skill: { name: string };
      claimMap: unknown[];
    };
    expect(plan.contract).toBe('experiment-plan-v1');
    expect(plan.skill.name).toBe('experiment-plan');
    expect(plan.claimMap.length).toBeGreaterThan(0);

    const events = await runCli(project, ['events', '--json']);
    expect(events.stdout).toContain('idea_plan');

    const experiment = await runCli(project, ['idea', 'experiment', 'calib-reweight', '--json']);
    expect(experiment.code, experiment.stdout + experiment.stderr).toBe(0);

    const doc = await runCli(project, ['experiment', 'show', 'idea-calib-reweight', '--json']);
    expect(doc.code).toBe(0);
    const notes = (JSON.parse(doc.stdout) as { spec: { environment: { notes: string[] } } }).spec
      .environment.notes;
    expect(notes.some((note) => note.startsWith('plan:'))).toBe(true);
  }, 180_000);

  it('refuses an experiment whose spec would not answer the plan metric', async () => {
    const project = await setupCheckedIdea();
    expect(
      (await runCli(project, ['idea', 'plan', 'calib-reweight', '--harness', 'fake'])).code,
    ).toBe(0);

    const plan = JSON.parse(await readFile(planFile(project), 'utf8')) as Record<string, unknown>;
    plan.primaryMetric = 'ghost-metric';
    await writeFile(planFile(project), JSON.stringify(plan, null, 2), 'utf8');

    const refused = await runCli(project, ['idea', 'experiment', 'calib-reweight']);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('ghost-metric');
    expect(refused.stderr).toContain('not in the spec metrics');
    expect(refused.stderr).toContain('--force');
  }, 180_000);

  it('reuses an identical plan instead of regenerating', async () => {
    const project = await setupCheckedIdea();
    expect(
      (await runCli(project, ['run', '--question', 'plan reuse', '--enqueue-only'])).code,
    ).toBe(0);
    const first = await runCli(project, [
      'idea',
      'plan',
      'calib-reweight',
      '--harness',
      'fake',
      '--json',
    ]);
    expect(first.code).toBe(0);
    const second = await runCli(project, [
      'idea',
      'plan',
      'calib-reweight',
      '--harness',
      'fake',
      '--json',
    ]);
    expect(second.code).toBe(0);
    const payload = JSON.parse(second.stdout) as PlanPayload;
    expect(payload.reused).toBe(true);
    expect(payload.inputHash).toBe((JSON.parse(first.stdout) as PlanPayload).inputHash);

    const events = await runCli(project, ['events', '--json']);
    expect(events.stdout.split('idea_plan').length - 1).toBe(1);
  }, 180_000);

  it('a stale plan neither blocks the run nor travels in the notes', async () => {
    const project = await setupCheckedIdea();
    expect(
      (await runCli(project, ['idea', 'plan', 'calib-reweight', '--harness', 'fake'])).code,
    ).toBe(0);
    const plan = JSON.parse(await readFile(planFile(project), 'utf8')) as Record<string, unknown>;
    plan.cardVersion = 99;
    await writeFile(planFile(project), JSON.stringify(plan, null, 2), 'utf8');

    const experiment = await runCli(project, ['idea', 'experiment', 'calib-reweight', '--json']);
    expect(experiment.code, experiment.stdout + experiment.stderr).toBe(0);

    const doc = await runCli(project, ['experiment', 'show', 'idea-calib-reweight', '--json']);
    const notes = (JSON.parse(doc.stdout) as { spec: { environment: { notes: string[] } } }).spec
      .environment.notes;
    expect(notes.some((note) => note.startsWith('plan:'))).toBe(false);
  }, 180_000);

  it('rejects malformed plan output without writing plan.json', async () => {
    const project = await setupCheckedIdea();
    const failed = await runCli(project, ['idea', 'plan', 'calib-reweight', '--harness', 'fake'], {
      IDEASEEK_FAKE_PLAN_OUTPUT: '{"broken":true}',
    });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('PARSE_FAILED');
    await expect(readFile(planFile(project), 'utf8')).rejects.toThrow();
  }, 120_000);

  it('fails clearly for an unknown idea', async () => {
    const project = await setupCheckedIdea();
    const failed = await runCli(project, ['idea', 'plan', 'ghost-idea']);
    expect(failed.code).not.toBe(0);
    expect(failed.stderr.toLowerCase()).toContain('ghost-idea');
  }, 120_000);

  it('maps quota blocks to exit 2 with nothing written, then recovers', async () => {
    const project = await setupCheckedIdea();
    const blocked = await runCli(project, ['idea', 'plan', 'calib-reweight', '--harness', 'fake'], {
      IDEASEEK_FAKE_BLOCK: 'QUOTA_EXHAUSTED',
    });
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain('QUOTA_EXHAUSTED');
    expect(blocked.stderr).toContain('nothing was written');
    await expect(readFile(planFile(project), 'utf8')).rejects.toThrow();

    const recovered = await runCli(project, [
      'idea',
      'plan',
      'calib-reweight',
      '--harness',
      'fake',
      '--json',
    ]);
    expect(recovered.code, recovered.stderr).toBe(0);
    expect((JSON.parse(recovered.stdout) as PlanPayload).primaryMetric).toBe('rare-class recall');
  }, 180_000);
});
