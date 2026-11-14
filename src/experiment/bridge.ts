import { IdeaseekError } from '../core/errors.js';
import { type ComparisonGateResult } from '../comparison/gate.js';
import { evaluateComparisonGateForProject } from '../comparison/worktree-stamp.js';
import {
  ideaResourceRequest,
  runIdeaExperiment,
  type IdeaExperimentOutcome,
  type IdeaScale,
} from '../idea/experiment.js';
import { loadWorkspaceMeta } from '../idea/workspace.js';
import {
  computeAdmission,
  probeCapacity,
  type AdmissionPlan,
  type CapacityProbe,
} from '../runtime/capacity.js';
import type { WorkflowDb } from '../workflow/db.js';
import { loadStoredPlan, type StoredPlan } from './plan.js';

/**
 * ARIS `experiment-bridge` mapping (Phase 4.5 capability 2): the bridge
 * workflow — parse plan → deploy → collect — is realized as plan-gated
 * execution through IdeaSeek's OWN runner (docs/ARIS_AUDIT: ARIS has no
 * lease/admission/checkpoint semantics, so execution/queue/RunResult stay
 * IdeaSeek). What this module adds on top of `idea experiment`:
 * a current-plan requirement, the required-comparison gate, capacity
 * admission through the GPU Capacity Planner, and an `experiment_bridge`
 * RunEvent binding plan → spec → result.
 */

export interface BridgeOptions {
  timeoutMs: number;
  /** Resume from the last compatible training checkpoint (task-level refuses). */
  resume?: boolean;
  /** Test seam: inject a capacity probe instead of probing the live host. */
  probeOverride?: CapacityProbe;
}

export interface BridgeResult {
  ideaId: string;
  plan: {
    inputHash: string;
    ideaVersion: number;
    scale: PlanScale;
    specId: string;
    specVersion: number;
  };
  gate: { ok: boolean; blocking: { methodId: string; status: string; hint: string }[] };
  /** False ⇒ queued by the capacity planner (nothing executed). */
  admitted: boolean;
  queuedReason: string | null;
  constraints: string[];
  outcome: IdeaExperimentOutcome | null;
  eventSeq: number | null;
}

type PlanScale = Extract<IdeaScale, 'smoke' | 'quick'>;

/** ProjectRuntime surface the bridge needs (structurally satisfied). */
export interface BridgeRuntime {
  db: Pick<
    WorkflowDb,
    | 'listArtifactsByKind'
    | 'listComparisons'
    | 'listExperiments'
    | 'getExperiment'
    | 'upsertExperiment'
    | 'attachExperimentResult'
    | 'getLatestRun'
    | 'appendEvent'
  >;
  store: { readFinalText(hash: string): Promise<string> };
  project: { id: string };
  config: { resources: { maxParallelIdeas: number } };
}

/**
 * Plan → gate → capacity admission → execute → RunEvent. Throws
 * DEPENDENCY_NOT_MET when no current plan exists and USER_INPUT_REQUIRED
 * when the required-comparison gate blocks (exit 2, nothing executed).
 */
export async function runExperimentBridge(
  projectRoot: string,
  ideaId: string,
  opts: BridgeOptions,
  runtime: BridgeRuntime,
): Promise<BridgeResult> {
  // 1. The bridge never plans for itself: a CURRENT plan is mandatory.
  const meta = await loadWorkspaceMeta(projectRoot, ideaId);
  const stored: StoredPlan | null = await loadStoredPlan(runtime, ideaId);
  if (!stored || stored.ideaVersion !== meta.currentVersion) {
    throw new IdeaseekError(
      'DEPENDENCY_NOT_MET',
      `idea ${ideaId} has no current experiment plan — run: ideaseek experiment plan ${ideaId}` +
        (stored ? ' (the plan is stale after a revision)' : ''),
    );
  }
  const scale = stored.spec.scale;
  if (scale !== 'smoke' && scale !== 'quick') {
    throw new IdeaseekError(
      'INVALID_STATE',
      `plan scale "${String(scale)}" is not executable (smoke | quick only — full runs go through handoff)`,
    );
  }

  // 2. Required-comparison gate: the skill path cannot bypass it.
  const gate: ComparisonGateResult = await evaluateComparisonGateForProject(
    projectRoot,
    runtime.db,
  );
  if (!gate.ok) {
    const detail = gate.blocking
      .map((entry) => `${entry.methodId} (${entry.status}) — ${entry.hint}`)
      .join('; ');
    throw new IdeaseekError(
      'USER_INPUT_REQUIRED',
      `comparison gate blocks experiment bridge for ${ideaId}: ${detail}`,
      { blocking: gate.blocking },
    );
  }

  // 3. Capacity admission (GPU Capacity Planner — never over-assign).
  const probe = opts.probeOverride ?? (await probeCapacity(projectRoot));
  const request = await ideaResourceRequest(projectRoot, ideaId);
  const admission: AdmissionPlan = computeAdmission(probe, [request], {
    maxParallelIdeas: runtime.config.resources.maxParallelIdeas,
  });
  const admittedEntry = admission.admitted.find((entry) => entry.ideaId === ideaId);
  if (!admittedEntry) {
    const queued = admission.queued.find((entry) => entry.ideaId === ideaId);
    return {
      ideaId,
      plan: planSummary(stored),
      gate: { ok: gate.ok, blocking: gate.blocking },
      admitted: false,
      queuedReason: queued?.reason ?? 'not admitted by the capacity planner',
      constraints: admission.constraints,
      outcome: null,
      eventSeq: null,
    };
  }

  // 4. Execute through the IdeaSeek runner (check gate, RunResult, checkpoint).
  const outcome = await runIdeaExperiment(
    projectRoot,
    ideaId,
    { scale: scale as IdeaScale, timeoutMs: opts.timeoutMs, resume: opts.resume },
    runtime,
    runtime.db,
  );

  // 5. Audit trail: plan → spec → result in one RunEvent.
  let eventSeq: number | null = null;
  const run = await runtime.db.getLatestRun(runtime.project.id);
  if (run) {
    const event = await runtime.db.appendEvent({
      runId: run.runId,
      phase: 'EXPERIMENTING',
      objectId: ideaId,
      role: 'system',
      eventType: 'experiment_bridge',
      summary:
        `bridged ${ideaId} plan ${stored.inputHash.slice(0, 12)}… → ${outcome.specId} ` +
        `v${outcome.version} ${outcome.alreadyRecorded ? 'already recorded' : outcome.resultStatus}` +
        ` (ARIS experiment-bridge, scale=${scale})`,
      status: outcome.alreadyRecorded ? 'reused' : (outcome.resultStatus ?? 'unknown'),
    });
    eventSeq = event.seq;
  }

  return {
    ideaId,
    plan: planSummary(stored),
    gate: { ok: gate.ok, blocking: gate.blocking },
    admitted: true,
    queuedReason: null,
    constraints: admission.constraints,
    outcome,
    eventSeq,
  };
}

function planSummary(stored: StoredPlan): BridgeResult['plan'] {
  return {
    inputHash: stored.inputHash,
    ideaVersion: stored.ideaVersion,
    scale: stored.spec.scale,
    specId: stored.spec.specId,
    specVersion: stored.spec.version,
  };
}
