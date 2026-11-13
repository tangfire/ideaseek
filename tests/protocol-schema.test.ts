import { describe, expect, it } from 'vitest';
import { validateProtocolProposal } from '../src/experiment/protocol.js';
import {
  assertAgainstSchema,
  listSchemaNames,
  validateAgainstSchema,
} from '../src/core/schema/index.js';

/**
 * protocol-proposal-v1: structural mirror of validateProtocolProposal.
 * Low-confidence agent-inference confirmations are UX items (never
 * errors) and stay TS; the schema mirrors the error rules only —
 * validateProtocolProposal runs first at both call sites (model output
 * and confirm/lock).
 */

function validProposal(): Record<string, unknown> {
  return {
    protocolId: 'proto-abc123-v1',
    version: 1,
    generator: 'protocol-prompt-v1',
    generatedAt: 1_700_000_000_000,
    taskDefinition: { value: 'classify rows', source: 'user', confidence: 0.9 },
    sampleUnit: { value: 'one row', source: 'user', confidence: 0.9 },
    labelSemantics: { value: 'last column', source: 'data-probe', confidence: 0.8 },
    splitRules: { value: ['70/15/15'], source: 'adapter-rule', confidence: 0.9 },
    leakageChecks: ['no test feedback'],
    preprocessing: ['fit on train'],
    baselineEntries: [
      { methodId: 'fedavg', entry: 'python run.py', source: 'code', confidence: 0.9 },
    ],
    primaryMetrics: [
      { name: 'accuracy', direction: 'higher', source: 'paper-evidence', confidence: 0.85 },
    ],
    secondaryMetrics: [],
    statisticalSummary: ['mean over 3 seeds'],
    smokeTest: { value: 'small slice', source: 'user', confidence: 0.9 },
    resourceEstimate: { value: 'cpu-only', source: 'agent-inference', confidence: 0.75 },
    ablations: ['w/o reweighting'],
    supportCriteria: ['beats baseline'],
    refuteCriteria: ['no gain'],
    invalidRunCriteria: ['nan metrics'],
    stopConditions: ['budget exhausted'],
  };
}

function validatorOk(proposal: unknown): boolean {
  return validateProtocolProposal(proposal).ok;
}

function mutate(apply: (p: Record<string, unknown>) => void): Record<string, unknown> {
  const p = structuredClone(validProposal());
  apply(p);
  return p;
}

describe('protocol-proposal-v1 schema', () => {
  it('is registered and accepts a valid proposal', () => {
    expect(listSchemaNames()).toContain('protocol-proposal-v1');
    const check = validateAgainstSchema('protocol-proposal-v1', validProposal());
    expect(check.errors).toEqual([]);
    expect(() => assertAgainstSchema('protocol-proposal-v1', validProposal())).not.toThrow();
    expect(validatorOk(validProposal())).toBe(true);
  });

  const cases: { name: string; proposal: unknown; ok: boolean }[] = [
    { name: 'null', proposal: null, ok: false },
    { name: 'bad protocolId', proposal: mutate((p) => (p.protocolId = 'x-1')), ok: false },
    { name: 'version 0', proposal: mutate((p) => (p.version = 0)), ok: false },
    { name: 'empty generator', proposal: mutate((p) => (p.generator = '')), ok: false },
    { name: 'missing taskDefinition', proposal: mutate((p) => delete p.taskDefinition), ok: false },
    {
      name: 'bad sourced source',
      proposal: mutate((p) => ((p.taskDefinition as Record<string, unknown>).source = 'vibes')),
      ok: false,
    },
    {
      name: 'confidence > 1',
      proposal: mutate((p) => ((p.taskDefinition as Record<string, unknown>).confidence = 1.5)),
      ok: false,
    },
    {
      name: 'empty sourced value',
      proposal: mutate((p) => ((p.taskDefinition as Record<string, unknown>).value = '')),
      ok: false,
    },
    {
      name: 'empty splitRules value',
      proposal: mutate((p) => ((p.splitRules as Record<string, unknown>).value = [])),
      ok: false,
    },
    { name: 'empty leakageChecks', proposal: mutate((p) => (p.leakageChecks = [])), ok: false },
    { name: 'no primaryMetrics', proposal: mutate((p) => (p.primaryMetrics = [])), ok: false },
    {
      name: 'bad metric direction',
      proposal: mutate(
        (p) => ((p.primaryMetrics as Record<string, unknown>[])[0]!.direction = 'sideways'),
      ),
      ok: false,
    },
    {
      name: 'secondaryMetrics not array',
      proposal: mutate((p) => (p.secondaryMetrics = 'x')),
      ok: false,
    },
    { name: 'no baselineEntries', proposal: mutate((p) => (p.baselineEntries = [])), ok: false },
    {
      name: 'baseline bad source',
      proposal: mutate(
        (p) => ((p.baselineEntries as Record<string, unknown>[])[0]!.source = 'guess'),
      ),
      ok: false,
    },
    { name: 'missing stopConditions', proposal: mutate((p) => delete p.stopConditions), ok: false },
  ];
  for (const testCase of cases) {
    it(`both ${testCase.ok ? 'accept' : 'reject'}: ${testCase.name}`, () => {
      expect(validateAgainstSchema('protocol-proposal-v1', testCase.proposal).ok).toBe(testCase.ok);
      expect(validatorOk(testCase.proposal)).toBe(testCase.ok);
    });
  }

  it('TS-only: low-confidence agent inference is a confirmation, not an error', () => {
    const proposal = mutate(
      (p) => ((p.resourceEstimate as Record<string, unknown>).confidence = 0.5),
    );
    const validation = validateProtocolProposal(proposal);
    expect(validation.ok).toBe(true);
    expect(validation.confirmations.length).toBeGreaterThan(0);
    expect(validateAgainstSchema('protocol-proposal-v1', proposal).ok).toBe(true);
  });
});
