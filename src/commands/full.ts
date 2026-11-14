import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { IdeaseekError } from '../core/errors.js';
import { ensureDir, writeFileAtomic } from '../core/atomic.js';
import { action, jsonLine } from './shared.js';

/**
 * `ideaseek full fairness / plan / approve` (docs/FULL_RESEARCH_MODE.md
 * CLI): fairness = per-method alignment lock vs protocol + idea spec
 * (machine-checked data/split, metrics, seeds; declared dimensions the
 * researcher confirms; missing inputs are blockers with recovery
 * commands). plan = deterministic readiness + lock over persisted state
 * (question, protocol, data/split, required comparisons, budget, time,
 * network, resources, licenses) — readiness REQUIRES a confirmed+current
 * fairness lock. approve = protected action `full-research`: guided
 * needs --confirm, autonomous records a Decision, review-only refuses;
 * approval binds to the plan's inputHash (stale state forces a
 * re-plan). Full RUN execution stays external (HANDOFF_READY + explicit
 * authorization + GPU/queue) and is NOT launched from here.
 */

async function openRoot(): Promise<string> {
  const { findProjectRoot } = await import('../config/paths.js');
  const root = await findProjectRoot(process.cwd());
  if (!root) {
    throw new IdeaseekError('NOT_INITIALIZED', 'no IdeaSeek project here; run: ideaseek init');
  }
  return root;
}

