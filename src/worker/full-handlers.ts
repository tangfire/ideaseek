import { IdeaseekError } from '../core/errors.js';
import type { TaskContext, TaskHandler } from './types.js';
import type { ExperimentSpec } from '../experiment/spec.js';
import { applyFaults } from './handlers.js';

/**
 * `full.run` workflow task (docs/FULL_RESEARCH_MODE.md 全量实验): executes
 * the approved full-scale work list — every required comparison plus the
 * final idea — through the SAME spec/runner/registry primitives as every
 * other experiment (prepareSpecRecording → executeSpecRun →
 * attachSpecResult), on the existing ResearchRun worker (FaultSpec,
 * quota/network blocking, pause signal, attempts/leases). No second
 * queue, database or runner.
 *
 * Safety: the approved plan's inputHash is re-verified inside the
 * handler — state that moved after enqueue fails loud instead of running
 * a stale authorization. Already-succeeded items with an unchanged spec
 * hash are skipped (idempotent recovery after pause/crash/retry).
 */
export const fullRun: TaskHandler = async (ctx: TaskContext) => {
  await applyFaults(ctx); // fault injection: crash/fail/quota/network (tests + --fault)
  return runFull(ctx);
};

interface FullRunItemResult {
  kind: 'comparison' | 'idea';
  id: string;
  specId: string;
  status: 'succeeded' | 'skipped';
  metrics: { name: string; value: number }[];
}

async function runFull(ctx: TaskContext): Promise<{
  artifacts: { kind: string; data: string; meta?: Record<string, unknown> }[];
  summary: string;
  data: Record<string, unknown>;
}> {
  const ideaId = ctx.payload.ideaId;
  const planInputHash = ctx.payload.planInputHash;
  if (typeof ideaId !== 'string' || !ideaId.trim()) {
    throw new IdeaseekError('INVALID_ARGUMENT', 'full.run payload needs an ideaId');
  }
  if (typeof planInputHash !== 'string' || !planInputHash.startsWith('sha256:')) {
    throw new IdeaseekError('INVALID_ARGUMENT', 'full.run payload needs a planInputHash');
  }
  const root = ctx.runtime.paths.root;
  const runtime = ctx.runtime;
  ctx.log(`full.run start idea=${ideaId} plan=${planInputHash.slice(0, 19)}`);

  // Re-verify authorization at execution time (state may have moved
  // between enqueue and this attempt — a stale approval never runs).
  const { authorizeFullRun, buildFullComparisonSpec } = await import('../full/run.js');
  const auth = await authorizeFullRun(root, ideaId);
  ctx.log(`authorize ok (${auth.work.length} items)`);
  if (auth.planInputHash !== planInputHash) {
    throw new IdeaseekError(
      'INVALID_STATE',
      `full-run plan changed since this task was enqueued — rerun: ideaseek full run --idea ${ideaId} --confirm (stale authorization never executes)`,
    );
  }

  // GPU admission over the idea's declared resources (same planner the
  // exploration queue uses — no second scheduler).
  const { probeCapacity, computeAdmission } = await import('../runtime/capacity.js');
  const { ideaResourceRequest } = await import('../idea/experiment.js');
  const probe = await probeCapacity(root);
  const request = await ideaResourceRequest(root, ideaId);
  ctx.log(`admission request gpus=${request.gpus} mem=${request.memoryGiB}GiB`);
  const admission = computeAdmission(probe, [{ ...request, createdAt: Date.now() }], {
    maxParallelIdeas: 1,
  });
  if (admission.admitted.length === 0) {
    throw new IdeaseekError(
      'DEPENDENCY_NOT_MET',
      `insufficient capacity for full-run (need ${request.gpus} GPU / ${request.memoryGiB} GiB as declared) — free capacity or run on the target machine, then: ideaseek full run --idea ${ideaId} --confirm`,
    );
  }

  const items: FullRunItemResult[] = [];
  for (const item of auth.work) {
    // Cooperative cancellation: hard-pause/cancel aborts between items
    // (the lease/heartbeat machinery owns mid-command interruption).
    if (ctx.signal.aborted) {
      throw new IdeaseekError('TASK_CANCELED', 'full-run canceled between work items');
    }

    let spec: ExperimentSpec;
    let cwd: string | undefined;
    ctx.log(`item ${item.kind}:${item.id}`);
    if (item.kind === 'comparison') {
      spec = await buildFullComparisonSpec(root, ideaId, item.id);
      cwd = `${root}/comparisons/${item.id}/worktree`.replace(/\\/g, '/');
    } else {
      const { buildIdeaSpec } = await import('../idea/experiment.js');
      const built = await buildIdeaSpec(root, ideaId, { scale: 'full', runtime });
      spec = built.spec;
    }
    ctx.log(`spec built ${spec.specId} (${spec.command.join(' ')})`);

    // Record the planned spec in the unified registry (same helper the
    // exploration path uses — version/hash discipline included).
    const { prepareSpecRecording, recordPlannedSpec, executeSpecRun, attachSpecResult } =
      await import('../idea/experiment.js');
    const existing = await runtime.db.getExperiment(item.specId);
    const prepared = await prepareSpecRecording(spec, existing);

    // Idempotent recovery: an unchanged, already-succeeded item is
    // skipped (pause → resume, crashed attempt, retried task).
    if (prepared.alreadyRecorded && existing?.result) {
      const storedMetrics = (
        (existing.result as { metrics?: { name: unknown; value: unknown }[] }).metrics ?? []
      ).filter((m): m is { name: string; value: number } => typeof m.value === 'number');
      items.push({ ...item, status: 'skipped', metrics: storedMetrics });
      ctx.log(`skip ${item.specId} (already succeeded, spec unchanged)`);
      continue;
    }

    await recordPlannedSpec(runtime.db, prepared, existing);

    const exec = await executeSpecRun(
      root,
      `full-${item.id}`,
      prepared.spec,
      // Long-task bound: full runs honor run-level pause/cancel at item
      // boundaries; the per-command timeout stays generous but finite.
      6 * 60 * 60 * 1000,
      { cwd },
    );
    const result = await attachSpecResult(
      runtime.db,
      prepared.spec,
      exec,
      `full-run ${item.kind} ${item.id} plan ${planInputHash.slice(7, 19)}`,
    );
    if (result.status !== 'succeeded') {
      // Fail loud with recovery — the RunResult is already attached for
      // analysis/audit; succeeded items above stay recorded.
      throw new IdeaseekError(
        'DEPENDENCY_NOT_MET',
        `full-run item ${item.specId} failed: ${result.failure?.summary ?? 'unknown'} — ` +
          `fix the method/idea, then rerun: ideaseek full run --idea ${ideaId} --confirm (succeeded items are skipped)`,
      );
    }
    items.push({ ...item, status: 'succeeded', metrics: result.metrics });
    ctx.log(
      `succeeded ${item.specId}` +
        (result.metrics.length > 0
          ? ` (${result.metrics.map((m) => `${m.name}=${m.value}`).join(', ')})`
          : ''),
    );
  }

  const report = {
    contract: 'full-run-report-v1',
    ideaId,
    planInputHash,
    finishedAt: Date.now(),
    items,
  };
  return {
    artifacts: [
      {
        kind: 'full-run-report',
        data: `${JSON.stringify(report, null, 2)}\n`,
        meta: { ideaId, planInputHash },
      },
    ],
    summary:
      `full-run ${ideaId}: ${items.filter((i) => i.status === 'succeeded').length} succeeded, ` +
      `${items.filter((i) => i.status === 'skipped').length} skipped (${items.length} total)`,
    data: report as unknown as Record<string, unknown>,
  };
}
