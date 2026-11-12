import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { ensureDir, writeFileAtomic } from '../core/atomic.js';
import { action, buildHarness, jsonLine } from './shared.js';

/**
 * `ideaseek paper plan` — Phase 4.5C capability 1: the vendored ARIS
 * paper-plan skill as an IdeaSeek use-case. The prompt is the skill body
 * plus an explicit output contract; the context is a read-only snapshot of
 * persisted, hashable state (protocol locks, comparisons, experiment
 * results, idea analyses, research map) so every cited source traces back
 * to an artifact. Skill integrity is verified BEFORE any model call; a
 * quota/auth block writes nothing; identical inputs reuse the stored plan.
 */

interface StoredPlan {
  contract: string;
  inputHash: string;
  skill: { name: string; sha256: string };
  snapshot: unknown;
  harnessRuntime: string;
  generatedAt: number;
  plan: Record<string, unknown>;
}

function planPath(root: string): string {
  return join(root, 'reports', 'paper', 'plan.json');
}

async function readStoredPlan(root: string): Promise<StoredPlan | null> {
  try {
    return JSON.parse(await readFile(planPath(root), 'utf8')) as StoredPlan;
  } catch {
    return null;
  }
}

export function registerPaperCommand(program: Command): void {
  const paper = program
    .command('paper')
    .description('paper delivery workflows (ARIS paper-* skills over locked results)');

  paper
    .command('plan')
    .description('generate a structured paper outline from persisted results (ARIS paper-plan)')
    .option(
      '--harness <kind>',
      'model harness: fake | dsh (default: dsh when a key is configured, else fake)',
    )
    .option('--force', 'ignore a stored plan.json and regenerate')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { harness?: string; force?: boolean; json?: boolean }) => {
        const root = await findRoot();
        const { loadArisSkill } = await import('../aris/skill.js');
        // Integrity gate BEFORE any model call (ADR-008).
        const skill = await loadArisSkill('paper-plan');
        const {
          PAPER_PLAN_SCHEMA,
          buildPaperPlanRequest,
          collectPaperPlanSnapshot,
          parsePaperPlanOutput,
        } = await import('../paper/plan.js');
        const snapshot = await collectPaperPlanSnapshot(root);
        const request = buildPaperPlanRequest(skill, snapshot);

        if (!opts.force) {
          const stored = await readStoredPlan(root);
          if (stored && stored.inputHash === request.inputHash) {
            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  contract: stored.contract,
                  inputHash: stored.inputHash,
                  skill: stored.skill,
                  harnessRuntime: stored.harnessRuntime,
                  reused: true,
                  plan: stored.plan,
                  path: planPath(root),
                }),
              );
            } else {
              process.stdout.write(
                `reused paper plan (same inputHash ${stored.inputHash.slice(0, 12)}…, skill ${stored.skill.name}@${stored.skill.sha256.slice(0, 12)})\n`,
              );
              process.stdout.write(`  file: ${planPath(root)}\n`);
              process.stdout.write('next: review the plan; regenerate with --force\n');
            }
            return 0;
          }
        }

        const keyPresent = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
        const kind =
          opts.harness ?? process.env.IDEASEEK_ASK_HARNESS ?? (keyPresent ? 'dsh' : 'fake');
        const harness = buildHarness(kind);
        await harness.initialize();
        let output: string;
        let runtimeKind = kind;
        try {
          const result = await harness.runTask({
            runId: 'paper-plan',
            taskId: 'paper-plan',
            profile: 'paper-planner',
            instruction: request.instruction,
            inputs: [{ kind: 'text', name: 'snapshot', content: request.context }],
            outputSchema: PAPER_PLAN_SCHEMA,
            budget: { timeoutMs: 180_000, maxOutputTokens: 16_384 },
            idempotencyKey: request.idempotencyKey,
          });
          output = result.output;
          runtimeKind = result.runtime.kind;
        } catch (error) {
          if (error instanceof Error && error.name === 'HarnessBlockError') {
            const block = (error as { block?: string }).block ?? 'BLOCKED';
            if (opts.json) {
              process.stdout.write(
                jsonLine({ blocked: block, written: false, contract: PAPER_PLAN_SCHEMA }),
              );
            } else {
              process.stderr.write(
                `paper plan blocked [${block}]: ${(error as Error).message}\n` +
                  'nothing was written — restore quota/auth/network and rerun the same command\n',
              );
            }
            return 2;
          }
          throw error;
        } finally {
          await harness.shutdown().catch(() => undefined);
        }

        // Contract gate: invalid output is a hard failure with zero writes.
        const plan = parsePaperPlanOutput(output);
        const stored: StoredPlan = {
          contract: PAPER_PLAN_SCHEMA,
          inputHash: request.inputHash,
          skill: { name: skill.name, sha256: skill.sha256 },
          snapshot,
          harnessRuntime: runtimeKind,
          generatedAt: Date.now(),
          plan: plan as unknown as Record<string, unknown>,
        };
        await ensureDir(join(root, 'reports', 'paper'));
        await writeFileAtomic(planPath(root), `${JSON.stringify(stored, null, 2)}\n`);

        // Audit trail when a run exists (same discipline as idea generate).
        let eventSeq: number | null = null;
        const { ProjectRuntime } = await import('../workflow/runtime.js');
        const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
        try {
          const run = await runtime.db.getLatestRun(runtime.project.id);
          if (run) {
            const event = await runtime.db.appendEvent({
              runId: run.runId,
              phase: 'PAPER',
              objectId: 'paper-plan',
              role: 'system',
              eventType: 'paper_plan',
              summary: `paper plan generated (${plan.claimsEvidence.length} claim(s), venue ${plan.venue}, ARIS paper-plan)`,
              status: 'generated',
            });
            eventSeq = event.seq;
          }
        } finally {
          await runtime.close();
        }

        if (opts.json) {
          process.stdout.write(
            jsonLine({
              contract: stored.contract,
              inputHash: stored.inputHash,
              skill: stored.skill,
              harnessRuntime: stored.harnessRuntime,
              reused: false,
              eventSeq,
              plan,
              path: planPath(root),
            }),
          );
        } else {
          process.stdout.write(
            `paper plan written: reports/paper/plan.json (${plan.venue}, ${plan.maxPages} pages, ${plan.claimsEvidence.length} claim(s), ${plan.structure.length} section(s))\n`,
          );
          process.stdout.write(
            `  inputHash ${stored.inputHash.slice(0, 19)}… · skill ${skill.name}@${skill.sha256.slice(0, 12)}… · harness ${runtimeKind}\n`,
          );
          process.stdout.write(
            `  reviewer: ${plan.reviewerFeedback.verdict} (no reviewer backend is hosted here)\n`,
          );
          process.stdout.write('next: review reports/paper/plan.json; regenerate with --force\n');
        }
        return 0;
      }),
    );
}

async function findRoot(): Promise<string> {
  const { findProjectRoot } = await import('../config/paths.js');
  const root = await findProjectRoot(process.cwd());
  if (!root) {
    throw new IdeaseekError('NOT_INITIALIZED', 'no IdeaSeek project here; run: ideaseek init');
  }
  return root;
}
