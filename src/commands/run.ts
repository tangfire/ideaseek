import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { ProjectRuntime } from '../workflow/runtime.js';
import { demoHandlers } from '../worker/handlers.js';
import {
  action,
  countByStatus,
  enqueueDemoPipeline,
  isBlockedRun,
  isTerminalRun,
  jsonLine,
  parseFaultSpec,
  runWorkerInteractive,
} from './shared.js';

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('create or resume a workflow and execute it with the foreground fake worker')
    .option('-q, --question <text>', 'research question (required when creating a run)')
    .option('--run <runId>', 'operate on a specific run instead of the latest')
    .option('--enqueue-only', 'create/adopt the run and enqueue tasks without executing')
    .option('--fault <json>', 'fault injection map, e.g. \'{"demo.analyze":{"crash":true}}\'')
    .option('--force', 'attach even if another live worker holds this run')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (opts: {
          question?: string;
          run?: string;
          enqueueOnly?: boolean;
          fault?: string;
          force?: boolean;
          json?: boolean;
        }) => {
          const runtime = await ProjectRuntime.open({ cwd: process.cwd() });
          try {
            const faults = parseFaultSpec(opts.fault);
            const db = runtime.db;
            let run = opts.run
              ? await db.getRun(opts.run)
              : await db.getLatestRun(runtime.project.id);
            if (opts.run && !run) {
              throw new IdeaseekError('RUN_NOT_FOUND', `run ${opts.run} not found`);
            }
            const actions: string[] = [];

            if (run && !isTerminalRun(run.status)) {
              const liveWorkers = await liveWorkersOf(runtime, run.runId);
              if (liveWorkers > 0 && !opts.force) {
                throw new IdeaseekError(
                  'INVALID_STATE',
                  `run ${run.runId} already has ${liveWorkers} live worker(s); use ideaseek status or wait for them to exit`,
                );
              }
              if (run.status === 'PAUSED') {
                run = await db.resumeRun(run.runId);
                actions.push('resumed paused run');
              } else if (isBlockedRun(run.status)) {
                throw new IdeaseekError(
                  'RUN_BLOCKED',
                  `run is ${run.status}${run.blockReason ? `: ${run.blockReason}` : ''}; resolve it and run: ideaseek continue`,
                );
              } else {
                actions.push('adopted running run');
              }
            } else {
              const question = opts.question ?? (runtime.config.research.question || undefined);
              if (!question) {
                throw new IdeaseekError(
                  'USER_INPUT_REQUIRED',
                  'no active run; pass --question "..." to create one (or set research.question in research.yaml)',
                );
              }
              run = await db.createRun({
                projectId: runtime.project.id,
                question,
                config: runtime.config,
                strategy: runtime.config.research.mode,
              });
              await enqueueDemoPipeline(runtime, run, question, faults);
              actions.push('created run with demo pipeline');
            }

            if (!run) throw new IdeaseekError('INTERNAL', 'run state lost after create');

            if (opts.enqueueOnly) {
              const tasks = await db.listTasks(run.runId);
              if (opts.json) {
                process.stdout.write(
                  jsonLine({
                    runId: run.runId,
                    status: run.status,
                    actions,
                    tasks: countByStatus(tasks),
                  }),
                );
              } else {
                process.stdout.write(
                  `${actions.join('; ')} → run ${run.runId} (${tasks.length} tasks queued)\n`,
                );
                process.stdout.write(
                  'next: ideaseek worker   (or ideaseek run to execute inline)\n',
                );
              }
              return 0;
            }

            const { exit } = await runWorkerInteractive(runtime, run.runId, {
              kind: 'inline',
              handlers: demoHandlers,
              onLog: opts.json ? undefined : (message) => process.stderr.write(`  · ${message}\n`),
            });

            const finalRun = await db.getRun(run.runId);
            const tasks = await db.listTasks(run.runId);
            const counts = countByStatus(tasks);

            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  runId: run.runId,
                  status: finalRun?.status,
                  exitReason: exit.reason,
                  processed: exit.processed,
                  actions,
                  tasks: counts,
                  blockReason: finalRun?.blockReason ?? null,
                }),
              );
            } else {
              process.stdout.write(
                `run ${run.runId} → ${finalRun?.status} (processed ${exit.processed} task(s))\n`,
              );
              process.stdout.write(
                `  tasks: ${Object.entries(counts)
                  .filter(([, n]) => n > 0)
                  .map(([k, n]) => `${k}=${n}`)
                  .join(' ')}\n`,
              );
              if (finalRun?.status === 'QUOTA_EXHAUSTED') {
                process.stdout.write(
                  `  blocked: ${finalRun.blockReason ?? 'quota exhausted'}\n  next: ideaseek continue\n`,
                );
              }
              if (finalRun?.status === 'PAUSED') {
                process.stdout.write('  next: ideaseek resume\n');
              }
              if (finalRun?.status === 'FAILED') {
                process.stdout.write('  next: ideaseek status --detail\n');
              }
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
              case 'idle':
              case 'stopped':
                return exit.runStatus === 'RUNNING' ? 3 : 0;
              default:
                return 0;
            }
          } finally {
            await runtime.close();
          }
        },
      ),
    );
}

async function liveWorkersOf(runtime: ProjectRuntime, runId: string): Promise<number> {
  const workers = await runtime.db.listWorkers(runId);
  const cutoff = runtime.clock.now() - runtime.config.runtime.leaseTtlSeconds * 3000;
  return workers.filter((worker) => worker.heartbeatAt >= cutoff).length;
}
