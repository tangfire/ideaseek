/**
 * Watchdog (Phase 4.5B, ARIS watchdog capability): ONE-SHOT liveness
 * detection over IdeaSeek's own state — stalled / dead / stale ONLY, no
 * quality verdicts (ARIS watchdog's contract). Build-vs-reuse (ADR-007):
 * the ARIS helper is a screen/tmux registration DAEMON; IdeaSeek runs
 * workers/experiments under DB leases and progress heartbeats, so a
 * second monitor process would duplicate the task DB (forbidden). This
 * thin adapter answers the same capability contract against the existing
 * lease/heartbeat/lock/supervisor records.
 */

import { readdir, readFile } from 'node:fs/promises';
import { daemonSummary, inspectProjectLock } from './project-lock.js';

export type WatchdogScope = 'worker' | 'supervisor' | 'lock' | 'experiment';
export type WatchdogState = 'stale' | 'dead' | 'stalled';

export interface WatchdogFinding {
  scope: WatchdogScope;
  target: string;
  state: WatchdogState;
  detail: string;
}

export interface WatchdogReport {
  checkedAt: number;
  healthy: boolean;
  findings: WatchdogFinding[];
  checked: { workers: number; experiments: number; supervisor: boolean; lock: boolean };
}

export interface WatchdogOptions {
  now?: number;
  /** Heartbeat grace for in-flight experiments (default 10 minutes). */
  heartbeatGraceMs?: number;
}

export async function detectWatchdog(
  root: string,
  opts: WatchdogOptions = {},
): Promise<WatchdogReport> {
  const now = opts.now ?? Date.now();
  const grace = opts.heartbeatGraceMs ?? 10 * 60_000;
  const findings: WatchdogFinding[] = [];
  const checked = { workers: 0, experiments: 0, supervisor: false, lock: false };

  // --- supervisor: daemon.json says running but the pid is gone → dead.
  const daemon = daemonSummary(root);
  if (daemon) {
    checked.supervisor = true;
    if (daemon.state === 'process gone') {
      findings.push({
        scope: 'supervisor',
        target: `pid ${daemon.pid}`,
        state: 'dead',
        detail:
          'daemon.json reports a live supervisor but the process is gone — restart or clean with ideaseek cleanup',
      });
    }
  }

  // --- project lock: record exists but the owner pid is gone → stale.
  const lock = await inspectProjectLock(root);
  if (lock) {
    checked.lock = true;
    if (!lock.alive) {
      findings.push({
        scope: 'lock',
        target: `pid ${lock.lock.pid}`,
        state: 'stale',
        detail: `project lock held by a dead process (purpose: ${lock.lock.purpose}) — reclaimed on next run`,
      });
    }
  }

  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  try {
    // --- workers: marked active but heartbeating older than 3× lease TTL.
    const run = await runtime.db.getLatestRun(runtime.project.id);
    if (run) {
      const ttlMs = runtime.config.runtime.leaseTtlSeconds * 3000; // 3× TTL in ms
      const workers = await runtime.db.listWorkers(run.runId);
      for (const worker of workers) {
        checked.workers += 1;
        if (worker.status !== 'active') continue;
        if (now - worker.heartbeatAt < ttlMs) continue;
        findings.push({
          scope: 'worker',
          target: `${worker.workerId} (pid ${worker.pid})`,
          state: 'stale',
          detail:
            `last heartbeat ${Math.round((now - worker.heartbeatAt) / 1000)}s ago ` +
            `(lease TTL ${runtime.config.runtime.leaseTtlSeconds}s × 3) — its tasks will be reclaimed`,
        });
      }
    }

    // --- experiments: progress heartbeat old AND no attached result → stalled.
    const { join: joinPath } = await import('node:path');
    for (const idea of await readdir(joinPath(root, 'ideas')).catch(() => [] as string[])) {
      const expDir = joinPath(root, 'ideas', idea, 'experiments');
      const files = await readdir(expDir).catch(() => [] as string[]);
      for (const file of files) {
        if (!file.startsWith('progress-') || !file.endsWith('.json')) continue;
        checked.experiments += 1;
        try {
          const progress = JSON.parse(await readFile(joinPath(expDir, file), 'utf8')) as {
            specId?: string;
            interrupt?: string | null;
            heartbeat?: { at?: number } | null;
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
          if (now - last < grace) continue;
          findings.push({
            scope: 'experiment',
            target: specId,
            state: 'stalled',
            detail:
              `no progress for ${Math.round((now - last) / 1000)}s ` +
              `(grace ${Math.round(grace / 1000)}s) with no attached result — check the runner or resume`,
          });
        } catch {
          continue; // unreadable progress file: report nothing, never crash
        }
      }
    }
  } finally {
    await runtime.close();
  }

  // Stable, human-scannable order.
  findings.sort((a, b) => a.scope.localeCompare(b.scope) || a.target.localeCompare(b.target));
  return { checkedAt: now, healthy: findings.length === 0, findings, checked };
}
