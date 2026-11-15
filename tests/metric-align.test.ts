import { expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  alignIdeaMetrics,
  alignedMetricNames,
  applyMetricAlignment,
  lowConfidenceMappings,
  requiredPrimaryMetric,
  type MetricAlignment,
} from '../src/idea/metric-align.js';
import type { IdeaCard } from '../src/idea/card.js';
import type { LockedProtocol } from '../src/experiment/protocol-source.js';

const PROTOCOL: LockedProtocol = {
  protocolId: 'p-feddg-1',
  locked: true,
  primaryMetrics: [
    {
      name: 'target_unseen_domain_top1_accuracy (held-out domain value, all samples, %)',
      direction: 'higher',
    },
  ],
  secondaryMetrics: [{ name: 'worst_domain_accuracy (min over domains, %)', direction: 'higher' }],
  splitRules: ['test domains never used for training'],
  slicing: [],
};

const CARD = {
  ideaId: 'gen-x',
  version: 1,
  hypothesis: { statement: 's', targetProblem: 't' },
  novelty: { claim: 'a held-out-domain gain', uncertainty: 'u', whyNotRestatement: 'w' },
  mechanismChain: {
    designPrincipleLink: 'd',
    steps: [{ kind: 'expected-change', text: 'unseen-domain top-1 accuracy rises' }],
  },
  minimalExperiment: {
    code: 'c',
    data: 'd',
    baselines: ['fedavg'],
    metrics: [
      'unseen-domain top-1 accuracy (held-out domain)',
      'class-conditional prototype variance along separating directions',
    ],
    ablations: [],
  },
} as unknown as IdeaCard;

function harnessReturning(answer: unknown) {
  return {
    kind: 'fake',
    async runTask() {
      return {
        output: JSON.stringify(answer),
        usage: {},
        model: 'm',
        toolCalls: [],
        finishedAt: 0,
      };
    },
    async health() {
      return { reachable: true, models: [], blocked: false, blockReason: null };
    },
    async initialize() {},
    async shutdown() {},
  } as never;
}

const align = (answer: unknown) =>
  alignIdeaMetrics({
    harness: harnessReturning(answer),
    card: CARD,
    protocol: PROTOCOL,
    ideaId: 'gen-x',
    runId: 'r-1',
  });

it('refuses a protocol name the agent invented', async () => {
  // The whole point of the boundary: choosing a name is how a primary metric
  // changes silently, so an answer that names something outside the protocol
  // set cannot be applied even when its prose is convincing.
  const result = await align({
    mappings: [
      {
        cardMetric: 'unseen-domain top-1 accuracy (held-out domain)',
        protocolMetric: 'unseen_domain_accuracy',
        reasoning: 'both are held-out domain accuracy',
        evidence: ['held-out domain value, all samples'],
        confidence: 0.9,
      },
    ],
    unmeasuredProtocolMetrics: [],
    summary: 'one invented name, nothing covered',
  });
  expect(result).not.toBeNull();
  expect(result!.mappings[0]!.protocolMetric).toBeNull();
  // And the metric it claimed to cover stays reported as unmeasured.
  expect(result!.unmeasuredProtocolMetrics).toContain('target_unseen_domain_top1_accuracy');
});

it('treats a mapping without quoted evidence as a guess', async () => {
  const result = await align({
    mappings: [
      {
        cardMetric: 'unseen-domain top-1 accuracy (held-out domain)',
        protocolMetric: 'target_unseen_domain_top1_accuracy',
        reasoning: 'they look like the same thing',
        evidence: [],
        confidence: 0.99,
      },
    ],
    unmeasuredProtocolMetrics: [],
    summary: 'confident but unsupported',
  });
  expect(result!.mappings[0]!.protocolMetric).toBeNull();
});

it('reports an uncovered protocol metric even when the agent omits it', async () => {
  const result = await align({
    mappings: [
      {
        cardMetric: 'unseen-domain top-1 accuracy (held-out domain)',
        protocolMetric: 'target_unseen_domain_top1_accuracy',
        reasoning: 'same population, same split, same aggregation',
        evidence: ['held-out domain value, all samples, %'],
        confidence: 0.9,
      },
    ],
    unmeasuredProtocolMetrics: [],
    summary: 'primary aligned; the secondary is simply not measured by this idea',
  });
  // Forgetting to report a gap is not allowed to make the gap disappear.
  expect(result!.unmeasuredProtocolMetrics).toEqual(['worst_domain_accuracy']);
  expect(result!.mappings[0]!.protocolMetric).toBe('target_unseen_domain_top1_accuracy');
});

