import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { projectPaths } from '../config/paths.js';
import { readDaemonInfo, writeDaemonInfo } from '../runtime/daemon.js';
import { ProjectRuntime } from '../workflow/runtime.js';
import {
  assertConfigUsable,
  action,
  buildHandlers,
  buildHarness,
  resolveRun,
  runWorkerInteractive,
} from './shared.js';

/**
 * `ideaseek supervise` — the internal long-lived worker loop spawned
 * detached by `run --detach`. Output goes to `.research/logs/<runId>.log`;
 * daemon metadata (pid/heartbeat) lives in `.research/daemon.json` so
 * `status` can show whether the background supervisor is alive.
 */
export function registerSuperviseCommand(program: Command): void {
  program
    .command('supervise')
    .description('internal: background supervisor loop (spawned by run --detach)')
    .option('--run <runId>', 'run id (default: latest)')
    .option('--harness <kind>', 'agent harness: fake (default) or dsh', 'fake')
    .action(
      action(async (opts: { run?: string; harness?: string }) => {
        const runtime = await ProjectRuntime.open({
          cwd: process.cwd(),
          harness: buildHarness(opts.harness),
        });
        const paths = projectPaths(process.cwd());
        try {
          assertConfigUsable(runtime.configLoad);
          const run = await resolveRun(runtime, opts.run);
          // Ensure daemon metadata exists even if the parent died before its
          // post-spawn write, so the exit handler always has a record.
          const existing = readDaemonInfo(paths.researchDir);
          writeDaemonInfo(paths.researchDir, {
            runId: run.runId,
            pid: process.pid,
            startedAt: existing?.startedAt ?? Date.now(),
            heartbeatAt: Date.now(),
            logPath: existing?.logPath ?? '',
            version: existing?.version ?? '0.0.0',
          });
          if (run.status !== 'RUNNING') {
            throw new IdeaseekError(
              'RUN_NOT_ACTIVE',
              `supervise requires a RUNNING run (this one is ${run.status})`,
            );
          }

          let heartbeatTicks = 0;
          const heartbeat = setInterval(() => {
            const info = readDaemonInfo(paths.researchDir);
            if (info && info.runId === run.runId) {
              writeDaemonInfo(paths.researchDir, { ...info, heartbeatAt: Date.now() });
            }
            // Every ~60s: surface non-terminal anomalies (disk/backup/
            // quota/watchdog) as notifications with a 30min per-kind
            // cooldown; delivery never breaks the loop (PROGRESS 213).
            heartbeatTicks += 1;
            if (heartbeatTicks % 12 === 0) {
              void (async () => {
                try {
                  const { collectRuntimeAlerts } = await import('../runtime/alerts.js');
                  const { listNotifications, notifyUser, shouldNotifyAlert } =
                    await import('../runtime/notify.js');
                  const report = await collectRuntimeAlerts(process.cwd());
                  if (report.healthy) return;
                  const now = Date.now();
                  const records = await listNotifications(process.cwd(), 200);
                  for (const alert of report.alerts) {
                    const notifyKind = `alert.${alert.kind}`;
                    if (!shouldNotifyAlert(records, notifyKind, now)) continue;
                    await notifyUser(process.cwd(), {
                      kind: notifyKind,
                      title: `${alert.severity} · ${alert.kind}`,
                      summary: alert.detail,
                    });
                  }
                } catch {
                  // best-effort telemetry only
                }
              })();
            }
          }, 5_000);
          heartbeat.unref();

          try {
            const { exit } = await runWorkerInteractive(runtime, run.runId, {
              kind: 'standalone',
              handlers: buildHandlers(),
              onLog: (message) => process.stdout.write(`[supervise] ${message}\n`),
            });
            const info = readDaemonInfo(paths.researchDir);
            if (info && info.runId === run.runId) {
              writeDaemonInfo(paths.researchDir, {
                ...info,
                exitedAt: Date.now(),
                reason: exit.reason,
              });
            }
            // Notification entry (Phase 7): the background supervisor is the
            // process that knows the run reached a terminal state. Delivery
            // never breaks the exit path (notifyUser never throws).
            try {
              const { notifyUser } = await import('../runtime/notify.js');
              await notifyUser(process.cwd(), {
                kind: exit.reason,
                title: `run ${run.runId}: ${exit.reason}`,
                summary: `supervisor finished with ${exit.reason} (status ${exit.runStatus ?? 'unknown'})`,
              });
            } catch {
              // best-effort only
            }
            switch (exit.reason) {
              case 'completed':
                return 0;
              case 'failed':
                return 1;
              case 'canceled':
                return 4;
              case 'blocked':
                return 2;
              default:
                return exit.runStatus === 'RUNNING' ? 3 : 0;
            }
          } finally {
            clearInterval(heartbeat);
          }
        } finally {
          await runtime.close();
        }
      }),
    );
}
