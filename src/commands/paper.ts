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

function figurePlanPath(root: string): string {
  return join(root, 'reports', 'paper', 'figures-plan.json');
}

interface StoredFigurePlan {
  contract: string;
  inputHash: string;
  skill: { name: string; sha256: string };
  snapshot: unknown;
  harnessRuntime: string;
  generatedAt: number;
  figures: Record<string, unknown>;
}

async function readStoredFigurePlan(root: string): Promise<StoredFigurePlan | null> {
  try {
    return JSON.parse(await readFile(figurePlanPath(root), 'utf8')) as StoredFigurePlan;
  } catch {
    return null;
  }
}

function manuscriptPath(root: string): string {
  return join(root, 'reports', 'paper', 'manuscript.json');
}

interface StoredManuscript {
  contract: string;
  inputHash: string;
  skill: { name: string; sha256: string };
  snapshot: unknown;
  harnessRuntime: string;
  generatedAt: number;
  manuscript: Record<string, unknown>;
}

async function readStoredManuscript(root: string): Promise<StoredManuscript | null> {
  try {
    return JSON.parse(await readFile(manuscriptPath(root), 'utf8')) as StoredManuscript;
  } catch {
    return null;
  }
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

  paper
    .command('figure')
    .description(
      'plan publication figures and plotting scripts from persisted results (ARIS paper-figure)',
    )
    .option(
      '--harness <kind>',
      'model harness: fake | dsh (default: dsh when a key is configured, else fake)',
    )
    .option('--force', 'ignore a stored figures-plan.json and regenerate')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { harness?: string; force?: boolean; json?: boolean }) => {
        const root = await findRoot();
        const { loadArisSkill } = await import('../aris/skill.js');
        const skill = await loadArisSkill('paper-figure');
        const {
          PAPER_FIGURE_SCHEMA,
          buildFigureRequest,
          collectFigureContext,
          parsePaperFigureOutput,
        } = await import('../paper/figure.js');
        const context = await collectFigureContext(root);
        const request = buildFigureRequest(skill, context);

        if (!opts.force) {
          const stored = await readStoredFigurePlan(root);
          if (stored && stored.inputHash === request.inputHash) {
            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  contract: stored.contract,
                  inputHash: stored.inputHash,
                  skill: stored.skill,
                  harnessRuntime: stored.harnessRuntime,
                  reused: true,
                  figures: stored.figures,
                  path: figurePlanPath(root),
                }),
              );
            } else {
              process.stdout.write(
                `reused figure plan (same inputHash ${stored.inputHash.slice(0, 12)}…, skill ${stored.skill.name}@${stored.skill.sha256.slice(0, 12)})\n`,
              );
              process.stdout.write(`  file: ${figurePlanPath(root)}\n`);
              process.stdout.write('next: review the scripts; regenerate with --force\n');
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
            runId: 'paper-figure',
            taskId: 'paper-figure',
            profile: 'paper-planner',
            instruction: request.instruction,
            inputs: [{ kind: 'text', name: 'figure_context', content: request.context }],
            outputSchema: PAPER_FIGURE_SCHEMA,
            budget: { timeoutMs: 180_000, maxOutputTokens: 24_576 },
            idempotencyKey: request.idempotencyKey,
          });
          output = result.output;
          runtimeKind = result.runtime.kind;
        } catch (error) {
          if (error instanceof Error && error.name === 'HarnessBlockError') {
            const block = (error as { block?: string }).block ?? 'BLOCKED';
            if (opts.json) {
              process.stdout.write(
                jsonLine({ blocked: block, written: false, contract: PAPER_FIGURE_SCHEMA }),
              );
            } else {
              process.stderr.write(
                `paper figure blocked [${block}]: ${(error as Error).message}\n` +
                  'nothing was written — restore quota/auth/network and rerun the same command\n',
              );
            }
            return 2;
          }
          throw error;
        } finally {
          await harness.shutdown().catch(() => undefined);
        }

        const figures = parsePaperFigureOutput(output, context);
        const stored: StoredFigurePlan = {
          contract: PAPER_FIGURE_SCHEMA,
          inputHash: request.inputHash,
          skill: { name: skill.name, sha256: skill.sha256 },
          snapshot: context.snapshot,
          harnessRuntime: runtimeKind,
          generatedAt: Date.now(),
          figures: figures as unknown as Record<string, unknown>,
        };
        await ensureDir(join(root, 'reports', 'paper'));
        await writeFileAtomic(figurePlanPath(root), `${JSON.stringify(stored, null, 2)}\n`);

        let eventSeq: number | null = null;
        const { ProjectRuntime } = await import('../workflow/runtime.js');
        const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
        try {
          const run = await runtime.db.getLatestRun(runtime.project.id);
          if (run) {
            const event = await runtime.db.appendEvent({
              runId: run.runId,
              phase: 'PAPER',
              objectId: 'paper-figure',
              role: 'system',
              eventType: 'paper_figure',
              summary: `figure plan generated (${figures.figures.length} figure(s), scripts persisted, ARIS paper-figure)`,
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
              figures,
              path: figurePlanPath(root),
            }),
          );
        } else {
          process.stdout.write(
            `figure plan written: reports/paper/figures-plan.json (${figures.figures.length} figure(s) · ${figures.format} @ ${figures.dpi} dpi, reviewer ${figures.reviewerFeedback.verdict})\n`,
          );
          process.stdout.write(
            `  inputHash ${stored.inputHash.slice(0, 19)}… · skill ${skill.name}@${skill.sha256.slice(0, 12)}… · harness ${runtimeKind}\n`,
          );
          if (figures.manualRemaining.length > 0) {
            process.stdout.write(
              `  manual (not auto-generated): ${figures.manualRemaining.join('; ')}\n`,
            );
          }
          process.stdout.write(
            'scripts are persisted, NOT executed — execution belongs to the Phase 7 figure pipeline\n',
          );
          process.stdout.write(
            'next: review reports/paper/figures-plan.json; regenerate with --force\n',
          );
        }
        return 0;
      }),
    );

  paper
    .command('write')
    .description('draft the manuscript content bound to the stored plan (ARIS paper-write)')
    .option(
      '--harness <kind>',
      'model harness: fake | dsh (default: dsh when a key is configured, else fake)',
    )
    .option('--force', 'ignore a stored manuscript.json and regenerate')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { harness?: string; force?: boolean; json?: boolean }) => {
        const root = await findRoot();
        const { loadArisSkill } = await import('../aris/skill.js');
        const skill = await loadArisSkill('paper-write');
        const {
          PAPER_WRITE_SCHEMA,
          buildWriteRequest,
          collectWriteContext,
          parseManuscriptOutput,
        } = await import('../paper/write.js');
        const context = await collectWriteContext(root);
        const request = buildWriteRequest(skill, context);

        if (!opts.force) {
          const stored = await readStoredManuscript(root);
          if (stored && stored.inputHash === request.inputHash) {
            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  contract: stored.contract,
                  inputHash: stored.inputHash,
                  skill: stored.skill,
                  harnessRuntime: stored.harnessRuntime,
                  reused: true,
                  manuscript: stored.manuscript,
                  path: manuscriptPath(root),
                }),
              );
            } else {
              process.stdout.write(
                `reused manuscript (same inputHash ${stored.inputHash.slice(0, 12)}…, skill ${stored.skill.name}@${stored.skill.sha256.slice(0, 12)})\n`,
              );
              process.stdout.write(`  file: ${manuscriptPath(root)}\n`);
              process.stdout.write('next: review the manuscript; regenerate with --force\n');
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
            runId: 'paper-write',
            taskId: 'paper-write',
            profile: 'paper-planner',
            instruction: request.instruction,
            inputs: [{ kind: 'text', name: 'write_context', content: request.context }],
            outputSchema: PAPER_WRITE_SCHEMA,
            budget: { timeoutMs: 300_000, maxOutputTokens: 32_768 },
            idempotencyKey: request.idempotencyKey,
          });
          output = result.output;
          runtimeKind = result.runtime.kind;
        } catch (error) {
          if (error instanceof Error && error.name === 'HarnessBlockError') {
            const block = (error as { block?: string }).block ?? 'BLOCKED';
            if (opts.json) {
              process.stdout.write(
                jsonLine({ blocked: block, written: false, contract: PAPER_WRITE_SCHEMA }),
              );
            } else {
              process.stderr.write(
                `paper write blocked [${block}]: ${(error as Error).message}\n` +
                  'nothing was written — restore quota/auth/network and rerun the same command\n',
              );
            }
            return 2;
          }
          throw error;
        } finally {
          await harness.shutdown().catch(() => undefined);
        }

        const manuscript = parseManuscriptOutput(output, context);
        const stored: StoredManuscript = {
          contract: PAPER_WRITE_SCHEMA,
          inputHash: request.inputHash,
          skill: { name: skill.name, sha256: skill.sha256 },
          snapshot: context.snapshot,
          harnessRuntime: runtimeKind,
          generatedAt: Date.now(),
          manuscript: manuscript as unknown as Record<string, unknown>,
        };
        await ensureDir(join(root, 'reports', 'paper'));
        await writeFileAtomic(manuscriptPath(root), `${JSON.stringify(stored, null, 2)}\n`);

        let eventSeq: number | null = null;
        const { ProjectRuntime } = await import('../workflow/runtime.js');
        const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
        try {
          const run = await runtime.db.getLatestRun(runtime.project.id);
          if (run) {
            const event = await runtime.db.appendEvent({
              runId: run.runId,
              phase: 'PAPER',
              objectId: 'paper-write',
              role: 'system',
              eventType: 'paper_write',
              summary: `manuscript drafted (${manuscript.sections.length} section(s), venue ${manuscript.venue}, ARIS paper-write)`,
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
              manuscript,
              path: manuscriptPath(root),
            }),
          );
        } else {
          process.stdout.write(
            `manuscript written: reports/paper/manuscript.json (${manuscript.venue}, ${manuscript.sections.length} section(s), ${manuscript.bibliography.length} bib entr(ies), reviewer ${manuscript.reviewerFeedback.verdict})\n`,
          );
          process.stdout.write(
            `  inputHash ${stored.inputHash.slice(0, 19)}… · skill ${skill.name}@${skill.sha256.slice(0, 12)}… · harness ${runtimeKind}\n`,
          );
          if (manuscript.manualFixes.length > 0) {
            process.stdout.write(`  manual fixes left: ${manuscript.manualFixes.join('; ')}\n`);
          }
          process.stdout.write(
            'content is persisted, NOT assembled or compiled — paper-compile is the next step\n',
          );
          process.stdout.write(
            'next: review reports/paper/manuscript.json; regenerate with --force\n',
          );
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
