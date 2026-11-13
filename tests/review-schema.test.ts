import { describe, expect, it } from 'vitest';
import {
  assertAgainstSchema,
  listSchemaNames,
  validateAgainstSchema,
} from '../src/core/schema/index.js';

/**
 * idea-review-v1 + experiment-audit-v1: structural mirrors of the review
 * payload validators. Self-contained conditional rules live in the schema
 * (non-ready verdicts need >=1 weakness); relational rules stay TS
 * (unique check ids, all five A-F ids present, overall == worst status)
 * and are pinned as documented one-way divergences.
 */

function validIdeaReview(): Record<string, unknown> {
  return {
    score: 7,
    verdict: 'almost',
    weaknesses: [
      {
        severity: 'major',
        detail: 'no multi-seed evidence for the main claim',
        minimumFix: 'run ≥2 seeds on the quick slice',
      },
    ],
    summary: 'Solid mechanism story, evidence still thin.',
  };
}

function validAudit(): Record<string, unknown> {
  const check = (id: string) => ({
    id,
    status: 'PASS',
    details: `${id} verified against inputs`,
    evidence: 'knowledge/reviews/alpha/experiment-audit-v1.json',
  });
  return {
    checks: [
      check('gt_provenance'),
      check('score_normalization'),
      check('result_existence'),
      check('dead_code'),
      check('scope'),
    ],
    evalType: 'real_gt',
    overall: 'PASS',
    summary: 'All integrity checks passed.',
  };
}

function mutate(
  value: Record<string, unknown>,
  apply: (record: Record<string, unknown>) => void,
): Record<string, unknown> {
  const copy = structuredClone(value);
  apply(copy);
  return copy;
}

describe('idea-review-v1 schema', () => {
  it('is registered and accepts a valid payload', () => {
    expect(listSchemaNames()).toContain('idea-review-v1');
    const check = validateAgainstSchema('idea-review-v1', validIdeaReview());
    expect(check.errors).toEqual([]);
    expect(() => assertAgainstSchema('idea-review-v1', validIdeaReview())).not.toThrow();
  });

  const structural: { name: string; payload: unknown }[] = [
    { name: 'null', payload: null },
    { name: 'score 0', payload: mutate(validIdeaReview(), (r) => (r.score = 0)) },
    { name: 'score 11', payload: mutate(validIdeaReview(), (r) => (r.score = 11)) },
    { name: 'bad verdict', payload: mutate(validIdeaReview(), (r) => (r.verdict = 'meh')) },
    {
      name: 'weaknesses not array',
      payload: mutate(validIdeaReview(), (r) => (r.weaknesses = 'x')),
    },
    {
      name: 'weakness missing minimumFix',
      payload: mutate(
        validIdeaReview(),
        (r) => delete (r.weaknesses as Record<string, unknown>[])[0]!.minimumFix,
      ),
    },
    { name: 'empty summary', payload: mutate(validIdeaReview(), (r) => (r.summary = '')) },
    {
      // Self-contained conditional rule lives in the schema (if/then).
      name: 'almost verdict without weaknesses',
      payload: mutate(validIdeaReview(), (r) => {
        r.verdict = 'almost';
        r.weaknesses = [];
      }),
    },
    {
      name: 'ready verdict without weaknesses is fine',
      payload: mutate(validIdeaReview(), (r) => {
        r.verdict = 'ready';
        r.weaknesses = [];
      }),
      // expectation handled below (not in the reject matrix)
    },
  ];
  for (const testCase of structural.slice(0, 8)) {
    it(`rejects: ${testCase.name}`, () => {
      expect(
        validateAgainstSchema('idea-review-v1', testCase.payload).ok,
        validateAgainstSchema('idea-review-v1', testCase.payload).errors.join('; '),
      ).toBe(false);
    });
  }
  it('accepts ready verdict with zero weaknesses', () => {
    const ready = mutate(validIdeaReview(), (r) => {
      r.verdict = 'ready';
      r.weaknesses = [];
    });
    expect(validateAgainstSchema('idea-review-v1', ready).ok).toBe(true);
  });
});

describe('experiment-audit-v1 schema', () => {
  it('is registered and accepts a valid payload', () => {
    expect(listSchemaNames()).toContain('experiment-audit-v1');
    const check = validateAgainstSchema('experiment-audit-v1', validAudit());
    expect(check.errors).toEqual([]);
    expect(() => assertAgainstSchema('experiment-audit-v1', validAudit())).not.toThrow();
  });

  const structural: { name: string; payload: unknown }[] = [
    { name: 'null', payload: null },
    { name: 'checks not array', payload: mutate(validAudit(), (r) => (r.checks = 'x')) },
    {
      name: 'unknown check id',
      payload: mutate(
        validAudit(),
        (r) => ((r.checks as Record<string, unknown>[])[0]!.id = 'made_up'),
      ),
    },
    {
      name: 'bad check status',
      payload: mutate(
        validAudit(),
        (r) => ((r.checks as Record<string, unknown>[])[0]!.status = 'MAYBE'),
      ),
    },
    {
      name: 'empty check details',
      payload: mutate(
        validAudit(),
        (r) => ((r.checks as Record<string, unknown>[])[0]!.details = ''),
      ),
    },
    { name: 'bad evalType', payload: mutate(validAudit(), (r) => (r.evalType = 'vibes')) },
    { name: 'bad overall', payload: mutate(validAudit(), (r) => (r.overall = 'GREEN')) },
    { name: 'empty summary', payload: mutate(validAudit(), (r) => (r.summary = '')) },
  ];
  for (const testCase of structural) {
    it(`rejects: ${testCase.name}`, () => {
      const check = validateAgainstSchema('experiment-audit-v1', testCase.payload);
      expect(check.ok, check.errors.join('; ')).toBe(false);
    });
  }

  const tsOnly: { name: string; payload: unknown }[] = [
    {
      name: 'duplicate check id',
      payload: mutate(validAudit(), (r) => {
        const checks = r.checks as Record<string, unknown>[];
        checks[1]!.id = checks[0]!.id;
      }),
    },
    {
      name: 'missing one A-F check id',
      payload: mutate(validAudit(), (r) => (r.checks = (r.checks as unknown[]).slice(0, 4))),
    },
    {
      name: 'overall != worst check status',
      payload: mutate(validAudit(), (r) => {
        const checks = r.checks as Record<string, unknown>[];
        checks[0]!.status = 'FAIL';
        r.overall = 'PASS';
      }),
    },
  ];
  for (const testCase of tsOnly) {
    it(`TS-only rule (documented subset): ${testCase.name}`, () => {
      // The semantic validator rejects; the schema accepts — runtime order
      // runs the validator first (documented in the schema description).
      expect(validateAgainstSchema('experiment-audit-v1', testCase.payload).ok).toBe(true);
    });
  }
});
