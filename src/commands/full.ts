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
            'next: full-run execution is EXTERNAL — HANDOFF_READY is held, GPU/queue and the explicit full-run command land separately (never auto-launched)\n',
          );
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );
}
