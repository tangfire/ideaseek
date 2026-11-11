import { IdeaseekError } from '../core/errors.js';
import { sha256Of } from '../core/hash.js';
import { stableJson } from './spec.js';
import { renderArisSkill, type LoadedArisSkill } from '../aris/skill.js';

/**
 * ARIS `experiment-plan` skill backend (Phase 4.5 capability 2,
 * docs/ARIS_AUDIT §experiment plan/bridge): the vendored skill supplies the
 * claim-driven planning methodology; this module owns the IdeaSeek contract —
 * the idea context the plan is grounded in, the structured
 * `experiment-plan-v1` output schema with IdeaSeek guards (budget ceiling,
 * smoke/quick run scales, smoke/quick/standard data scales, protocol primary
 * metric), the inputHash that makes planning idempotent, and the stored-plan
 * reader that execution (buildIdeaSpec seeds, the bridge gate) consumes.
 * Execution itself stays in IdeaSeek (ARIS has no lease/admission semantics).
 */

export const EXPERIMENT_PLAN_SCHEMA = 'experiment-plan-v1';

export type PlanRunScale = 'smoke' | 'quick';
export type PlanDataScale = 'smoke' | 'quick' | 'standard';

export interface PlanMetric {
  name: string;
  direction: 'higher' | 'lower';
}

export interface PlanClaim {
  claimId: string;
  statement: string;
  linkedBlocks: string[];
}

export interface PlanBlock {
  blockId: string;
  name: string;
  claimTested: string;
  priority: 'MUST-RUN' | 'NICE-TO-HAVE';
  /** Bounded run scale — IdeaSeek never plans full training (handoff owns it). */
  scale: PlanRunScale;
  /** DatasetSlice tier this block consumes (IdeaSeek data-scale vocabulary). */
  dataScale: PlanDataScale;
  metrics: PlanMetric[];
  successCriterion: string;
  failureInterpretation: string;
}

export interface ExperimentPlan {
  problem: string;
  thesis: string;
  claims: PlanClaim[];
  blocks: PlanBlock[];
  runOrder: string[];
  /** Plan-wide reproducibility seeds (ARIS DEFAULT_SEEDS); executed as-is. */
  seeds: number[];
  /** Estimated compute minutes; must fit inside the IdeaCard budget. */
  budgetMinutes: number;
  risks: { risk: string; mitigation: string }[];
}

/** The plan artifact as committed: platform stamps wrap the model output. */
export interface StoredPlan {
  contract: typeof EXPERIMENT_PLAN_SCHEMA;
  ideaId: string;
  ideaVersion: number;
  inputHash: string;
  skill: { name: string; sha256: string };
  generatedAt: number;
  reused: boolean;
  plan: ExperimentPlan;
  /** Planned spec binding at record time (scale drives bridge execution). */
  spec: { specId: string; specHash: string; version: number; scale: PlanRunScale };
}

/** Runtime slice the plan context and stored-plan readers need. */
export interface PlanStoreRuntime {
  db: {
    listArtifactsByKind(kind: string): Promise<
      {
        contentHash: string;
        /** Optional so the narrow spec-builder runtime can satisfy this too. */
        meta?: Record<string, unknown>;
      }[]
    >;
  };
  store: { readFinalText(hash: string): Promise<string> };
}

/** Additional reads the idea context needs (satisfied by ProjectRuntime). */
export interface PlanContextRuntime extends PlanStoreRuntime {
  db: PlanStoreRuntime['db'] & {
    listComparisons(filter: {
      required?: boolean;
    }): Promise<{ methodId: string; status: string; required: boolean }[]>;
    listSlices(opts?: { scale?: string }): Promise<{ sliceId: string; scale: string }[]>;
  };
  config: { research: { question: string | null }; runtime: { defaultDataScale: string } };
}

