import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeRunBaselines } from '../src/idea/experiment.js';
import { collectAnalysisInput } from '../src/idea/analyze.js';
import type { ExperimentSpec, RunResult } from '../src/experiment/spec.js';
import type { IdeaCard } from '../src/idea/card.js';

/**
 * #22②: an idea run's own control group is evidence, and it used to be
 * printed and thrown away. Two layers had to change: the capture (what the
 * entry printed becomes a recorded field) and the gathering (a recorded
 * control becomes a legal baseline source, saying where it came from).
 */

const PRIMARY = 'target_unseen_domain_top1_accuracy';
const DECLARED = `${PRIMARY} (held-out domain value, all samples, %)`;

function specFor(ideaId: string): ExperimentSpec {
  return {
    specId: `idea-${ideaId}`,
    version: 1,
    idea: { ideaId, version: 1 },
    comparisonIds: ['fedavg'],
    codeCommit: null,
    dataSnapshotId: 'inputs:fdg',
    sliceIds: [],
    environment: { python: 'v24', notes: ['scale:smoke'] },
    command: ['python', 'src/train.py', '--scale', 'smoke'],
    metrics: [{ name: PRIMARY, direction: 'higher' }],
    seeds: [42],
    resources: {},
    budget: { maxRuns: 1, maxMinutes: 5 },
    protocolId: null,
    createdAt: 1,
  } as unknown as ExperimentSpec;
}

describe('in-run control capture (what the entry printed)', () => {
  it('normalises the shapes programs actually write', () => {
    const spec = specFor('probe-shrink');
    // Flat map: the FDG prototype's `report["baselines"]`.
    expect(normalizeRunBaselines({ fedavg: 18.75, rethinkfl: 22.1 }, spec)).toEqual([
      { methodId: 'fedavg', metric: PRIMARY, value: 18.75 },
      { methodId: 'rethinkfl', metric: PRIMARY, value: 22.1 },
    ]);
    // Nested map: one metric per control, matched by identifier across prose.
    expect(
      normalizeRunBaselines(
        { fedavg: { [`${PRIMARY} (held-out, %)`]: 18.75, rounds_to_stability: 41 } },
        spec,
      ),
    ).toEqual([{ methodId: 'fedavg', metric: `${PRIMARY} (held-out, %)`, value: 18.75 }]);
    // Structured array, including a spread the entry measured itself.
    expect(normalizeRunBaselines([{ method: 'fedavg', accuracy: 18.75, std: 0.4 }], spec)).toEqual([
      { methodId: 'fedavg', metric: PRIMARY, value: 18.75, stdev: 0.4 },
    ]);
  });

  it('refuses the values that cannot enter a record', () => {
    const spec = specFor('probe-shrink');
    // A control named after the idea itself is #23's contamination: the
    // subject's own metric relabelled as its baseline.
    expect(normalizeRunBaselines({ 'probe-shrink': 30.0, fedavg: 18.75 }, spec)).toEqual([
      { methodId: 'fedavg', metric: PRIMARY, value: 18.75 },
    ]);
    expect(normalizeRunBaselines({ fedavg: Number.NaN, center: 'none' }, spec)).toEqual([]);
    expect(normalizeRunBaselines(undefined, spec)).toEqual([]);
    expect(normalizeRunBaselines('fedavg=18.75', spec)).toEqual([]);
  });
});

