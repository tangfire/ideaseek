import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { sha256Of } from '../core/hash.js';
import { writeFileAtomic } from '../core/atomic.js';
import { stableJson } from '../experiment/spec.js';
import { renderArisSkill, type LoadedArisSkill } from '../aris/skill.js';
import type { IdeaCard } from './card.js';
import { slugify } from './analysis.js';

/**
 * ARIS ablation-planner backend (Phase 4.5 capability 3): the vendored
 * skill proposes WHICH ablations matter and WHY (what_it_tests +
 * expected outcome + priority) from the mechanism chain; IdeaSeek keeps
 * the derived matrix, spec binding and execution. A current plan orders
 * the run queue, annotates each spec with the expected outcome and lists
 * entries the scaffold cannot run (hyperparameter/design → deferred,
 * never silently dropped — ARIS: "don't silently drop").
 */

export const ABLATION_PLAN_SCHEMA = 'ablation-plan-v1';

export type AblationPlanKind = 'component' | 'card-ablation' | 'hyperparameter' | 'design';

export interface AblationPlanEntry {
  name: string;
  kind: AblationPlanKind;
  /** component name or card ablation label; null for hyperparameter/design. */
  target: string | null;
  whatItTests: string;
  expectedOutcome: string;
  /** 1 = run first … 5 = last. */
  priority: number;
}

export interface AblationPlan {
  contract: typeof ABLATION_PLAN_SCHEMA;
  ideaId: string;
  cardVersion: number;
  inputHash: string;
  skill: { name: string; sha256: string };
  generatedAt: number;
  harnessRuntime: string;
  entries: AblationPlanEntry[];
  coverageAssessment: string;
  unnecessary: string[];
  suggestedOrder: string[];
  estimatedGpuMinutes: number;
}

const OUTPUT_CONTRACT = `
# IdeaSeek output contract (${ABLATION_PLAN_SCHEMA})

Reply with ONE JSON object and nothing else:

{"entries": [{"name": "...", "kind": "component|card-ablation|hyperparameter|design",
   "target": "<component name or card ablation label, else null>",
   "whatItTests": "...", "expectedOutcome": "...", "priority": <1-5>}],
 "coverageAssessment": "...", "unnecessary": ["..."],
 "suggestedOrder": ["<entry name>", ...], "estimatedGpuMinutes": <int>}

Rules:
- entries ≥ 1. kind=component requires target ∈ the card's componentNecessity
  components; kind=card-ablation requires target ∈ minimalExperiment.ablations;
  kind=hyperparameter|design must have target null (the scaffold cannot run
  them — list them, never pretend they are runnable).
- Every entry states what it tests and the predicted outcome ("no 'just try
  it'" — ARIS ablation-planner).
- priority 1 = most discriminating first; suggestedOrder lists entry names.
- unnecessary: ablations from the card you would SKIP and why (may be []).
- coverageAssessment: one paragraph on whether the set discriminates the
  mechanism chain.
- No prose, no markdown fence, no commentary outside the JSON object.
`.trim();

export interface AblationPlanRequest {
  instruction: string;
  inputHash: string;
  idempotencyKey: string;
}

export function buildAblationPlanRequest(
  skill: LoadedArisSkill,
  context: { ideaId: string; cardVersion: number; cardJson: string; planJson: string | null },
): AblationPlanRequest {
  const inputHash = sha256Of(
    stableJson({
      contract: ABLATION_PLAN_SCHEMA,
      skillSha256: skill.sha256,
      ideaId: context.ideaId,
      cardVersion: context.cardVersion,
      card: JSON.parse(context.cardJson),
      experimentPlan: context.planJson ? JSON.parse(context.planJson) : null,
    }),
  );
  const instruction = [
    renderArisSkill(skill, {
      arguments: `IdeaSeek idea ${context.ideaId} (card v${context.cardVersion})`,
    }),
    '',
    '---',
    '',
    OUTPUT_CONTRACT,
    '',
    'IdeaCard (authoritative input):',
    context.cardJson,
    '',
    'Experiment plan (when present, align ablations with its claims):',
    context.planJson ?? '(none yet)',
  ].join('\n');
  return { instruction, inputHash, idempotencyKey: `ablation-plan:${inputHash}` };
}

