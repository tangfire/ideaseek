import { sha256Of } from '../core/hash.js';
import { IdeaseekError } from '../core/errors.js';
import { stableJson } from '../experiment/spec.js';

/**
 * Full Research plan/approval (docs/FULL_RESEARCH_MODE.md 进入条件): a
 * deterministic, reviewable lock of everything the researcher must
 * confirm before ANY full-scale run — question, protocol, data/split,
 * required comparisons, budget, time ceiling, network and resources.
 *
 * The plan itself is read-only over persisted state (ADR-002); the
 * handoff package is (re)built as the readiness evidence. Approval is a
 * protected action (`full-research`): guided needs --confirm, autonomous
 * records a Decision, review-only refuses outright — and an approval
 * only binds to a plan whose inputHash still matches current state.
 * Execution (`full run`) stays external: HANDOFF_READY + explicit
 * authorization + GPU/queue (never launched from here).
 */

export const FULL_PLAN_SCHEMA = 'full-plan-v1';

export interface FullPlanReadiness {
  ready: boolean;
  handoffLevel: string;
  blockers: string[];
}

export interface FullPlan {
  contract: typeof FULL_PLAN_SCHEMA;
  ideaId: string;
  ideaVersion: number;
  inputHash: string;
  generatedAt: number;
  /** The scientific question being locked (card hypothesis). */
  question: string;
  readiness: FullPlanReadiness;
  lock: {
    protocol: { protocolId: string; protocolHash: string; lockedAt: number } | null;
    dataSnapshotId: string | null;
    sliceIds: string[];
    codeCommit: string | null;
    seeds: number[];
  };
  comparisons: {
    gateOk: boolean;
    required: { methodId: string; status: string; required: boolean }[];
    /** Every registered comparison (sorted) — any change forces a re-plan. */
    inventory: { methodId: string; status: string; required: boolean }[];
    blocking: string[];
  };
  budget: {
    maxModelCost: number | null;
    maxGpuHours: number | null;
    ideaMaxGpuMinutes: number | null;
    basis: string;
  };
  timeLimit: { ceilingHours: number | null; basis: string };
  network: { allowNetwork: boolean; externalSearch: boolean; basis: string };
  resources: { gpus: number; memoryGiB: number; diskFreeGiB: number | null; basis: string };
  licenses: { kinds: string[]; policyNote: string };
  /** Fairness lock status (src/full/fairness.ts) — must be confirmed+current. */
  fairness: {
    present: boolean;
    confirmed: boolean;
    current: boolean;
    inputHash: string | null;
    blockers: string[];
  };
  /** What the researcher must confirm before `full approve`. */
  approvalsNeeded: string[];
  boundaries: string[];
  approval?: { at: number; mode: string; planInputHash: string };
}

function computeInputHash(plan: Omit<FullPlan, 'inputHash' | 'generatedAt' | 'approval'>): string {
  // Volatile-by-design fields never enter the hash: generatedAt is
  // wall-clock, and resources is a live capacity probe (free mem/disk
  // move every tick) — both are snapshots for the researcher; capacity
  // is re-probed before any full run, not an approval input.
  const { generatedAt: _ts, resources: _probe, ...stable } = plan as FullPlan;
  return sha256Of(stableJson(stable));
}

/**
 * Gathers the full-research lock from persisted state. Rebuilds the
 * idea handoff package as the readiness evidence (idempotent, audited).
 */
