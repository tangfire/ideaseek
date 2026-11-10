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

          const heartbeat = setInterval(() => {
            const info = readDaemonInfo(paths.researchDir);
            if (info && info.runId === run.runId) {
              writeDaemonInfo(paths.researchDir, { ...info, heartbeatAt: Date.now() });
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
