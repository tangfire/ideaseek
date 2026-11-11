import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { sha256Of } from '../core/hash.js';
import { writeFileAtomic } from '../core/atomic.js';
import { stableJson } from '../experiment/spec.js';
import { renderArisSkill, type LoadedArisSkill } from '../aris/skill.js';

/**
 * ARIS experiment-plan backend (Phase 4.5 capability 2): the vendored
 * `experiment-plan` skill turns an IdeaCard into a structured plan
 * (claim map, experiment blocks, budget, risks, checklist) that IdeaSeek
 * persists beside the workspace and binds into ExperimentSpec
 * environment.notes. The executable spec itself stays with buildIdeaSpec
 * (resource/queue/checkpoint semantics are IdeaSeek-owned); the plan adds
 * the claim→metric accountability the runner then enforces.
 */

export const EXPERIMENT_PLAN_SCHEMA = 'experiment-plan-v1';

export interface PlanBlock {
  name: string;
  scale: 'smoke' | 'quick' | 'standard';
  metrics: string[];
  successCriteria: string;
  failureModes: string[];
}

export interface ExperimentPlan {
  contract: typeof EXPERIMENT_PLAN_SCHEMA;
  ideaId: string;
  cardVersion: number;
  inputHash: string;
  skill: { name: string; sha256: string };
  generatedAt: number;
  harnessRuntime: string;
  primaryMetric: string;
  claimMap: { claim: string; evidence: string }[];
  blocks: PlanBlock[];
  runOrder: string[];
  computeBudget: { gpuMinutes: number };
  risks: string[];
  checklist: string[];
}

const OUTPUT_CONTRACT = `
# IdeaSeek output contract (${EXPERIMENT_PLAN_SCHEMA})

Reply with ONE JSON object and nothing else:

{"ideaId": "<same as input>", "cardVersion": <int>, "primaryMetric": "<name>",
 "claimMap": [{"claim": "...", "evidence": "..."}],
 "blocks": [{"name": "...", "scale": "smoke|quick|standard", "metrics": ["..."],
   "successCriteria": "...", "failureModes": ["..."]}],
 "runOrder": ["M0 ...", "M1 ..."],
 "computeBudget": {"gpuMinutes": <int>},
 "risks": ["..."], "checklist": ["..."]}

Rules:
- claimMap ≥ 1: each claim must cite evidence from the IdeaCard (paper
  references or mechanism chain), never invent results.
- blocks ≥ 1; "metrics" entries must be metric names that exist in the
  idea's config/train.json (the runner checks primaryMetric against the
  spec and refuses a mismatch).
- runOrder, risks, checklist each ≥ 1; computeBudget.gpuMinutes must fit
  the card budget (budget.maxGpuMinutes).
- No prose, no markdown fence, no commentary outside the JSON object.
`.trim();

export interface PlanRequest {
  instruction: string;
  inputHash: string;
  idempotencyKey: string;
}

export function buildPlanRequest(
  skill: LoadedArisSkill,
  context: { ideaId: string; cardVersion: number; cardJson: string; question: string | null },
): PlanRequest {
  const inputHash = sha256Of(
    stableJson({
      contract: EXPERIMENT_PLAN_SCHEMA,
      skillSha256: skill.sha256,
      ideaId: context.ideaId,
      cardVersion: context.cardVersion,
      card: JSON.parse(context.cardJson),
      question: context.question,
    }),
  );
  const instruction = [
    renderArisSkill(skill, {
      arguments:
        `IdeaSeek idea ${context.ideaId} (card v${context.cardVersion}), ` +
        `research question: ${context.question ?? '(none)'}`,
    }),
    '',
    '---',
    '',
    OUTPUT_CONTRACT,
    '',
    'IdeaCard (authoritative input):',
    context.cardJson,
  ].join('\n');
  return { instruction, inputHash, idempotencyKey: `idea-plan:${inputHash}` };
}

export interface PlanValidation {
  ok: boolean;
  errors: string[];
}

