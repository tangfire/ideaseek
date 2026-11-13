import { describe, expect, it } from 'vitest';
import { parseExperimentPlan, type PlanIdeaContext } from '../src/experiment/plan.js';
import {
  assertAgainstSchema,
  listSchemaNames,
  validateAgainstSchema,
} from '../src/core/schema/index.js';

/**
 * experiment-plan-v1: structural mirror of parseExperimentPlan. Relational
 * and context rules (runOrder↔blocks, claims↔blocks, budget ceiling,
 * protocol primary metrics) stay TS-only — pinned here as documented
 * one-way divergences (the schema is a sound subset; the runtime gate
 * runs the relational validator FIRST).
 */

function ctx(): PlanIdeaContext {
  return {
    ideaId: 'alpha',
    ideaVersion: 1,
    question: 'q',
    hypothesis: { statement: 'h', targetProblem: 'p' },
    nearestComparisons: [],
    comparisonStatuses: [],
    minimalExperiment: { code: 'c', data: 'd', baselines: [], metrics: [], ablations: [] },
    budget: { maxRounds: 3, maxGpuMinutes: 600 },
    protocol: null,
    dataScales: { registered: ['smoke', 'quick', 'standard'], default: 'quick' },
  };
}

function validPlan(): Record<string, unknown> {
  return {
    problem: 'Cross-client generalization collapses under label skew.',
    thesis: 'A drift-aware reweighting term restores worst-client accuracy.',
    claims: [
      { claimId: 'c1', statement: 'Reweighting beats uniform averaging.', linkedBlocks: ['b-run'] },
    ],
    blocks: [
      {
        blockId: 'b-run',
        name: 'main comparison',
        claimTested: 'c1',
        priority: 'MUST-RUN',
        scale: 'smoke',
        dataScale: 'smoke',
        metrics: [{ name: 'accuracy', direction: 'higher' }],
        successCriterion: 'Δ ≥ +2% worst-client accuracy',
        failureInterpretation: 'no gain → mechanism insufficient',
      },
      {
        blockId: 'b-abl',
        name: 'ablation',
        claimTested: 'c1',
        priority: 'NICE-TO-HAVE',
        scale: 'quick',
        dataScale: 'quick',
        metrics: [{ name: 'accuracy', direction: 'higher' }],
        successCriterion: 'component matters',
        failureInterpretation: 'drop is flat → component unnecessary',
      },
    ],
    runOrder: ['b-run', 'b-abl'],
    seeds: [42, 7],
    budgetMinutes: 45,
    risks: [{ risk: 'seed noise', mitigation: 'report per-seed' }],
  };
}

function validatorOk(plan: unknown): boolean {
  try {
    parseExperimentPlan(JSON.stringify(plan), ctx());
    return true;
  } catch {
    return false;
  }
}

function mutate(apply: (plan: Record<string, unknown>) => void): Record<string, unknown> {
  const plan = structuredClone(validPlan());
  apply(plan);
  return plan;
}

