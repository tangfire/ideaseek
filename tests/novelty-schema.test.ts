import { describe, expect, it } from 'vitest';
import { validateNoveltyReport } from '../src/idea/novelty.js';
import {
  assertAgainstSchema,
  listSchemaNames,
  validateAgainstSchema,
} from '../src/core/schema/index.js';

/**
 * novelty-check-v1: structural mirror of validateNoveltyReport. The
 * context-bound rules (ideaId/cardVersion equality, closestPaperRef
 * membership in the offered candidates, trim semantics) stay TS-only —
 * pinned as documented one-way divergences; the ABANDON
 * closestPaperRef rule is self-contained and lives in the schema's
 * if/then.
 */

const EXPECTED = { ideaId: 'alpha', cardVersion: 3, candidateRefs: ['p1', 'p2'] };

function validReport(): Record<string, unknown> {
  return {
    ideaId: 'alpha',
    cardVersion: 3,
    verdict: 'PROCEED_WITH_CAUTION',
    score: 6,
    positioning: 'Closest to reweighting work but with a drift-aware twist.',
    claims: [
      {
        claim: 'Novel drift-aware reweighting under label skew',
        closestPaperRef: 'p1',
        overlap: 'shares federated averaging backbone',
        delta: 'adds client-drift correction term',
      },
    ],
    patents: [{ patentNumber: 'US1234567', overlapRisk: 'LOW', notes: 'different mechanism' }],
    priorArtDegraded: true,
    notes: ['web search unavailable; local corpus only'],
  };
}

function validatorOk(report: unknown): boolean {
  return validateNoveltyReport(report, EXPECTED).ok;
}

function mutate(apply: (report: Record<string, unknown>) => void): Record<string, unknown> {
  const report = structuredClone(validReport());
  apply(report);
  return report;
}

describe('novelty-check-v1 schema', () => {
  it('is registered', () => {
    expect(listSchemaNames()).toContain('novelty-check-v1');
  });

  it('accepts the valid report at both layers', () => {
    expect(validatorOk(validReport())).toBe(true);
    const check = validateAgainstSchema('novelty-check-v1', validReport());
    expect(check.errors).toEqual([]);
    expect(() => assertAgainstSchema('novelty-check-v1', validReport())).not.toThrow();
  });

  const structural: { name: string; report: unknown }[] = [
    { name: 'null', report: null },
    { name: 'bad verdict', report: mutate((r) => (r.verdict = 'MAYBE')) },
    { name: 'score 0', report: mutate((r) => (r.score = 0)) },
    { name: 'score 11', report: mutate((r) => (r.score = 11)) },
    { name: 'fractional score', report: mutate((r) => (r.score = 6.5)) },
    { name: 'empty positioning', report: mutate((r) => (r.positioning = '')) },
    { name: 'no claims', report: mutate((r) => (r.claims = [])) },
    {
      name: 'claim missing delta',
      report: mutate((r) => delete (r.claims as Record<string, unknown>[])[0]!.delta),
    },
    { name: 'patents not array', report: mutate((r) => (r.patents = 'x')) },
    {
      name: 'patent bad overlapRisk',
      report: mutate((r) => ((r.patents as Record<string, unknown>[])[0]!.overlapRisk = 'MEGA')),
    },
    { name: 'priorArtDegraded not boolean', report: mutate((r) => (r.priorArtDegraded = 'yes')) },
    { name: 'notes not array', report: mutate((r) => (r.notes = 'x')) },
    {
      // Self-contained ABANDON rule lives in the schema (if/then).
      name: 'ABANDON claim without closestPaperRef',
      report: mutate((r) => {
        r.verdict = 'ABANDON';
        (r.claims as Record<string, unknown>[])[0]!.closestPaperRef = null;
      }),
    },
  ];
  for (const testCase of structural) {
    it(`both reject: ${testCase.name}`, () => {
      const schema = validateAgainstSchema('novelty-check-v1', testCase.report);
      expect(schema.ok, `schema: ${schema.errors.join('; ')}`).toBe(false);
      expect(validatorOk(testCase.report)).toBe(false);
    });
  }

  const tsOnly: { name: string; report: unknown }[] = [
    { name: 'wrong ideaId', report: mutate((r) => (r.ideaId = 'beta')) },
    { name: 'wrong cardVersion', report: mutate((r) => (r.cardVersion = 9)) },
    {
      name: 'closestPaperRef not among candidates',
      report: mutate(
        (r) => ((r.claims as Record<string, unknown>[])[0]!.closestPaperRef = 'ghost'),
      ),
    },
    {
      name: 'whitespace-only positioning',
      report: mutate((r) => (r.positioning = ' ')),
    },
  ];
  for (const testCase of tsOnly) {
    it(`TS-only rule (documented subset): ${testCase.name}`, () => {
      expect(validatorOk(testCase.report)).toBe(false);
      expect(validateAgainstSchema('novelty-check-v1', testCase.report).ok).toBe(true);
    });
  }
});
