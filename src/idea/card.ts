import { IdeaseekError } from '../core/errors.js';

/**
 * IdeaCard contract (docs/DATA_CONTRACTS.md §IdeaCard, plan.md 阶段 D).
 * The mechanism chain is the scientific core: an idea without a complete
 * chain — or one that is only a surface composition of existing components —
 * must carry status DRAFT_COMPOSITION and never enters the experiment queue.
 */

export type IdeaStatus = 'DRAFT_COMPOSITION' | 'CANDIDATE';

export type ChainKind =
  | 'observation'
  | 'hypothesis'
  | 'intervention'
  | 'expected-change'
  | 'baseline-difference'
  | 'falsifier';

export const CHAIN_KINDS: readonly ChainKind[] = [
  'observation',
  'hypothesis',
  'intervention',
  'expected-change',
  'baseline-difference',
  'falsifier',
];

export type ComponentRole = 'necessary-mechanism' | 'alternative-explanation' | 'engineering';

export interface IdeaEvidence {
  paperRef: string;
  statement: string;
  /** Citation locator: page/quote inside the paper. */
  evidence: string;
}

export interface ChainStep {
  kind: ChainKind;
  text: string;
}

export interface NearestComparison {
  methodId: string;
  difference: string;
  /** Evidence position for the claimed difference. */
  evidence: string;
}

export interface ComponentNecessity {
  component: string;
  role: ComponentRole;
  /** What is expected to happen if this component is removed. */
  removeEffect: string;
}

export interface MinimalExperiment {
  code: string;
  data: string;
  baselines: string[];
  metrics: string[];
  ablations: string[];
}

export interface IdeaCard {
  /** Stable id per scientific hypothesis; a new hypothesis needs a new id. */
  ideaId: string;
  version: number;
  /** Required when version > 1; null when version === 1. */
  parentVersion: number | null;
  status: IdeaStatus;
  hypothesis: { statement: string; targetProblem: string };
  paperEvidence: IdeaEvidence[];
  contradictions: string[];
  novelty: { claim: string; uncertainty: string; whyNotRestatement: string };
  mechanismChain: {
    /** How the chain maps onto the papers' design principles. */
    designPrincipleLink: string;
    steps: ChainStep[];
  };
  nearestComparisons: NearestComparison[];
  componentNecessity: ComponentNecessity[];
  competingExplanations: string[];
  boundaryConditions: string[];
  risks: string[];
  minimalExperiment: MinimalExperiment;
  falsification: { conditions: string[] };
  budget: { maxRounds: number; maxGpuMinutes: number };
  stopConditions: string[];
  createdAt: number;
}

export interface IdeaValidation {
  ok: boolean;
  errors: string[];
}

