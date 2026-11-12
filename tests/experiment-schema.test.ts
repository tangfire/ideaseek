import { describe, expect, it } from 'vitest';
import { validateExperimentSpec, validateRunResult } from '../src/experiment/spec.js';
import { assertAgainstSchema, validateAgainstSchema } from '../src/core/schema/index.js';

/**
 * Decision parity: experiment-spec-v1 / run-result-v1 (the cross-language
 * authority files) and the TS semantic validators must accept the SAME
 * payloads, with exactly one documented divergence: the finishedAt >=
 * startedAt time-order rule stays TS-only (JSON Schema cannot cross-
 * reference two instance fields), so the schema is a sound subset — the
 * runtime gate therefore runs the semantic validator FIRST and the schema
 * can never reject anything the validator accepted.
 */

function validSpec(): Record<string, unknown> {
  return {
    specId: 'idea-alpha-quick',
    version: 1,
    idea: { ideaId: 'alpha', version: 2 },
    comparisonIds: ['fedavg'],
    codeCommit: null,
    dataSnapshotId: 'sha256:' + 'a'.repeat(64),
    sliceIds: ['train-quick'],
    environment: { python: '3.11', notes: ['cpu only'] },
    command: ['python', 'train.py', '--epochs', '1'],
    metrics: [
      { name: 'accuracy', direction: 'higher' },
      { name: 'loss', direction: 'lower' },
    ],
    seeds: [42, 7],
    resources: { gpus: 1, memoryGiB: 8 },
    budget: { maxMinutes: 30 },
    protocolId: null,
    createdAt: 1_700_000_000_000,
  };
}

