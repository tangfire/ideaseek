import { expect, it } from 'vitest';
import {
  auditMetricDirections,
  directionIsFlagged,
  type DirectionAudit,
} from '../src/experiment/direction-audit.js';
import type { LockedProtocol } from '../src/experiment/protocol-source.js';
import { declaredMetric } from '../src/experiment/protocol-source.js';

// The FDG protocol as actually recorded: every metric declared direction
// "higher", including one where a larger value is the failing outcome.
const PROTOCOL: LockedProtocol = {
  protocolId: 'p-1',
  locked: true,
  primaryMetrics: [
    declaredMetric(
      'target_unseen_domain_top1_accuracy (held-out domain value, all samples, %)',
      'higher',
    ),
  ],
  secondaryMetrics: [
    declaredMetric('principal-angle mismatch of per-client separating bases', 'higher'),
    declaredMetric(
      'class-conditional cross-client prototype variance along separating vs nuisance directions',
      'higher',
    ),
  ],
  splitRules: [],
  slicing: [],
};

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

const call = (answer: unknown) =>
  auditMetricDirections({ harness: harness(answer), protocol: PROTOCOL, runId: 'r-1' });

it('flags a declared direction the definition contradicts', async () => {
  const audit = await call({
    findings: [
      {
        metric: 'target_unseen_domain_top1_accuracy',
        declared: 'higher',
        consistent: true,
        expected: 'higher',
        reasoning: 'an accuracy on held-out domains: larger is better by definition',
        evidence: ['held-out domain value, all samples, %'],
      },
      {
        metric: 'principal-angle mismatch of per-client separating bases',
        declared: 'higher',
        consistent: false,
        expected: 'lower',
        reasoning:
          'a mismatch angle is an error: the card wants the bases to align, so smaller is better and 79 degrees is near-orthogonal',
        evidence: ['principal-angle mismatch of per-client separating bases'],
      },
      {
        metric:
          'class-conditional cross-client prototype variance along separating vs nuisance directions',
        declared: 'higher',
        consistent: false,
        expected: 'lower',
        reasoning: 'the mechanism wants variance along the separating direction to shrink',
        evidence: ['prototype variance the server shrinks'],
      },
    ],
    inconsistent: ['principal-angle mismatch of per-client separating bases'],
    summary: 'two of three directions contradict their own definitions',
  });
  expect(audit).not.toBeNull();
  expect(
    directionIsFlagged(audit!, 'principal-angle mismatch of per-client separating bases'),
  ).toBe(true);
  // Matched by identifier too, since callers hold protocol names with prose.
  expect(directionIsFlagged(audit!, 'target_unseen_domain_top1_accuracy (x)')).toBe(false);
});

it('recomputes the inconsistent list instead of trusting the model summary', async () => {
  // The agent lists one problem metric while its own findings mark two as
  // inconsistent; the platform must not adopt the shorter list.
  const audit = await call({
    findings: [
      {
        metric: 'target_unseen_domain_top1_accuracy',
        declared: 'higher',
        consistent: false,
        expected: 'unknown',
        reasoning: 'the definition gives a % domain but not which way a fold average improves',
        evidence: ['held-out domain value, all samples, %'],
      },
      {
        metric: 'principal-angle mismatch of per-client separating bases',
        declared: 'higher',
        consistent: false,
        expected: 'lower',
        reasoning:
          'a mismatch angle is an error measure, so the protocol intent is smaller is better',
        evidence: ['principal-angle mismatch'],
      },
    ],
    inconsistent: [],
    summary: 'directions cannot be confirmed from the recorded definitions',
  });
  expect(audit!.inconsistent).toContain('target_unseen_domain_top1_accuracy');
  expect(audit!.inconsistent).toContain('principal-angle mismatch of per-client separating bases');
});

it('treats an unexamined metric as unverified, and an unsupported finding as inconsistent', async () => {
  // Two ways a model can leave a wrong direction standing: it never mentions
  // the metric, or it says "consistent" without quoting the definition.
  const audit = await call({
    findings: [
      {
        metric:
          'class-conditional cross-client prototype variance along separating vs nuisance directions',
        declared: 'higher',
        consistent: true,
        expected: 'higher',
        reasoning: 'variance is presumably good for this method',
        evidence: [],
      },
    ],
    inconsistent: [],
    summary: 'one metric reviewed, the rest assumed correct',
  });
  const flagged = new Set(audit!.inconsistent);
  expect(
    flagged.has(
      'class-conditional cross-client prototype variance along separating vs nuisance directions',
    ),
  ).toBe(true);
  expect(flagged.has('principal-angle mismatch of per-client separating bases')).toBe(true);
  expect((audit as unknown as DirectionAudit).findings[0]!.evidence[0]).toMatch(
    /quoted no definition text/,
  );
});