export interface IdeaGate {
  /** True when the idea is a testable candidate (not a surface draft). */
  ok: boolean;
  status: IdeaStatus;
  /** Reasons the idea is held at DRAFT_COMPOSITION. */
  blockers: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringArray(value: unknown, min: number, field: string, errors: string[]): void {
  if (!Array.isArray(value) || value.length < min || value.some((v) => !nonEmptyString(v))) {
    errors.push(`${field} must be an array of at least ${min} non-empty string(s)`);
  }
}

/** Structural validation — never persists or accepts malformed cards. */
export function validateIdeaCard(value: unknown): IdeaValidation {
  const errors: string[] = [];
  if (!isObject(value)) return { ok: false, errors: ['idea card must be an object'] };

  if (typeof value.ideaId !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(value.ideaId)) {
    errors.push('ideaId must be kebab-case');
  }
  if (typeof value.version !== 'number' || !Number.isInteger(value.version) || value.version < 1) {
    errors.push('version must be an integer >= 1');
  }
  if (value.version === 1) {
    if (value.parentVersion !== null) errors.push('parentVersion must be null when version is 1');
  } else if (
    typeof value.parentVersion !== 'number' ||
    !Number.isInteger(value.parentVersion) ||
    (value.parentVersion as number) < 1 ||
    (value.parentVersion as number) >= (value.version as number)
  ) {
    errors.push('parentVersion must be an integer < version when version > 1');
  }
  if (value.status !== 'DRAFT_COMPOSITION' && value.status !== 'CANDIDATE') {
    errors.push('status must be DRAFT_COMPOSITION | CANDIDATE');
  }

  if (!isObject(value.hypothesis)) {
    errors.push('hypothesis is required');
  } else {
    if (!nonEmptyString(value.hypothesis.statement))
      errors.push('hypothesis.statement is required');
    if (!nonEmptyString(value.hypothesis.targetProblem)) {
      errors.push('hypothesis.targetProblem is required');
    }
  }

  if (!Array.isArray(value.paperEvidence) || value.paperEvidence.length === 0) {
    errors.push('paperEvidence must list at least one cited claim');
  } else {
    for (const [i, item] of value.paperEvidence.entries()) {
      if (
        !isObject(item) ||
        !nonEmptyString(item.paperRef) ||
        !nonEmptyString(item.statement) ||
        !nonEmptyString(item.evidence)
      ) {
        errors.push(`paperEvidence[${i}] requires paperRef, statement and evidence locator`);
      }
    }
  }
  stringArray(value.contradictions, 1, 'contradictions', errors);

  if (!isObject(value.novelty)) {
    errors.push('novelty is required');
  } else {
    if (!nonEmptyString(value.novelty.claim)) errors.push('novelty.claim is required');
    if (!nonEmptyString(value.novelty.uncertainty)) errors.push('novelty.uncertainty is required');
    if (!nonEmptyString(value.novelty.whyNotRestatement)) {
      errors.push('novelty.whyNotRestatement is required');
    }
  }

  if (!isObject(value.mechanismChain)) {
    errors.push('mechanismChain is required');
  } else {
    if (!nonEmptyString(value.mechanismChain.designPrincipleLink)) {
      errors.push('mechanismChain.designPrincipleLink is required');
    }
    if (!Array.isArray(value.mechanismChain.steps) || value.mechanismChain.steps.length === 0) {
      errors.push('mechanismChain.steps must not be empty');
    } else {
      for (const [i, step] of value.mechanismChain.steps.entries()) {
        if (!isObject(step)) {
          errors.push(`mechanismChain.steps[${i}] must be { kind, text }`);
          continue;
        }
        if (!CHAIN_KINDS.includes(step.kind as ChainKind)) {
          errors.push(`mechanismChain.steps[${i}].kind must be one of ${CHAIN_KINDS.join(' | ')}`);
        }
        if (!nonEmptyString(step.text)) {
          errors.push(`mechanismChain.steps[${i}].text is required`);
        }
      }
    }
  }

  if (!Array.isArray(value.nearestComparisons) || value.nearestComparisons.length === 0) {
    errors.push('nearestComparisons must list at least one related work');
  } else {
    for (const [i, item] of value.nearestComparisons.entries()) {
      if (
        !isObject(item) ||
        !nonEmptyString(item.methodId) ||
        !nonEmptyString(item.difference) ||
        !nonEmptyString(item.evidence)
      ) {
        errors.push(`nearestComparisons[${i}] requires methodId, difference and evidence`);
      }
    }
  }

  if (!Array.isArray(value.componentNecessity)) {
    errors.push('componentNecessity must be an array (may be empty for single-component ideas)');
  } else {
    for (const [i, item] of value.componentNecessity.entries()) {
      if (
        !isObject(item) ||
        !nonEmptyString(item.component) ||
        !nonEmptyString(item.removeEffect)
      ) {
        errors.push(`componentNecessity[${i}] requires component and removeEffect`);
        continue;
      }
      const roles: ComponentRole[] = [
        'necessary-mechanism',
        'alternative-explanation',
        'engineering',
      ];
      if (!roles.includes(item.role as ComponentRole)) {
        errors.push(`componentNecessity[${i}].role must be one of ${roles.join(' | ')}`);
      }
    }
  }

  stringArray(value.competingExplanations, 1, 'competingExplanations', errors);
  stringArray(value.boundaryConditions, 1, 'boundaryConditions', errors);
  stringArray(value.risks, 1, 'risks', errors);

  if (!isObject(value.minimalExperiment)) {
    errors.push('minimalExperiment is required');
  } else {
    if (!nonEmptyString(value.minimalExperiment.code))
      errors.push('minimalExperiment.code is required');
    if (!nonEmptyString(value.minimalExperiment.data))
      errors.push('minimalExperiment.data is required');
    stringArray(value.minimalExperiment.baselines, 1, 'minimalExperiment.baselines', errors);
    stringArray(value.minimalExperiment.metrics, 1, 'minimalExperiment.metrics', errors);
    stringArray(value.minimalExperiment.ablations, 1, 'minimalExperiment.ablations', errors);
  }

  if (!isObject(value.falsification)) {
    errors.push('falsification is required');
  } else {
    stringArray(value.falsification.conditions, 1, 'falsification.conditions', errors);
  }

  if (!isObject(value.budget)) {
    errors.push('budget is required');
  } else {
    for (const field of ['maxRounds', 'maxGpuMinutes'] as const) {
      const budget = value.budget as Record<string, unknown>;
      if (
        typeof budget[field] !== 'number' ||
        !Number.isInteger(budget[field]) ||
        (budget[field] as number) < 1
      ) {
        errors.push(`budget.${field} must be a positive integer`);
      }
    }
  }
  stringArray(value.stopConditions, 1, 'stopConditions', errors);

  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) {
    errors.push('createdAt must be a number');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Mechanism gate (plan 阶段 D: 缺少机制解释、只是已有模块的表面组合时，状态必须
 * 是 DRAFT_COMPOSITION，不能进入自动实验队列). Deterministic checks only —
 * semantic judgment stays with the review agents and the user.
 */
export function assessIdeaGate(value: unknown): IdeaGate {
  const blockers: string[] = [];
  if (!isObject(value)) {
    return { ok: false, status: 'DRAFT_COMPOSITION', blockers: ['not an idea card object'] };
  }

  const chain = isObject(value.mechanismChain) ? value.mechanismChain : null;
  const steps = chain && Array.isArray(chain.steps) ? chain.steps : [];
  const present = new Set(
    steps
      .filter(isObject)
      .map((step) => String(step.kind))
      .filter((kind) => CHAIN_KINDS.includes(kind as ChainKind)),
  );
  const missingKinds = CHAIN_KINDS.filter((kind) => !present.has(kind));
  if (missingKinds.length > 0) {
    blockers.push(`mechanism chain is incomplete: missing ${missingKinds.join(', ')}`);
  }

  const components = Array.isArray(value.componentNecessity)
    ? value.componentNecessity.filter(isObject)
    : [];
  if (components.length >= 2) {
    const hasNecessary = components.some((c) => c.role === 'necessary-mechanism');
    if (!hasNecessary) {
      blockers.push(
        `surface composition: ${components.length} components declared but none is a necessary mechanism`,
      );
    }
  }

  const novelty = isObject(value.novelty) ? value.novelty : null;
  if (novelty && nonEmptyString(novelty.claim) && !nonEmptyString(novelty.uncertainty)) {
    blockers.push('novelty claim without stated uncertainty');
  }

  const ok = blockers.length === 0;
  return { ok, status: ok ? 'CANDIDATE' : 'DRAFT_COMPOSITION', blockers };
}

/**
 * Full assessment: structural errors first; then the mechanism gate; finally
 * the status cross-check — a card that fails the gate MUST declare
 * DRAFT_COMPOSITION (never sneaks into the queue as a candidate).
 */
export function assessIdeaCard(value: unknown): {
  validation: IdeaValidation;
  gate: IdeaGate;
  ok: boolean;
} {
  const validation = validateIdeaCard(value);
  const gate = assessIdeaGate(value);
  const errors = [...validation.errors];
  if (validation.ok && !gate.ok) {
    const status = (value as { status?: unknown }).status;
    if (status !== 'DRAFT_COMPOSITION') {
      errors.push(
        `status must be DRAFT_COMPOSITION when the mechanism gate fails (${gate.blockers.join('; ')})`,
      );
    }
  }
  return {
    validation: { ok: validation.ok, errors },
    gate,
    ok: errors.length === 0,
  };
}

/** Convenience: throws INVALID_ARGUMENT with the first problems listed. */
export function assertValidIdeaCard(value: unknown): IdeaGate {
  const result = assessIdeaCard(value);
  if (!result.ok) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `invalid idea card: ${result.validation.errors.join('; ')}`,
    );
  }
  return result.gate;
}
