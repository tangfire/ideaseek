import { TERMINAL_RUN_STATUSES } from '../workflow/types.js';

/**
 * Experiment queue view (Phase 4.5B): dependency WAVES over the latest
 * run (layer = longest path over unfinished deps; wave 1 = claimable now,
 * exactly what claimNextTask will take), per-task waitingOn lists for
 * `depends_on` transparency, stale queued leftovers on terminal runs
 * (cleaned via `queue --cleanup` → db.cleanupQueued), and the EXISTING
 * capacity admission plan embedded for fairness (stable createdAt/ideaId
 * order — no second scheduler, ADR-007).
 */

export interface QueueTaskView {
  taskId: string;
  type: string;
  status: string;
  wave: number;
  waitingOn: string[];
}

export interface QueueReport {
  runId: string | null;
  runStatus: string | null;
  terminal: boolean;
  waves: { wave: number; tasks: QueueTaskView[] }[];
  staleQueued: QueueTaskView[];
  admission: {
    parallelLimit: number;
    admitted: { ideaId: string }[];
    queued: { ideaId: string; reason: string }[];
    constraints: string[];
  } | null;
  checkedAt: number;
}

export async function collectQueue(
  root: string,
  opts: { now?: number } = {},
): Promise<QueueReport> {
  const now = opts.now ?? Date.now();
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  try {
    const run = await runtime.db.getLatestRun(runtime.project.id);
    if (!run) {
      return {
        runId: null,
        runStatus: null,
        terminal: false,
        waves: [],
        staleQueued: [],
        admission: null,
        checkedAt: now,
      };
    }

    const tasks = await runtime.db.listTasks(run.runId);
    const byId = new Map(tasks.map((task) => [task.taskId, task]));
    const unfinished = tasks.filter(
      (task) =>
        task.status === 'queued' ||
        task.status === 'leased' ||
        task.status === 'running' ||
        task.status === 'committing',
    );

    // Longest-path layering over UNFINISHED deps (satisfied deps drop out).
    const layerOf = new Map<string, number>();
    const visit = (taskId: string, guard: Set<string>): number => {
      const cached = layerOf.get(taskId);
      if (cached !== undefined) return cached;
      if (guard.has(taskId)) return 0; // defensive: dep cycles never hang the view
      guard.add(taskId);
      const task = byId.get(taskId);
      let layer = 0;
      for (const dep of task?.dependsOn ?? []) {
        const depTask = byId.get(dep);
        if (!depTask) continue;
        const depUnfinished =
          depTask.status === 'queued' ||
          depTask.status === 'leased' ||
          depTask.status === 'running' ||
          depTask.status === 'committing';
        if (depUnfinished) layer = Math.max(layer, visit(dep, guard) + 1);
      }
      layerOf.set(taskId, layer);
      return layer;
    };

    const views: QueueTaskView[] = unfinished.map((task) => {
      const waitingOn = (task.dependsOn ?? []).filter((dep) => {
        const depTask = byId.get(dep);
        return !depTask || depTask.status !== 'succeeded';
      });
      return {
        taskId: task.taskId,
        type: task.type,
        status: task.status,
        wave: visit(task.taskId, new Set()),
        waitingOn,
      };
    });
    views.sort((a, b) => a.wave - b.wave || a.taskId.localeCompare(b.taskId));

    const terminal = (TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status);
    const staleQueued = terminal ? views.filter((task) => task.status === 'queued') : [];

    const waves: { wave: number; tasks: QueueTaskView[] }[] = [];
    for (const view of views) {
      const bucket = waves.find((entry) => entry.wave === view.wave);
      if (bucket) bucket.tasks.push(view);
      else waves.push({ wave: view.wave, tasks: [view] });
    }

    // Fairness preview: reuse the capacity admission plan verbatim.
    let admission: QueueReport['admission'] = null;
    try {
      const { computeAdmission, probeCapacity } = await import('./capacity.js');
      const { listWorkspaces } = await import('../idea/workspace.js');
      const { ideaResourceRequest } = await import('../idea/experiment.js');
      const probe = await probeCapacity(root);
      const ready = (await listWorkspaces(root)).filter((idea) => idea.status === 'SMOKE_TESTED');
      const requests = await Promise.all(
        ready.map((idea) => ideaResourceRequest(root, idea.ideaId)),
      );
      const plan = computeAdmission(probe, requests, {
        maxParallelIdeas: runtime.config.resources.maxParallelIdeas,
      });
      admission = {
        parallelLimit: plan.parallelLimit,
        admitted: plan.admitted.map((entry) => ({ ideaId: entry.ideaId })),
        queued: plan.queued.map((entry) => ({ ideaId: entry.ideaId, reason: entry.reason })),
        constraints: plan.constraints,
      };
    } catch {
      admission = null; // probe/admission is advisory — absence never fails the view
    }

    return {
      runId: run.runId,
      runStatus: run.status,
      terminal,
      waves,
      staleQueued,
      admission,
      checkedAt: now,
    };
  } finally {
    await runtime.close();
  }
}

/** Cancels stale queued tasks on the latest terminal run (explicit cleanup). */
export async function cleanupStaleQueue(root: string): Promise<{ runId: string; cleaned: number }> {
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const { IdeaseekError } = await import('../core/errors.js');
  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  try {
    const run = await runtime.db.getLatestRun(runtime.project.id);
    if (!run) {
      throw new IdeaseekError('RUN_NOT_FOUND', 'no run exists yet — nothing to clean');
    }
    const cleaned = await runtime.db.cleanupQueued(run.runId);
    return { runId: run.runId, cleaned };
  } finally {
    await runtime.close();
  }
}
