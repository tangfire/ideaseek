import { sha256Of } from '../core/hash.js';
import { IdeaseekError } from '../core/errors.js';
import { stableJson } from '../experiment/spec.js';
import type { ExperimentSpec } from '../experiment/spec.js';
import type { FullPlan } from './plan.js';

/**
 * Full-run orchestration planning (docs/FULL_RESEARCH_MODE.md 全量实验,
 * docs/DATA_SCALE_POLICY 平台内执行路线): pure-ish gates + spec builders
 * over persisted state. The actual execution is ONE `full.run` workflow
 * task on the existing ResearchRun — same worker, FaultSpec, quota/
 * network blocking, pause/resume and audit as every other task (no
 * second queue/runner). Approval is re-verified at enqueue AND inside
 * the handler (state may move between the two).
 */

export interface FullRunWorkItem {
  kind: 'comparison' | 'idea';
  /** methodId for comparisons, ideaId for the final idea. */
  id: string;
  specId: string;
}

export interface FullRunAuthorization {
  planInputHash: string;
  ideaId: string;
  /** Required, non-excluded methods the full run must execute. */
  requiredMethodIds: string[];
  work: FullRunWorkItem[];
}

/** Parses a method entry (string or argv) — full runs never accept a placeholder. */
export function resolveFullEntry(entry: unknown): string[] | null {
  if (Array.isArray(entry) && entry.every((part) => typeof part === 'string')) {
    return (entry as string[]).length > 0 ? (entry as string[]) : null;
  }
  if (typeof entry === 'string' && entry.trim()) {
    return entry.trim().split(/\s+/);
  }
  return null;
}

/**
 * Enqueue-time gate: the stored plan must be approved AND still match
 * current state, and every required method must carry a runnable entry
 * (no silent skips, no `python --version` placeholders in a full run).
 */
