import type { Command } from 'commander';
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { basename, join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { ensureDir } from '../core/atomic.js';
import { killTree } from '../core/proc.js';
import { projectPaths } from '../config/paths.js';
import { ProjectRuntime } from '../workflow/runtime.js';
import {
  action,
  assertConfigUsable,
  buildHarness,
  countByStatus,
  jsonLine,
  resolveHarnessKind,
} from './shared.js';
import { ensureActiveRun } from './ingest.js';

/**
 * Sources with a committed parsed-paper artifact vs sources whose extraction
 * already succeeded (or is queued in a live run) — the incremental decision
 * for the batch map stage. Pure so the selection is unit-testable.
 */
export function selectPendingExtracts(
  parsedSources: Iterable<string>,
  extractedOrBusy: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const pending: string[] = [];
  for (const source of parsedSources) {
    if (!source || extractedOrBusy.has(source) || seen.has(source)) continue;
    seen.add(source);
    pending.push(source);
  }
  return pending.sort();
}

async function committedSourcesOf(
  runtime: ProjectRuntime,
  kind: 'parsed-paper' | 'papercard',
): Promise<Set<string>> {
  const sources = new Set<string>();
  for (const artifact of await runtime.db.listArtifactsByKind(kind)) {
    try {
      const payload = JSON.parse(await runtime.store.readFinalText(artifact.contentHash)) as {
        source?: string;
      };
      const source =
        kind === 'parsed-paper'
          ? (payload as { source?: string }).source
          : ((payload as { source?: { sourcePath?: string } }).source?.sourcePath ?? null);
      if (source) sources.add(source);
    } catch {
      continue;
    }
  }
  return sources;
}

function runCliChild(args: string[], logFd: number) {
  const script = process.argv[1];
  if (!script) {
    throw new IdeaseekError('INTERNAL', 'cannot resolve ideaseek script path for extract workers');
  }
  return spawn(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    stdio: ['ignore', logFd, logFd],
  });
}

/**
 * `ideaseek extract` — the Phase 2 parallel map stage: enqueues
 * paper.extract for every parsed-but-unextracted paper (incremental,
 * cross-run), then drives K concurrent `worker` children on the same run.
 * Claiming is atomic in the DB, so K children = K papers in flight; the
 * evidence-verification tasks trail their extracts via dependencies.
 */
