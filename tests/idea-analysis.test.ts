import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ExperimentSpec, RunResult } from '../src/experiment/spec.js';
import type { IdeaCard } from '../src/idea/card.js';
import {
  analyzeIdea,
  classifyRuntimeFailure,
  deriveAblations,
  type AnalysisInput,
} from '../src/idea/analysis.js';
import { CLI_BIN } from './helpers.js';

function makeCard(ideaId: string): IdeaCard {
  return {
    ideaId,
    version: 1,
    parentVersion: null,
    status: 'CANDIDATE',
    hypothesis: { statement: `hypothesis for ${ideaId}`, targetProblem: 't' },
    paperEvidence: [{ paperRef: 'p', statement: 's', evidence: 'e' }],
    contradictions: ['c'],
    novelty: { claim: 'c', uncertainty: 'u', whyNotRestatement: 'w' },
    mechanismChain: {
      designPrincipleLink: 'l',
      steps: [
        { kind: 'observation', text: 'a' },
        { kind: 'hypothesis', text: 'b' },
        { kind: 'intervention', text: 'c' },
        { kind: 'expected-change', text: 'd' },
        { kind: 'baseline-difference', text: 'e' },
        { kind: 'falsifier', text: 'f' },
      ],
    },
    nearestComparisons: [{ methodId: 'fedavg', difference: 'd', evidence: 'e' }],
    componentNecessity: [
      { component: 'calibration probe', role: 'necessary-mechanism', removeEffect: 'gain gone' },
      { component: 'logger', role: 'engineering', removeEffect: 'cosmetic only' },
    ],
    competingExplanations: ['x'],
    boundaryConditions: ['x'],
    risks: ['x'],
    minimalExperiment: {
      code: 'src/train.py',
      data: 'd',
      baselines: ['fedavg'],
      metrics: ['rare-class recall'],
      ablations: ['no reweighting'],
    },
    falsification: { conditions: ['f'] },
    budget: { maxRounds: 1, maxGpuMinutes: 10 },
    stopConditions: ['s'],
    createdAt: 1,
  } as IdeaCard;
}

function spec(overrides: Partial<ExperimentSpec> = {}): ExperimentSpec {
  return {
    specId: 'idea-x',
    version: 1,
    idea: { ideaId: 'x', version: 1 },
    comparisonIds: ['fedavg'],
    codeCommit: null,
    dataSnapshotId: 'synthetic:idea-workspace',
    sliceIds: [],
    environment: { python: 'v24', notes: ['scale:smoke'] },
    command: ['python', 'src/smoke.py'],
    metrics: [{ name: 'rare-class recall', direction: 'higher' }],
    seeds: [42],
    resources: {},
    budget: { maxRuns: 1, maxMinutes: 5 },
    protocolId: null,
    createdAt: 1,
    ...overrides,
  } as ExperimentSpec;
}

function result(overrides: Partial<RunResult> = {}): RunResult {
  return {
    specId: 'idea-x',
    status: 'succeeded',
    logRefs: [],
    artifactRefs: [],
    metrics: [{ name: 'rare-class recall', value: 0.8 }],
    resourcesUsed: {},
    failure: null,
    startedAt: 1,
    finishedAt: 2,
    ...overrides,
  } as RunResult;
}

function baseInput(overrides: Partial<AnalysisInput> = {}): AnalysisInput {
  return {
    ideaId: 'x',
    ideaVersion: 1,
    codeHash: 'sha256:aa',
    card: makeCard('x'),
    main: { spec: spec(), result: result() },
    ablations: [],
    baselines: [{ methodId: 'fedavg', value: 0.7 }],
    scalesRun: ['smoke', 'quick'],
    datasetsRun: ['inputs:abc'],
    seedsCount: 2,
    failures: [],
    resources: [],
    ...overrides,
  };
}

describe('classifyRuntimeFailure', () => {
  it('maps runtime categories to engineering/environment/data/resource/metric — never hypothesis', () => {
    expect(classifyRuntimeFailure('code')).toBe('engineering');
    expect(classifyRuntimeFailure('dependency')).toBe('environment');
    expect(classifyRuntimeFailure('environment')).toBe('environment');
    expect(classifyRuntimeFailure('timeout')).toBe('environment');
    expect(classifyRuntimeFailure('data')).toBe('data');
    expect(classifyRuntimeFailure('resource')).toBe('resource');
    expect(classifyRuntimeFailure('invalid-result')).toBe('metric');
    // The hard invariant: no runtime category can ever become a science verdict.
    for (const category of [
      'code',
      'dependency',
      'environment',
      'timeout',
      'data',
      'resource',
      'invalid-result',
      'unknown',
    ] as const) {
      const cls = classifyRuntimeFailure(category);
      expect(cls).not.toBe('hypothesis');
      expect(cls).not.toBe('effect-insufficient');
    }
  });
});