it('keeps an idea-specific metric under its own identifier', () => {
  const alignment: MetricAlignment = {
    ideaId: 'gen-x',
    protocolId: 'p',
    mappings: [
      {
        cardMetric: 'unseen-domain top-1 accuracy (held-out domain)',
        protocolMetric: 'target_unseen_domain_top1_accuracy',
        reasoning: 'r',
        evidence: ['e'],
        confidence: 0.9,
      },
      {
        cardMetric: 'class-conditional prototype variance along separating directions',
        protocolMetric: null,
        reasoning: 'the protocol defines no variance statistic',
        evidence: ['prototype variance is not in the protocol metric list'],
        confidence: 0.8,
      },
    ],
    unmeasuredProtocolMetrics: [],
    summary: 's',
    createdAt: 0,
    alignmentHash: 'h',
  };
  expect(alignedMetricNames(CARD.minimalExperiment.metrics, alignment)).toEqual([
    'target_unseen_domain_top1_accuracy',
    'class-conditional prototype variance along separating directions',
  ]);
});

it('rewrites only the metric names of the idea config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ide-align-'));
  const ideaDir = join(root, 'ideas', 'gen-x');
  await mkdir(join(ideaDir, 'config'), { recursive: true });
  await writeFile(
    join(ideaDir, 'config', 'train.json'),
    JSON.stringify(
      { idea_id: 'gen-x', seeds: [42], metrics: ['unseen-domain top-1 accuracy (x)'] },
      null,
      2,
    ),
    'utf8',
  );
  const alignment: MetricAlignment = {
    ideaId: 'gen-x',
    protocolId: 'p',
    mappings: [
      {
        cardMetric: 'unseen-domain top-1 accuracy (x)',
        protocolMetric: 'target_unseen_domain_top1_accuracy',
        reasoning: 'r',
        evidence: ['e'],
        confidence: 0.9,
      },
    ],
    unmeasuredProtocolMetrics: [],
    summary: 's',
    createdAt: 0,
    alignmentHash: 'h',
  };
  const applied = await applyMetricAlignment({
    projectRoot: root,
    ideaId: 'gen-x',
    declaredMetrics: ['unseen-domain top-1 accuracy (x)'],
    alignment,
  });
  expect(applied.after).toEqual(['target_unseen_domain_top1_accuracy']);
  const stored = JSON.parse(
    await readFile(join(ideaDir, 'config', 'train.json'), 'utf8'),
  ) as Record<string, unknown>;
  expect(stored.metrics).toEqual(['target_unseen_domain_top1_accuracy']);
  // Everything else in the file survives untouched: a reformat would read like
  // an unrelated change in the idea's version record.
  expect(stored.seeds).toEqual([42]);
  expect(stored.idea_id).toBe('gen-x');
});

it('will not act on a mapping the agent itself calls shaky', () => {
  // Observed on the second real FDG call: 'in-domain accuracy' →
  // average_accuracy_across_folds, quoted evidence included, with the model's
  // own summary describing it as "the looser guess". Evidence alone cannot
  // detect that; confidence can, and applying it would redefine what the run
  // claims to measure.
  const alignment: MetricAlignment = {
    ideaId: 'gen-x',
    protocolId: 'p',
    mappings: [
      {
        cardMetric: 'unseen-domain top-1 accuracy (held-out domain)',
        protocolMetric: 'target_unseen_domain_top1_accuracy',
        reasoning: 'same population, split and aggregation',
        evidence: ['held-out domain value, all samples, %'],
        confidence: 0.9,
      },
      {
        cardMetric: 'in-domain accuracy',
        protocolMetric: 'average_accuracy_across_folds',
        reasoning: 'the looser guess; both are accuracies',
        evidence: ['average_accuracy_across_folds'],
        confidence: 0.45,
      },
    ],
    unmeasuredProtocolMetrics: ['worst_domain_accuracy'],
    summary: 'one firm mapping, one the agent hedged',
    createdAt: 0,
    alignmentHash: 'h',
  };
  expect(
    alignedMetricNames(
      ['unseen-domain top-1 accuracy (held-out domain)', 'in-domain accuracy'],
      alignment,
    ),
  ).toEqual(['target_unseen_domain_top1_accuracy', 'in-domain accuracy']);
  expect(lowConfidenceMappings(alignment).map((m) => m.cardMetric)).toEqual(['in-domain accuracy']);
  // The gate is the protocol's own first primary, the same one the experiment
  // guard requires; a wider gate would block the repair route.
  expect(requiredPrimaryMetric(PROTOCOL)).toBe('target_unseen_domain_top1_accuracy');
});
