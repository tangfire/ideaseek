import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validatePaperCard } from '../src/knowledge/papercard.js';
import { validateProtocolProposal } from '../src/experiment/protocol.js';
import { checkLeakage } from '../src/experiment/leakage.js';
import type { DatasetSlice } from '../src/experiment/slices.js';
import { evaluateComparisonGate, type ComparisonGateDb } from '../src/comparison/gate.js';
import { assessIdeaCard } from '../src/idea/card.js';
import { analyzeIdea, type AnalysisInput } from '../src/idea/analysis.js';

/**
 * Second task family regression (docs/PROGRESS 领域无关回归验证): the
 * FL gold set pins the federated direction; this suite pins the SAME
 * core validators/analyst/gate on an image-segmentation direction —
 * different sample unit (patient volume), split rule (patient-level),
 * metrics (dice higher / hd95 lower) — proving the engine is not
 * FL/accuracy-specific. Synthetic fixtures only; no real data/secrets.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'seg-goldset');

async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(FIXTURES, name), 'utf8')) as T;
}

function segIdeaCard(): Record<string, unknown> {
  return {
    ideaId: 'seg-alpha',
    version: 1,
    parentVersion: null,
    status: 'DRAFT_COMPOSITION',
    hypothesis: {
      statement: 'Boundary-aware loss lifts small-organ Dice.',
      targetProblem: 'small-organ under-segmentation',
    },
    paperEvidence: [
      { paperRef: 'synth-seg-0001', statement: 'boundary loss helps', evidence: 'p.7' },
    ],
    contradictions: ['plain Dice works on large organs'],
    novelty: {
      claim: 'boundary term for small organs',
      uncertainty: 'thin',
      whyNotRestatement: 'adds an auxiliary loss',
    },
    mechanismChain: {
      designPrincipleLink: 'sharpen decision boundary',
      steps: [{ kind: 'observation', text: 'small organs lose boundary voxels' }],
    },
    nearestComparisons: [
      { methodId: 'unet', difference: 'adds boundary loss', evidence: 'table 2' },
      {
        methodId: 'transunet',
        difference: 'transformer encoder instead of CNN',
        evidence: 'table 1',
      },
    ],
    componentNecessity: [],
    competingExplanations: ['longer training explains it'],
    boundaryConditions: ['single-site CT only'],
    risks: ['annotation noise'],
    minimalExperiment: {
      code: 'src/train.py',
      data: 'smoke',
      baselines: ['unet'],
      metrics: ['dice'],
      ablations: ['w/o boundary loss'],
    },
    falsification: { conditions: ['no Dice gain'] },
    budget: { maxRounds: 3, maxGpuMinutes: 60 },
    stopConditions: ['budget'],
    createdAt: 1,
  };
}

function slice(overrides: Partial<DatasetSlice> = {}): DatasetSlice {
  return {
    sliceId: 'ds-seg-quick-r1',
    datasetSnapshotId: 'data-seg',
    scale: 'quick',
    rule: 'patient-level shuffle take 1/100',
    ruleVersion: 1,
    inputHash: `sha256:${'c'.repeat(64)}`,
    outputHash: `sha256:${'d'.repeat(64)}`,
    stats: { totalRows: 100, selectedRows: 20 },
    seed: 7,
    boundaries: ['patient-level selection (rule v1)'],
    generatedBy: 'test',
    generatedAt: 1,
    limits: ['fraction for quick is 0.20'],
    ...overrides,
  };
}

function analysisInput(
  card: Record<string, unknown>,
  primary: { name: string; direction: 'higher' | 'lower' },
  ideaValue: number,
  baselineValue: number,
): AnalysisInput {
  return {
    ideaId: String(card.ideaId),
    ideaVersion: 1,
    codeHash: 'sha256:' + 'e'.repeat(64),
    card: card as never,
    main: {
      spec: {
        specId: 'idea-seg-alpha',
        version: 1,
        idea: { ideaId: String(card.ideaId), version: 1 },
        comparisonIds: ['unet-fixture'],
        codeCommit: null,
        dataSnapshotId: 'data-seg',
        sliceIds: ['ds-seg-quick-r1'],
        environment: { python: 'v24', notes: ['scale:smoke'] },
        command: ['python', 'src/train.py'],
        metrics: [primary],
        seeds: [7, 11],
        resources: {},
        budget: { maxRuns: 1, maxMinutes: 5 },
        protocolId: 'proto-seg-v1',
        createdAt: 1,
      } as never,
      result: {
        specId: 'idea-seg-alpha',
        status: 'succeeded',
        logRefs: [],
        artifactRefs: [],
        metrics: [{ name: primary.name, value: ideaValue }],
        resourcesUsed: {},
        failure: null,
        startedAt: 1,
        finishedAt: 2,
      } as never,
    },
    ablations: [],
    baselines: [{ methodId: 'unet-fixture', value: baselineValue }],
    scalesRun: ['smoke', 'quick'],
    datasetsRun: ['data-seg'],
    seedsCount: 2,
    failures: [],
    resources: [],
  };
}

describe('second task family: image segmentation fixtures', () => {
  it('PaperCard satisfies the structural contract with locatable claims', async () => {
    const card = await fixture<Record<string, unknown>>('papercard.json');
    const result = validatePaperCard(card);
    expect(result).toEqual({ ok: true, errors: [] });
    const claims = card.claims as { evidence: unknown[] }[];
    expect(claims.length).toBeGreaterThanOrEqual(2);
    for (const claim of claims) expect(claim.evidence.length).toBeGreaterThan(0);
    expect(String(card.document_hash)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('protocol validates with segmentation metrics and surfaces confirmations', async () => {
    const proposal = await fixture<Record<string, unknown>>('protocol-proposal.json');
    const result = validateProtocolProposal(proposal);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.confirmations.length).toBeGreaterThan(0);
    const primary = proposal.primaryMetrics as { name: string; direction: string }[];
    expect(primary.map((m) => m.name)).toContain('dice');
    expect(primary.every((m) => m.direction === 'higher' || m.direction === 'lower')).toBe(true);
    const secondary = proposal.secondaryMetrics as { name: string; direction: string }[];
    expect(secondary.find((m) => m.name === 'hd95')?.direction).toBe('lower');
  });

  it('patient-level slices pass the leakage gate (single snapshot, nested scales)', () => {
    const report = checkLeakage({
      slices: [
        slice(),
        slice({
          sliceId: 'ds-seg-smoke-r1',
          scale: 'smoke',
          stats: { totalRows: 100, selectedRows: 5 },
          limits: ['fraction for smoke is 0.05'],
        }),
      ],
      now: 1,
    });
    const blockers = report.findings.filter((f) => f.severity === 'blocker');
    expect(blockers).toEqual([]);
    expect(report.ok).toBe(true);
    const single = report.findings.find((f) => f.check === 'single-snapshot');
    expect(single?.ok).toBe(true);
  });

  it('Idea card assesses as a candidate (mechanism chain complete)', () => {
    const assessment = assessIdeaCard(segIdeaCard() as never);
    expect(assessment.ok).toBe(true);
  });

  it('analysis is direction-agnostic: dice (higher) loses, hd95 (lower) wins', () => {
    const card = segIdeaCard();

    // Dice, higher-is-better: idea 0.72 vs baseline 0.85 → negative delta.
    const losing = analyzeIdea(
      analysisInput(card, { name: 'dice', direction: 'higher' }, 0.72, 0.85),
    );
    expect(losing.primaryDelta!).toBeLessThan(0);
    expect(losing.verdict).toBe('rejected');
    expect(losing.failureClass).toBe('effect-insufficient');

    // HD95, lower-is-better: idea 12 vs baseline 20 → POSITIVE delta
    // (same adjustedDelta engine — nothing FL/accuracy-specific).
    const winning = analyzeIdea(analysisInput(card, { name: 'hd95', direction: 'lower' }, 12, 20));
    expect(winning.primaryDelta!).toBeGreaterThan(0);
  });

  it('comparison gate is generic over segmentation methods', async () => {
    const methods = [
      {
        methodId: 'unet-fixture',
        status: 'smoke-tested',
        required: true,
        record: { methodId: 'unet-fixture' },
      },
      {
        methodId: 'sam-fixture',
        status: 'excluded',
        required: true,
        record: { methodId: 'sam-fixture', statusReason: '2D-only, cannot consume 3D volumes' },
      },
      {
        methodId: 'transunet-fixture',
        status: 'repairing',
        required: true,
        record: { methodId: 'transunet-fixture' },
      },
    ];
    const experiments = [
      {
        specId: 'repro-unet-fixture',
        status: 'succeeded',
        spec: { comparisonIds: ['unet-fixture'] },
        result: { status: 'succeeded' },
      },
    ];
    const db: ComparisonGateDb = {
      listComparisons: async (filter) =>
        filter.required ? methods : methods.map((m) => ({ ...m, required: false })),
      listExperiments: async () => experiments,
    };

    const blocked = await evaluateComparisonGate(db);
    expect(blocked.ok).toBe(false);
    expect(blocked.skipped).toEqual([
      { methodId: 'sam-fixture', reason: '2D-only, cannot consume 3D volumes' },
    ]);
    expect(blocked.blocking.map((b) => b.methodId)).toEqual(['transunet-fixture']);

    const ready = await evaluateComparisonGate({
      ...db,
      listComparisons: async (filter) => {
        const rest = methods.filter((m) => m.methodId !== 'transunet-fixture');
        return filter.required ? rest : rest.map((m) => ({ ...m, required: false }));
      },
    });
    expect(ready.ok).toBe(true);
    expect(ready.blocking).toEqual([]);
  });
});
