/**
 * Required-comparison gate (plan §C.10): every required method needs a
 * runnable result before idea generation / handoff. Extracted so the CLI
 * command and the idea handoff package share ONE evaluation.
 */

export interface GateComparisonRecord {
  methodId: string;
  status: string;
  record: Record<string, unknown>;
}

export interface GateExperimentRecord {
  specId: string;
  spec: Record<string, unknown>;
  result: Record<string, unknown> | null;
  /** Registry lifecycle status (present on WorkflowDb rows). */
  status: string;
}

export interface ComparisonGateDb {
  listComparisons(filter: { required: boolean }): Promise<GateComparisonRecord[]>;
  listExperiments(): Promise<GateExperimentRecord[]>;
}

export interface GatePassed {
  methodId: string;
  status: string;
  via: 'status' | 'experiment';
  algorithmModified?: boolean;
}

export interface GateSkipped {
  methodId: string;
  reason: string | null;
}

export interface GateBlocking {
  methodId: string;
  status: string;
  hint: string;
}

export interface ComparisonGateResult {
  ok: boolean;
  required: number;
  passed: GatePassed[];
  skipped: GateSkipped[];
  blocking: GateBlocking[];
  note?: string;
}

/** Statuses that prove a runnable result under the current protocol. */
const PASSING = new Set(['smoke-tested', 'evaluated', 'validated']);

export async function evaluateComparisonGate(
  db: ComparisonGateDb,
  opts: { staleWorktrees?: ReadonlySet<string> } = {},
): Promise<ComparisonGateResult> {
  const methods = await db.listComparisons({ required: true });
  const skipped: GateSkipped[] = [];
  const passed: GatePassed[] = [];
  const blocking: GateBlocking[] = [];

  // Experiment results covering a method also prove it runs under a spec.
  const experiments = await db.listExperiments();
  const experimentCover = new Map<string, string>();
  for (const doc of experiments) {
    if (!doc.result) continue;
    const result = doc.result as { status?: unknown };
    if (result.status !== 'succeeded' && result.status !== 'partial') continue;
    const ids = (doc.spec as { comparisonIds?: unknown }).comparisonIds;
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      if (typeof id === 'string' && !experimentCover.has(id)) {
        experimentCover.set(id, doc.specId);
      }
    }
  }

  for (const method of methods) {
    if (method.status === 'excluded') {
      skipped.push({
        methodId: method.methodId,
        reason: (method.record.statusReason as string | undefined) ?? null,
      });
      continue;
    }
    if (PASSING.has(method.status)) {
      if (opts.staleWorktrees?.has(method.methodId)) {
        blocking.push({
          methodId: method.methodId,
          status: `${method.status} (worktree modified)`,
          hint: `worktree changed since the passing smoke test — rerun: ideaseek comparison smoke ${method.methodId}`,
        });
        continue;
      }
      const repro = method.record.reproduction as { algorithmModified?: boolean } | undefined;
      passed.push({
        methodId: method.methodId,
        status: method.status,
        via: 'status',
        ...(repro?.algorithmModified ? { algorithmModified: true } : {}),
      });
      continue;
    }
    const viaExperiment = experimentCover.get(method.methodId);
    if (viaExperiment) {
      passed.push({
        methodId: method.methodId,
        status: method.status,
        via: 'experiment',
      });
      continue;
    }
    blocking.push({
      methodId: method.methodId,
      status: method.status,
      hint:
        method.status === 'blocked'
          ? `resolve the block or exclude with a reason: ideaseek comparison set-status ${method.methodId} excluded --reason "..."`
          : method.status === 'repairing' || method.status === 'implemented'
            ? `finish the baseline: ideaseek baseline repair --method ${method.methodId}`
            : `advance the method: ideaseek comparison set-status ${method.methodId} implemented`,
    });
  }

  // Zero required comparisons used to note-and-pass: a project could reach
  // handoff and a paper with no baseline registered at all, because the gate
  // vouched for an empty set. An empty set is not evidence — block it.
  const zeroRequired = methods.length === 0;
  if (zeroRequired) {
    blocking.push({
      methodId: '(none)',
      status: 'no required comparisons registered',
      hint: 'register at least one established baseline: ideaseek comparison discover → explain → register (an approved decision waiver is the audited escape hatch)',
    });
  }

  return {
    ok: blocking.length === 0,
    required: methods.length,
    passed,
    skipped,
    blocking,
    ...(zeroRequired ? { note: 'no required comparisons registered' } : {}),
  };
}
