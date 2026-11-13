import { describe, expect, it } from 'vitest';
import { validateIdeaCard } from '../src/idea/card.js';
import {
  assertAgainstSchema,
  listSchemaNames,
  validateAgainstSchema,
} from '../src/core/schema/index.js';

/**
 * idea-card-v1 + idea-candidates-v1 envelope: structural mirrors of
 * validateIdeaCard. Semantic rules stay TS (the DRAFT_COMPOSITION
 * mechanism gate, status cross-check, fingerprints/duplicates in the
 * batch loop) — pinned as documented one-way divergences; the runtime
 * validator runs first.
 */

function validCard(): Record<string, unknown> {
  return {
    ideaId: 'alpha-idea',
    version: 1,
    parentVersion: null,
    status: 'DRAFT_COMPOSITION',
    hypothesis: { statement: 'Drift-aware reweighting helps.', targetProblem: 'label skew' },
    paperEvidence: [{ paperRef: 'mcmahan17a', statement: 'FedAvg baseline', evidence: 'p.1' }],
    contradictions: ['prior work claims uniform weighting suffices'],
    novelty: {
      claim: 'client-drift correction term',
      uncertainty: 'no multi-dataset evidence yet',
      whyNotRestatement: 'adds an explicit drift estimator, not a restatement',
    },
    mechanismChain: {
      designPrincipleLink: 'compensate non-IID drift',
      steps: [{ kind: 'observation', text: 'client updates diverge' }],
    },
    nearestComparisons: [
      { methodId: 'fedavg', difference: 'adds drift term', evidence: 'table 2' },
    ],
    componentNecessity: [],
    competingExplanations: ['lr schedule explains the gain'],
    boundaryConditions: ['label-skew only'],
    risks: ['weight noise'],
    minimalExperiment: {
      code: 'src/train.py',
      data: 'smoke slice',
      baselines: ['fedavg'],
      metrics: ['worst-client accuracy'],
      ablations: ['w/o drift term'],
    },
    falsification: { conditions: ['variance unchanged across seeds'] },
    budget: { maxRounds: 2, maxGpuMinutes: 60 },
    stopConditions: ['budget exhausted'],
    createdAt: 1,
  };
}

function validatorOk(card: unknown): boolean {
  return validateIdeaCard(card).ok;
}

function mutate(apply: (card: Record<string, unknown>) => void): Record<string, unknown> {
  const card = structuredClone(validCard());
  apply(card);
  return card;
}

describe('idea-card-v1 schema', () => {
  it('is registered and accepts a valid card', () => {
    expect(listSchemaNames()).toContain('idea-card-v1');
    const check = validateAgainstSchema('idea-card-v1', validCard());
    expect(check.errors).toEqual([]);
    expect(() => assertAgainstSchema('idea-card-v1', validCard())).not.toThrow();
  });

  const structural: { name: string; card: unknown }[] = [
    { name: 'null', card: null },
    { name: 'bad ideaId', card: mutate((c) => (c.ideaId = 'Alpha Idea')) },
    { name: 'version 0', card: mutate((c) => (c.version = 0)) },
    {
      name: 'version 1 with parent',
      card: mutate((c) => (c.parentVersion = 1)),
    },
    {
      name: 'version 2 without integer parent',
      card: mutate((c) => {
        c.version = 2;
        c.parentVersion = null;
      }),
    },
    {
      name: 'version 2 with fractional parent',
      card: mutate((c) => {
        c.version = 2;
        c.parentVersion = 1.5;
      }),
    },
    { name: 'bad status', card: mutate((c) => (c.status = 'FINAL')) },
    { name: 'missing hypothesis', card: mutate((c) => delete c.hypothesis) },
    { name: 'empty paperEvidence', card: mutate((c) => (c.paperEvidence = [])) },
    { name: 'empty contradictions', card: mutate((c) => (c.contradictions = [])) },
    { name: 'missing novelty', card: mutate((c) => delete c.novelty) },
    {
      name: 'bad chain kind',
      card: mutate(
        (c) =>
          ((c.mechanismChain as Record<string, unknown>).steps = [{ kind: 'vibes', text: 't' }]),
      ),
    },
    {
      name: 'empty chain steps',
      card: mutate((c) => ((c.mechanismChain as Record<string, unknown>).steps = [])),
    },
    { name: 'no nearestComparisons', card: mutate((c) => (c.nearestComparisons = [])) },
    {
      name: 'bad component role',
      card: mutate(
        (c) => (c.componentNecessity = [{ component: 'x', removeEffect: 'y', role: 'magic' }]),
      ),
    },
    { name: 'empty competingExplanations', card: mutate((c) => (c.competingExplanations = [])) },
    {
      name: 'minimalExperiment without ablations',
      card: mutate((c) => delete (c.minimalExperiment as Record<string, unknown>).ablations),
    },
    {
      name: 'empty falsification',
      card: mutate((c) => ((c.falsification as Record<string, unknown>).conditions = [])),
    },
    {
      name: 'budget maxRounds 0',
      card: mutate((c) => ((c.budget as Record<string, unknown>).maxRounds = 0)),
    },
    { name: 'empty stopConditions', card: mutate((c) => (c.stopConditions = [])) },
    { name: 'createdAt string', card: mutate((c) => (c.createdAt = 'now')) },
  ];
  for (const testCase of structural) {
    it(`both reject: ${testCase.name}`, () => {
      const schema = validateAgainstSchema('idea-card-v1', testCase.card);
      expect(schema.ok, `schema: ${schema.errors.join('; ')}`).toBe(false);
      expect(validatorOk(testCase.card)).toBe(false);
    });
  }

  const tsOnly: { name: string; card: unknown }[] = [
    {
      name: 'whitespace statement',
      card: mutate((c) => ((c.hypothesis as Record<string, unknown>).statement = ' ')),
    },
  ];
  for (const testCase of tsOnly) {
    it(`TS-only rule (documented subset): ${testCase.name}`, () => {
      expect(validatorOk(testCase.card)).toBe(false);
      expect(validateAgainstSchema('idea-card-v1', testCase.card).ok).toBe(true);
    });
  }

  it('version 2 with integer parent is accepted at both layers', () => {
    const card = mutate((c) => {
      c.version = 2;
      c.parentVersion = 1;
    });
    expect(validatorOk(card)).toBe(true);
    expect(validateAgainstSchema('idea-card-v1', card).ok).toBe(true);
  });
});

describe('idea-candidates-v1 envelope', () => {
  it('accepts candidate batches without item-level schema checks (partial-batch semantics)', () => {
    expect(listSchemaNames()).toContain('idea-candidates-v1');
    // The envelope only pins the array; invalid items are collected by the
    // parse loop (rejected cards), never fatal at the envelope layer.
    const envelope = { candidates: [{ totally: 'broken' }], reason: 'partial' };
    const check = validateAgainstSchema('idea-candidates-v1', envelope);
    expect(check.ok).toBe(true);
    expect(validateAgainstSchema('idea-candidates-v1', { candidates: [] }).ok).toBe(true);
  });

  it('rejects a missing candidates array', () => {
    const check = validateAgainstSchema('idea-candidates-v1', { reason: 'x' });
    expect(check.ok).toBe(false);
  });
});