function validResult(): Record<string, unknown> {
  return {
    specId: 'idea-alpha-quick',
    status: 'succeeded',
    logRefs: ['logs/run.log'],
    artifactRefs: ['sha256:' + 'b'.repeat(64)],
    metrics: [{ name: 'accuracy', value: 0.91, stdev: 0.01, n: 3 }],
    resourcesUsed: { gpuMinutes: 12, peakMemoryGiB: 4.5 },
    failure: null,
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_600_000,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function mutate(base: Record<string, unknown>, apply: (spec: Record<string, unknown>) => void) {
  const spec = clone(base);
  apply(spec);
  return spec;
}

const SPEC_CASES: { name: string; spec: unknown; expectOk: boolean }[] = [
  { name: 'valid spec', spec: validSpec(), expectOk: true },
  { name: 'null', spec: null, expectOk: false },
  { name: 'array', spec: [], expectOk: false },
  { name: 'string', spec: 'spec', expectOk: false },
  { name: 'missing specId', spec: mutate(validSpec(), (s) => delete s.specId), expectOk: false },
  {
    name: 'non-kebab specId',
    spec: mutate(validSpec(), (s) => (s.specId = 'Bad_ID')),
    expectOk: false,
  },
  { name: 'version 0', spec: mutate(validSpec(), (s) => (s.version = 0)), expectOk: false },
  { name: 'version 1.5', spec: mutate(validSpec(), (s) => (s.version = 1.5)), expectOk: false },
  {
    name: 'idea wrong shape',
    spec: mutate(validSpec(), (s) => (s.idea = 'nope')),
    expectOk: false,
  },
  {
    // Validator types idea.version as a plain number — schema must match.
    name: 'idea fractional version allowed',
    spec: mutate(validSpec(), (s) => (s.idea = { ideaId: 'x', version: 1.5 })),
    expectOk: true,
  },
  {
    name: 'comparisonIds with numbers',
    spec: mutate(validSpec(), (s) => (s.comparisonIds = [1])),
    expectOk: false,
  },
  {
    // Only `null` passes: `undefined !== null` trips the validator, so the
    // schema must require the key too.
    name: 'codeCommit absent',
    spec: mutate(validSpec(), (s) => delete s.codeCommit),
    expectOk: false,
  },
  {
    name: 'codeCommit null allowed',
    spec: mutate(validSpec(), (s) => (s.codeCommit = null)),
    expectOk: true,
  },
  { name: 'codeCommit 42', spec: mutate(validSpec(), (s) => (s.codeCommit = 42)), expectOk: false },
  { name: 'empty command', spec: mutate(validSpec(), (s) => (s.command = [])), expectOk: false },
  {
    name: 'command with number',
    spec: mutate(validSpec(), (s) => (s.command = ['python', 1])),
    expectOk: false,
  },
  { name: 'empty metrics', spec: mutate(validSpec(), (s) => (s.metrics = [])), expectOk: false },
  {
    name: 'bad direction',
    spec: mutate(validSpec(), (s) => (s.metrics = [{ name: 'a', direction: 'sideways' }])),
    expectOk: false,
  },
  { name: 'empty seeds', spec: mutate(validSpec(), (s) => (s.seeds = [])), expectOk: false },
  {
    name: 'fractional seed',
    spec: mutate(validSpec(), (s) => (s.seeds = [1.5])),
    expectOk: false,
  },
  {
    // No >= 1 rule in the validator — seed 0 is legal; schema must agree.
    name: 'zero seed allowed',
    spec: mutate(validSpec(), (s) => (s.seeds = [0])),
    expectOk: true,
  },
  {
    name: 'environment array',
    spec: mutate(validSpec(), (s) => (s.environment = [])),
    expectOk: false,
  },
  {
    name: 'resources string',
    spec: mutate(validSpec(), (s) => (s.resources = 'x')),
    expectOk: false,
  },
  {
    name: 'createdAt missing',
    spec: mutate(validSpec(), (s) => delete s.createdAt),
    expectOk: false,
  },
];

const RESULT_CASES: { name: string; result: unknown; expectOk: boolean }[] = [
  { name: 'valid result', result: validResult(), expectOk: true },
  { name: 'null', result: null, expectOk: false },
  {
    name: 'bad status',
    result: mutate(validResult(), (r) => (r.status = 'crashed')),
    expectOk: false,
  },
  {
    name: 'failed without failure',
    result: mutate(validResult(), (r) => {
      r.status = 'failed';
      r.failure = null;
    }),
    expectOk: false,
  },
  {
    name: 'failed with failure object',
    result: mutate(validResult(), (r) => {
      r.status = 'failed';
      r.failure = { category: 'timeout', summary: 'hit the 30m bound' };
    }),
    expectOk: true,
  },
  {
    name: 'succeeded with null failure',
    result: mutate(validResult(), (r) => (r.failure = null)),
    expectOk: true,
  },
  {
    name: 'bad failure category',
    result: mutate(validResult(), (r) => (r.failure = { category: 'bogus', summary: 'x' })),
    expectOk: false,
  },
  {
    name: 'whitespace failure summary',
    result: mutate(validResult(), (r) => (r.failure = { category: 'data', summary: '   ' })),
    expectOk: false,
  },
  {
    name: 'metric value not finite-typed',
    result: mutate(validResult(), (r) => (r.metrics = [{ name: 'a', value: 'x' }])),
    expectOk: false,
  },
  {
    name: 'negative stdev',
    result: mutate(validResult(), (r) => (r.metrics = [{ name: 'a', value: 1, stdev: -1 }])),
    expectOk: false,
  },
  {
    name: 'n below 1',
    result: mutate(validResult(), (r) => (r.metrics = [{ name: 'a', value: 1, n: 0 }])),
    expectOk: false,
  },
  {
    name: 'logRefs with numbers',
    result: mutate(validResult(), (r) => (r.logRefs = [1])),
    expectOk: false,
  },
  {
    name: 'resourcesUsed array',
    result: mutate(validResult(), (r) => (r.resourcesUsed = [])),
    expectOk: false,
  },
  {
    name: 'explanation wrong type',
    result: mutate(validResult(), (r) => (r.explanation = 42)),
    expectOk: false,
  },
];

describe('experiment-spec-v1 parity', () => {
  for (const testCase of SPEC_CASES) {
    it(`agrees on: ${testCase.name}`, () => {
      const validator = validateExperimentSpec(testCase.spec);
      const schema = validateAgainstSchema('experiment-spec-v1', testCase.spec);
      // Gate safety: the schema must never reject what the validator accepts.
      if (validator.ok) {
        expect(schema.ok, `schema errors: ${schema.errors.join('; ')}`).toBe(true);
      }
      expect(validator.ok).toBe(testCase.expectOk);
      // Structural cases decide identically (validator runs first at runtime).
      if (testCase.expectOk) expect(schema.ok).toBe(true);
      else expect(schema.ok).toBe(false);
    });
  }

  it('accepts every validator-approved payload through the gate helper', () => {
    expect(() => assertAgainstSchema('experiment-spec-v1', validSpec())).not.toThrow();
  });
});

describe('run-result-v1 parity', () => {
  for (const testCase of RESULT_CASES) {
    it(`agrees on: ${testCase.name}`, () => {
      const validator = validateRunResult(testCase.result);
      const schema = validateAgainstSchema('run-result-v1', testCase.result);
      if (validator.ok) {
        expect(schema.ok, `schema errors: ${schema.errors.join('; ')}`).toBe(true);
      }
      expect(validator.ok).toBe(testCase.expectOk);
      if (testCase.expectOk) expect(schema.ok).toBe(true);
      else expect(schema.ok).toBe(false);
    });
  }

  it('documents the one divergence: time order is TS-validator-only', () => {
    const inverted = mutate(validResult(), (r) => {
      r.finishedAt = (r.startedAt as number) - 1;
    });
    // The TS validator rejects it; JSON Schema cannot cross-reference
    // finishedAt against startedAt — hence semantic rules stay in TS and
    // the runtime gate runs the validator FIRST (schema is a subset).
    expect(validateRunResult(inverted).ok).toBe(false);
    expect(validateAgainstSchema('run-result-v1', inverted).ok).toBe(true);
  });

  it('rejects a failed status carrying a null failure at both layers', () => {
    const nullFailure = mutate(validResult(), (r) => {
      r.status = 'partial';
      r.failure = null;
    });
    expect(validateRunResult(nullFailure).ok).toBe(false);
    expect(validateAgainstSchema('run-result-v1', nullFailure).ok).toBe(false);
  });
});
