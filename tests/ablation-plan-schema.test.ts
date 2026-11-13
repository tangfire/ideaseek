import { describe, expect, it } from 'vitest';
import { validateAblationPlan } from '../src/idea/ablation-plan.js';
import type { IdeaCard } from '../src/idea/card.js';
import {
  assertAgainstSchema,
  listSchemaNames,
  validateAgainstSchema,
} from '../src/core/schema/index.js';

/**
 * ablation-plan-v1: structural mirror of validateAblationPlan. The
 * context-bound rules (ideaId/cardVersion equality, target membership in
 * the card's componentNecessity/minimalExperiment lists) stay TS-only and
 * are pinned as documented one-way divergences — the runtime validator
 * runs first, the schema is the subset defense.
 */

const EXPECTED = {
  ideaId: 'alpha',
  cardVersion: 2,
  card: {
    componentNecessity: [{ component: 'reweighting', role: 'necessary-mechanism' }],
    minimalExperiment: { ablations: ['no reweighting'] },
  },
} as unknown as { ideaId: string; cardVersion: number; card: IdeaCard };

function validPlan(): Record<string, unknown> {
  return {
    ideaId: 'alpha',
    cardVersion: 2,
    entries: [
      {
        name: 'w/o reweighting',
        kind: 'component',
        target: 'reweighting',
        whatItTests: 'whether the reweighting mechanism matters',
        expectedOutcome: 'worst-client accuracy drops',
        priority: 1,
      },
      {
        name: 'learning rate sweep',
        kind: 'hyperparameter',
        target: null,
        whatItTests: 'optimizer sensitivity',
        expectedOutcome: 'stable across ±2x lr',
        priority: 3,
      },
    ],
    coverageAssessment: 'component + hyperparameter coverage is complete for a smoke round',
    unnecessary: ['dropout ablation (out of scope)'],
    suggestedOrder: ['w/o reweighting', 'learning rate sweep'],
    estimatedGpuMinutes: 30,
  };
}

function validatorOk(plan: unknown): boolean {
  return validateAblationPlan(plan, EXPECTED).ok;
}

function mutate(apply: (plan: Record<string, unknown>) => void): Record<string, unknown> {
  const plan = structuredClone(validPlan());
  apply(plan);
  return plan;
}

describe('ablation-plan-v1 schema', () => {
  it('is registered', () => {
    expect(listSchemaNames()).toContain('ablation-plan-v1');
  });

  it('accepts the valid plan at both layers', () => {
    expect(validatorOk(validPlan())).toBe(true);
    const check = validateAgainstSchema('ablation-plan-v1', validPlan());
    expect(check.errors).toEqual([]);
    expect(() => assertAgainstSchema('ablation-plan-v1', validPlan())).not.toThrow();
  });

  const structural: { name: string; plan: unknown }[] = [
    { name: 'null', plan: null },
    { name: 'no entries', plan: mutate((p) => (p.entries = [])) },
    {
      name: 'unknown kind',
      plan: mutate((p) => ((p.entries as Record<string, unknown>[])[0]!.kind = 'vibes')),
    },
    {
      name: 'hyperparameter entry with non-null target',
      plan: mutate((p) => ((p.entries as Record<string, unknown>[])[1]!.target = 'lr')),
    },
    {
      name: 'component entry with null target',
      plan: mutate((p) => ((p.entries as Record<string, unknown>[])[0]!.target = null)),
    },
    {
      name: 'priority 0',
      plan: mutate((p) => ((p.entries as Record<string, unknown>[])[0]!.priority = 0)),
    },
    {
      name: 'priority 6',
      plan: mutate((p) => ((p.entries as Record<string, unknown>[])[0]!.priority = 6)),
    },
    {
      name: 'fractional priority',
      plan: mutate((p) => ((p.entries as Record<string, unknown>[])[0]!.priority = 1.5)),
    },
    { name: 'empty coverageAssessment', plan: mutate((p) => (p.coverageAssessment = '')) },
    { name: 'unnecessary not array', plan: mutate((p) => (p.unnecessary = 'x')) },
    { name: 'empty suggestedOrder', plan: mutate((p) => (p.suggestedOrder = [])) },
    { name: 'zero gpu budget', plan: mutate((p) => (p.estimatedGpuMinutes = 0)) },
  ];

  for (const testCase of structural) {
    it(`both reject: ${testCase.name}`, () => {
      const schema = validateAgainstSchema('ablation-plan-v1', testCase.plan);
      expect(schema.ok, `schema: ${schema.errors.join('; ')}`).toBe(false);
      expect(validatorOk(testCase.plan)).toBe(false);
    });
  }

  const tsOnly: { name: string; plan: unknown }[] = [
    { name: 'wrong ideaId', plan: mutate((p) => (p.ideaId = 'beta')) },
    {
      // trim() semantics stay TS-side (validator runs first at runtime).
      name: 'whitespace-only entry name',
      plan: mutate((p) => ((p.entries as Record<string, unknown>[])[0]!.name = ' ')),
    },
    { name: 'wrong cardVersion', plan: mutate((p) => (p.cardVersion = 9)) },
    {
      name: 'component target not on the card',
      plan: mutate((p) => ((p.entries as Record<string, unknown>[])[0]!.target = 'attention')),
    },
    {
      name: 'card-ablation target not on the card',
      plan: mutate((p) => {
        (p.entries as Record<string, unknown>[])[1]!.kind = 'card-ablation';
        (p.entries as Record<string, unknown>[])[1]!.target = 'not-a-label';
      }),
    },
  ];
  for (const testCase of tsOnly) {
    it(`TS-only rule (documented subset): ${testCase.name}`, () => {
      expect(validatorOk(testCase.plan)).toBe(false);
      expect(validateAgainstSchema('ablation-plan-v1', testCase.plan).ok).toBe(true);
    });
  }
});
