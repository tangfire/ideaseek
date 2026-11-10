import { describe, expect, it } from 'vitest';
import { buildDefaultPortfolio, validatePortfolio } from '../src/experiment/scenarios.js';

const base = {
  ideaId: 'idea-001',
  maxRounds: 3,
  hasExternalData: false,
  generatedAt: 1,
  generatedBy: 'unit',
};

describe('buildDefaultPortfolio', () => {
  it('covers L0-L3 deterministically without external data', () => {
    const a = buildDefaultPortfolio(base);
    const b = buildDefaultPortfolio(base);
    expect(a).toEqual(b);
    expect(a.portfolioId).toBe('pf-idea-001-v1');
    expect(a.scenarios.map((scenario) => scenario.level)).toEqual(['L0', 'L1', 'L2', 'L3']);
    expect(validatePortfolio(a).errors).toEqual([]);

    const l2 = a.scenarios.find((scenario) => scenario.level === 'L2')!;
    expect(l2.seeds).toBe(5);
    const l3 = a.scenarios.find((scenario) => scenario.level === 'L3')!;
    expect(l3.seeds).toBeGreaterThanOrEqual(3);
    expect(l3.scales).toContain('standard');
    expect(a.promotionRules.length).toBeGreaterThan(0);
    expect(a.stopConditions.join(' ')).toContain('leakage');
  });

  it('adds L4 only when external data exists', () => {
    const without = buildDefaultPortfolio(base);
    expect(without.scenarios.some((scenario) => scenario.level === 'L4')).toBe(false);

    const withExternal = buildDefaultPortfolio({ ...base, hasExternalData: true });
    expect(withExternal.scenarios.some((scenario) => scenario.level === 'L4')).toBe(true);
    expect(validatePortfolio(withExternal).errors).toEqual([]);
  });
});

describe('validatePortfolio', () => {
  it('rejects missing provenance and structural problems', () => {
    expect(validatePortfolio(null).ok).toBe(false);
    expect(validatePortfolio({}).ok).toBe(false);

    const noRules = buildDefaultPortfolio(base);
    (noRules as { promotionRules: string[] }).promotionRules = [];
    expect(validatePortfolio(noRules).errors.join(' ')).toContain('promotionRules');

    const noScenarios = buildDefaultPortfolio(base);
    (noScenarios as { scenarios: unknown[] }).scenarios = [];
    expect(validatePortfolio(noScenarios).ok).toBe(false);
  });

  it('requires >=3 seeds for stability levels and forbids duplicates', () => {
    const weak = buildDefaultPortfolio(base);
    const l2 = weak.scenarios.find((scenario) => scenario.level === 'L2')!;
    l2.seeds = 1;
    const result = validatePortfolio(weak);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('at least 3 seeds');

    const dup = buildDefaultPortfolio(base);
    dup.scenarios.push({ ...dup.scenarios[0]! });
    expect(validatePortfolio(dup).errors.join(' ')).toContain('duplicate scenario level');
  });

  it('blocks L4 without external data and bad budget', () => {
    const l4 = buildDefaultPortfolio({ ...base, hasExternalData: true });
    const stripped = { ...l4, hasExternalData: false };
    const result = validatePortfolio(stripped);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('L4 scenario requires hasExternalData');

    const badBudget = buildDefaultPortfolio(base);
    (badBudget as { budget: { maxRounds: number } }).budget = { maxRounds: 0 };
    expect(validatePortfolio(badBudget).errors.join(' ')).toContain('budget.maxRounds');
  });

  it('rejects invalid levels and cost hints', () => {
    const bad = buildDefaultPortfolio(base);
    (bad.scenarios[0] as { level: string }).level = 'L9';
    const result = validatePortfolio(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('level must be one of');

    const badCost = buildDefaultPortfolio(base);
    (badCost.scenarios[0] as { costHint: string }).costHint = 'extreme';
    expect(validatePortfolio(badCost).errors.join(' ')).toContain('costHint invalid');
  });
});
