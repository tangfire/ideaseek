import { IdeaseekError } from '../core/errors.js';
import type { TaskContext, TaskHandler } from './types.js';
import { applyFaults } from './handlers.js';

/**
 * `comparison.plan` workflow task: the Comparison Planner agent stage —
 * renders the bounded planning context (research questions, literature,
 * venue/subfield, benchmark evidence) through the harness and validates
 * the proposal against it (no invented citations, no unknown methods).
 * The artifact feeds `comparison matrix` as the reviewed default; the
 * user's `--confirm` remains the only thing that touches the registry.
 */

export const comparisonPlan: TaskHandler = async (ctx: TaskContext) => {
  await applyFaults(ctx);
  const harness = ctx.runtime.harness;
  if (!harness) {
    const error = new IdeaseekError(
      'INVALID_STATE',
      'no harness adapter configured for comparison.plan',
    );
    (error as IdeaseekError & { permanent?: boolean }).permanent = true;
    throw error;
  }

  const {
    buildPlannerContext,
    plannerContextHash,
    validateMatrixProposal,
    PLANNER_PROMPT_VERSION,
    MATRIX_PROPOSAL_SCHEMA,
  } = await import('../comparison/planner.js');

  const context = await buildPlannerContext(ctx.runtime.paths.root);
  if (context.candidates.length === 0) {
    const error = new IdeaseekError(
      'USER_INPUT_REQUIRED',
      'comparison planner has no candidates — register a method or create idea cards first',
    );
    (error as IdeaseekError & { permanent?: boolean }).permanent = true;
    throw error;
  }
  const contextHash = plannerContextHash(context);

  // Idempotent reuse: same context → same proposal bytes.
  let output: string | null = null;
  let reused = false;
  for (const artifact of await ctx.runtime.db.listArtifactsByKind('comparison-matrix-proposal')) {
    if (artifact.meta.contextHash === contextHash) {
      try {
        output = await ctx.runtime.store.readFinalText(artifact.contentHash);
        reused = true;
        break;
      } catch {
        continue;
      }
    }
  }

  if (!output) {
    const instruction =
      `You are the Comparison Planner. Classify EVERY candidate method as required, ` +
      `reference-only, excluded or blocked for the full-run comparison list. ` +
      `Cite ONLY source ids from the provided literature context (invented citations are rejected). ` +
      `Use the research questions, venue/subfield and benchmark evidence as planning context ` +
      `(venue is context, never an acceptance promise). Recent literature matters when years are present. ` +
      `Output JSON: {"contract":"${MATRIX_PROPOSAL_SCHEMA}","entries":[{"methodId":str,` +
      `"classification":"required|reference-only|excluded|blocked","rationale":str,` +
      `"sources":[str],"relevanceNote":str?}],"notes":[str?]}`;
    await harness.initialize();
    const result = await harness.runTask(
      {
        runId: ctx.run.runId,
        taskId: ctx.task.taskId,
        profile: 'synthesis-analyst',
        instruction,
        inputs: [{ kind: 'text', name: 'planner-context', content: JSON.stringify(context) }],
        outputSchema: MATRIX_PROPOSAL_SCHEMA,
        budget: { timeoutMs: 180_000, maxOutputTokens: 8192 },
        idempotencyKey: `comparison-plan:${ctx.run.runId}:${ctx.task.taskId}`,
      },
      (event) => ctx.log(event.summary),
      ctx.signal,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.output);
    } catch {
      throw new Error('comparison matrix proposal output was not valid JSON');
    }
    const validation = validateMatrixProposal(parsed, context);
    if (!validation.ok) {
      throw new Error(
        `comparison matrix proposal invalid: ${validation.errors.slice(0, 5).join('; ')}`,
      );
    }
    output = `${JSON.stringify(
      {
        ...validation.proposal,
        generator: PLANNER_PROMPT_VERSION,
        contextHash,
        generatedAt: ctx.runtime.clock.now(),
      },
      null,
      2,
    )}\n`;
  }

  return {
    artifacts: [
      {
        kind: 'comparison-matrix-proposal',
        data: output,
        meta: { contextHash, reused, generator: PLANNER_PROMPT_VERSION },
      },
    ],
    summary: reused
      ? `comparison plan: proposal reused for context ${contextHash.slice(7, 19)}`
      : `comparison plan: ${JSON.parse(output).entries?.length ?? '?'} classified for context ${contextHash.slice(7, 19)}`,
    data: { contextHash, reused, candidateCount: context.candidates.length },
  };
};