export interface PlanIdeaContext {
  ideaId: string;
  ideaVersion: number;
  question: string | null;
  hypothesis: { statement: string; targetProblem: string };
  nearestComparisons: { methodId: string; difference: string }[];
  comparisonStatuses: { methodId: string; status: string; required: boolean }[];
  minimalExperiment: {
    code: string;
    data: string;
    baselines: string[];
    metrics: string[];
    ablations: string[];
  };
  budget: { maxRounds: number; maxGpuMinutes: number };
  protocol: { protocolId: string; primaryMetrics: PlanMetric[] } | null;
  /** Registered DatasetSlice tiers + the configured default data scale. */
  dataScales: { registered: string[]; default: string };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads the idea's card/workspace context that grounds the plan. */
export async function buildPlanContext(
  projectRoot: string,
  runtime: PlanContextRuntime,
  ideaId: string,
): Promise<PlanIdeaContext> {
  const { loadIdeaCard, loadWorkspaceMeta } = await import('../idea/workspace.js');
  const { assessIdeaCard } = await import('../idea/card.js');
  const card = await loadIdeaCard(projectRoot, ideaId);
  const assessment = assessIdeaCard(card);
  if (!assessment.ok) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `idea card invalid: ${assessment.validation.errors.slice(0, 3).join('; ')}`,
    );
  }
  const meta = await loadWorkspaceMeta(projectRoot, ideaId);

  // Latest protocol's primary metrics (the plan must measure them).
  let protocol: PlanIdeaContext['protocol'] = null;
  try {
    const artifacts = await runtime.db.listArtifactsByKind('protocol-proposal');
    const chosen = artifacts[artifacts.length - 1];
    if (chosen) {
      const proposal = JSON.parse(await runtime.store.readFinalText(chosen.contentHash)) as {
        protocolId?: unknown;
        primaryMetrics?: { name?: unknown; direction?: unknown }[];
      };
      const primaryMetrics = (proposal.primaryMetrics ?? [])
        .filter(
          (m): m is { name: string; direction: 'higher' | 'lower' } =>
            typeof m.name === 'string' && (m.direction === 'higher' || m.direction === 'lower'),
        )
        .map((m) => ({ name: m.name, direction: m.direction }));
      protocol =
        typeof proposal.protocolId === 'string' && primaryMetrics.length > 0
          ? { protocolId: proposal.protocolId, primaryMetrics }
          : null;
    }
  } catch {
    // no protocol yet — the plan is unconstrained by primary metrics
  }

  const comparisons = await runtime.db.listComparisons({});
  const slices = await runtime.db.listSlices();

  return {
    ideaId,
    ideaVersion: meta.currentVersion,
    question: runtime.config.research.question,
    hypothesis: {
      statement: card.hypothesis.statement,
      targetProblem: card.hypothesis.targetProblem,
    },
    nearestComparisons: card.nearestComparisons.map((item) => ({
      methodId: item.methodId,
      difference: item.difference,
    })),
    comparisonStatuses: comparisons.map((method) => ({
      methodId: method.methodId,
      status: method.status,
      required: method.required,
    })),
    minimalExperiment: {
      code: card.minimalExperiment.code,
      data: card.minimalExperiment.data,
      baselines: [...card.minimalExperiment.baselines],
      metrics: [...card.minimalExperiment.metrics],
      ablations: [...card.minimalExperiment.ablations],
    },
    budget: { maxRounds: card.budget.maxRounds, maxGpuMinutes: card.budget.maxGpuMinutes },
    protocol,
    dataScales: {
      registered: [...new Set(slices.map((slice) => slice.scale))].sort(),
      default: runtime.config.runtime.defaultDataScale,
    },
  };
}

/** Content identity of a plan request: same inputs ⇒ same inputHash. */
export function computePlanInputHash(context: PlanIdeaContext, skill: LoadedArisSkill): string {
  return sha256Of(
    stableJson({
      contract: EXPERIMENT_PLAN_SCHEMA,
      skillSha256: skill.sha256,
      context,
    }),
  );
}

