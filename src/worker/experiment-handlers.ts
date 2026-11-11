import { IdeaseekError } from '../core/errors.js';
import { loadArisSkill } from '../aris/skill.js';
import {
  EXPERIMENT_PLAN_SCHEMA,
  buildPlanContext,
  buildPlanRequest,
  parseExperimentPlan,
  planPrimaryScale,
  type StoredPlan,
} from '../experiment/plan.js';
import type { TaskContext, TaskHandler } from './types.js';
import { applyFaults } from './handlers.js';

/**
 * `experiment.plan` workflow task: the ARIS `experiment-plan` skill rendered
 * through the IdeaSeek harness produces an `experiment-plan-v1` document that
 * is validated against IdeaSeek guards (budget ceiling, smoke/quick run
 * scales, smoke/quick/standard data scales, protocol primary metrics), then
 * mapped onto a planned ExperimentSpec in the unified registry. The plan is
 * committed as a content-addressed Artifact; quota/auth/network park the run
 * without burning an attempt (docs/WORKFLOW_SPEC §QUOTA_EXHAUSTED).
 */

/** Codes that must not retry (a retry cannot fix them). */
const PERMANENT_CODES = new Set([
  'PARSE_FAILED',
  'INVALID_ARGUMENT',
  'FILE_NOT_FOUND',
  'USER_INPUT_REQUIRED',
  'INVALID_STATE',
  'SKILL_NOT_FOUND',
  'SKILL_TAMPERED',
  'SKILL_INVALID',
]);

function permanentize(error: unknown): unknown {
  if (error instanceof IdeaseekError && PERMANENT_CODES.has(error.code)) {
    (error as IdeaseekError & { permanent?: boolean }).permanent = true;
  }
  return error;
}

export const experimentPlan: TaskHandler = async (ctx: TaskContext) => {
  await applyFaults(ctx);
  try {
    return await runPlan(ctx);
  } catch (error) {
    throw permanentize(error);
  }
};

async function runPlan(ctx: TaskContext): Promise<{
  artifacts: { kind: string; data: string; meta?: Record<string, unknown> }[];
  summary: string;
  data: Record<string, unknown>;
}> {
  const harness = ctx.runtime.harness;
  if (!harness) {
    throw new IdeaseekError('INVALID_STATE', 'no harness adapter configured for experiment.plan');
  }
  const ideaId = ctx.payload.ideaId;
  if (typeof ideaId !== 'string' || !ideaId.trim()) {
    throw new IdeaseekError('INVALID_ARGUMENT', 'experiment.plan payload needs an ideaId');
  }
  const projectRoot = ctx.runtime.paths.root;

  const context = await buildPlanContext(projectRoot, ctx.runtime, ideaId);
  const skill = await loadArisSkill('experiment-plan');
  const request = buildPlanRequest(context, skill);

  // Idempotent reuse: identical inputs already have a committed plan. The
  // bytes are returned unchanged so the content-addressed store dedupes.
  const { loadStoredPlan } = await import('../experiment/plan.js');
  const prior = await loadStoredPlan(ctx.runtime, ideaId, { inputHash: request.inputHash });
  if (prior) {
    return {
      artifacts: [
        {
          kind: 'experiment-plan',
          data: `${JSON.stringify(prior, null, 2)}\n`,
          meta: planMeta(prior, request.inputHash, true),
        },
      ],
      summary: `experiment plan unchanged for ${ideaId} (input identical)`,
      data: {
        ideaId,
        inputHash: request.inputHash,
        reused: true,
        scale: prior.spec.scale,
        specId: prior.spec.specId,
      },
    };
  }

  await harness.initialize();
  const result = await harness.runTask(
    {
      runId: ctx.run.runId,
      taskId: ctx.task.taskId,
      profile: 'experiment-designer',
      instruction: request.instruction,
      inputs: [{ kind: 'text', name: 'idea-context', content: JSON.stringify(context, null, 2) }],
      outputSchema: EXPERIMENT_PLAN_SCHEMA,
      budget: { timeoutMs: 180_000, maxOutputTokens: 8_192 },
      idempotencyKey: `${request.idempotencyKey}:${ctx.task.taskId}`,
    },
    (event) => ctx.log(event.summary),
    ctx.signal,
  );

  const plan = parseExperimentPlan(result.output, context);
  const scale = planPrimaryScale(plan);

  // Map the plan onto the unified registry: the EXACT spec execution will
  // later rebuild (same builder, plan seeds applied) so the bridge attaches
  // its RunResult to this version without hash churn.
  const { buildIdeaSpec, prepareSpecRecording, recordPlannedSpec } =
    await import('../idea/experiment.js');
  const { spec: baseSpec } = await buildIdeaSpec(projectRoot, ideaId, {
    scale,
    runtime: ctx.runtime,
    planSeeds: plan.seeds,
  });
  const existing = await ctx.runtime.db.getExperiment(baseSpec.specId);
  const prepared = await prepareSpecRecording(baseSpec, existing);

  // Refuse to silently discard a same-version result: a changed plan over a
  // finished run must walk through idea revision, not overwrite history.
  const existingIdeaVersion = (existing?.spec as { idea?: { version?: unknown } } | null)?.idea
    ?.version;
  if (
    existing?.result &&
    existingIdeaVersion === context.ideaVersion &&
    prepared.nextVersion !== existing.version
  ) {
    throw new IdeaseekError(
      'INVALID_STATE',
      `idea ${ideaId} already has recorded results at v${context.ideaVersion} — a changed plan ` +
        'must walk through revision first: ideaseek idea set-status ' +
        `${ideaId} NEEDS_REVISION --reason "..." → IMPLEMENTING → check → re-plan`,
    );
  }
  await recordPlannedSpec(ctx.runtime.db, prepared, existing);

  const stored: StoredPlan = {
    contract: EXPERIMENT_PLAN_SCHEMA,
    ideaId,
    ideaVersion: context.ideaVersion,
    inputHash: request.inputHash,
    skill: { name: skill.name, sha256: skill.sha256 },
    generatedAt: ctx.runtime.clock.now(),
    reused: false,
    plan,
    spec: {
      specId: prepared.spec.specId,
      specHash: prepared.specHash,
      version: prepared.nextVersion,
      scale,
    },
  };

  const mustRun = plan.blocks.filter((block) => block.priority === 'MUST-RUN').length;
  return {
    artifacts: [
      {
        kind: 'experiment-plan',
        data: `${JSON.stringify(stored, null, 2)}\n`,
        meta: planMeta(stored, request.inputHash, false),
      },
    ],
    summary:
      `planned ${ideaId} v${context.ideaVersion}: ${plan.blocks.length} block(s) ` +
      `(${mustRun} must-run) scale=${scale} seeds=${plan.seeds.join(',')}`,
    data: {
      ideaId,
      inputHash: request.inputHash,
      reused: false,
      scale,
      mustRun,
      blocks: plan.blocks.length,
      specId: stored.spec.specId,
      specVersion: stored.spec.version,
    },
  };
}

function planMeta(stored: StoredPlan, inputHash: string, reused: boolean): Record<string, unknown> {
  return {
    filename: `experiment-plan-${stored.ideaId}.json`,
    inputHash,
    ideaId: stored.ideaId,
    ideaVersion: stored.ideaVersion,
    specId: stored.spec.specId,
    specHash: stored.spec.specHash,
    scale: stored.spec.scale,
    skill: stored.skill.name,
    reused,
  };
}