export async function authorizeFullRun(
  root: string,
  ideaId: string,
): Promise<FullRunAuthorization> {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const path = join(root, 'knowledge', `full-plan-${ideaId}.json`);
  let stored: FullPlan | null = null;
  try {
    stored = JSON.parse(await readFile(path, 'utf8')) as FullPlan;
  } catch {
    stored = null;
  }
  if (!stored) {
    throw new IdeaseekError(
      'USER_INPUT_REQUIRED',
      `no full plan for ${ideaId} — run: ideaseek full plan --idea ${ideaId} (then fairness + approve)`,
    );
  }
  if (!stored.approval) {
    throw new IdeaseekError(
      'USER_INPUT_REQUIRED',
      `full plan for ${ideaId} is not approved — run: ideaseek full approve --idea ${ideaId} --confirm`,
    );
  }
  const { buildFullPlan, assertApprovable } = await import('./plan.js');
  const current = await buildFullPlan(root, ideaId);
  assertApprovable(stored, current.inputHash); // stale or not-ready → throws with recovery

  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  try {
    const methods = await runtime.db.listComparisons({ required: true });
    const required = methods.filter((method) => method.status !== 'excluded');
    const missingEntry = required.filter(
      (method) => resolveFullEntry(method.record.entry) === null,
    );
    if (missingEntry.length > 0) {
      throw new IdeaseekError(
        'USER_INPUT_REQUIRED',
        `required comparison(s) have no runnable entry: ${missingEntry
          .map((m) => m.methodId)
          .join(
            ', ',
          )} — set one with: ideaseek baseline repair --method <id> --entry "python eval.py"`,
        { methods: missingEntry.map((m) => m.methodId) },
      );
    }

    const work: FullRunWorkItem[] = [
      ...required
        .map((method) => ({
          kind: 'comparison' as const,
          id: method.methodId,
          specId: `full-${method.methodId}`,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      { kind: 'idea' as const, id: ideaId, specId: `idea-${ideaId}` },
    ];
    return {
      planInputHash: stored.inputHash,
      ideaId,
      requiredMethodIds: required.map((method) => method.methodId).sort(),
      work,
    };
  } finally {
    await runtime.close();
  }
}

/**
 * Full-scale ExperimentSpec for one required comparison: locked
 * data/split + seeds come from the idea's own spec (the fairness
 * reference), metrics/directions from the locked protocol, command from
 * the method entry, executed in the method worktree.
 */
export async function buildFullComparisonSpec(
  root: string,
  ideaId: string,
  methodId: string,
): Promise<ExperimentSpec> {
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  try {
    const doc = await runtime.db.getComparison(methodId);
    if (!doc) {
      throw new IdeaseekError('TASK_NOT_FOUND', `comparison ${methodId} not found`);
    }
    const entry = resolveFullEntry(doc.record.entry);
    if (!entry) {
      throw new IdeaseekError(
        'USER_INPUT_REQUIRED',
        `comparison ${methodId} has no entry — ideaseek baseline repair --method ${methodId} --entry "..."`,
      );
    }
    const ideaDoc = await runtime.db.getExperiment(`idea-${ideaId}`);
    const ideaSpec = (ideaDoc?.spec ?? null) as {
      dataSnapshotId?: unknown;
      seeds?: unknown;
    } | null;
    const locks = await runtime.db.listProtocolLocks();
    const protocol = locks.length > 0 ? locks[locks.length - 1]! : null;
    const protocolRecord = protocol?.record as
      { primaryMetrics?: unknown; secondaryMetrics?: unknown; protocolId?: unknown } | undefined;
    const metricNames = (value: unknown): { name: string; direction: 'higher' | 'lower' }[] =>
      Array.isArray(value)
        ? value
            .map((item) => {
              const entry = item as { name?: unknown; direction?: unknown };
              if (typeof entry?.name === 'string') {
                return {
                  name: entry.name,
                  direction: entry.direction === 'lower' ? ('lower' as const) : ('higher' as const),
                };
              }
              return null;
            })
            .filter((m): m is { name: string; direction: 'higher' | 'lower' } => m !== null)
        : [];
    const metrics = [
      ...metricNames(protocolRecord?.primaryMetrics),
      ...metricNames(protocolRecord?.secondaryMetrics),
    ];
    if (metrics.length === 0) {
      throw new IdeaseekError(
        'DEPENDENCY_NOT_MET',
        'no locked protocol metrics — run: ideaseek full plan --idea <id> (requires a locked protocol)',
      );
    }
    const seeds = Array.isArray(ideaSpec?.seeds)
      ? (ideaSpec.seeds as unknown[]).filter((s): s is number => typeof s === 'number')
      : [42];

    const spec: ExperimentSpec = {
      specId: `full-${methodId}`,
      version: 1, // caller rewrites after hash comparison
      idea: null,
      comparisonIds: [methodId],
      codeCommit:
        typeof (doc.record as { repo?: { commit?: unknown } }).repo?.commit === 'string'
          ? ((doc.record as { repo?: { commit?: string } }).repo!.commit as string)
          : null,
      dataSnapshotId:
        typeof ideaSpec?.dataSnapshotId === 'string' ? ideaSpec.dataSnapshotId : 'synthetic:full',
      sliceIds: [],
      environment: {
        python: process.version,
        // Spec identity = the work itself (scale + method), NOT the
        // approval instance — re-approvals must not invalidate skips.
        notes: [`scale:full`, `method:${methodId}`],
      },
      command: entry,
      metrics,
      seeds,
      resources: {},
      budget: { maxRuns: 1, maxMinutes: 60 * 24 },
      protocolId: protocol?.protocolId ?? null,
      createdAt: Date.now(),
    };
    return spec;
  } finally {
    await runtime.close();
  }
}

/**
 * Stable identity of a full-run work item: everything a full-run cares
 * about EXCEPT wall-clock createdAt and registry version (both change on
 * every rebuild without changing what would execute).
 */
export function fullSpecInputHash(spec: ExperimentSpec): string {
  const { createdAt: _ts, version: _v, ...stable } = spec;
  return sha256Of(stableJson(stable));
}
