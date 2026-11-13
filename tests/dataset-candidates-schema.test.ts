import { describe, expect, it } from 'vitest';
import {
  assertAgainstSchema,
  listSchemaNames,
  validateAgainstSchema,
} from '../src/core/schema/index.js';

/**
 * dataset-candidates-v1: structural mirror of the model-output validator.
 * Anti-hallucination grounding (evidenceIds membership, name grounding,
 * relatedPapers from provided refs) stays TS — pinned as one-way
 * divergences; the url-for-public-download rule is self-contained and
 * lives in the schema's if/then.
 */

function validOutput(): Record<string, unknown> {
  return {
    candidates: [
      {
        name: 'FedPF MNIST',
        task: 'federated image classification',
        unit: 'client npz archives',
        scale: '20 clients',
        license: { value: 'MIT', confidence: 0.9, note: 'stated in README' },
        acquisition: 'public-download',
        restricted: false,
        size: 'small',
        url: 'https://example.org/fedpf',
        indexId: null,
        instructions: 'download and point research.yaml at the root',
        relevanceReason: 'matches the label-skew research question',
        confidence: 0.8,
        confidenceBasis: ['dataset-paper evidence'],
        relatedPapers: ['mcmahan17a'],
        evidenceIds: ['ev-1'],
      },
    ],
    notes: ['one strong match'],
  };
}

function mutate(apply: (output: Record<string, unknown>) => void): Record<string, unknown> {
  const output = structuredClone(validOutput());
  apply(output);
  return output;
}

const candidate = (output: Record<string, unknown>): Record<string, unknown> =>
  (output.candidates as Record<string, unknown>[])[0]!;

describe('dataset-candidates-v1 schema', () => {
  it('is registered and accepts a valid output', () => {
    expect(listSchemaNames()).toContain('dataset-candidates-v1');
    const check = validateAgainstSchema('dataset-candidates-v1', validOutput());
    expect(check.errors).toEqual([]);
    expect(() => assertAgainstSchema('dataset-candidates-v1', validOutput())).not.toThrow();
  });

  const structural: { name: string; output: unknown; skip?: boolean }[] = [
    { name: 'null', output: null },
    { name: 'candidates not array', output: mutate((o) => (o.candidates = 'x')) },
    { name: 'empty candidates allowed', output: mutate((o) => (o.candidates = [])), skip: true },
    { name: 'name too long', output: mutate((c) => (candidate(c).name = 'x'.repeat(121))) },
    { name: 'empty task', output: mutate((c) => (candidate(c).task = '')) },
    { name: 'scale number', output: mutate((c) => (candidate(c).scale = 42)) },
    { name: 'license not object', output: mutate((c) => (candidate(c).license = 'MIT')) },
    {
      name: 'license confidence > 1',
      output: mutate((c) => ((candidate(c).license as Record<string, unknown>).confidence = 1.5)),
    },
    { name: 'bad acquisition', output: mutate((c) => (candidate(c).acquisition = 'telepathy')) },
    { name: 'restricted not boolean', output: mutate((c) => (candidate(c).restricted = 'yes')) },
    { name: 'bad size', output: mutate((c) => (candidate(c).size = 'gigantic')) },
    { name: 'url number', output: mutate((c) => (candidate(c).url = 123)) },
    { name: 'indexId number', output: mutate((c) => (candidate(c).indexId = 7)) },
    { name: 'confidence 2', output: mutate((c) => (candidate(c).confidence = 2)) },
    {
      name: 'empty confidenceBasis',
      output: mutate((c) => (candidate(c).confidenceBasis = [])),
    },
    { name: 'notes not array', output: mutate((c) => (c.notes = 'x')) },
    { name: 'relatedPapers numbers', output: mutate((c) => (candidate(c).relatedPapers = [1])) },
    { name: 'empty evidenceIds', output: mutate((c) => (candidate(c).evidenceIds = [])) },
    {
      // Self-contained if/then rule lives in the schema.
      name: 'public-download without url',
      output: mutate((c) => (candidate(c).url = null)),
    },
  ];
  for (const testCase of structural) {
    if (testCase.skip) continue;
    it(`rejects: ${testCase.name}`, () => {
      const check = validateAgainstSchema('dataset-candidates-v1', testCase.output);
      expect(check.ok, check.errors.join('; ')).toBe(false);
    });
  }

  it('accepts an empty candidates array (honest no-match)', () => {
    expect(validateAgainstSchema('dataset-candidates-v1', { candidates: [] }).ok).toBe(true);
  });

  const tsOnly: { name: string; output: unknown }[] = [
    {
      name: 'evidenceId not provided',
      output: mutate((c) => (candidate(c).evidenceIds = ['ev-ghost'])),
    },
    {
      name: 'name not grounded in evidence',
      output: mutate((c) => (candidate(c).name = 'Invented Dataset 9000')),
    },
    {
      name: 'relatedPaper not among provided refs',
      output: mutate((c) => (candidate(c).relatedPapers = ['ghost2026'])),
    },
  ];
  for (const testCase of tsOnly) {
    it(`TS-only rule (documented subset): ${testCase.name}`, () => {
      // Grounding checks live in validateDatasetCandidatesOutput, which
      // runs first at runtime — the schema accepts by design.
      expect(validateAgainstSchema('dataset-candidates-v1', testCase.output).ok).toBe(true);
    });
  }
});