/** Output contract appended after the ARIS skill body (the thin wrapper). */
export const PLAN_OUTPUT_CONTRACT = `
# IdeaSeek output contract (${EXPERIMENT_PLAN_SCHEMA})

You are running inside IdeaSeek. Reply with ONE JSON object and nothing else:

{"problem": str, "thesis": str,
 "claims": [{"claimId", "statement", "linkedBlocks": [blockId, ...]}, ...],
 "blocks": [{"blockId", "name", "claimTested", "priority", "scale", "dataScale",
             "metrics": [{"name", "direction": "higher" | "lower"}],
             "successCriterion", "failureInterpretation"}, ...],
 "runOrder": [blockId, ...],
 "seeds": [int, ...],
 "budgetMinutes": int,
 "risks": [{"risk", "mitigation"}, ...]}

Rules (IdeaSeek hard guards — violating any makes the plan invalid):
- "claims": 1–2 entries (ARIS MAX_PRIMARY_CLAIMS); every linkedBlocks id
  must exist in "blocks".
- "blocks": 1–5 entries (ARIS MAX_CORE_BLOCKS), unique kebab-case blockId;
  at least one "priority": "MUST-RUN"; every claimTested names a claim.
- "scale" is the bounded RUN scale: "smoke" | "quick" only — never full
  training (full runs are delivered via handoff, not executed here).
- "dataScale" is the dataset slice tier: "smoke" | "quick" | "standard"
  (IdeaSeek's data-scale vocabulary; use the context's registered scales).
- "runOrder" lists every block id exactly once and includes ALL MUST-RUN
  blocks; the first MUST-RUN entry is the anchor run.
- "seeds": non-empty list of integers (ARIS DEFAULT_SEEDS = 3 when the
  budget allows).
- "budgetMinutes": positive int and NEVER above the context's
  budget.maxGpuMinutes (the IdeaCard ceiling — the plan cannot inflate it).
- "metrics" across MUST-RUN blocks must include every protocol primary
  metric from the context (the 主指标 may not change silently).
- successCriterion / failureInterpretation: non-empty for every block.
- No prose, no markdown fence, no commentary outside the JSON object.
`.trim();

export interface PlanRequest {
  instruction: string;
  inputHash: string;
  idempotencyKey: string;
}

/** Assembles the harness request: ARIS skill body + IdeaSeek contract. */
export function buildPlanRequest(context: PlanIdeaContext, skill: LoadedArisSkill): PlanRequest {
  const inputHash = computePlanInputHash(context, skill);
  const contextJson = JSON.stringify(context, null, 2);
  const instruction = [
    renderArisSkill(skill, {
      arguments: `idea ${context.ideaId}: ${context.hypothesis.statement}`,
    }),
    '',
    '---',
    '',
    PLAN_OUTPUT_CONTRACT,
    '',
    'Idea context (ground the plan in these facts; never invent beyond them):',
    contextJson,
  ].join('\n');
  return {
    instruction,
    inputHash,
    idempotencyKey: `experiment-plan:${inputHash.slice(7, 31)}`,
  };
}

function fail(errors: string[]): never {
  throw new IdeaseekError(
    'INVALID_ARGUMENT',
    `experiment plan invalid: ${errors.slice(0, 5).join('; ')}`,
  );
}

/**
 * Parses and structurally validates the harness output against the idea
 * context (budget ceiling, scale vocabulary, primary metrics, run order).
 * Non-JSON is PARSE_FAILED; contract violations are INVALID_ARGUMENT — both
 * are permanent task failures (nothing is written).
 */