describe('experiment-plan-v1 schema', () => {
  it('is registered', () => {
    expect(listSchemaNames()).toContain('experiment-plan-v1');
  });

  it('accepts the valid plan at both layers', () => {
    expect(validatorOk(validPlan())).toBe(true);
    const check = validateAgainstSchema('experiment-plan-v1', validPlan());
    expect(check.errors).toEqual([]);
    expect(() => assertAgainstSchema('experiment-plan-v1', validPlan())).not.toThrow();
  });

  const structural: { name: string; plan: unknown }[] = [
    { name: 'null', plan: null },
    { name: 'missing thesis', plan: mutate((p) => delete p.thesis) },
    { name: 'empty problem', plan: mutate((p) => (p.problem = '')) },
    {
      name: 'three claims',
      plan: mutate(
        (p) =>
          (p.claims = [
            ...(p.claims as unknown[]),
            { claimId: 'c2', statement: 's', linkedBlocks: ['b-run'] },
            { claimId: 'c3', statement: 's', linkedBlocks: ['b-run'] },
          ]),
      ),
    },
    {
      name: 'six blocks',
      plan: mutate(
        (p) =>
          (p.blocks = [
            ...(p.blocks as unknown[]),
            {
              blockId: 'x1',
              name: 'n',
              claimTested: 'c1',
              priority: 'MUST-RUN',
              scale: 'smoke',
              dataScale: 'smoke',
              metrics: [{ name: 'm', direction: 'higher' }],
              successCriterion: 's',
              failureInterpretation: 'f',
            },
            {
              blockId: 'x2',
              name: 'n',
              claimTested: 'c1',
              priority: 'MUST-RUN',
              scale: 'smoke',
              dataScale: 'smoke',
              metrics: [{ name: 'm', direction: 'higher' }],
              successCriterion: 's',
              failureInterpretation: 'f',
            },
            {
              blockId: 'x3',
              name: 'n',
              claimTested: 'c1',
              priority: 'MUST-RUN',
              scale: 'smoke',
              dataScale: 'smoke',
              metrics: [{ name: 'm', direction: 'higher' }],
              successCriterion: 's',
              failureInterpretation: 'f',
            },
            {
              blockId: 'x4',
              name: 'n',
              claimTested: 'c1',
              priority: 'MUST-RUN',
              scale: 'smoke',
              dataScale: 'smoke',
              metrics: [{ name: 'm', direction: 'higher' }],
              successCriterion: 's',
              failureInterpretation: 'f',
            },
          ]),
      ),
    },
    {
      name: 'non-kebab blockId',
      plan: mutate((p) => ((p.blocks as Record<string, unknown>[])[0]!.blockId = 'Bad Id')),
    },
    {
      name: 'bad priority',
      plan: mutate((p) => ((p.blocks as Record<string, unknown>[])[0]!.priority = 'MAYBE')),
    },
    {
      name: 'full scale',
      plan: mutate((p) => ((p.blocks as Record<string, unknown>[])[0]!.scale = 'full')),
    },
    {
      name: 'bad dataScale',
      plan: mutate((p) => ((p.blocks as Record<string, unknown>[])[0]!.dataScale = 'huge')),
    },
    {
      name: 'empty metrics',
      plan: mutate((p) => ((p.blocks as Record<string, unknown>[])[0]!.metrics = [])),
    },
    {
      name: 'bad direction',
      plan: mutate(
        (p) =>
          ((p.blocks as Record<string, unknown>[])[0]!.metrics = [
            { name: 'm', direction: 'sideways' },
          ]),
      ),
    },
    { name: 'fractional seed', plan: mutate((p) => (p.seeds = [1.5])) },
    { name: 'empty seeds', plan: mutate((p) => (p.seeds = [])) },
    { name: 'zero budget', plan: mutate((p) => (p.budgetMinutes = 0)) },
    { name: 'empty runOrder', plan: mutate((p) => (p.runOrder = [])) },
    { name: 'risk missing mitigation', plan: mutate((p) => (p.risks = [{ risk: 'r' }])) },
  ];

  for (const testCase of structural) {
    it(`both reject: ${testCase.name}`, () => {
      const schema = validateAgainstSchema('experiment-plan-v1', testCase.plan);
      expect(schema.ok, `schema: ${schema.errors.join('; ')}`).toBe(false);
      expect(validatorOk(testCase.plan)).toBe(false);
    });
  }

  const tsOnly: { name: string; plan: unknown }[] = [
    {
      name: 'runOrder references unknown block',
      plan: mutate((p) => (p.runOrder = ['b-run', 'ghost'])),
    },
    {
      name: 'budget exceeds the IdeaCard ceiling',
      plan: mutate((p) => (p.budgetMinutes = 99_999)),
    },
    {
      // trim() semantics live in the TS validator; JSON Schema only sees
      // minLength — hence validator-first ordering at runtime.
      name: 'whitespace-only problem',
      plan: mutate((p) => (p.problem = ' ')),
    },
    {
      name: 'claim links an unknown block',
      plan: mutate((p) => ((p.claims as Record<string, unknown>[])[0]!.linkedBlocks = ['ghost'])),
    },
  ];
  for (const testCase of tsOnly) {
    it(`TS-only rule (documented subset): ${testCase.name}`, () => {
      // The relational/context validator rejects; the schema accepts —
      // hence the runtime gate runs the validator FIRST.
      expect(validatorOk(testCase.plan)).toBe(false);
      expect(validateAgainstSchema('experiment-plan-v1', testCase.plan).ok).toBe(true);
    });
  }

  it('soundness: every validator-accepted payload passes the schema', () => {
    const accepted = [validPlan()];
    for (const plan of accepted) {
      if (validatorOk(plan)) {
        expect(validateAgainstSchema('experiment-plan-v1', plan).ok).toBe(true);
      }
    }
  });
});
