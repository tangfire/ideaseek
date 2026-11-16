import { expect, it } from 'vitest';
import { compareWithAgent, type ComparisonFact } from '../src/idea/analysis-agent.js';

const FACTS: ComparisonFact[] = [
  {
    source: 'idea-main',
    metric: 'target_unseen_domain_top1_accuracy',
    value: 0.16858931604511102,
    scale: 'quick',
    provenance: 'idea main run, delta=-0.05',
  },
  {
    source: 'fedavg',
    metric: 'target_unseen_domain_top1_accuracy',
    value: 18.75,
    scale: 'quick',
    provenance: 'recorded baseline result',
  },
];

function harness(answer: unknown) {
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

const call = (answer: unknown, facts = FACTS) =>
  compareWithAgent({
    harness: harness(answer),
    ideaId: 'gen-x',
    runId: 'r-1',
    protocolText:
      'primary metric: target_unseen_domain_top1_accuracy (held-out domain value, all samples, %)',
    coverageText: 'scales=[quick, smoke] datasets=1 seeds=1',
    facts,
  });

it('refuses to adopt a verdict that cites a number the records do not have', async () => {
  // The citation check is the boundary that makes an agent verdict usable:
  // without it a hallucinated baseline value would become a conclusion.
  const answer = {
    comparable: false,
    verdict: 'inconclusive',
    failureClass: 'metric',
    unitAssessment:
      'fedavg is recorded as a percentage (18.75) while the idea value is a 0-1 fraction, so the two are not the same unit system',
    reasoning:
      'the deterministic ladder compared a fraction against a percentage and declared the hypothesis lost',
    citedValues: [
      { source: 'idea-main', metric: 'target_unseen_domain_top1_accuracy', value: 0.42 },
      { source: 'fedavg', metric: 'target_unseen_domain_top1_accuracy', value: 18.75 },
    ],
    evidence: ['held-out domain value, all samples, %'],
    recommendedNext: 'declare the unit in the protocol',
    confidence: 0.9,
  };
  expect(await call(answer)).toBeNull();
});

it('accepts a comparability refusal whose citations all match', async () => {
  const answer = {
    comparable: false,
    verdict: 'inconclusive',
    failureClass: 'metric',
    unitAssessment:
      'fedavg=18.75 is a percentage while the idea metric is a 0-1 accuracy; no fraction could ever beat it',
    reasoning:
      'the primary values are not in one unit system, so the effect-insufficient verdict is not evidence about the hypothesis',
    citedValues: [
      {
        source: 'idea-main',
        metric: 'target_unseen_domain_top1_accuracy',
        value: 0.16858931604511102,
      },
      { source: 'fedavg', metric: 'target_unseen_domain_top1_accuracy', value: 18.75 },
    ],
    evidence: ['held-out domain value, all samples, %'],
    recommendedNext: 'record both sides in the same unit or declare it in the protocol',
    confidence: 0.85,
  };
  const review = await call(answer);
  expect(review).not.toBeNull();
  expect(review!.comparable).toBe(false);
  expect(review!.verdict).toBe('inconclusive');
});

it('discards a self-contradicting answer that calls the values incomparable but the idea rejected', async () => {
  const answer = {
    comparable: false,
    verdict: 'rejected',
    failureClass: 'effect-insufficient',
    unitAssessment:
      'the two sides are in different unit systems (percentage versus fraction) and so cannot be ranked',
    reasoning:
      'even though the units differ, the platform ladder said the idea lost, so the hypothesis is rejected',
    citedValues: [
      {
        source: 'idea-main',
        metric: 'target_unseen_domain_top1_accuracy',
        value: 0.16858931604511102,
      },
      { source: 'fedavg', metric: 'target_unseen_domain_top1_accuracy', value: 18.75 },
    ],
    evidence: ['held-out domain value, all samples, %'],
    confidence: 0.8,
  };
  expect(await call(answer)).toBeNull();
});
