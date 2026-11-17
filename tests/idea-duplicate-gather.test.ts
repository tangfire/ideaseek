import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { collectAnalysisInput } from '../src/idea/analyze.js';
import type { ExperimentSpec, RunResult } from '../src/experiment/spec.js';
import type { IdeaCard } from '../src/idea/card.js';

/**
 * Two properties the real FDG run showed the gather layer getting wrong, and
 * which no earlier test could have caught because both involve a control the
 * idea card never mentions.
 */

const PRIMARY = 'target_unseen_domain_top1_accuracy';
const DECLARED = `${PRIMARY} (held-out domain value, all samples, %)`;
const ideaId = 'dup-and-scale';

function specFor(scale: string, version = 1): ExperimentSpec {
  return {
    specId: `idea-${ideaId}`,
    version,
    idea: { ideaId, version },
    comparisonIds: ['fedavg'],
    environment: { python: 'v24', notes: [`scale:${scale}`] },
    command: ['python', 'src/train.py', '--scale', scale],
    metrics: [{ name: PRIMARY, direction: 'higher' }],
    seeds: [42],
    dataSnapshotId: 'inputs:fdg',
    createdAt: 1,
  } as unknown as ExperimentSpec;
}

function cardFixture(declared: string[]): IdeaCard {
  return {
    ideaId,
    version: 1,
    hypothesis: { statement: 's', targetProblem: 't' },
    nearestComparisons: declared.map((methodId) => ({
      methodId,
      difference: 'd',
      evidence: 'e',
    })),
    minimalExperiment: { metrics: [PRIMARY], baselines: declared, ablations: [] },
    mechanismChain: { steps: [] },
    componentNecessity: [],
    falsification: { conditions: ['f'] },
  } as unknown as IdeaCard;
}

function resultFixture(baselines: RunResult['baselines'], value: number): RunResult {
  return {
    specId: `idea-${ideaId}`,
    status: 'succeeded',
    logRefs: [],
    artifactRefs: [],
    metrics: [{ name: PRIMARY, value }],
    resourcesUsed: {},
    failure: null,
    startedAt: 1,
    finishedAt: 2,
    ...(baselines ? { baselines } : {}),
  } as unknown as RunResult;
}

async function workspace(
  declaredMethods: string[],
  mirrors: { spec: ExperimentSpec; result: RunResult }[],
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ideaseek-dupgather-'));
  const idea = join(root, 'ideas', ideaId);
  await mkdir(join(idea, 'experiments'), { recursive: true });
  await mkdir(join(idea, 'src'), { recursive: true });
  await writeFile(join(idea, 'src', 'train.py'), 'print(1)\n', 'utf8');
  await writeFile(
    join(idea, 'workspace.json'),
    JSON.stringify({ ideaId, currentVersion: 1, status: 'ANALYZING' }),
    'utf8',
  );
  await writeFile(join(idea, 'idea.json'), JSON.stringify(cardFixture(declaredMethods)), 'utf8');
  for (const mirror of mirrors) {
    await writeFile(
      join(idea, 'experiments', `idea-${ideaId}-v${mirror.spec.version}.json`),
      JSON.stringify(mirror),
      'utf8',
    );
  }
  return root;
}

const dbWithoutRepro = {
  getExperiment: async () => null,
  listExperiments: async () => [],
};