export async function buildFullPlan(root: string, ideaId: string): Promise<FullPlan> {
  const { loadIdeaCard, loadWorkspaceMeta } = await import('../idea/workspace.js');
  const card = await loadIdeaCard(root, ideaId);
  const meta = await loadWorkspaceMeta(root, ideaId);
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  try {
    // Readiness evidence = the handoff gate (writes the package — the
    // same artifact `idea handoff` produces; idempotent by design).
    let gateReadiness: FullPlanReadiness;
    try {
      const { buildIdeaHandoff } = await import('../idea/handoff.js');
      const result = await buildIdeaHandoff(root, ideaId, runtime.db);
      gateReadiness = {
        ready: result.gate.handoffReady,
        handoffLevel: result.gate.level,
        blockers: result.gate.blockers,
      };
    } catch (error) {
      gateReadiness = {
        ready: false,
        handoffLevel: 'UNKNOWN',
        blockers: [`handoff evidence unavailable: ${(error as Error).message}`],
      };
    }

    // Fairness lock: read-only rebuild + stored-draft check. Missing,
    // stale or unconfirmed locks — and any fairness blockers — gate
    // readiness (the researcher confirms fairness BEFORE full approve).
    let fairness: FullPlan['fairness'];
    const fairnessBlockers: string[] = [];
    try {
      const { buildFairnessLock } = await import('./fairness.js');
      const freshFairness = await buildFairnessLock(root, ideaId);
      let storedFairness: typeof freshFairness | null = null;
      try {
        const { readFile } = await import('node:fs/promises');
        const { join } = await import('node:path');
        storedFairness = JSON.parse(
          await readFile(join(root, 'knowledge', `fairness-${ideaId}.json`), 'utf8'),
        ) as typeof freshFairness;
      } catch {
        storedFairness = null;
      }
      const confirmed = storedFairness !== null && storedFairness.confirmed !== undefined;
      const current = confirmed && storedFairness?.inputHash === freshFairness.inputHash;
      fairness = {
        present: storedFairness !== null,
        confirmed,
        current,
        inputHash: freshFairness.inputHash,
        blockers: freshFairness.blockers,
      };
      if (!current) {
        fairnessBlockers.push(
          storedFairness
            ? `fairness lock stale or unconfirmed for ${ideaId} — run: ideaseek full fairness --idea ${ideaId} (review, then --confirm)`
            : `fairness lock missing for ${ideaId} — run: ideaseek full fairness --idea ${ideaId} (review, then --confirm)`,
        );
      }
      for (const blocker of freshFairness.blockers) {
        fairnessBlockers.push(`fairness: ${blocker}`);
      }
    } catch (error) {
      fairness = {
        present: false,
        confirmed: false,
        current: false,
        inputHash: null,
        blockers: [`fairness evidence unavailable: ${(error as Error).message}`],
      };
      fairnessBlockers.push(`fairness evidence unavailable: ${(error as Error).message}`);
    }

    const readiness: FullPlanReadiness = {
      ready: gateReadiness.ready && fairnessBlockers.length === 0,
      handoffLevel: gateReadiness.handoffLevel,
      blockers: [...gateReadiness.blockers, ...fairnessBlockers],
    };

    const locks = await runtime.db.listProtocolLocks();
    const protocol = locks.length > 0 ? locks[locks.length - 1]! : null;
    const specDoc = await runtime.db.getExperiment(`idea-${ideaId}`);
    const spec = (specDoc?.spec ?? null) as {
      dataSnapshotId?: unknown;
      sliceIds?: unknown;
      codeCommit?: unknown;
      seeds?: unknown;
    } | null;

    const methods = await runtime.db.listComparisons({});
    const { evaluateComparisonGateForProject } = await import('../comparison/worktree-stamp.js');
    const gate = await evaluateComparisonGateForProject(root, runtime.db);

    const { loadConfig } = await import('../config/config.js');
    const { projectPaths } = await import('../config/paths.js');
    const config = (await loadConfig(projectPaths(root))).resolved;
    const { probeCapacity } = await import('../runtime/capacity.js');
    const probe = await probeCapacity(root);

    const licenseKinds = [
      ...new Set(
        methods
          .map((method) => (method.record as { repo?: { licenseKind?: string } }).repo?.licenseKind)
          .filter((kind): kind is string => typeof kind === 'string'),
      ),
    ].sort();

    const question = card.hypothesis.statement;
    const base: Omit<FullPlan, 'inputHash' | 'approval'> = {
      contract: FULL_PLAN_SCHEMA,
      ideaId,
      ideaVersion: meta.currentVersion,
      generatedAt: Date.now(),
      question,
      readiness,
      fairness,
      lock: {
        protocol: protocol
          ? {
              protocolId: protocol.protocolId,
              protocolHash: protocol.protocolHash,
              lockedAt: protocol.lockedAt,
            }
          : null,
        dataSnapshotId: typeof spec?.dataSnapshotId === 'string' ? spec.dataSnapshotId : null,
        sliceIds: Array.isArray(spec?.sliceIds)
          ? (spec.sliceIds as unknown[]).filter((s): s is string => typeof s === 'string')
          : [],
        codeCommit: typeof spec?.codeCommit === 'string' ? spec.codeCommit : null,
        seeds: Array.isArray(spec?.seeds)
          ? (spec.seeds as unknown[]).filter((s): s is number => typeof s === 'number')
          : [],
      },
      comparisons: {
        gateOk: gate.ok,
        required: methods
          .filter((method) => method.required)
          .map((method) => ({
            methodId: method.methodId,
            status: method.status,
            required: method.required,
          }))
          .sort((a, b) => a.methodId.localeCompare(b.methodId)),
        inventory: methods
          .map((method) => ({
            methodId: method.methodId,
            status: method.status,
            required: method.required,
          }))
          .sort((a, b) => a.methodId.localeCompare(b.methodId)),
        blocking: gate.blocking.map((item) => item.methodId),
      },
      budget: {
        maxModelCost:
          typeof config.resources.maxModelCost === 'number' ? config.resources.maxModelCost : null,
        maxGpuHours:
          typeof config.resources.maxGpuHours === 'number' ? config.resources.maxGpuHours : null,
        ideaMaxGpuMinutes: card.budget?.maxGpuMinutes ?? null,
        basis: 'config resources ceilings (not a prediction) + idea card budget',
      },
      timeLimit: {
        ceilingHours:
          typeof config.resources.maxGpuHours === 'number' ? config.resources.maxGpuHours : null,
        basis: 'derived from resources.max_gpu_hours — set it before approving',
      },
      network: {
        allowNetwork: config.runtime.allowNetwork === true,
        externalSearch: config.research.externalSearch === true,
        basis: 'config runtime.allow_network + research.external_search',
      },
      resources: {
        gpus: probe.gpus.length,
        memoryGiB: probe.freeMemGiB ?? 0,
        diskFreeGiB: probe.diskFreeGiB ?? null,
        basis: 'live capacity probe at plan time (re-probe before full run)',
      },
      licenses: {
        kinds: licenseKinds,
        policyNote:
          licenseKinds.length > 0
            ? 'required comparisons declare these license kinds — confirm they match your policy before full run'
            : 'no licensed comparisons registered yet',
      },
      approvalsNeeded: [
        'confirm the research question matches the locked protocol and data usage',
        'confirm required comparison list, budgets, seeds/repeats and stop rules',
        'confirm network/external-search policy for the full run',
        'confirm license policy against the declared comparison licenses',
        'confirm the machine/queue can absorb the projected resources',
      ],
      boundaries: [
        'Full runs are never launched by this plan — ideaseek full run requires HANDOFF_READY plus explicit authorization (external: GPU/queue).',
        'This plan is a draft/research aid; final scientific claims stay with the researcher.',
        'Quick/standard results never substitute for full-run results.',
      ],
    };
    const inputHash = computeInputHash(base);
    return { ...base, inputHash };
  } finally {
    await runtime.close();
  }
}

/** Pure approve gates (unit-testable): freshness + readiness. */
export function assertApprovable(plan: FullPlan, currentInputHash: string): void {
  if (plan.inputHash !== currentInputHash) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      'full plan is stale (project state changed since the plan) — rerun: ideaseek full plan --idea <id>',
    );
  }
  if (!plan.readiness.ready) {
    throw new IdeaseekError(
      'USER_INPUT_REQUIRED',
      `not ready for full research: ${plan.readiness.blockers.join('; ') || 'readiness gate failed'}`,
      { blockers: plan.readiness.blockers },
    );
  }
}

export function fullPlanPath(root: string, ideaId: string): string {
  return `${root}/knowledge/full-plan-${ideaId}.json`.replace(/\\/g, '/');
}
