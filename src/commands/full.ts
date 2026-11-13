import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { IdeaseekError } from '../core/errors.js';
import { ensureDir, writeFileAtomic } from '../core/atomic.js';
import { action, jsonLine } from './shared.js';

/**
 * `ideaseek full plan / approve` (docs/FULL_RESEARCH_MODE.md CLI):
 * plan = deterministic readiness + lock over persisted state (question,
 * protocol, data/split, required comparisons, budget, time, network,
 * resources, licenses). approve = protected action `full-research`:
 * guided needs --confirm, autonomous records a Decision, review-only
 * refuses; approval binds to the plan's inputHash (stale state forces a
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
    .description('Full Research: plan and approve (execution stays externally authorized)');

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
