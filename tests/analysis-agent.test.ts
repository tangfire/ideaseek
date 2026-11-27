import { expect, it } from 'vitest';
import {
  buildCoverageText,
  compareWithAgent,
  type ComparisonFact,
} from '../src/idea/analysis-agent.js';

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

it('coverage text carries the ablation spread the verdict contract asks the agent to weigh', () => {
  // Observed: the contract says "say what spread the platform recorded
  // (seeds, scales, ablations)" while the context listed only scales/seeds —
  // a careful agent could not see the green ablations and answered
  // "insufficient evidence" (inconclusive) on evidence it was never shown.
  const text = buildCoverageText({
    coverage: { scales: ['quick', 'smoke'], datasets: ['inputs:x'], seeds: 2, missing: [] },
    mechanismEvidence: [
      {
        ablationId: 'abl-w-o-global-low-rank',
        mainValue: 23.7179,
        ablationValue: 22.5314,
        supports: true,
      },
      {
        ablationId: 'abl-random-basis',
        mainValue: 23.7179,
        ablationValue: 23.2005,
        supports: null,
      },
    ],
  });
  expect(text).toContain('seeds=2');
  expect(text).toContain('ablations:');
  expect(text).toContain('abl-w-o-global-low-rank 23.7179→22.5314 [necessary holds]');
  expect(text).toContain('abl-random-basis 23.7179→23.2005');
  expect(
    buildCoverageText({
      coverage: { scales: ['smoke'], datasets: [], seeds: 1, missing: ['seeds'] },
      mechanismEvidence: [],
    }),
  ).toContain('ablations: (none recorded)');
});

it('binds the review to the shown facts: the instruction bans reasoning from other files', async () => {
  // Observed: with file tools available the agent went reading old
  // workspace records (scaffold-era runs) and declared the current
  // comparison NOT comparable because history disagreed — a verdict about
  // the wrong records. The contract must say the shown facts are all there
  // is to reason from.
  const answer = {
    comparable: true,
    verdict: 'supported',
    failureClass: 'none',
    unitAssessment: 'both values are the protocol primary metric in percent at the same scale',
    reasoning: 'same metric, same unit, same scale; the idea value exceeds the baseline',
    citedValues: [
      {
        source: 'idea-main',
        metric: 'target_unseen_domain_top1_accuracy',
        value: 0.16858931604511102,
      },
      { source: 'fedavg', metric: 'target_unseen_domain_top1_accuracy', value: 18.75 },
    ],
    evidence: ['held-out domain value, all samples, %'],
    recommendedNext: 'record the verdict',
    confidence: 0.8,
  };
  let instruction = '';
  const capturing = {
    kind: 'fake',
    async runTask(request: { instruction: string }) {
      instruction = request.instruction;
      return { output: JSON.stringify(answer), usage: {}, model: 'm', toolCalls: [], finishedAt: 0 };
    },
    async health() {
      return { reachable: true, models: [], blocked: false, blockReason: null };
    },
    async initialize() {},
    async shutdown() {},
  } as never;
  await compareWithAgent({
    harness: capturing,
    ideaId: 'gen-x',
    runId: 'r-2',
    protocolText: 'primary metric: target_unseen_domain_top1_accuracy (held-out domain value, all samples, %)',
    coverageText: 'scales=[quick, smoke] datasets=1 seeds=1',
    facts: FACTS,
  });
  expect(instruction).toContain('Use ONLY what is shown above');
  expect(instruction).toContain('Workspace files, older experiment records');
  expect(instruction).toContain('Recorded values');
});