export function parseExperimentPlan(output: string, context: PlanIdeaContext): ExperimentPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `experiment planner returned non-JSON output: ${output.slice(0, 160)}`,
    );
  }
  if (!isObject(parsed)) fail(['plan must be a JSON object']);

  const errors: string[] = [];
  const str = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0;

  if (!str(parsed.problem)) errors.push('problem must be a non-empty string');
  if (!str(parsed.thesis)) errors.push('thesis must be a non-empty string');

  // --- claims (1..2, ARIS MAX_PRIMARY_CLAIMS).
  const claims: PlanClaim[] = [];
  if (!Array.isArray(parsed.claims) || parsed.claims.length < 1 || parsed.claims.length > 2) {
    errors.push('claims must contain 1–2 entries (MAX_PRIMARY_CLAIMS)');
  } else {
    for (const [i, raw] of parsed.claims.entries()) {
      if (!isObject(raw)) {
        errors.push(`claims[${i}] must be an object`);
        continue;
      }
      if (!str(raw.claimId)) errors.push(`claims[${i}].claimId must be a non-empty string`);
      if (!str(raw.statement)) errors.push(`claims[${i}].statement must be a non-empty string`);
      if (
        !Array.isArray(raw.linkedBlocks) ||
        raw.linkedBlocks.length === 0 ||
        raw.linkedBlocks.some((id) => !str(id))
      ) {
        errors.push(`claims[${i}].linkedBlocks must be a non-empty string array`);
        continue;
      }
      claims.push({
        claimId: String(raw.claimId ?? ''),
        statement: String(raw.statement ?? ''),
        linkedBlocks: raw.linkedBlocks.map(String),
      });
    }
  }

  // --- blocks (1..5, ARIS MAX_CORE_BLOCKS).
  const blocks: PlanBlock[] = [];
  const seenIds = new Set<string>();
  if (!Array.isArray(parsed.blocks) || parsed.blocks.length < 1 || parsed.blocks.length > 5) {
    errors.push('blocks must contain 1–5 entries (MAX_CORE_BLOCKS)');
  } else {
    for (const [i, raw] of parsed.blocks.entries()) {
      if (!isObject(raw)) {
        errors.push(`blocks[${i}] must be an object`);
        continue;
      }
      const blockId = typeof raw.blockId === 'string' ? raw.blockId : '';
      if (!/^[a-z0-9][a-z0-9-]*$/.test(blockId)) {
        errors.push(`blocks[${i}].blockId must be kebab-case`);
      } else if (seenIds.has(blockId)) {
        errors.push(`duplicate blockId: ${blockId}`);
      } else {
        seenIds.add(blockId);
      }
      if (!str(raw.name)) errors.push(`blocks[${i}].name must be a non-empty string`);
      if (!str(raw.claimTested)) errors.push(`blocks[${i}].claimTested must be a non-empty string`);
      if (raw.priority !== 'MUST-RUN' && raw.priority !== 'NICE-TO-HAVE') {
        errors.push(`blocks[${i}].priority must be MUST-RUN | NICE-TO-HAVE`);
      }
      if (raw.scale !== 'smoke' && raw.scale !== 'quick') {
        errors.push(`blocks[${i}].scale must be smoke | quick (full training runs via handoff)`);
      }
      if (raw.dataScale !== 'smoke' && raw.dataScale !== 'quick' && raw.dataScale !== 'standard') {
        errors.push(
          `blocks[${i}].dataScale must be smoke | quick | standard (IdeaSeek data scales)`,
        );
      }
      const metrics: PlanMetric[] = [];
      if (!Array.isArray(raw.metrics) || raw.metrics.length === 0) {
        errors.push(`blocks[${i}].metrics must be a non-empty array`);
      } else {
        for (const [j, m] of raw.metrics.entries()) {
          if (
            !isObject(m) ||
            !str(m.name) ||
            (m.direction !== 'higher' && m.direction !== 'lower')
          ) {
            errors.push(`blocks[${i}].metrics[${j}] needs name + direction higher|lower`);
            continue;
          }
          metrics.push({ name: String(m.name), direction: m.direction });
        }
      }
      if (!str(raw.successCriterion)) {
        errors.push(`blocks[${i}].successCriterion must be a non-empty string`);
      }
      if (!str(raw.failureInterpretation)) {
        errors.push(`blocks[${i}].failureInterpretation must be a non-empty string`);
      }
      blocks.push({
        blockId,
        name: String(raw.name ?? ''),
        claimTested: String(raw.claimTested ?? ''),
        priority: raw.priority as PlanBlock['priority'],
        scale: raw.scale as PlanRunScale,
        dataScale: raw.dataScale as PlanDataScale,
        metrics,
        successCriterion: String(raw.successCriterion ?? ''),
        failureInterpretation: String(raw.failureInterpretation ?? ''),
      });
    }
  }

  // --- run order covers every MUST-RUN block exactly once.
  const runOrder: string[] = [];
  if (!Array.isArray(parsed.runOrder) || parsed.runOrder.length === 0) {
    errors.push('runOrder must be a non-empty array');
  } else {
    const orderSeen = new Set<string>();
    for (const id of parsed.runOrder) {
      if (!str(id)) {
        errors.push('runOrder entries must be non-empty strings');
        continue;
      }
      if (!seenIds.has(id)) errors.push(`runOrder references unknown block: ${id}`);
      if (orderSeen.has(id)) errors.push(`duplicate runOrder entry: ${id}`);
      orderSeen.add(id);
      runOrder.push(id);
    }
    for (const block of blocks) {
      if (block.priority === 'MUST-RUN' && !orderSeen.has(block.blockId)) {
        errors.push(`MUST-RUN block missing from runOrder: ${block.blockId}`);
      }
    }
  }

  // --- claims link to real blocks.
  for (const claim of claims) {
    for (const id of claim.linkedBlocks) {
      if (seenIds.size > 0 && !seenIds.has(id)) {
        errors.push(`claim ${claim.claimId} links unknown block: ${id}`);
      }
    }
  }

  // --- seeds: non-empty integers (executed as the spec's seeds).
  const seeds: number[] = [];
  if (
    !Array.isArray(parsed.seeds) ||
    parsed.seeds.length === 0 ||
    parsed.seeds.some((s) => typeof s !== 'number' || !Number.isInteger(s))
  ) {
    errors.push('seeds must be a non-empty array of integers');
  } else {
    seeds.push(...(parsed.seeds as number[]));
  }

  // --- budget ceiling: the plan cannot inflate the IdeaCard budget.
  const budgetMinutes = parsed.budgetMinutes;
  if (typeof budgetMinutes !== 'number' || !Number.isFinite(budgetMinutes) || budgetMinutes <= 0) {
    errors.push('budgetMinutes must be a positive number');
  } else if (budgetMinutes > context.budget.maxGpuMinutes) {
    errors.push(
      `budgetMinutes ${budgetMinutes} exceeds the idea card ceiling ${context.budget.maxGpuMinutes} min ` +
        '(the plan cannot inflate the IdeaCard budget)',
    );
  }

  // --- risks: array of {risk, mitigation} (empty allowed).
  const risks: { risk: string; mitigation: string }[] = [];
  if (!Array.isArray(parsed.risks)) {
    errors.push('risks must be an array');
  } else {
    for (const [i, raw] of parsed.risks.entries()) {
      if (!isObject(raw) || !str(raw.risk) || !str(raw.mitigation)) {
        errors.push(`risks[${i}] needs non-empty risk + mitigation`);
        continue;
      }
      risks.push({ risk: String(raw.risk), mitigation: String(raw.mitigation) });
    }
  }

  // --- protocol primary metrics must be planned (主指标 cannot silently go missing).
  if (context.protocol && errors.length === 0) {
    const planned = new Set(
      blocks
        .filter((block) => block.priority === 'MUST-RUN')
        .flatMap((block) => block.metrics.map((m) => m.name)),
    );
    for (const primary of context.protocol.primaryMetrics) {
      if (!planned.has(primary.name)) {
        errors.push(`protocol primary metric not planned in any MUST-RUN block: ${primary.name}`);
      }
    }
  }

  if (errors.length > 0) fail(errors);
  return {
    problem: String(parsed.problem),
    thesis: String(parsed.thesis),
    claims,
    blocks,
    runOrder,
    seeds,
    budgetMinutes: Number(budgetMinutes),
    risks,
  };
}