export interface AblationPlanValidation {
  ok: boolean;
  errors: string[];
}

export function validateAblationPlan(
  value: unknown,
  expected: { ideaId: string; cardVersion: number; card: IdeaCard },
): AblationPlanValidation {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['plan must be a JSON object'] };
  }
  const record = value as Record<string, unknown>;
  if (record.ideaId !== expected.ideaId) errors.push(`ideaId must be "${expected.ideaId}"`);
  if (record.cardVersion !== expected.cardVersion)
    errors.push(`cardVersion must be ${expected.cardVersion}`);

  const components = new Set(expected.card.componentNecessity.map((entry) => entry.component));
  const cardAblations = new Set(expected.card.minimalExperiment.ablations);

  const entries = record.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    errors.push('entries must have ≥ 1 entry');
  } else {
    for (const [i, entry] of entries.entries()) {
      const item = entry as Partial<AblationPlanEntry>;
      const where = `entries[${i}]`;
      if (typeof item?.name !== 'string' || !item.name.trim()) errors.push(`${where}.name invalid`);
      const kind = item?.kind;
      if (!['component', 'card-ablation', 'hyperparameter', 'design'].includes(String(kind))) {
        errors.push(`${where}.kind must be component|card-ablation|hyperparameter|design`);
      }
      if (kind === 'component') {
        if (typeof item.target !== 'string' || !components.has(item.target)) {
          errors.push(`${where}.target must be a componentNecessity component of the card`);
        }
      } else if (kind === 'card-ablation') {
        if (typeof item.target !== 'string' || !cardAblations.has(item.target)) {
          errors.push(`${where}.target must be a minimalExperiment.ablations label of the card`);
        }
      } else if (item.target !== null) {
        errors.push(`${where}.target must be null for ${String(kind)} entries`);
      }
      if (typeof item?.whatItTests !== 'string' || !item.whatItTests.trim()) {
        errors.push(`${where}.whatItTests must be a non-empty string`);
      }
      if (typeof item?.expectedOutcome !== 'string' || !item.expectedOutcome.trim()) {
        errors.push(`${where}.expectedOutcome must be a non-empty string`);
      }
      if (
        typeof item?.priority !== 'number' ||
        !Number.isInteger(item.priority) ||
        item.priority < 1 ||
        item.priority > 5
      ) {
        errors.push(`${where}.priority must be an integer 1-5`);
      }
    }
  }
  if (typeof record.coverageAssessment !== 'string' || !record.coverageAssessment.trim()) {
    errors.push('coverageAssessment must be a non-empty string');
  }
  if (!Array.isArray(record.unnecessary)) errors.push('unnecessary must be an array');
  if (!Array.isArray(record.suggestedOrder) || record.suggestedOrder.length === 0) {
    errors.push('suggestedOrder must have ≥ 1 entry');
  }
  const budget = record.estimatedGpuMinutes;
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) {
    errors.push('estimatedGpuMinutes must be a positive number');
  }
  return { ok: errors.length === 0, errors };
}

