import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IdeaCard } from '../src/idea/card.js';
import { CLI_BIN, implementIdeaSmoke } from './helpers.js';

/**
 * Capability 3 (Phase 4.5): ablation-planner → mechanism chain + ablation
 * matrix. The ARIS skill proposes priorities/expected outcomes; IdeaSeek
 * keeps derivation, spec binding and execution. Covers plan generation,
 * queue reordering, expect:/ablation-plan: annotations, stale-plan
 * neutrality, deferred hyperparameter entries, reuse, invalid targets,
 * malformed output and quota recovery.
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
  timeoutMs = 120_000,
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

interface AblationPlanPayload {
  ideaId: string;
  reused: boolean;
  inputHash: string;
  entries: number;
  runnable: number;
  deferred: number;
  eventSeq?: number | null;
  blocked?: string;
}

describe('ideaseek idea ablation-plan (ARIS ablation-planner backend)', () => {
  async function setupReadyIdea(): Promise<string> {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-ablplan-'));
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
    // The scaffold's smoke is a self-declared template; a passed check needs
    // code that actually computes.
    await implementIdeaSmoke(project, 'calib-reweight', 'rare-class recall');
    const check = await runCli(project, ['idea', 'check', 'calib-reweight', '--json']);
    expect(check.code, check.stdout + check.stderr).toBe(0);
    const experiment = await runCli(project, ['idea', 'experiment', 'calib-reweight', '--json']);
    expect(experiment.code, experiment.stdout + experiment.stderr).toBe(0);
    return project;
  }

  const planFile = (project: string): string =>
    join(project, 'ideas', 'calib-reweight', 'experiments', 'ablation-plan.json');

  it('generates the plan, reorders the matrix and annotates the specs', async () => {
    const project = await setupReadyIdea();
    expect((await runCli(project, ['run', '--question', 'abl plan', '--enqueue-only'])).code).toBe(
      0,
    );

    const planned = await runCli(project, [
      'idea',
      'ablation-plan',
      'calib-reweight',
      '--harness',
      'fake',
      '--json',
    ]);
    expect(planned.code, planned.stderr).toBe(0);
    const payload = JSON.parse(planned.stdout) as AblationPlanPayload;
    expect(payload).toMatchObject({
      ideaId: 'calib-reweight',
      reused: false,
      entries: 3,
      runnable: 2,
      deferred: 1,
    });
    expect(payload.eventSeq).toBeGreaterThan(0);

    const events = await runCli(project, ['events', '--json']);
    expect(events.stdout).toContain('ablation_plan');

    const ablated = await runCli(project, ['idea', 'ablate', 'calib-reweight', '--json']);
    expect(ablated.code, ablated.stdout + ablated.stderr).toBe(0);
    const result = JSON.parse(ablated.stdout) as {
      entries: { ablationId: string }[];
      plan?: { matched: number; deferred: { name: string }[]; coverageAssessment: string };
    };
    expect(result.plan).toBeDefined();
    expect(result.plan!.matched).toBe(2);
    expect(result.plan!.deferred.map((entry) => entry.name)).toContain('learning-rate sensitivity');
    // Plan priority puts the card ablation first; derivation would put the
    // component entry first — proving the ARIS plan reordered the queue.
    expect(result.entries[0]!.ablationId).toBe('abl-no-reweighting');

    const doc = await runCli(project, [
      'experiment',
      'show',
      'idea-calib-reweight-abl-abl-no-reweighting',
      '--json',
    ]);
    expect(doc.code, doc.stdout + doc.stderr).toBe(0);
    const notes = (JSON.parse(doc.stdout) as { spec: { environment: { notes: string[] } } }).spec
      .environment.notes;
    expect(notes.some((note) => note.startsWith('ablation-plan:'))).toBe(true);
    expect(notes.some((note) => note.startsWith('expect:'))).toBe(true);
  }, 300_000);

  it('stale plan leaves derivation order and notes untouched', async () => {
    const project = await setupReadyIdea();
    expect(
      (await runCli(project, ['idea', 'ablation-plan', 'calib-reweight', '--harness', 'fake']))
        .code,
    ).toBe(0);
    const plan = JSON.parse(await readFile(planFile(project), 'utf8')) as Record<string, unknown>;
    plan.cardVersion = 99;
    await writeFile(planFile(project), JSON.stringify(plan, null, 2), 'utf8');

    const ablated = await runCli(project, ['idea', 'ablate', 'calib-reweight', '--json']);
    expect(ablated.code, ablated.stdout + ablated.stderr).toBe(0);
    const result = JSON.parse(ablated.stdout) as {
      entries: { ablationId: string }[];
      plan?: unknown;
    };
    expect(result.plan).toBeUndefined();
    // Derivation order: component entry first (plan would have inverted it).
    expect(result.entries[0]!.ablationId).toBe('w-o-probe');

    const doc = await runCli(project, [
      'experiment',
      'show',
      'idea-calib-reweight-abl-w-o-probe',
      '--json',
    ]);
    const notes = (JSON.parse(doc.stdout) as { spec: { environment: { notes: string[] } } }).spec
      .environment.notes;
    expect(notes.some((note) => note.startsWith('ablation-plan:'))).toBe(false);
    expect(notes.some((note) => note.startsWith('expect:'))).toBe(false);
  }, 300_000);

  it('reuses an identical ablation plan without duplicate events', async () => {
    const project = await setupReadyIdea();
    expect((await runCli(project, ['run', '--question', 'abl reuse', '--enqueue-only'])).code).toBe(
      0,
    );
    const first = await runCli(project, [
      'idea',
      'ablation-plan',
      'calib-reweight',
      '--harness',
      'fake',
      '--json',
    ]);
    expect(first.code).toBe(0);
    const second = await runCli(project, [
      'idea',
      'ablation-plan',
      'calib-reweight',
      '--harness',
      'fake',
      '--json',
    ]);
    expect(second.code).toBe(0);
    const payload = JSON.parse(second.stdout) as AblationPlanPayload;
    expect(payload.reused).toBe(true);
    expect(payload.inputHash).toBe((JSON.parse(first.stdout) as AblationPlanPayload).inputHash);

    const events = await runCli(project, ['events', '--json']);
    expect(events.stdout.split('ablation_plan').length - 1).toBe(1);
  }, 300_000);

  it('refuses plan targets that are not on the card', async () => {
    const project = await setupReadyIdea();
    const failed = await runCli(
      project,
      ['idea', 'ablation-plan', 'calib-reweight', '--harness', 'fake'],
      {
        IDEASEEK_FAKE_ABLATION_PLAN_OUTPUT: JSON.stringify({
          ideaId: 'calib-reweight',
          cardVersion: 1,
          entries: [
            {
              name: 'ghost component',
              kind: 'component',
              target: 'not-on-card',
              whatItTests: 'x',
              expectedOutcome: 'y',
              priority: 1,
            },
          ],
          coverageAssessment: 'c',
          unnecessary: [],
          suggestedOrder: ['ghost component'],
          estimatedGpuMinutes: 5,
        }),
      },
    );
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('PARSE_FAILED');
    expect(failed.stderr).toContain('componentNecessity');
    await expect(readFile(planFile(project), 'utf8')).rejects.toThrow();
  }, 180_000);

  it('rejects malformed plan output without writing the file', async () => {
    const project = await setupReadyIdea();
    const failed = await runCli(
      project,
      ['idea', 'ablation-plan', 'calib-reweight', '--harness', 'fake'],
      { IDEASEEK_FAKE_ABLATION_PLAN_OUTPUT: '{"entries":[]}' },
    );
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('PARSE_FAILED');
    await expect(readFile(planFile(project), 'utf8')).rejects.toThrow();
  }, 180_000);

  it('maps quota blocks to exit 2 with nothing written, then recovers', async () => {
    const project = await setupReadyIdea();
    const blocked = await runCli(
      project,
      ['idea', 'ablation-plan', 'calib-reweight', '--harness', 'fake'],
      { IDEASEEK_FAKE_BLOCK: 'QUOTA_EXHAUSTED' },
    );
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain('QUOTA_EXHAUSTED');
    expect(blocked.stderr).toContain('nothing was written');
    await expect(readFile(planFile(project), 'utf8')).rejects.toThrow();

    const recovered = await runCli(project, [
      'idea',
      'ablation-plan',
      'calib-reweight',
      '--harness',
      'fake',
      '--json',
    ]);
    expect(recovered.code, recovered.stderr).toBe(0);
    expect((JSON.parse(recovered.stdout) as AblationPlanPayload).entries).toBe(3);
  }, 300_000);
});