export function registerFullCommand(program: Command): void {
  const full = program
    .command('full')
    .description(
      'Full Research: fairness lock, plan and approve (execution stays externally authorized)',
    );

  full
    .command('fairness')
    .description(
      'build/confirm the per-method comparison fairness lock (alignment vs protocol + idea spec)',
    )
    .requiredOption('--idea <ideaId>', 'idea id')
    .option('--confirm', 'confirm the reviewed lock (required in guided mode)')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { idea: string; confirm?: boolean; json?: boolean }) => {
        const root = await openRoot();
        const { buildFairnessLock, assertFairnessApprovable } = await import('../full/fairness.js');
        const { join } = await import('node:path');
        const path = join(root, 'knowledge', `fairness-${opts.idea}.json`);
        await ensureDir(join(root, 'knowledge'));

        const { ProjectRuntime } = await import('../workflow/runtime.js');
        const { parseAutonomyMode, checkAutonomy, recordDecision } =
          await import('../workflow/autonomy.js');
        const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
        try {
          // The draft build (no --confirm) is a read-only report — same
          // privilege as `full plan`, allowed in every mode. Only the
          // lock action itself is gated (cheapest refusal first).
          const mode = parseAutonomyMode(runtime.config.policy.autonomyMode);
          const check = checkAutonomy(mode, 'lock-fairness', {
            confirmed: opts.confirm === true,
          });
          if (opts.confirm && !check.allowed) {
            if (opts.json) {
              process.stdout.write(
                jsonLine({ confirmed: false, reason: check.reason ?? 'refused', mode }),
              );
            } else {
              process.stderr.write(`fairness lock refused: ${check.reason ?? 'refused'}\n`);
            }
            return 2;
          }

          const fresh = await buildFairnessLock(root, opts.idea);
          let stored: typeof fresh | null = null;
          try {
            stored = JSON.parse(await readFile(path, 'utf8')) as typeof fresh;
          } catch {
            stored = null;
          }

          if (!opts.confirm) {
            // Draft build (review step). An unchanged, already-confirmed
            // lock keeps its stamp — rebuilding must not silently revoke.
            const preserved =
              stored?.confirmed && stored.inputHash === fresh.inputHash ? stored.confirmed : null;
            const unchangedConfirmed = preserved !== null;
            const toWrite = preserved ? { ...fresh, confirmed: preserved } : fresh;
            await writeFileAtomic(path, `${JSON.stringify(toWrite, null, 2)}\n`);
            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  path,
                  inputHash: fresh.inputHash,
                  confirmed: unchangedConfirmed,
                  blockers: fresh.blockers,
                  methods: fresh.methods.map((entry) => ({
                    methodId: entry.methodId,
                    deviations: entry.deviations,
                    unknowns: entry.dimensions
                      .filter((dimension) => dimension.status === 'unknown')
                      .map((dimension) => dimension.dimension),
                  })),
                }),
              );
              return 0;
            }
            process.stdout.write(
              `fairness lock for ${opts.idea}: ${fresh.blockers.length === 0 ? 'READY to confirm' : 'NOT READY'} ` +
                `(${fresh.methods.length} required method(s))\n`,
            );
            process.stdout.write(
              `  protocol: ${fresh.protocol?.protocolId ?? 'none'} · reference spec: ${fresh.reference.specId ?? 'none'} · seeds [${fresh.reference.seeds.join(', ')}]\n`,
            );
            for (const blocker of fresh.blockers) {
              process.stdout.write(`  blocker: ${blocker}\n`);
            }
            for (const entry of fresh.methods) {
              const aligned = entry.dimensions.filter((d) => d.status === 'aligned').length;
              process.stdout.write(
                `  ${entry.methodId}: ${aligned} aligned · ${entry.deviations.length} deviation(s) · ${entry.dimensions.filter((d) => d.status === 'unknown').length} declared\n`,
              );
              for (const deviation of entry.deviations) {
                process.stdout.write(`    deviation: ${deviation}\n`);
              }
            }
            process.stdout.write(`  file: knowledge/fairness-${opts.idea}.json\n`);
            process.stdout.write(
              fresh.blockers.length === 0
                ? `next: review the report, then ideaseek full fairness --idea ${opts.idea} --confirm\n`
                : 'next: clear the blockers above, then rerun ideaseek full fairness\n',
            );
            return 0;
          }

          // Confirm: the reviewed draft must still match current state.
          if (!stored) {
            throw new IdeaseekError(
              'USER_INPUT_REQUIRED',
              `no fairness lock for ${opts.idea} — run: ideaseek full fairness --idea ${opts.idea}`,
            );
          }
          assertFairnessApprovable(stored, fresh.inputHash);

          const now = Date.now();
          const confirmedLock = {
            ...fresh,
            confirmed: { at: now, mode, inputHash: fresh.inputHash },
          };
          await writeFileAtomic(path, `${JSON.stringify(confirmedLock, null, 2)}\n`);

          let decisionSeq: number | null = null;
          if (check.needsDecision) {
            const decision = await recordDecision(runtime.db, runtime.project.id, {
              action: 'lock-fairness',
              target: `${opts.idea} (fairness ${fresh.inputHash.slice(0, 12)})`,
              mode,
            });
            decisionSeq = decision?.seq ?? null;
          }

          if (opts.json) {
            process.stdout.write(
              jsonLine({
                confirmed: true,
                mode,
                decisionSeq,
                inputHash: fresh.inputHash,
                methods: fresh.methods.length,
                path,
              }),
            );
            return 0;
          }
          process.stdout.write(
            `fairness lock CONFIRMED for ${opts.idea} [${mode}] (${fresh.inputHash.slice(0, 12)}…)\n`,
          );
          process.stdout.write(
            `  ${fresh.methods.length} required method(s), ` +
              `${fresh.methods.reduce((sum, entry) => sum + entry.deviations.length, 0)} recorded deviation(s)\n`,
          );
          if (decisionSeq !== null) {
            process.stdout.write(`  decision recorded (event #${decisionSeq})\n`);
          }
          process.stdout.write(
            `next: ideaseek full plan --idea ${opts.idea} (the plan requires this lock to be current)\n`,
          );
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );

  full
    .command('plan')
    .description('build the reviewable full-research lock for an idea (read-only over state)')
    .requiredOption('--idea <ideaId>', 'idea id')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { idea: string; json?: boolean }) => {
        const root = await openRoot();
        const { buildFullPlan } = await import('../full/plan.js');
        const plan = await buildFullPlan(root, opts.idea);
        const { join } = await import('node:path');
        const path = join(root, 'knowledge', `full-plan-${opts.idea}.json`);
        await ensureDir(join(root, 'knowledge'));
        await writeFileAtomic(path, `${JSON.stringify(plan, null, 2)}\n`);

        if (opts.json) {
          process.stdout.write(jsonLine({ path, plan }));
          return 0;
        }
        process.stdout.write(
          `full plan for ${opts.idea}: ${plan.readiness.ready ? 'READY' : 'NOT READY'} ` +
            `(handoff ${plan.readiness.handoffLevel})\n`,
        );
        process.stdout.write(`  question: ${plan.question.slice(0, 120)}\n`);
        process.stdout.write(
          `  lock: protocol ${plan.lock.protocol?.protocolId ?? 'none'} · ` +
            `data ${plan.lock.dataSnapshotId ?? 'none'} · slices ${plan.lock.sliceIds.length} · seeds ${plan.lock.seeds.length}\n`,
        );
        process.stdout.write(
          `  comparisons: gate=${plan.comparisons.gateOk ? 'ok' : 'BLOCKED'} required=${plan.comparisons.required.length}\n`,
        );
        process.stdout.write(
          `  fairness: ${plan.fairness.current ? 'confirmed+current' : plan.fairness.present ? 'stale/unconfirmed' : 'missing'}` +
            (plan.fairness.blockers.length > 0
              ? ` (${plan.fairness.blockers.length} blocker(s))`
              : '') +
            '\n',
        );
        process.stdout.write(
          `  budget: maxModelCost=${plan.budget.maxModelCost ?? '∞'} maxGpuHours=${plan.budget.maxGpuHours ?? '∞'} · network allow=${plan.network.allowNetwork} search=${plan.network.externalSearch}\n`,
        );
        process.stdout.write(
          `  resources: ${plan.resources.gpus} GPU · ${plan.resources.memoryGiB} GiB free mem · disk ${plan.resources.diskFreeGiB ?? '?'} GiB\n`,
        );
        if (!plan.readiness.ready) {
          for (const blocker of plan.readiness.blockers.slice(0, 8)) {
            process.stdout.write(`  blocker: ${blocker}\n`);
          }
        }
        for (const need of plan.approvalsNeeded) {
          process.stdout.write(`  confirm: ${need}\n`);
        }
        process.stdout.write(`  file: knowledge/full-plan-${opts.idea}.json\n`);
        process.stdout.write(
          plan.readiness.ready
            ? `next: ideaseek full approve --idea ${opts.idea} --confirm\n`
            : 'next: clear the blockers above, then rerun ideaseek full plan\n',
        );
        return 0;
      }),
    );

  full
    .command('approve')
    .description(
      'approve a READY full-research plan (protected action; records Decision/Event, never launches runs)',
    )
    .requiredOption('--idea <ideaId>', 'idea id')
    .option('--confirm', 'required in guided mode')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { idea: string; confirm?: boolean; json?: boolean }) => {
        const root = await openRoot();
        const { buildFullPlan, assertApprovable } = await import('../full/plan.js');
        const { join } = await import('node:path');
        const path = join(root, 'knowledge', `full-plan-${opts.idea}.json`);

        let stored: Awaited<ReturnType<typeof buildFullPlan>> | null = null;
        try {
          stored = JSON.parse(await readFile(path, 'utf8')) as Awaited<
            ReturnType<typeof buildFullPlan>
          >;
        } catch {
          stored = null;
        }
        if (!stored) {
          throw new IdeaseekError(
            'USER_INPUT_REQUIRED',
            `no full plan for ${opts.idea} — run: ideaseek full plan --idea ${opts.idea}`,
          );
        }

        const { ProjectRuntime } = await import('../workflow/runtime.js');
        const { parseAutonomyMode, checkAutonomy, recordDecision } =
          await import('../workflow/autonomy.js');
        const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
        try {
          // Mode gate first (cheapest refusal): guided needs --confirm,
          // autonomous records, review-only refuses outright.
          const mode = parseAutonomyMode(runtime.config.policy.autonomyMode);
          const check = checkAutonomy(mode, 'full-research', { confirmed: opts.confirm });
          if (!check.allowed) {
            if (opts.json) {
              process.stdout.write(
                jsonLine({ approved: false, reason: check.reason ?? 'refused', mode }),
              );
            } else {
              process.stderr.write(`full approve refused: ${check.reason ?? 'refused'}\n`);
              if (check.needsConfirm) {
                process.stderr.write(`next: ideaseek full approve --idea ${opts.idea} --confirm\n`);
              }
            }
            return 2;
          }

          // Freshness + readiness gates (pure, unit-tested).
          const current = await buildFullPlan(root, opts.idea);
          assertApprovable(stored, current.inputHash);

          const now = Date.now();
          stored.approval = { at: now, mode, planInputHash: stored.inputHash };
          await writeFileAtomic(path, `${JSON.stringify(stored, null, 2)}\n`);

          let decisionSeq: number | null = null;
          if (check.needsDecision) {
            const decision = await recordDecision(runtime.db, runtime.project.id, {
              action: 'full-research',
              target: `${opts.idea} (plan ${stored.inputHash.slice(0, 12)})`,
              mode,
            });
            decisionSeq = decision?.seq ?? null;
          }

          if (opts.json) {
            process.stdout.write(
              jsonLine({
                approved: true,
                mode,
                decisionSeq,
                planInputHash: stored.inputHash,
                question: stored.question,
                path,
              }),
            );
            return 0;
          }
          process.stdout.write(
            `full research APPROVED for ${opts.idea} [${mode}] (plan ${stored.inputHash.slice(0, 12)}…)\n`,
          );
          if (decisionSeq !== null) {
            process.stdout.write(`  decision recorded (event #${decisionSeq})\n`);
          }
          process.stdout.write(
            'next: ideaseek full run --idea ' +
              `${opts.idea} --confirm   (platform-executed full-scale run; never auto-launched)\n`,
          );
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );

  full
    .command('run')
    .description(
      'execute the approved full-scale work list (protected; reuses the workflow queue, never auto-launched)',
    )
    .requiredOption('--idea <ideaId>', 'idea id')
    .option('--confirm', 'launch authorization (required in guided mode)')
    .option('--enqueue-only', 'queue the full.run task and exit')
    .option('--detach', 'spawn a background supervisor and return immediately')
    .option(
      '--fault <json>',
      'fault injection map keyed by task type, e.g. \'{"full.run":{"failTimes":1}}\'',
    )
    .option(
      '--harness <kind>',
      'agent harness: fake | dsh (default: dsh when a key is configured, else fake with a warning)',
    )
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (opts: {
          idea: string;
          confirm?: boolean;
          enqueueOnly?: boolean;
          detach?: boolean;
          fault?: string;
          harness?: string;
          json?: boolean;
        }) => {
          const root = await openRoot();
          const { parseAutonomyMode, checkAutonomy, recordDecision } =
            await import('../workflow/autonomy.js');
          const shared = await import('./shared.js');
          const { ProjectRuntime } = await import('../workflow/runtime.js');
          const runtime = await ProjectRuntime.open({
            cwd: root,
            harness: shared.buildHarness(shared.resolveHarnessKind(opts.harness)),
          });
          let lockHeld = false;
          let lockRoot: string | null = null;
          try {
            shared.assertConfigUsable(runtime.configLoad);

            // Cheapest refusal first: launch is a protected full-research
            // action (guided needs --confirm, review-only refuses).
            const mode = parseAutonomyMode(runtime.config.policy.autonomyMode);
            const check = checkAutonomy(mode, 'full-research', {
              confirmed: opts.confirm === true,
            });
            if (!check.allowed) {
              if (opts.json) {
                process.stdout.write(
                  jsonLine({ started: false, reason: check.reason ?? 'refused', mode }),
                );
              } else {
                process.stderr.write(`full run refused: ${check.reason ?? 'refused'}\n`);
                if (check.needsConfirm) {
                  process.stderr.write(`next: ideaseek full run --idea ${opts.idea} --confirm\n`);
                }
              }
              return 2;
            }

            // Authorization: approved + fresh plan, every required method
            // has a runnable entry (no silent skips).
            const { authorizeFullRun } = await import('../full/run.js');
            const auth = await authorizeFullRun(root, opts.idea);

            // One mutating controller at a time (same lock as `run`).
            const { findProjectRoot } = await import('../config/paths.js');
            lockRoot = await findProjectRoot(process.cwd());
            if (lockRoot) {
              const { acquireProjectLock } = await import('../runtime/project-lock.js');
              const acquired = await acquireProjectLock(lockRoot, 'run');
              lockHeld = acquired.acquired;
              if (acquired.tookOverStale && !opts.json) {
                process.stdout.write(
                  'note: took over a stale project lock (previous pid is gone)\n',
                );
              }
            }

            const { ensureActiveRun } = await import('./ingest.js');
            const { runId } = await ensureActiveRun(runtime);
            const faults = shared.parseFaultSpec(opts.fault);
            const { created } = await runtime.db.enqueueTask({
              runId,
              type: 'full.run',
              phase: 'DEMO',
              payload: {
                ideaId: opts.idea,
                planInputHash: auth.planInputHash,
                ...(faults['full.run'] ? { fault: faults['full.run'] } : {}),
              },
              dependsOn: [],
              idempotencyKey: `fullrun:${opts.idea}:${auth.planInputHash.slice(7, 19)}:v1`,
              maxAttempts: runtime.config.runtime.maxAttempts,
            });

            // Launch Decision (protected action — never silent).
            let decisionSeq: number | null = null;
            if (check.needsDecision) {
              const decision = await recordDecision(runtime.db, runtime.project.id, {
                action: 'full-research',
                target: `full run ${opts.idea} (plan ${auth.planInputHash.slice(0, 12)})`,
                mode,
              });
              decisionSeq = decision?.seq ?? null;
            }

            if (opts.enqueueOnly) {
              const tasks = await runtime.db.listTasks(runId);
              if (opts.json) {
                process.stdout.write(
                  jsonLine({
                    runId,
                    enqueued: created,
                    planInputHash: auth.planInputHash,
                    work: auth.work,
                    decisionSeq,
                    tasks: shared.countByStatus(tasks),
                  }),
                );
              } else {
                process.stdout.write(
                  `full run: ${created ? '1 task enqueued' : 'task already queued'} in run ${runId}\n`,
                );
                process.stdout.write(
                  `  work: ${auth.work.map((item) => `${item.kind}:${item.id}`).join(', ')}\n`,
                );
                process.stdout.write(
                  'next: ideaseek worker   (or ideaseek full run to execute inline)\n',
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
              const { projectPaths } = await import('../config/paths.js');
              const { ensureDir } = await import('../core/atomic.js');
              const { openSync, closeSync } = await import('node:fs');
              const { spawn } = await import('node:child_process');
              const { join: joinPath } = await import('node:path');
              const { readCliVersion, writeDaemonInfo } = await import('../runtime/daemon.js');
              const paths = projectPaths(process.cwd());
              await ensureDir(paths.logsDir);
              const logPath = joinPath(paths.logsDir, `${runId}.log`);
              const fd = openSync(logPath, 'a');
              const child = spawn(
                process.execPath,
                [script, 'supervise', '--run', runId, '--harness', opts.harness ?? 'fake'],
                { cwd: process.cwd(), detached: true, stdio: ['ignore', fd, fd] },
              );
              closeSync(fd);
              if (!child.pid) {
                throw new IdeaseekError('INTERNAL', 'failed to spawn background supervisor');
              }
              child.unref();
              writeDaemonInfo(paths.researchDir, {
                runId,
                pid: child.pid,
                startedAt: Date.now(),
                heartbeatAt: Date.now(),
                logPath,
                version: readCliVersion(),
              });
              if (opts.json) {
                process.stdout.write(
                  jsonLine({ runId, detached: true, pid: child.pid, logPath, decisionSeq }),
                );
              } else {
                process.stdout.write(
                  `detached supervisor for full run ${runId} (pid ${child.pid})\n`,
                );
                process.stdout.write(`  log: ${logPath}\n`);
                process.stdout.write(`next: ideaseek attach --run ${runId}\n`);
              }
              return 0;
            }

            const { exit } = await shared.runWorkerInteractive(runtime, runId, {
              kind: 'inline',
              handlers: shared.buildHandlers(),
              // Worker logs always go to stderr so --json stdout stays parseable.
              onLog: (message: string) => process.stderr.write(`  · ${message}\n`),
            });
            const finalRun = await runtime.db.getRun(runId);
            const counts = shared.countByStatus(await runtime.db.listTasks(runId));

            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  runId,
                  status: finalRun?.status,
                  exitReason: exit.reason,
                  processed: exit.processed,
                  planInputHash: auth.planInputHash,
                  decisionSeq,
                  tasks: counts,
                  blockReason: finalRun?.blockReason ?? null,
                }),
              );
            } else {
              process.stdout.write(
                `full run ${opts.idea} → ${finalRun?.status} (processed ${exit.processed} task(s))\n`,
              );
              process.stdout.write(
                `  tasks: ${Object.entries(counts)
                  .filter(([, n]) => n > 0)
                  .map(([k, n]) => `${k}=${n}`)
                  .join(' ')}\n`,
              );
              if (decisionSeq !== null) {
                process.stdout.write(`  decision recorded (event #${decisionSeq})\n`);
              }
              if (finalRun?.status === 'QUOTA_EXHAUSTED') {
                process.stdout.write(
                  `  blocked: ${finalRun.blockReason ?? 'quota exhausted'}\n  next: ideaseek continue\n`,
                );
              }
              if (finalRun?.status === 'PAUSED') {
                process.stdout.write('  next: ideaseek resume\n');
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
            if (lockHeld && lockRoot) {
              const { releaseProjectLock } = await import('../runtime/project-lock.js');
              await releaseProjectLock(lockRoot);
            }
          }
        },
      ),
    );
}