/** Structural contract + idea binding for a generated plan. */
export function validateExperimentPlan(
  value: unknown,
  expected: { ideaId: string; cardVersion: number },
): PlanValidation {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['plan must be a JSON object'] };
  }
  const record = value as Record<string, unknown>;
  if (record.ideaId !== expected.ideaId) {
    errors.push(`ideaId must be "${expected.ideaId}", got ${JSON.stringify(record.ideaId)}`);
  }
  if (record.cardVersion !== expected.cardVersion) {
    errors.push(`cardVersion must be ${expected.cardVersion}`);
  }
  if (typeof record.primaryMetric !== 'string' || !record.primaryMetric.trim()) {
    errors.push('primaryMetric must be a non-empty string');
  }
  const claimMap = record.claimMap;
  if (!Array.isArray(claimMap) || claimMap.length === 0) {
    errors.push('claimMap must have ≥ 1 entry');
  } else {
    for (const [i, entry] of claimMap.entries()) {
      const item = entry as { claim?: unknown; evidence?: unknown };
      if (typeof item?.claim !== 'string' || !item.claim.trim()) {
        errors.push(`claimMap[${i}].claim must be a non-empty string`);
      }
      if (typeof item?.evidence !== 'string' || !item.evidence.trim()) {
        errors.push(`claimMap[${i}].evidence must cite the IdeaCard (non-empty string)`);
      }
    }
  }
  const blocks = record.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    errors.push('blocks must have ≥ 1 entry');
  } else {
    for (const [i, entry] of blocks.entries()) {
      const item = entry as Partial<PlanBlock>;
      if (typeof item?.name !== 'string' || !item.name.trim())
        errors.push(`blocks[${i}].name invalid`);
      if (!['smoke', 'quick', 'standard'].includes(String(item?.scale))) {
        errors.push(`blocks[${i}].scale must be smoke|quick|standard`);
      }
      if (!Array.isArray(item?.metrics) || item.metrics.length === 0) {
        errors.push(`blocks[${i}].metrics must be a non-empty array`);
      }
      if (typeof item?.successCriteria !== 'string' || !item.successCriteria.trim()) {
        errors.push(`blocks[${i}].successCriteria must be a non-empty string`);
      }
      if (!Array.isArray(item?.failureModes) || item.failureModes.length === 0) {
        errors.push(`blocks[${i}].failureModes must be a non-empty array`);
      }
    }
  }
  if (!Array.isArray(record.runOrder) || record.runOrder.length === 0) {
    errors.push('runOrder must have ≥ 1 milestone');
  }
  const budget = record.computeBudget as { gpuMinutes?: unknown } | undefined;
  if (
    !budget ||
    typeof budget.gpuMinutes !== 'number' ||
    !Number.isFinite(budget.gpuMinutes) ||
    budget.gpuMinutes <= 0
  ) {
    errors.push('computeBudget.gpuMinutes must be a positive number');
  }
  if (!Array.isArray(record.risks) || record.risks.length === 0) {
    errors.push('risks must have ≥ 1 entry');
  }
  if (!Array.isArray(record.checklist) || record.checklist.length === 0) {
    errors.push('checklist must have ≥ 1 entry');
  }
  return { ok: errors.length === 0, errors };
}

/** Parses harness output; a structurally invalid plan is PARSE_FAILED. */
export function parsePlanOutput(
  output: string,
  expected: { ideaId: string; cardVersion: number },
  meta: { inputHash: string; skill: { name: string; sha256: string }; harnessRuntime: string },
): ExperimentPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new IdeaseekError('PARSE_FAILED', `experiment plan is not JSON: ${output.slice(0, 160)}`);
  }
  const validation = validateExperimentPlan(parsed, expected);
  if (!validation.ok) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `experiment plan failed validation: ${validation.errors.slice(0, 4).join('; ')}`,
    );
  }
  const record = parsed as Omit<
    ExperimentPlan,
    'contract' | 'inputHash' | 'skill' | 'generatedAt' | 'harnessRuntime'
  >;
  return {
    contract: EXPERIMENT_PLAN_SCHEMA,
    ideaId: expected.ideaId,
    cardVersion: expected.cardVersion,
    inputHash: meta.inputHash,
    skill: meta.skill,
    generatedAt: Date.now(),
    harnessRuntime: meta.harnessRuntime,
    primaryMetric: record.primaryMetric,
    claimMap: record.claimMap,
    blocks: record.blocks,
    runOrder: record.runOrder,
    computeBudget: record.computeBudget,
    risks: record.risks,
    checklist: record.checklist,
  };
}

export function planPath(root: string, ideaId: string): string {
  return join(root, 'ideas', ideaId, 'experiments', 'plan.json');
}

/** Reads the persisted plan; missing/corrupt/wrong idea → null. */
export async function readPlan(root: string, ideaId: string): Promise<ExperimentPlan | null> {
  try {
    const plan = JSON.parse(await readFile(planPath(root, ideaId), 'utf8')) as ExperimentPlan;
    if (plan.contract !== EXPERIMENT_PLAN_SCHEMA || plan.ideaId !== ideaId) return null;
    return plan;
  } catch {
    return null;
  }
}

export async function writePlan(root: string, plan: ExperimentPlan): Promise<string> {
  const path = planPath(root, plan.ideaId);
  await writeFileAtomic(path, `${JSON.stringify(plan, null, 2)}\n`);
  return path;
}

/**
 * Claim→metric accountability: when a CURRENT plan exists, its declared
 * primary metric must appear in the executable spec — a plan/spec drift is
 * refused before any compute is spent (ARIS: never let results answer a
 * different claim than the plan promised).
 */
export function assertPlanMatchesSpec(
  plan: ExperimentPlan | null,
  specMetrics: { name: string }[],
  opts: { ideaId: string; cardVersion: number },
): { applied: boolean; note?: string } {
  if (!plan) return { applied: false };
  if (plan.cardVersion !== opts.cardVersion) {
    return {
      applied: false,
      note: `plan is stale (plan v${plan.cardVersion}, card v${opts.cardVersion}) — rerun: ideaseek idea plan ${opts.ideaId}`,
    };
  }
  const names = new Set(specMetrics.map((metric) => metric.name));
  if (!names.has(plan.primaryMetric)) {
    throw new IdeaseekError(
      'USER_INPUT_REQUIRED',
      `experiment plan primaryMetric "${plan.primaryMetric}" is not in the spec metrics ` +
        `(${[...names].join(', ') || 'none'}) — align config/train.json with the plan or ` +
        `regenerate it: ideaseek idea plan ${opts.ideaId} --force`,
      { primaryMetric: plan.primaryMetric, specMetrics: [...names] },
    );
  }
  return { applied: true, note: `plan:${plan.inputHash.slice(7, 19)}` };
}