describe('deriveAblations (from the mechanism chain)', () => {
  it('ablates necessary-mechanism components and declared ablations, not engineering ones', () => {
    const plan = deriveAblations(makeCard('x'));
    const ids = plan.map((entry) => entry.ablationId);
    expect(ids).toContain('w-o-calibration-probe');
    expect(ids).toContain('abl-no-reweighting');
    expect(ids.join(' ')).not.toContain('logger'); // engineering role is not a mechanism ablation
    const necessary = plan.find((entry) => entry.ablationId === 'w-o-calibration-probe')!;
    expect(necessary.removeComponent).toBe('calibration probe');
    const declared = plan.find((entry) => entry.ablationId === 'abl-no-reweighting')!;
    expect(declared.removeComponent).toBeNull();
  });

  it('dedupes identical labels', () => {
    const card = makeCard('x');
    card.minimalExperiment.ablations = ['w/o calibration probe'];
    const plan = deriveAblations(card);
    expect(plan.filter((entry) => entry.removeComponent === 'calibration probe')).toHaveLength(1);
  });
});

describe('analyzeIdea verdict ladder', () => {
  it('classifies a crashed main run as invalid-run / engineering — never as hypothesis failure', () => {
    const analysis = analyzeIdea(
      baseInput({
        main: {
          spec: spec(),
          result: result({
            status: 'failed',
            metrics: [],
            failure: { category: 'code', summary: 'SyntaxError: boom' },
          }),
        },
        baselines: [{ methodId: 'fedavg', value: 0.7 }],
      }),
    );
    expect(analysis.verdict).toBe('invalid-run');
    expect(analysis.failureClass).toBe('engineering');
    expect(analysis.reasons.join(' ')).toContain('NOT a hypothesis failure');
    expect(analysis.failureClass).not.toBe('hypothesis');
    expect(analysis.nextSteps.join(' ')).toContain('idea check');
  });

  it('rejects a run that fails to beat the best baseline (effect insufficient)', () => {
    const analysis = analyzeIdea(
      baseInput({
        main: {
          spec: spec(),
          result: result({ metrics: [{ name: 'rare-class recall', value: 0.6 }] }),
        },
        baselines: [{ methodId: 'fedavg', value: 0.7 }],
      }),
    );
    expect(analysis.verdict).toBe('rejected');
    expect(analysis.failureClass).toBe('effect-insufficient');
    expect(analysis.primaryDelta).toBeCloseTo(-0.1);
    expect(analysis.reasons.join(' ')).toContain('effect insufficient');
  });

  it('stays inconclusive without a valid control (no superiority claims)', () => {
    const analysis = analyzeIdea(baseInput({ baselines: [{ methodId: 'fedavg', value: null }] }));
    expect(analysis.verdict).toBe('inconclusive');
    expect(analysis.reasons.join(' ')).toContain('缺少有效对照');
    expect(analysis.nextSteps.join(' ')).toContain('baseline');
  });

  it('stays inconclusive on a single seed even when beating the baseline', () => {
    const analysis = analyzeIdea(
      baseInput({
        seedsCount: 1,
        ablations: [
          {
            ablationId: 'w-o-calibration-probe',
            label: 'w/o calibration probe',
            removeComponent: 'calibration probe',
            spec: spec({ specId: 'idea-x-abl-w-o-calibration-probe' }),
            result: result({ metrics: [{ name: 'rare-class recall', value: 0.4 }] }),
          },
        ],
      }),
    );
    expect(analysis.verdict).toBe('inconclusive');
    expect(analysis.reasons.join(' ')).toContain('seeds: 1 < 2');
  });

  it('stays inconclusive when necessary-component ablations have not run', () => {
    const analysis = analyzeIdea(baseInput());
    expect(analysis.verdict).toBe('inconclusive');
    expect(analysis.reasons.join(' ')).toContain('no component ablation has run');
    expect(analysis.nextSteps.join(' ')).toContain('idea ablate');
  });

  it('stays inconclusive when removing the necessary component does not hurt', () => {
    const analysis = analyzeIdea(
      baseInput({
        ablations: [
          {
            ablationId: 'w-o-calibration-probe',
            label: 'w/o calibration probe',
            removeComponent: 'calibration probe',
            spec: spec({ specId: 'idea-x-abl-w-o-calibration-probe' }),
            result: result({ metrics: [{ name: 'rare-class recall', value: 0.8 }] }),
          },
        ],
      }),
    );
    expect(analysis.verdict).toBe('inconclusive');
    expect(analysis.reasons.join(' ')).toContain('mechanism not evidenced');
    expect(analysis.mechanismEvidence[0]!.supports).toBe(false);
  });

  it('supports when the idea beats the baseline with seeds, scales and mechanism evidence', () => {
    const analysis = analyzeIdea(
      baseInput({
        ablations: [
          {
            ablationId: 'w-o-calibration-probe',
            label: 'w/o calibration probe',
            removeComponent: 'calibration probe',
            spec: spec({ specId: 'idea-x-abl-w-o-calibration-probe' }),
            // Removing the component collapses the metric → mechanism holds.
            result: result({ metrics: [{ name: 'rare-class recall', value: 0.4 }] }),
          },
        ],
      }),
    );
    expect(analysis.verdict).toBe('supported');
    expect(analysis.failureClass).toBe('none');
    expect(analysis.mechanismEvidence[0]!.supports).toBe(true);
    expect(analysis.reasons.join(' ')).toContain('beats best baseline');
    expect(analysis.nextSteps.join(' ')).toContain('SUPPORTED');
  });

  it('demotes to inconclusive when another covered scale shows no gain (mixed-scale)', () => {
    const analysis = analyzeIdea(
      baseInput({
        main: {
          spec: spec(),
          result: result({ metrics: [{ name: 'rare-class recall', value: 53 }] }),
        },
        ideaByScale: { smoke: 53, quick: 4 },
        baselines: [
          { methodId: 'fedavg', value: 1, scale: 'smoke' },
          { methodId: 'fedavg', value: 4, scale: 'quick' },
        ],
        // necessary-component ablation still supports at the paired scale
        ablations: [
          {
            ablationId: 'w-o-calibration-probe',
            label: 'w/o calibration probe',
            removeComponent: 'calibration probe',
            spec: spec({ specId: 'idea-x-abl-w-o-calibration-probe' }),
            result: result({ metrics: [{ name: 'rare-class recall', value: 1 }] }),
          },
        ],
      }),
    );
    expect(analysis.verdict).toBe('inconclusive');
    expect(analysis.reasons.join(' ')).toContain('mixed-scale evidence');
    expect(analysis.reasons.join(' ')).toContain('quick');
    const quickEntry = analysis.baselineComparison.find(
      (c) => c.scale === 'quick' && c.delta !== null,
    );
    expect(quickEntry?.delta).toBe(0);
    expect(quickEntry?.ideaValue).toBe(4);
  });

  it('stays inconclusive without any same-scale baseline', () => {
    const analysis = analyzeIdea(
      baseInput({
        baselines: [{ methodId: 'fedavg', value: 7, scale: 'quick' }], // main is smoke
      }),
    );
    expect(analysis.verdict).toBe('inconclusive');
    expect(analysis.reasons.join(' ')).toContain('no same-scale baseline');
  });

  it('keeps every failure observation with its class', () => {
    const analysis = analyzeIdea(
      baseInput({
        failures: [
          {
            specId: 'idea-x-abl-broken',
            category: 'invalid-result',
            class: classifyRuntimeFailure('invalid-result'),
            logRefs: ['.research/logs/x.log'],
          },
        ],
      }),
    );
    expect(analysis.failures).toHaveLength(1);
    expect(analysis.failures[0]!.class).toBe('metric');
  });
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[], timeoutMs = 90_000): Promise<CliResult> {
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

describe('ideaseek idea ablate + analyze (CLI)', () => {
  let project: string;

  async function setupToAnalyzing(id = 'calib-reweight'): Promise<void> {
    const cardPath = join(project, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard(id)), 'utf8');
    expect((await runCli(project, ['idea', 'create', id, '--from-card', cardPath])).code).toBe(0);
    expect((await runCli(project, ['idea', 'set-status', id, 'IMPLEMENTING'])).code).toBe(0);
    expect((await runCli(project, ['idea', 'scaffold', id])).code).toBe(0);
    const check = await runCli(project, ['idea', 'check', id, '--json']);
    expect(check.code, check.stdout + check.stderr).toBe(0);
    const exp = await runCli(project, ['idea', 'experiment', id, '--json']);
    expect(exp.code, exp.stdout + exp.stderr).toBe(0);
    expect((JSON.parse(exp.stdout) as { statusAfter: string }).statusAfter).toBe('ANALYZING');
  }

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'ideaseek-anl-'));
    const init = await runCli(project, ['init']);
    expect(init.code).toBe(0);
  }, 60_000);

  it('refuses ablations before a succeeded main experiment', async () => {
    const cardPath = join(project, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard('calib-reweight')), 'utf8');
    await runCli(project, ['idea', 'create', 'calib-reweight', '--from-card', cardPath]);

    // Gate 1: no check report yet.
    const noCheck = await runCli(project, ['idea', 'ablate', 'calib-reweight']);
    expect(noCheck.code).not.toBe(0);
    expect(noCheck.stderr).toContain('idea check');

    // Gate 2: check passes but the main experiment has not run.
    expect(
      (await runCli(project, ['idea', 'set-status', 'calib-reweight', 'IMPLEMENTING'])).code,
    ).toBe(0);
    expect((await runCli(project, ['idea', 'scaffold', 'calib-reweight'])).code).toBe(0);
    expect((await runCli(project, ['idea', 'check', 'calib-reweight'])).code).toBe(0);
    const noMain = await runCli(project, ['idea', 'ablate', 'calib-reweight']);
    expect(noMain.code).not.toBe(0);
    expect(noMain.stderr).toContain('main experiment');
  }, 120_000);

  it('runs the derived ablation matrix and analyzes the idea', async () => {
    await setupToAnalyzing();

    const ablate = await runCli(project, ['idea', 'ablate', 'calib-reweight', '--json']);
    expect(ablate.code, ablate.stdout + ablate.stderr).toBe(0);
    const ablationPayload = JSON.parse(ablate.stdout) as {
      entries: {
        ablationId: string;
        specId: string;
        resultStatus: string;
        removeComponent: string | null;
      }[];
      allOk: boolean;
    };
    // 1 necessary-mechanism + 1 declared ablation (engineering role excluded).
    expect(ablationPayload.entries).toHaveLength(2);
    expect(ablationPayload.allOk).toBe(true);
    const ids = ablationPayload.entries.map((entry) => entry.ablationId);
    expect(ids).toContain('w-o-calibration-probe');
    expect(ids).toContain('abl-no-reweighting');

    // Each ablation is bound in the unified registry to idea + code hash.
    for (const entry of ablationPayload.entries) {
      const shown = await runCli(project, ['experiment', 'show', entry.specId, '--json']);
      expect(shown.code).toBe(0);
      const doc = JSON.parse(shown.stdout) as {
        spec: { idea: { ideaId: string; version: number }; environment: { notes: string[] } };
        status: string;
      };
      expect(doc.spec.idea.ideaId).toBe('calib-reweight');
      expect(doc.spec.environment.notes.join(' ')).toContain('idea-code:');
      expect(doc.spec.environment.notes.join(' ')).toContain('ablation:');
      expect(doc.status).toBe('succeeded');
    }

    // Idempotent re-run of the matrix.
    const again = await runCli(project, ['idea', 'ablate', 'calib-reweight', '--json']);
    expect(again.code).toBe(0);
    expect(
      (JSON.parse(again.stdout) as { entries: { alreadyRecorded: boolean }[] }).entries.every(
        (entry) => entry.alreadyRecorded,
      ),
    ).toBe(true);

    // Analysis: no baseline result in this project → inconclusive, honest.
    const analyze = await runCli(project, ['idea', 'analyze', 'calib-reweight', '--json']);
    expect(analyze.code).toBe(0);
    const payload = JSON.parse(analyze.stdout) as {
      analysis: {
        verdict: string;
        failureClass: string;
        reasons: string[];
        coverage: { scales: string[]; seeds: number };
        mechanismEvidence: { supports: boolean | null }[];
      };
      paths: string[];
    };
    expect(payload.analysis.verdict).toBe('inconclusive');
    expect(payload.analysis.failureClass).toBe('none');
    expect(payload.analysis.reasons.join(' ')).toContain('缺少有效对照');
    expect(payload.analysis.coverage.scales).toContain('smoke');
    expect(payload.analysis.coverage.seeds).toBe(1);
    // Both ablations produced mechanism observations (equal scaffold values
    // → supports=false for the necessary component).
    expect(payload.analysis.mechanismEvidence).toHaveLength(2);

    const latest = JSON.parse(
      await readFile(
        join(project, 'ideas', 'calib-reweight', 'experiments', 'analysis.json'),
        'utf8',
      ),
    ) as { ideaId: string; verdict: string };
    expect(latest).toMatchObject({ ideaId: 'calib-reweight', verdict: 'inconclusive' });
    await expect(
      readFile(join(project, 'ideas', 'calib-reweight', 'experiments', 'analysis-v1.json'), 'utf8'),
    ).resolves.toContain('"verdict"');
  }, 240_000);

  it('keeps analysis history across revisions (v1 file survives v2)', async () => {
    await setupToAnalyzing();
    expect((await runCli(project, ['idea', 'analyze', 'calib-reweight'])).code).toBe(0);

    // Walk back, revise to v2, re-check, re-experiment, re-analyze.
    expect(
      (
        await runCli(project, [
          'idea',
          'set-status',
          'calib-reweight',
          'NEEDS_REVISION',
          '--reason',
          'iterate',
        ])
      ).code,
    ).toBe(0);
    expect(
      (await runCli(project, ['idea', 'set-status', 'calib-reweight', 'IMPLEMENTING'])).code,
    ).toBe(0);
    expect(
      (
        await runCli(project, [
          'idea',
          'revise',
          'calib-reweight',
          '--kind',
          'engineering',
          '--summary',
          'tweak',
          '--json',
        ])
      ).code,
    ).toBe(0);
    expect((await runCli(project, ['idea', 'check', 'calib-reweight'])).code).toBe(0);
    const exp = await runCli(project, ['idea', 'experiment', 'calib-reweight', '--json']);
    expect(exp.code, exp.stdout + exp.stderr).toBe(0);
    expect((JSON.parse(exp.stdout) as { version: number }).version).toBe(2);
    expect((await runCli(project, ['idea', 'analyze', 'calib-reweight'])).code).toBe(0);

    // Immutable per-version analysis history + spec mirrors for both versions.
    const v1 = await readFile(
      join(project, 'ideas', 'calib-reweight', 'experiments', 'analysis-v1.json'),
      'utf8',
    );
    const v2 = await readFile(
      join(project, 'ideas', 'calib-reweight', 'experiments', 'analysis-v2.json'),
      'utf8',
    );
    expect(JSON.parse(v1).ideaVersion).toBe(1);
    expect(JSON.parse(v2).ideaVersion).toBe(2);
    await expect(
      readFile(
        join(project, 'ideas', 'calib-reweight', 'experiments', 'idea-calib-reweight-v1.json'),
        'utf8',
      ),
    ).resolves.toContain('"spec"');
    await expect(
      readFile(
        join(project, 'ideas', 'calib-reweight', 'experiments', 'idea-calib-reweight-v2.json'),
        'utf8',
      ),
    ).resolves.toContain('"spec"');
  }, 240_000);

  it('retains failed experiments in the analysis (never deletes unfavorable results)', async () => {
    await setupToAnalyzing();

    // Walk back so a changed-scale (quick) spec may run from SMOKE_TESTED.
    expect(
      (
        await runCli(project, [
          'idea',
          'set-status',
          'calib-reweight',
          'NEEDS_REVISION',
          '--reason',
          'try quick scale',
        ])
      ).code,
    ).toBe(0);
    expect(
      (await runCli(project, ['idea', 'set-status', 'calib-reweight', 'IMPLEMENTING'])).code,
    ).toBe(0);
    expect((await runCli(project, ['idea', 'check', 'calib-reweight'])).code).toBe(0);

    // A failed quick run (scaffold train.py emits no metrics).
    const quick = await runCli(project, [
      'idea',
      'experiment',
      'calib-reweight',
      '--scale',
      'quick',
      '--json',
    ]);
    expect(quick.code).toBe(1);

    const analyze = await runCli(project, ['idea', 'analyze', 'calib-reweight', '--json']);
    expect(analyze.code).toBe(0);
    const payload = JSON.parse(analyze.stdout) as {
      analysis: {
        verdict: string;
        failures: { specId: string; category: string; class: string }[];
      };
    };
    // The failed quick result is kept AND classified as metric — and because
    // a succeeded smoke main exists, the verdict stays analyzable.
    const failed = payload.analysis.failures.find((f) => f.category === 'invalid-result');
    expect(failed).toBeTruthy();
    expect(failed!.class).toBe('metric');
    expect(payload.analysis.verdict).not.toBe('invalid-run'); // main smoke still succeeded
  }, 240_000);
});