export function registerExtractCommand(program: Command): void {
  program
    .command('extract')
    .description('batch-extract parsed papers with K parallel workers (incremental map stage)')
    .option('--parallel <k>', 'parallel workers (1-4)', (value) => Number(value))
    .option('--limit <n>', 'only enqueue up to N pending papers', (value) => Number(value))
    .option('--run <runId>', 'target run (default: create or adopt an active run)')
    .option(
      '--harness <kind>',
      'agent harness: fake | dsh (default: dsh when a key is configured, else fake with a warning)',
    )
    .option('--enqueue-only', 'enqueue extract tasks without executing')
    .option('--timeout <ms>', 'bound on waiting for workers', (value) => Number(value))
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (opts: {
          parallel?: number;
          limit?: number;
          run?: string;
          harness?: string;
          enqueueOnly?: boolean;
          timeout?: number;
          json?: boolean;
        }) => {
          const runtime = await ProjectRuntime.open({
            cwd: process.cwd(),
            harness: buildHarness(resolveHarnessKind(opts.harness)),
          });
          try {
            assertConfigUsable(runtime.configLoad);

            const parsedSources = await committedSourcesOf(runtime, 'parsed-paper');
            if (parsedSources.size === 0) {
              throw new IdeaseekError(
                'USER_INPUT_REQUIRED',
                'no parsed papers found; run: ideaseek ingest',
              );
            }
            const extracted = await committedSourcesOf(runtime, 'papercard');
            // Busy sources: extract tasks queued/running in non-terminal runs.
            const runs = [await runtime.db.getLatestRun(runtime.project.id)].filter(
              (run): run is NonNullable<typeof run> =>
                run !== null && !['FAILED', 'CANCELED', 'COMPLETED'].includes(run.status),
            );
            for (const run of runs) {
              for (const task of await runtime.db.listTasks(run.runId)) {
                if (task.type !== 'paper.extract') continue;
                if (['failed', 'canceled'].includes(task.status)) continue;
                const source = task.payload.sourcePath;
                if (typeof source === 'string' && source) extracted.add(source);
              }
            }

            const allPending = selectPendingExtracts(parsedSources, extracted);
            const pending = Number.isFinite(opts.limit)
              ? allPending.slice(0, Math.max(1, opts.limit ?? 1))
              : allPending;

            if (pending.length === 0) {
              if (opts.json) {
                process.stdout.write(
                  jsonLine({
                    pending: 0,
                    alreadyExtracted: extracted.size,
                    action: 'nothing-to-do',
                  }),
                );
              } else {
                process.stdout.write(
                  `extract: all ${parsedSources.size} parsed paper(s) already extracted, nothing to do\n`,
                );
                process.stdout.write('next: ideaseek report   (or ideaseek search <terms>)\n');
              }
              return 0;
            }

            let runId: string;
            let created = false;
            let resumed = false;
            if (opts.run) {
              const target = await runtime.db.getRun(opts.run);
              if (!target) throw new IdeaseekError('RUN_NOT_FOUND', `run ${opts.run} not found`);
              if (['FAILED', 'CANCELED', 'COMPLETED'].includes(target.status)) {
                throw new IdeaseekError(
                  'RUN_TERMINAL',
                  `run ${opts.run} already finished (${target.status}); use a fresh run`,
                );
              }
              runId = target.runId;
            } else {
              const adopted = await ensureActiveRun(runtime);
              runId = adopted.runId;
              created = adopted.created;
              resumed = adopted.resumed;
            }
            const actions: string[] = [];
            if (created) actions.push('created run');
            if (resumed) actions.push('resumed run');

            let enqueued = 0;
            for (const source of pending) {
              const extract = await runtime.db.enqueueTask({
                runId,
                type: 'paper.extract',
                phase: 'DEMO',
                payload: {
                  paperName: basename(source),
                  paperText: '',
                  sourcePath: source,
                  nonBlocking: true,
                },
                dependsOn: [],
                idempotencyKey: `extract:${source}:v1`,
                maxAttempts: runtime.config.runtime.maxAttempts,
              });
              if (extract.created) enqueued += 1;
              // Evidence verification trails its extract via dependency.
              await runtime.db.enqueueTask({
                runId,
                type: 'paper.verify',
                phase: 'DEMO',
                payload: { sourcePath: source, nonBlocking: true },
                dependsOn: [extract.task.taskId],
                idempotencyKey: `verify:${source}:v1`,
                maxAttempts: runtime.config.runtime.maxAttempts,
              });
            }

            if (opts.enqueueOnly) {
              if (opts.json) {
                process.stdout.write(
                  jsonLine({ pending: pending.length, enqueued, runId, actions }),
                );
              } else {
                process.stdout.write(
                  `extract: ${enqueued} task(s) enqueued into ${runId} (${pending.length - enqueued} already queued)\n`,
                );
                process.stdout.write(
                  'next: ideaseek worker   (or ideaseek extract again to drive)\n',
                );
              }
              return 0;
            }

            // Parallel map: K concurrent worker children on the same run.
            const k = Math.min(4, Math.max(1, opts.parallel ?? 2));
            const paths = projectPaths(process.cwd());
            await ensureDir(paths.logsDir);
            const logPath = join(paths.logsDir, `extract-${Date.now()}.log`);
            const fd = openSync(logPath, 'a');
            const children = [];
            for (let i = 0; i < k; i += 1) {
              children.push(
                runCliChild(
                  [
                    'worker',
                    '--run',
                    runId,
                    '--harness',
                    opts.harness ?? 'fake',
                    '--idle-exit',
                    '3000',
                  ],
                  fd,
                ),
              );
            }
            const timeoutMs = Number.isFinite(opts.timeout) ? (opts.timeout as number) : 600_000;
            const deadline = Date.now() + timeoutMs;
            let timedOut = false;
            while (children.some((child) => child.exitCode === null && child.signalCode === null)) {
              if (Date.now() > deadline) {
                timedOut = true;
                await Promise.all(children.map((child) => killTree(child.pid)));
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 1500));
            }
            closeSync(fd);

            const finalRun = await runtime.db.getRun(runId);
            const tasks = await runtime.db.listTasks(runId);
            const counts = countByStatus(tasks);
            const unfinished =
              (counts.queued ?? 0) +
              (counts.leased ?? 0) +
              (counts.running ?? 0) +
              (counts.committing ?? 0);

            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  runId,
                  parallel: k,
                  pending: pending.length,
                  enqueued,
                  status: finalRun?.status,
                  tasks: counts,
                  unfinished,
                  timedOut,
                  logPath,
                  actions,
                }),
              );
            } else {
              process.stdout.write(
                `extract → run ${runId} with ${k} parallel worker(s): ` +
                  `${counts.succeeded ?? 0} succeeded, ${counts.failed ?? 0} failed, ${unfinished} unfinished\n`,
              );
              process.stdout.write(`  log: ${logPath}\n`);
              if (timedOut) process.stdout.write('  workers hit the timeout and were stopped\n');
              if (finalRun?.blockReason) {
                process.stdout.write(`  blocked: ${finalRun.blockReason}\n`);
              }
            }

            if (timedOut) return 3;
            switch (finalRun?.status) {
              case 'COMPLETED':
                return 0;
              case 'FAILED':
                return 1;
              case 'CANCELED':
                return 4;
              case 'QUOTA_EXHAUSTED':
              case 'AUTH_REQUIRED':
              case 'NETWORK_BLOCKED':
              case 'FAILED_RECOVERABLE':
                return 2;
              default:
                return unfinished > 0 ? 3 : 0;
            }
          } finally {
            await runtime.close();
          }
        },
      ),
    );
}