describe('duplicate detection sees the whole recorded control group', () => {
  it('flags a pair where only one of the two is declared by the card', async () => {
    // The bug this pins: the first implementation ran the detector over the
    // gathered `baselines` — one entry per method the CARD declares — so on FDG
    // it found nothing while the record held
    // fedavg = dp_noise_matched_no_shrinkage = 16.896707907604327. A check that
    // only inspects what was asked about cannot find what was not asked about.
    const controls = [
      { methodId: 'fedavg', metric: DECLARED, value: 16.896707907604327 },
      { methodId: 'dp_noise_matched_no_shrinkage', metric: DECLARED, value: 16.896707907604327 },
      { methodId: 'rethinkfl', metric: DECLARED, value: 17.216418964772203 },
    ];
    const root = await workspace(
      ['fedavg'],
      [{ spec: specFor('smoke'), result: resultFixture(controls, 16.715043539185267) }],
    );
    const input = await collectAnalysisInput(root, ideaId, dbWithoutRepro, [DECLARED]);
    expect(input.baselines.map((entry) => entry.methodId)).toEqual(['fedavg']);
    expect(input.suspiciousControls ?? []).toHaveLength(1);
    expect(input.suspiciousControls?.[0]).toContain('dp_noise_matched_no_shrinkage');
    expect(input.suspiciousControls?.[0]).toContain('16.896707907604327');
    expect(input.suspiciousControls?.[0]).toContain(`idea-${ideaId}@v1`);
  });

  it('reports nothing when the controls are genuinely distinct', async () => {
    const root = await workspace(
      ['fedavg'],
      [
        {
          spec: specFor('smoke'),
          result: resultFixture(
            [
              { methodId: 'fedavg', metric: DECLARED, value: 16.8967079 },
              { methodId: 'dp_noise_matched_no_shrinkage', metric: DECLARED, value: 16.8967081 },
            ],
            16.715043539185267,
          ),
        },
      ],
    );
    const input = await collectAnalysisInput(root, ideaId, dbWithoutRepro, [DECLARED]);
    expect(input.suspiciousControls ?? []).toEqual([]);
  });
});

describe('scale pairing outranks nominal provenance', () => {
  it('prefers an in-run control at the subject scale over a scale-unknown repro', async () => {
    // FDG's real pairing defect: `fedavg=18.75` came from a repro whose scale
    // was never recorded, and outranked the same run's own `fedavg=16.896708`
    // at smoke. The review could then only say the two are not matched
    // instrumentation — an unrankable comparison is not made honest by
    // preferring it for provenance. After the fix the same agent answered
    // "comparable" at confidence 0.72, and the delta moved from -0.5014 (an
    // artifact) to -0.1817 (a real, paired effect).
    const root = await workspace(
      ['fedavg'],
      [
        {
          spec: specFor('smoke'),
          result: resultFixture(
            [{ methodId: 'fedavg', metric: DECLARED, value: 16.896707907604327 }],
            16.715043539185267,
          ),
        },
      ],
    );
    const scaleUnknownRepro = {
      specId: 'repro-fedavg',
      spec: { ...specFor('unknown', 1), specId: 'repro-fedavg', idea: null },
      result: {
        ...resultFixture(undefined, 18.75),
        specId: 'repro-fedavg',
      },
    };
    const db = {
      getExperiment: async (specId: string) =>
        specId === 'repro-fedavg'
          ? {
              specId,
              spec: scaleUnknownRepro.spec as unknown as Record<string, unknown>,
              result: scaleUnknownRepro.result as unknown as Record<string, unknown>,
            }
          : null,
      listExperiments: async () => [],
    };
    const input = await collectAnalysisInput(root, ideaId, db, [DECLARED]);
    expect(input.baselines[0]).toMatchObject({
      methodId: 'fedavg',
      value: 16.896707907604327,
      scale: 'smoke',
      source: 'in-run',
    });
  });

  it('keeps the repro when it is itself at the subject scale', async () => {
    // The preference is about pairing, not about distrust: when the independent
    // reproduction is on the same scale, independence wins as documented.
    const root = await workspace(
      ['fedavg'],
      [
        {
          spec: specFor('smoke'),
          result: resultFixture(
            [{ methodId: 'fedavg', metric: DECLARED, value: 16.896707907604327 }],
            16.715043539185267,
          ),
        },
      ],
    );
    const matchedRepro = {
      specId: 'repro-fedavg',
      spec: { ...specFor('smoke', 1), specId: 'repro-fedavg', idea: null },
      result: { ...resultFixture(undefined, 18.75), specId: 'repro-fedavg' },
    };
    const db = {
      getExperiment: async (specId: string) =>
        specId === 'repro-fedavg'
          ? {
              specId,
              spec: matchedRepro.spec as unknown as Record<string, unknown>,
              result: matchedRepro.result as unknown as Record<string, unknown>,
            }
          : null,
      listExperiments: async () => [],
    };
    const input = await collectAnalysisInput(root, ideaId, db, [DECLARED]);
    expect(input.baselines[0]).toMatchObject({ value: 18.75, source: 'repro', scale: 'smoke' });
  });
});
