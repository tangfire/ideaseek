import { expect, it } from 'vitest';
import {
  buildBlueprintContext,
  type BlueprintEvidence,
} from '../src/comparison/blueprint-author.js';
import { blueprintMetricNames, checkMetricFeasibility } from '../src/comparison/reproduce.js';

const PROTOCOL = {
  primaryMetrics: [
    { name: 'target_unseen_domain_top1_accuracy', direction: 'higher' },
    { name: 'average_accuracy_across_folds', direction: 'higher' },
  ],
  splitRules: ['leave-one-domain-out'],
};

function evidence(over: Partial<BlueprintEvidence> = {}): BlueprintEvidence {
  return {
    methodId: 'fedavg',
    question: 'federated domain generalization',
    papers: [{ source: 'arxiv:2301.00001', title: 'FedDG', topClaims: [{ text: 'c', page: 1 }] }],
    protocol: PROTOCOL,
    corpus: { samples: 9991, domainAxis: 'domain', domains: ['A', 'B', 'C', 'D'], classes: 7 },
    ...over,
  };
}

it('names the required metric keys instead of relying on "reuse verbatim"', () => {
  const context = buildBlueprintContext(evidence());
  expect(context).toContain('## required output metric keys');
  expect(context).toContain('target_unseen_domain_top1_accuracy');
  expect(context).toContain('average_accuracy_across_folds');
  // The refusal to accept a close-enough name is the whole point: this is what
  // the feasibility check enforces and the model is told up front.
  expect(context).toContain('is not a substitute');
});

it('drops the required-keys section when nothing is locked', () => {
  const context = buildBlueprintContext(evidence({ protocol: null }));
  expect(context).not.toContain('## required output metric keys');
  expect(context).toContain('none — metrics must be proposed as assumptions');
});

it('keeps the correction past context truncation', () => {
  const long = 'x'.repeat(40_000);
  const context = buildBlueprintContext(
    evidence({
      correction: 'algorithm.metrics must use the protocol names',
      papers: [
        {
          source: 'arxiv:1',
          title: long,
          topClaims: Array.from({ length: 60 }, () => ({ text: long, page: 1 })),
        },
      ],
    }),
  );
  expect(context).toContain('(context truncated)');
  expect(context.indexOf('## correction required')).toBeGreaterThan(
    context.indexOf('(context truncated)'),
  );
  expect(context).toContain('algorithm.metrics must use the protocol names');
});

it('a plan reporting differently named metrics is blocked against the protocol', () => {
  const blueprint = {
    algorithm: {
      metrics: [
        { name: 'unseen_domain_accuracy', direction: 'higher' },
        { name: 'avg_source_domain_accuracy', direction: 'higher' },
      ],
    },
  } as unknown as Parameters<typeof blueprintMetricNames>[0];
  const feasibility = checkMetricFeasibility(
    PROTOCOL.primaryMetrics.map((metric) => metric.name),
    blueprintMetricNames(blueprint),
  );
  // This is the exact FDG shape: plausible names, zero protocol coverage.
  expect(feasibility.status).toBe('blocked');
  expect(feasibility.uncovered).toEqual([
    'target_unseen_domain_top1_accuracy',
    'average_accuracy_across_folds',
  ]);
});

it('matching is by normalised name and tolerates extra metrics', () => {
  const names = (list: string[]) => list.map((name) => ({ name, direction: 'higher' }));
  const blueprint = {
    algorithm: {
      metrics: [
        ...names(['Target-Unseen-Domain-Top1-Accuracy', 'average_accuracy_across_folds']),
        ...names(['communication_cost']),
      ],
    },
  } as unknown as Parameters<typeof blueprintMetricNames>[0];
  expect(
    checkMetricFeasibility(
      PROTOCOL.primaryMetrics.map((metric) => metric.name),
      blueprintMetricNames(blueprint),
    ).status,
  ).toBe('covered');
});
