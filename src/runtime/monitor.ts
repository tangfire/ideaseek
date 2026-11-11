import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Experiment monitor (Phase 4.5B, ARIS monitor-experiment capability):
 * ONE-SHOT snapshot of what is running — heartbeats (workers + experiment
 * progress), recent logs, host resources and WAITING REASONS (blocked/
 * paused run, admission queue). Detection of liveness belongs to
 * watchdog; queue layout to queue. Build-vs-reuse (ADR-007): the ARIS
 * skill watches screen sessions + W&B; IdeaSeek runs DB-heartbeated
 * workers and progress files, so this thin adapter reports the same
 * "what's running / what's waiting" contract over its own state — no
 * second monitor process.
 */

export interface MonitorWorker {
  workerId: string;
  pid: number;
  ageSeconds: number;
}

export interface MonitorExperiment {
  specId: string;
  ageSeconds: number;
  step: number | null;
  epoch: number | null;
}

export interface MonitorLog {
  path: string;
  ageSeconds: number;
  bytes: number;
}

export interface MonitorWaiting {
  scope: 'run' | 'admission' | 'queue';
  reason: string;
}

export interface MonitorReport {
  checkedAt: number;
  run: { runId: string; status: string; phase: string; blockReason: string | null } | null;
  workers: MonitorWorker[];
  experiments: MonitorExperiment[];
  logs: MonitorLog[];
  resources: {
    gpus: number;
    freeMemGiB: number | null;
    diskFreeGiB: number | null;
  } | null;
  waiting: MonitorWaiting[];
}

export async function collectMonitor(
  root: string,
  opts: { now?: number } = {},
): Promise<MonitorReport> {
  const now = opts.now ?? Date.now();
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  try {
    const run = await runtime.db.getLatestRun(runtime.project.id);

    const workers: MonitorWorker[] = [];
    const experiments: MonitorExperiment[] = [];
    const waiting: MonitorWaiting[] = [];

    if (run) {
      if (
        ['PAUSED', 'BLOCKED', 'QUOTA_EXHAUSTED', 'AUTH_REQUIRED', 'NETWORK_BLOCKED'].includes(
          run.status,
        )
      ) {
        waiting.push({
          scope: 'run',
          reason: `${run.status}${run.blockReason ? `: ${run.blockReason}` : ''}`,
        });
      }
      for (const worker of await runtime.db.listWorkers(run.runId)) {
        if (worker.status !== 'active') continue;
        workers.push({
          workerId: worker.workerId,
          pid: worker.pid,
          ageSeconds: Math.max(0, Math.round((now - worker.heartbeatAt) / 1000)),
        });
      }
    }

    const { readdir: readDir } = await import('node:fs/promises');
    for (const idea of await readDir(join(root, 'ideas')).catch(() => [] as string[])) {
      const expDir = join(root, 'ideas', idea, 'experiments');
      for (const file of await readDir(expDir).catch(() => [] as string[])) {
        if (!file.startsWith('progress-') || !file.endsWith('.json')) continue;
        try {
          const { readFile } = await import('node:fs/promises');
          const progress = JSON.parse(await readFile(join(expDir, file), 'utf8')) as {
            specId?: string;
            interrupt?: string | null;
            heartbeat?: { step?: number; epoch?: number | null; at?: number } | null;
            updatedAt?: number;
          };
          const specId = progress.specId ?? file.replace(/^progress-|\.json$/g, '');
          const doc = await runtime.db.getExperiment(specId);
          const finished = Boolean(
            doc?.result ||
            ['succeeded', 'failed', 'partial', 'invalid'].includes(doc?.status ?? ''),
          );
          if (finished || progress.interrupt) continue;
          const last = progress.heartbeat?.at ?? progress.updatedAt ?? 0;
          experiments.push({
            specId,
            ageSeconds: Math.max(0, Math.round((now - last) / 1000)),
            step: progress.heartbeat?.step ?? null,
            epoch: progress.heartbeat?.epoch ?? null,
          });
        } catch {
          continue;
        }
      }
    }

    // Recent logs (paths + ages only — contents stay behind `ideaseek logs`).
    const logs: MonitorLog[] = [];
    const logDir = join(root, '.research', 'logs');
    for (const name of await readdir(logDir).catch(() => [] as string[])) {
      const path = join(logDir, name);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) continue;
      logs.push({
        path: `.research/logs/${name}`,
        ageSeconds: Math.max(0, Math.round((now - info.mtimeMs) / 1000)),
        bytes: info.size,
      });
    }
    logs.sort((a, b) => a.ageSeconds - b.ageSeconds);
    const recentLogs = logs.slice(0, 10);

    // Waiting reasons from the admission plan (fair-queue visibility).
    let resources: MonitorReport['resources'] = null;
    try {
      const { probeCapacity } = await import('./capacity.js');
      const probe = await probeCapacity(root);
      resources = {
        gpus: probe.gpus.length,
        freeMemGiB: probe.freeMemGiB,
        diskFreeGiB: probe.diskFreeGiB,
      };
      const { computeAdmission } = await import('./capacity.js');
      const { listWorkspaces } = await import('../idea/workspace.js');
      const { ideaResourceRequest } = await import('../idea/experiment.js');
      const ready = (await listWorkspaces(root)).filter((idea) => idea.status === 'SMOKE_TESTED');
      const requests = await Promise.all(
        ready.map((idea) => ideaResourceRequest(root, idea.ideaId)),
      );
      const plan = computeAdmission(probe, requests, {
        maxParallelIdeas: runtime.config.resources.maxParallelIdeas,
      });
      for (const entry of plan.queued) {
        waiting.push({ scope: 'admission', reason: `${entry.ideaId}: ${entry.reason}` });
      }
    } catch {
      resources = null; // probe is advisory — absence never fails the snapshot
    }

    return {
      checkedAt: now,
      run: run
        ? { runId: run.runId, status: run.status, phase: run.phase, blockReason: run.blockReason }
        : null,
      workers,
      experiments,
      logs: recentLogs,
      resources,
      waiting,
    };
  } finally {
    await runtime.close();
  }
}