/** Anchor scale: the first MUST-RUN block in run order (else first block). */
export function planPrimaryScale(plan: ExperimentPlan): PlanRunScale {
  const byId = new Map(plan.blocks.map((block) => [block.blockId, block]));
  for (const id of plan.runOrder) {
    const block = byId.get(id);
    if (block && block.priority === 'MUST-RUN') return block.scale;
  }
  const first = byId.get(plan.runOrder[0] ?? '') ?? plan.blocks[0];
  return first?.scale ?? 'smoke';
}

/** Loads the latest stored plan for an idea (optionally of a given input). */
export async function loadStoredPlan(
  runtime: PlanStoreRuntime,
  ideaId: string,
  opts: { inputHash?: string } = {},
): Promise<StoredPlan | null> {
  const artifacts = await runtime.db.listArtifactsByKind('experiment-plan');
  for (let i = artifacts.length - 1; i >= 0; i -= 1) {
    const artifact = artifacts[i]!;
    if (artifact.meta?.ideaId !== ideaId) continue;
    try {
      const stored = JSON.parse(
        await runtime.store.readFinalText(artifact.contentHash),
      ) as StoredPlan;
      if (stored.contract !== EXPERIMENT_PLAN_SCHEMA || stored.ideaId !== ideaId) continue;
      if (opts.inputHash && stored.inputHash !== opts.inputHash) continue;
      return stored;
    } catch {
      continue; // unreadable artifact counts as absent (regenerate)
    }
  }
  return null;
}

/**
 * Plan-provided seeds for the spec build, or null when no current plan
 * exists (stale idea versions fall back to config seeds — a revised idea
 * must re-plan before the plan's seeds apply again).
 */
export async function loadPlanSeeds(
  runtime: PlanStoreRuntime,
  ideaId: string,
  ideaVersion: number,
): Promise<number[] | null> {
  const stored = await loadStoredPlan(runtime, ideaId);
  if (!stored || stored.ideaVersion !== ideaVersion) return null;
  const seeds = stored.plan?.seeds;
  if (!Array.isArray(seeds) || seeds.length === 0) return null;
  return seeds.filter((s): s is number => typeof s === 'number' && Number.isInteger(s));
}
