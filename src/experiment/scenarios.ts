/**
 * Scenario portfolio contract (docs/EXPERIMENT_PORTFOLIO.md, plan.md 阶段 E):
 * an idea's experiment plan progresses L0 engineering validity → L1 mechanism
 * → L2 multi-seed stability → L3 scenario robustness → L4 external data.
 * The default builder is deterministic and budget-aware; generation by the
 * Experiment Designer agent (with model) later replaces/edits entries but
 * must satisfy the same validator.
 */
export type ScenarioLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';

export const SCENARIO_LEVELS: readonly ScenarioLevel[] = ['L0', 'L1', 'L2', 'L3', 'L4'];

export interface ScenarioSpec {
  level: ScenarioLevel;
  name: string;
  purpose: string;
  /** Repetitions with different seeds (stability levels require >= 3). */
  seeds: number;
  /** Dataset scales this scenario may run on. */
  scales: ('smoke' | 'quick' | 'standard')[];
  costHint: 'low' | 'medium' | 'high';
}

export interface ExperimentPortfolio {
  /** pf-<ideaId>-v<version>. */
  portfolioId: string;
  ideaId: string;
  scenarioVersion: number;
  scenarios: ScenarioSpec[];
  /** Textual promotion rules (L1 → L2 etc.), checked by Result Analyst. */
  promotionRules: string[];
  stopConditions: string[];
  budget: { maxRounds: number };
  hasExternalData: boolean;
  generatedAt: number;
  generatedBy: string;
}

export interface PortfolioValidation {
  ok: boolean;
  errors: string[];
}

export function validatePortfolio(value: unknown): PortfolioValidation {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['portfolio must be an object'] };
  }
  const p = value as Record<string, unknown>;
  if (typeof p.portfolioId !== 'string' || !p.portfolioId.startsWith('pf-')) {
    errors.push('portfolioId must start with pf-');
  }
  if (typeof p.ideaId !== 'string' || !p.ideaId) {
    errors.push('ideaId is required');
  }
  if (typeof p.scenarioVersion !== 'number' || p.scenarioVersion < 1) {
    errors.push('scenarioVersion must be a positive number');
  }
  if (typeof p.hasExternalData !== 'boolean') {
    errors.push('hasExternalData must be a boolean');
  }
  const budget = p.budget as { maxRounds?: unknown } | undefined;
  if (!budget || typeof budget.maxRounds !== 'number' || budget.maxRounds < 1) {
    errors.push('budget.maxRounds must be a positive number');
  }
  for (const key of ['promotionRules', 'stopConditions'] as const) {
    const list = p[key];
    if (
      !Array.isArray(list) ||
      list.length === 0 ||
      list.some((item) => typeof item !== 'string')
    ) {
      errors.push(`${key} must be a non-empty array of strings`);
    }
  }

  const scenarios = p.scenarios;
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    errors.push('scenarios must be a non-empty array');
    return { ok: false, errors };
  }
  const seen = new Set<string>();
  scenarios.forEach((entry, index) => {
    const s = entry as ScenarioSpec;
    if (!s || typeof s !== 'object') {
      errors.push(`scenarios[${index}] must be an object`);
      return;
    }
    if (!SCENARIO_LEVELS.includes(s.level)) {
      errors.push(`scenarios[${index}].level must be one of ${SCENARIO_LEVELS.join(', ')}`);
    }
    if (seen.has(s.level)) errors.push(`duplicate scenario level ${s.level}`);
    seen.add(s.level);
    if (typeof s.name !== 'string' || !s.name) errors.push(`scenarios[${index}].name required`);
    if (typeof s.purpose !== 'string' || !s.purpose) {
      errors.push(`scenarios[${index}].purpose required`);
    }
    if (typeof s.seeds !== 'number' || s.seeds < 1) {
      errors.push(`scenarios[${index}].seeds must be >= 1`);
    }
    if ((s.level === 'L2' || s.level === 'L3') && s.seeds < 3) {
      errors.push(`scenarios[${index}] (${s.level}) requires at least 3 seeds for stability`);
    }
    if (!Array.isArray(s.scales) || s.scales.length === 0) {
      errors.push(`scenarios[${index}].scales must be non-empty`);
    }
    if (!['low', 'medium', 'high'].includes(s.costHint)) {
      errors.push(`scenarios[${index}].costHint invalid`);
    }
  });
  // L4 only when external data exists.
  const l4 = scenarios.find((entry) => (entry as ScenarioSpec).level === 'L4');
  if (l4 && p.hasExternalData !== true) {
    errors.push('L4 scenario requires hasExternalData: true');
  }
  return { ok: errors.length === 0, errors };
}

export interface DefaultPortfolioOptions {
  ideaId: string;
  maxRounds: number;
  hasExternalData: boolean;
  generatedAt: number;
  generatedBy: string;
  scenarioVersion?: number;
}

/** Deterministic default portfolio covering L0–L3 (L4 only with external data). */
export function buildDefaultPortfolio(opts: DefaultPortfolioOptions): ExperimentPortfolio {
  const version = opts.scenarioVersion ?? 1;
  const scenarios: ScenarioSpec[] = [
    {
      level: 'L0',
      name: 'engineering validity',
      purpose: 'smoke run proves the pipeline executes end to end on the idea code',
      seeds: 1,
      scales: ['smoke'],
      costHint: 'low',
    },
    {
      level: 'L1',
      name: 'mechanism validation',
      purpose: 'minimal discriminating experiment separates the idea mechanism from baseline',
      seeds: 1,
      scales: ['quick'],
      costHint: 'medium',
    },
    {
      level: 'L2',
      name: 'multi-seed stability',
      purpose: 'repeat the discriminating experiment across seeds to rule out noise',
      seeds: 5,
      scales: ['quick'],
      costHint: 'medium',
    },
    {
      level: 'L3',
      name: 'scenario robustness',
      purpose: 'harder slices and boundary conditions test whether the gain survives',
      seeds: 3,
      scales: ['quick', 'standard'],
      costHint: 'high',
    },
  ];
  if (opts.hasExternalData) {
    scenarios.push({
      level: 'L4',
      name: 'external validation',
      purpose: 'confirm the effect on a held-out external dataset',
      seeds: 3,
      scales: ['standard'],
      costHint: 'high',
    });
  }

  return {
    portfolioId: `pf-${opts.ideaId}-v${version}`,
    ideaId: opts.ideaId,
    scenarioVersion: version,
    scenarios,
    promotionRules: [
      'L0 must pass before any L1 run (pipeline executes, metrics produced)',
      'L1 must beat its registered baseline on the primary metric before L2',
      'L2 requires mean gain with overlapping-free variance report before L3',
      'L3 must hold on every pre-registered slice before claiming robustness',
      'L4 (external data) never substitutes for L1-L3; it only extends them',
    ],
    stopConditions: [
      'budget.maxRounds exhausted',
      'three consecutive rounds without information gain',
      'a blocker-level leakage finding on the active slices',
    ],
    budget: { maxRounds: opts.maxRounds },
    hasExternalData: opts.hasExternalData,
    generatedAt: opts.generatedAt,
    generatedBy: opts.generatedBy,
  };
}
