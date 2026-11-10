import type { Command } from 'commander';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { ensureDir } from '../core/atomic.js';
import { IdeaseekError } from '../core/errors.js';
import { projectPaths } from '../config/paths.js';
import { readCliVersion, writeDaemonInfo } from '../runtime/daemon.js';
import { ProjectRuntime } from '../workflow/runtime.js';
import { readFile, stat } from 'node:fs/promises';
import { basename, relative, resolve as resolvePath } from 'node:path';
import { countInputs, resolveStrategy } from '../workflow/strategy.js';
import {
  action,
  assertConfigUsable,
  buildHandlers,
  buildHarness,
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
    .option('--detach', 'start a background supervisor and return immediately')
    .option('--fault <json>', 'fault injection map, e.g. \'{"demo.analyze":{"crash":true}}\'')
    .option('--paper <path>', 'also enqueue a Phase 1 paper.extract task for this text file')
    .option('--harness <kind>', 'agent harness: fake (default) or dsh', 'fake')
    .option('--force', 'attach even if another live worker holds this run')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (opts: {
          question?: string;
          run?: string;
          enqueueOnly?: boolean;
          detach?: boolean;
          fault?: string;
          paper?: string;
          harness?: string;
          force?: boolean;
          json?: boolean;
        }) => {
          const runtime = await ProjectRuntime.open({
            cwd: process.cwd(),
            harness: buildHarness(opts.harness),
          });
          try {
            assertConfigUsable(runtime.configLoad);
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
              const counts = await countInputs(runtime.paths.root, {
                papers: runtime.config.inputs.papersDir,
                datasets: runtime.config.inputs.datasetsDir,
                comparisons: runtime.config.inputs.comparisonsDir,
              });
              run = await db.createRun({
                projectId: runtime.project.id,
                question,
                config: runtime.config,
                strategy: resolveStrategy(runtime.config.research.mode, counts),
              });
              await enqueueDemoPipeline(runtime, run, question, faults);
              if (opts.paper) {
                await enqueuePaperExtract(runtime, run.runId, opts.paper);
                actions.push('created run with demo pipeline + paper.extract');
              } else {
                actions.push('created run with demo pipeline');
              }
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

            if (opts.detach) {
              const script = process.argv[1];
              if (!script) {
                throw new IdeaseekError(
                  'INTERNAL',
                  'cannot resolve ideaseek script path for --detach',
                );
              }
              const paths = projectPaths(process.cwd());
              await ensureDir(paths.logsDir);
              const logPath = join(paths.logsDir, `${run.runId}.log`);
              const fd = openSync(logPath, 'a');
              const child = spawn(
                process.execPath,
                [script, 'supervise', '--run', run.runId, '--harness', opts.harness ?? 'fake'],
                {
                  cwd: process.cwd(),
                  detached: true,
                  stdio: ['ignore', fd, fd],
                },
              );
              closeSync(fd);
              if (!child.pid) {
                throw new IdeaseekError('INTERNAL', 'failed to spawn background supervisor');
              }
              child.unref();
              writeDaemonInfo(paths.researchDir, {
                runId: run.runId,
                pid: child.pid,
                startedAt: Date.now(),
                heartbeatAt: Date.now(),
                logPath,
                version: readCliVersion(),
              });
              if (opts.json) {
                process.stdout.write(
                  jsonLine({
                    runId: run.runId,
                    detached: true,
                    pid: child.pid,
                    logPath,
                    tasks: countByStatus(await db.listTasks(run.runId)),
                  }),
                );
              } else {
                process.stdout.write(
                  `detached supervisor started for run ${run.runId} (pid ${child.pid})
`,
                );
                process.stdout.write(`  log: ${logPath}
`);
                process.stdout.write(`next: ideaseek attach --run ${run.runId}
`);
              }
              return 0;
            }

            const { exit } = await runWorkerInteractive(runtime, run.runId, {
              kind: 'inline',
              handlers: buildHandlers(),
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
/**
 * Enqueues the paper pipeline for `--paper`:
 * - `.pdf` → `paper.parse` (page-tagged text) then `paper.extract` chained on
 *   it, so page locators survive into the structured card;
 * - anything else → treated as a text excerpt, extracted directly.
 * Both tasks are idempotent per run, so re-running is a no-op.
 */
async function enqueuePaperExtract(
  runtime: ProjectRuntime,
  runId: string,
  paperPathArg: string,
): Promise<void> {
  const paperPath = resolvePath(process.cwd(), paperPathArg);
  let info;
  try {
    info = await stat(paperPath);
  } catch (error) {
    throw new IdeaseekError(
      'USER_INPUT_REQUIRED',
      `cannot read --paper file ${paperPathArg}: ${(error as Error).message}`,
    );
  }
  if (!info.isFile()) {
    throw new IdeaseekError('USER_INPUT_REQUIRED', `--paper path is not a file: ${paperPathArg}`);
  }
  const isPdf = paperPath.toLowerCase().endsWith('.pdf');
  const maxBytes = isPdf ? 50 * 1024 * 1024 : 256 * 1024;
  if (info.size > maxBytes) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `--paper file exceeds the limit of ${maxBytes} bytes${isPdf ? '' : ' (pass an excerpt)'}`,
    );
  }

  const relPath = relative(runtime.paths.root, paperPath).split(/[\\/]/).join('/');
  if (relPath.startsWith('..')) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `--paper file must live inside the project (got ${paperPathArg})`,
    );
  }

  let dependsOn: string[] = [];
  if (isPdf) {
    const parsed = await runtime.db.enqueueTask({
      runId,
      type: 'paper.parse',
      phase: 'DEMO',
      payload: { pdfPath: relPath, nonBlocking: true },
      dependsOn: [],
      idempotencyKey: 'paper.parse:v1',
      maxAttempts: runtime.config.runtime.maxAttempts,
    });
    dependsOn = [parsed.task.taskId];
  }

  let paperText = '';
  if (!isPdf) {
    try {
      paperText = await readFile(paperPath, 'utf8');
    } catch (error) {
      throw new IdeaseekError(
        'USER_INPUT_REQUIRED',
        `cannot read --paper file ${paperPathArg}: ${(error as Error).message}`,
      );
    }
  }

  const extract = await runtime.db.enqueueTask({
    runId,
    type: 'paper.extract',
    phase: 'DEMO',
    payload: { paperName: basename(paperPath), paperText, sourcePath: relPath },
    dependsOn,
    idempotencyKey: 'paper.extract:v1',
    maxAttempts: runtime.config.runtime.maxAttempts,
  });

  // Evidence Checker runs deterministically after extraction.
  await runtime.db.enqueueTask({
    runId,
    type: 'paper.verify',
    phase: 'DEMO',
    payload: { sourcePath: relPath },
    dependsOn: [extract.task.taskId],
    idempotencyKey: 'paper.verify:v1',
    maxAttempts: runtime.config.runtime.maxAttempts,
  });
}
