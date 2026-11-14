import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { ProjectRuntime } from '../workflow/runtime.js';
import {
  action,
  assertConfigUsable,
  buildHandlers,
  buildHarness,
  isBlockedRun,
  isTerminalRun,
  jsonLine,
  resolveRun,
  resolveHarnessKind,
  runWorkerInteractive,
} from './shared.js';

export function registerWorkerCommand(program: Command): void {
  program
    .command('worker')
    .description('run a standalone fake worker against the current run')
    .option('--run <runId>', 'run id (default: latest)')
    .option('--max-tasks <n>', 'exit after N tasks', (value) => Number(value))
    .option('--idle-exit <ms>', 'exit after this many ms without claimable work', (value) =>
      Number(value),
    )
    .option(
      '--harness <kind>',
      'agent harness: fake | dsh (default: dsh when a key is configured, else fake with a warning)',
    )
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (opts: {
          run?: string;
          maxTasks?: number;
          idleExit?: number;
          harness?: string;
          json?: boolean;
        }) => {
          const runtime = await ProjectRuntime.open({
            cwd: process.cwd(),
            harness: buildHarness(resolveHarnessKind(opts.harness)),
          });
          try {
            assertConfigUsable(runtime.configLoad);
            const run = await resolveRun(runtime, opts.run);
            if (isTerminalRun(run.status)) {
              if (opts.json) {
                process.stdout.write(
                  jsonLine({
                    runId: run.runId,
                    status: run.status,
                    exitReason: 'already-terminal',
                  }),
                );
              } else {
                process.stdout.write(`run ${run.runId} already ${run.status}; nothing to claim\n`);
              }
              return run.status === 'FAILED' ? 1 : run.status === 'CANCELED' ? 4 : 0;
            }
            if (run.status === 'PAUSED') {
              throw new IdeaseekError(
                'RUN_NOT_ACTIVE',
                'run is PAUSED; resume it first: ideaseek resume',
              );
            }
            if (isBlockedRun(run.status)) {
              throw new IdeaseekError(
                'RUN_BLOCKED',
                `run is ${run.status}; resolve the block and run: ideaseek continue`,
              );
            }

            const { exit } = await runWorkerInteractive(runtime, run.runId, {
              kind: 'standalone',
              handlers: buildHandlers(),
              maxTasks: Number.isFinite(opts.maxTasks) ? opts.maxTasks : undefined,
              idleExitMs: Number.isFinite(opts.idleExit) ? opts.idleExit : undefined,
              onLog: opts.json ? undefined : (message) => process.stderr.write(`  · ${message}\n`),
            });

            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  runId: exit.runId,
                  status: exit.runStatus,
                  exitReason: exit.reason,
                  processed: exit.processed,
                }),
              );
            } else {
              process.stdout.write(
                `worker exit: ${exit.reason} (run ${exit.runStatus}, processed ${exit.processed})\n`,
              );
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
              case 'paused':
                return 0;
              default:
                return exit.runStatus === 'RUNNING' ? 3 : 0;
            }
          } finally {
            await runtime.close();
          }
        },
      ),
    );
}