export function parseAblationPlanOutput(
  output: string,
  expected: { ideaId: string; cardVersion: number; card: IdeaCard },
  meta: { inputHash: string; skill: { name: string; sha256: string }; harnessRuntime: string },
): AblationPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new IdeaseekError('PARSE_FAILED', `ablation plan is not JSON: ${output.slice(0, 160)}`);
  }
  const validation = validateAblationPlan(parsed, expected);
  if (!validation.ok) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `ablation plan failed validation: ${validation.errors.slice(0, 4).join('; ')}`,
    );
  }
  const record = parsed as Omit<
    AblationPlan,
    'contract' | 'inputHash' | 'skill' | 'generatedAt' | 'harnessRuntime'
  >;
  return {
    contract: ABLATION_PLAN_SCHEMA,
    ideaId: expected.ideaId,
    cardVersion: expected.cardVersion,
    inputHash: meta.inputHash,
    skill: meta.skill,
    generatedAt: Date.now(),
    harnessRuntime: meta.harnessRuntime,
    entries: record.entries,
    coverageAssessment: record.coverageAssessment,
    unnecessary: record.unnecessary,
    suggestedOrder: record.suggestedOrder,
    estimatedGpuMinutes: record.estimatedGpuMinutes,
  };
}

export function ablationPlanPath(root: string, ideaId: string): string {
  return join(root, 'ideas', ideaId, 'experiments', 'ablation-plan.json');
}

export async function readAblationPlan(root: string, ideaId: string): Promise<AblationPlan | null> {
  try {
    const plan = JSON.parse(await readFile(ablationPlanPath(root, ideaId), 'utf8')) as AblationPlan;
    if (plan.contract !== ABLATION_PLAN_SCHEMA || plan.ideaId !== ideaId) return null;
    return plan;
  } catch {
    return null;
  }
}

export async function writeAblationPlan(root: string, plan: AblationPlan): Promise<string> {
  const path = ablationPlanPath(root, plan.ideaId);
  await writeFileAtomic(path, `${JSON.stringify(plan, null, 2)}\n`);
  return path;
}

export interface DerivedAblation {
  ablationId: string;
  label: string;
  removeComponent: string | null;
}

export interface OrderedAblations<T extends DerivedAblation> {
  /** Plan-priority order (stable: unplanned entries keep derivation order). */
  ordered: T[];
  /** ablationId → matched plan entry (for expected-outcome annotations). */
  matched: Map<string, AblationPlanEntry>;
  /** Plan entries the scaffold cannot run — reported, never silently dropped. */
  deferred: AblationPlanEntry[];
  /** Plan targets that matched no derived ablation (coverage gap warning). */
  unmatchedTargets: string[];
}

function entryKeys(entry: AblationPlanEntry): string[] {
  if (!entry.target) return [];
  return [
    entry.target,
    slugify(entry.target),
    `abl-${slugify(entry.target)}`,
    `w-o-${slugify(entry.target)}`,
  ];
}

/**
 * Orders the derived matrix by the plan's priorities and returns the
 * matches used for annotation. A null/stale plan returns the input order.
 */
export function orderDerivedAblations<T extends DerivedAblation>(
  derived: T[],
  plan: AblationPlan | null,
): OrderedAblations<T> {
  const deferred = plan ? plan.entries.filter((entry) => entry.target === null) : [];
  if (!plan) {
    return { ordered: derived, matched: new Map(), deferred, unmatchedTargets: [] };
  }
  const matched = new Map<string, AblationPlanEntry>();
  const matchedEntries = new Set<string>();
  for (const item of derived) {
    const keys = new Set([
      item.ablationId,
      item.label,
      slugify(item.label),
      ...(item.removeComponent ? [item.removeComponent, slugify(item.removeComponent)] : []),
    ]);
    for (const entry of plan.entries) {
      if (entry.target === null || matchedEntries.has(entry.name)) continue;
      if (entryKeys(entry).some((key) => keys.has(key))) {
        matched.set(item.ablationId, entry);
        matchedEntries.add(entry.name);
        break;
      }
    }
  }
  const priorityOf = (item: T): number => matched.get(item.ablationId)?.priority ?? 99;
  const ordered = [...derived].sort((a, b) => priorityOf(a) - priorityOf(b));
  const unmatchedTargets = plan.entries
    .filter((entry) => entry.target !== null && !matchedEntries.has(entry.name))
    .map((entry) => entry.target as string);
  return { ordered, matched, deferred, unmatchedTargets };
}
