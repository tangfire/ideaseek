import { expect, it } from 'vitest';
import {
  BLUEPRINT_INSTRUCTION,
  buildBlueprintContext,
  type BlueprintEvidence,
} from '../src/comparison/blueprint-author.js';
import { blueprintMetricNames, checkMetricFeasibility } from '../src/comparison/reproduce.js';
import { metricIdentifier, metricKey } from '../src/core/metric-id.js';

it('shows the identifier, not the comparison key', () => {
  // An earlier version listed the normalized key in the prompt, and the model
  // dutifully wrote metric names like "targetunseendomaintop1accuracy" into
  // the plan: matching became stable and the artifacts became unreadable.
  expect(metricIdentifier('target_unseen_domain_top1_accuracy (held-out domain value, %)')).toBe(
    'target_unseen_domain_top1_accuracy',
  );
  const context = buildBlueprintContext(evidence());
  expect(context).toContain('do not lowercase it or strip its separators');
});

it('a protocol name carrying its definition matches the bare identifier', () => {
  // The observed instability: one run copied "x (held-out domain value, …)"
  // and passed, the next wrote "x" and was blocked. Copying prose is not a
  // property a plan should depend on.
  expect(
    metricKey('target_unseen_domain_top1_accuracy (held-out domain value, all samples, %)'),
  ).toBe(metricKey('target_unseen_domain_top1_accuracy'));
  expect(metricKey('delta_over_FedAvg')).toBe('deltaoverfedavg');
  expect(
    checkMetricFeasibility(
      ['target_unseen_domain_top1_accuracy (held-out domain value, all samples, %)'],
      ['target_unseen_domain_top1_accuracy'],
    ).status,
  ).toBe('covered');
});

it('a genuinely different metric is still blocked', () => {
  expect(
    checkMetricFeasibility(['average_accuracy_across_folds'], ['unseen_domain_accuracy']).status,
  ).toBe('blocked');
});

it('the blueprint contract names the environment the program will really run in', () => {
  // Only check-data gets a path handed to it, so a plan that describes data
  // access purely as "the caller passes a path" leaves smoke guessing.
  expect(BLUEPRINT_INSTRUCTION).toContain('IDEASEEK_DATASET_ROOTS');
  expect(BLUEPRINT_INSTRUCTION).toContain('Only check-data receives a path');
});

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

it('states that the measured corpus is full-scale while the checks are not', () => {
  // check-data failed a correct 1000-sample subset against "expected 9991"
  // because the plan was given the full-corpus profile with no scale note.
  expect(buildBlueprintContext(evidence())).toContain('this count is the FULL corpus');
  expect(BLUEPRINT_INSTRUCTION).toContain('Do not put an absolute sample count into any check');
});

it('the blueprint is a plan, not an embedded program', () => {
  // Authoring used to demand a whole Python file inside one JSON string. That
  // is where truncation and bracket failures came from, and it left two
  // copies of the implementation (plan + worktree) with the plan never read
  // again once implement had written the real one.
  expect(BLUEPRINT_INSTRUCTION).toContain('This is a PLAN, not a program');
  expect(BLUEPRINT_INSTRUCTION).toContain('comparison implement');
});

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