describe('in-run controls as a baseline source (gathering)', () => {
  const ideaId = 'probe-shrink';

  async function workspaceWith(recordedResult: RunResult): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ideaseek-inrun-'));
    const idea = join(root, 'ideas', ideaId);
    await mkdir(join(idea, 'experiments'), { recursive: true });
    await mkdir(join(idea, 'src'), { recursive: true });
    await writeFile(join(idea, 'src', 'train.py'), 'print(1)\n', 'utf8');
    await writeFile(
      join(idea, 'workspace.json'),
      JSON.stringify({ ideaId, currentVersion: 1, status: 'RUNNING' }),
      'utf8',
    );
    // A card the ladder can read in full: deriveAblations walks
    // componentNecessity and minimalExperiment.ablations without guarding, and
    // production cards are schema-validated before they get here.
    const card = {
      ideaId,
      version: 1,
      parentVersion: null,
      status: 'RUNNING',
      hypothesis: { statement: 'probe consensus shrinks drift', targetProblem: 't' },
      paperEvidence: [{ paperRef: 'p', statement: 's', evidence: 'e' }],
      contradictions: ['c'],
      novelty: { claim: 'c', uncertainty: 'u', whyNotRestatement: 'w' },
      mechanismChain: {
        designPrincipleLink: 'l',
        steps: [
          { kind: 'observation', text: 'a' },
          { kind: 'expected-change', text: 'd' },
        ],
      },
      nearestComparisons: [
        { methodId: 'fedavg', difference: 'no client weighting', evidence: 'e' },
      ],
      componentNecessity: [],
      competingExplanations: ['x'],
      boundaryConditions: ['x'],
      risks: ['x'],
      minimalExperiment: {
        code: 'src/train.py',
        data: 'd',
        baselines: ['fedavg'],
        metrics: [PRIMARY],
        ablations: [],
      },
      falsification: { conditions: ['f'] },
      budget: { maxRounds: 1, maxGpuMinutes: 10 },
      stopConditions: ['s'],
      createdAt: 1,
    } as unknown as IdeaCard;
    await writeFile(join(idea, 'idea.json'), JSON.stringify(card), 'utf8');
    await writeFile(
      join(idea, 'experiments', `idea-${ideaId}-v1.json`),
      JSON.stringify({ spec: specFor(ideaId), result: recordedResult }),
      'utf8',
    );
    return root;
  }

  const emptyDb = {
    getExperiment: async () => null,
    listExperiments: async () => [],
  };

  function succeededWith(baselines: RunResult['baselines']): RunResult {
    return {
      specId: `idea-${ideaId}`,
      status: 'succeeded',
      logRefs: [],
      artifactRefs: [],
      metrics: [{ name: PRIMARY, value: 30.0 }],
      resourcesUsed: {},
      failure: null,
      startedAt: 1,
      finishedAt: 2,
      ...(baselines ? { baselines } : {}),
    } as RunResult;
  }

  it('reads a recorded control as the baseline it is, with its provenance', async () => {
    const root = await workspaceWith(
      succeededWith([{ methodId: 'fedavg', metric: DECLARED, value: 18.75 }]),
    );
    const input = await collectAnalysisInput(root, ideaId, emptyDb, [DECLARED]);
    expect(input.baselines).toEqual([
      {
        methodId: 'fedavg',
        value: 18.75,
        scale: 'smoke',
        source: 'in-run',
        fromSpecId: `idea-${ideaId}@v1`,
      },
    ]);
  });

  it('still reports no baseline when the run recorded no control', async () => {
    const root = await workspaceWith(succeededWith(undefined));
    const input = await collectAnalysisInput(root, ideaId, emptyDb, [DECLARED]);
    expect(input.baselines.map((baseline) => baseline.value)).toEqual([null]);
  });

  it("prefers an independent reproduction over the idea's own control", async () => {
    const root = await workspaceWith(
      succeededWith([{ methodId: 'fedavg', metric: DECLARED, value: 18.75 }]),
    );
    const reproResult = {
      specId: 'repro-fedavg',
      status: 'succeeded',
      logRefs: [],
      artifactRefs: [],
      metrics: [{ name: PRIMARY, value: 21.5 }],
      resourcesUsed: {},
      failure: null,
      startedAt: 1,
      finishedAt: 2,
    };
    const db = {
      getExperiment: async (specId: string) =>
        specId === 'repro-fedavg'
          ? {
              specId,
              spec: { ...specFor('fedavg-run'), specId, idea: null },
              result: reproResult,
            }
          : null,
      listExperiments: async () => [],
    };
    const input = await collectAnalysisInput(root, ideaId, db, [DECLARED]);
    // A reproduction of the method by the platform outranks a control the
    // subject's own code measured, so the ladder ranks the stronger evidence.
    expect(input.baselines).toEqual([
      { methodId: 'fedavg', value: 21.5, scale: 'smoke', source: 'repro' },
    ]);
  });

  it('holds a recorded control to the declared unit like any other value', async () => {
    // The idea printed its control as a fraction while the protocol declares
    // percent: dropping it silently would read as "no baseline available".
    const root = await workspaceWith(
      succeededWith([{ methodId: 'fedavg', metric: DECLARED, value: 0.1875 }]),
    );
    const input = await collectAnalysisInput(root, ideaId, emptyDb, [DECLARED]);
    expect(input.baselines.map((baseline) => baseline.value)).toEqual([null]);
    expect(input.unitProblems ?? []).toHaveLength(1);
    expect(input.unitProblems?.[0]).toContain('declared percent');
  });

  it('reports a control recorded under a private key name instead of calling it absent', async () => {
    // FDG's entry writes {"fedavg": {"unseen": …, "in_domain": …}}: the control
    // was really measured, and its label denotes neither the primary metric nor
    // anything this platform can rank. Comparing it would be a silent
    // redefinition; discarding it would report an absence that is not true.
    const root = await workspaceWith(
      succeededWith([
        { methodId: 'fedavg', metric: 'unseen', value: 0.19 },
        { methodId: 'fedavg', metric: 'in_domain', value: 0.44 },
      ]),
    );
    const input = await collectAnalysisInput(root, ideaId, emptyDb, [DECLARED]);
    expect(input.baselines.map((baseline) => baseline.value)).toEqual([null]);
    expect(input.unmatchableControls ?? []).toHaveLength(1);
    expect(input.unmatchableControls?.[0]).toContain('"unseen", "in_domain"');
    expect(input.unmatchableControls?.[0]).toContain('does not denote the primary metric');

    const { analyzeIdea } = await import('../src/idea/analysis.js');
    const verdict = analyzeIdea({
      ideaId,
      ideaVersion: 1,
      codeHash: 'sha256:aa',
      card: JSON.parse(
        await (
          await import('node:fs/promises')
        ).readFile(join(root, 'ideas', ideaId, 'idea.json'), 'utf8'),
      ),
      main: input.main,
      ablations: input.ablations,
      baselines: input.baselines,
      scalesRun: input.scalesRun,
      datasetsRun: input.datasetsRun,
      seedsCount: input.seedsCount,
      failures: input.failures,
      resources: input.resources,
      unmatchableControls: input.unmatchableControls,
    });
    // The finding is engineering, never a verdict about the hypothesis.
    expect(verdict.reasons.join(' ')).toContain('cannot be ranked');
    expect(verdict.nextSteps.join(' ')).toContain('primary metric name as the key');
  });
});
