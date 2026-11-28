import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import type { HarnessAdapter } from '../dsh/adapter.js';
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

interface DiagramRenderRecord {
  contract: string;
  renders: unknown[];
}

/**
 * The append-only diagram render record. Missing file = first render (fresh
 * record); corrupt or wrong-shaped file must be LOUD, never "first render" —
 * the old catch-all silently overwrote the render history it exists to keep,
 * and a non-array `renders` crashed the command at `.filter`.
 */
export async function readDiagramRenderRecord(recordPath: string): Promise<DiagramRenderRecord> {
  const fresh: DiagramRenderRecord = { contract: 'diagram-render-v1', renders: [] };
  let text: string;
  try {
    text = await readFile(recordPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fresh;
    throw new IdeaseekError(
      'INVALID_STATE',
      `cannot read diagram render record ${recordPath}: ${(error as Error).message} — restore or move it aside, then rerun`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new IdeaseekError(
      'INVALID_STATE',
      `diagram render record ${recordPath} is not valid JSON — rerunning would erase its history; restore or move it aside, then rerun`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as DiagramRenderRecord).renders)
  ) {
    throw new IdeaseekError(
      'INVALID_STATE',
      `diagram render record ${recordPath} has an unexpected shape — restore or move it aside, then rerun`,
    );
  }
  return parsed as DiagramRenderRecord;
}

interface StoredReview {
  status: string;
  note: string | null;
  at: number | null;
  history: { status: string; note: string | null; at: number }[];
}

const REVIEW_STATUSES = ['unreviewed', 'approved', 'rejected'];

/**
 * The review block of one stored figure, as a value this command may extend.
 *
 * WHY a guard rather than `figure.review ?? {…}` plus a spread: `paper compile`
 * now obeys `review.status`, so this record is load-bearing, and a stored block
 * that is half-present used to reach `...previous.history` and throw a bare
 * TypeError — a crash with no code, no next step, and (worse) the appearance of
 * a broken platform in front of a user whose artifact is the broken thing. The
 * contract (figure-render-v1) requires `review.status` and `review.history`, so
 * an artifact missing either was not written by `render-figures`: it is corrupt,
 * and the honest answer is INVALID_ARTIFACT with the repair command — not a
 * silently restarted history, which would erase the append-only trail the
 * verdict exists to keep.
 */
function storedReview(figure: { id: string; review?: unknown }, location: string): StoredReview {
  const where = `${location} → figures[].review of ${figure.id}`;
  if (figure.review === undefined || figure.review === null) {
    // No verdict recorded is the renderer's own starting state, not damage.
    return { status: 'unreviewed', note: null, at: null, history: [] };
  }
  if (typeof figure.review !== 'object' || Array.isArray(figure.review)) {
    throw new IdeaseekError(
      'INVALID_ARTIFACT',
      `${where} is not an object — repair it with: ideaseek paper render-figures`,
    );
  }
  const block = figure.review as Record<string, unknown>;
  if (typeof block.status !== 'string' || !REVIEW_STATUSES.includes(block.status)) {
    throw new IdeaseekError(
      'INVALID_ARTIFACT',
      `${where}.status is ${JSON.stringify(block.status ?? null)}, expected ` +
        `${REVIEW_STATUSES.join(' | ')} — repair it with: ideaseek paper render-figures`,
    );
  }
  if (!Array.isArray(block.history)) {
    throw new IdeaseekError(
      'INVALID_ARTIFACT',
      `${where}.history is ${
        block.history === undefined ? 'missing' : `not an array (` + `${typeof block.history})`
      } — the append-only review trail is part of ` +
        'figure-render-v1, so rerun: ideaseek paper render-figures (this rewrites the report and ' +
        'clears the verdicts) and review the figures again',
    );
  }
  const history = block.history.map((entry, index) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    if (typeof record.status !== 'string' || typeof record.at !== 'number') {
      throw new IdeaseekError(
        'INVALID_ARTIFACT',
        `${where}.history[${index}] needs a string status and a numeric at — repair it with: ` +
          'ideaseek paper render-figures',
      );
    }
    return {
      status: record.status,
      note: typeof record.note === 'string' ? record.note : null,
      at: record.at,
    };
  });
  return {
    status: block.status,
    note: typeof block.note === 'string' ? block.note : null,
    at: typeof block.at === 'number' ? block.at : null,
    history,
  };
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
        // Claim/verdict reconciliation (mechanical): `supported` claims are
        // only honest when some idea's recorded analysis actually says
        // supported — the model used to declare claim status freely and the
        // plan shipped without ever reading analysis.json.
        const supportedClaims = plan.claimsEvidence.filter(
          (claim) => claim.status === 'supported',
        ).length;
        const anyIdeaSupported = snapshot.ideas.some((idea) => idea.verdict === 'supported');
        if (supportedClaims > 0 && !anyIdeaSupported) {
          const detail = `plan declares ${supportedClaims} supported claim(s) but no idea analysis records verdict=supported — run: ideaseek idea analyze <ideaId> (or lower the claims to partial/unadjudicated), then rerun: ideaseek paper plan`;
          if (opts.json) {
            process.stdout.write(jsonLine({ ok: false, written: false, errors: [detail] }));
          } else {
            process.stderr.write(`paper plan refused, nothing written:\n  ✗ ${detail}\n`);
          }
          return 2;
        }
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
    .command('results')
    .description(
      'export recorded experiment results to reports/paper/results.json for figures and tables (deterministic, no model)',
    )
    .option('--json', 'machine-readable output')
    .option(
      '--include-ablations',
      'also export ablation-control rows (excluded by default so tables cannot present controls as competing methods)',
    )
    .action(
      action(async (opts: { json?: boolean; includeAblations?: boolean }) => {
        const root = await findRoot();
        const { ProjectRuntime } = await import('../workflow/runtime.js');
        const runtime = await ProjectRuntime.open({ cwd: root });
        try {
          const { exportPaperResults } = await import('../paper/results-export.js');
          const rows = await runtime.db.listExperiments();
          const { export: exported, path } = await exportPaperResults(
            root,
            rows.map((row) => ({
              spec: (row as { spec?: unknown }).spec as never,
              result: (row as { result?: unknown }).result as never,
            })),
            Date.now(),
            { includeAblations: opts.includeAblations === true },
          );
          if (opts.json) {
            process.stdout.write(jsonLine({ path, rows: exported.rows.length, export: exported }));
            return 0;
          }
          process.stdout.write(
            `results exported: ${exported.rows.length} recorded run(s) → ${path}\n` +
              `  input hash ${exported.inputHash.slice(0, 19)}… (figures cite this)\n` +
              (exported.excludedAblations > 0
                ? `  excluded ${exported.excludedAblations} ablation-control row(s) — rerun with --include-ablations to plot controls\n`
                : ''),
          );
          for (const row of exported.rows.slice(0, 8)) {
            process.stdout.write(
              `  ${row.specId} [${row.scale}/${row.status}] ` +
                `${row.metrics.map((metric) => `${metric.identifier}=${metric.value}`).join(' ')}\n`,
            );
          }
          if (exported.rows.length > 8) {
            process.stdout.write(`  … ${exported.rows.length - 8} more\n`);
          }
          if (exported.identicalValueGroups.length > 0) {
            process.stdout.write(
              `  警告：${exported.identicalValueGroups.length} 组运行的数值完全相同，无法区分各自的改动：\n`,
            );
            for (const group of exported.identicalValueGroups) {
              process.stdout.write(
                `    ${group.specIds.join(', ')} → ${group.metrics.length} 项指标逐位相同\n`,
              );
            }
            process.stdout.write(
              '  含义：消融脚本很可能没有真的应用它的开关（或者复用了旧结果），' +
                '这不是一张消融表能支持的结论；核对 ideas/*/src 里的开关实现后重跑。\n',
            );
          }
          process.stdout.write(
            'next: ideaseek paper figure --force (scripts must read this file), then ' +
              'ideaseek paper render-figures\n' +
              '  无需绘图库的路线：ideaseek paper compile --place-figures' +
              '（直接把上面的记录写成 LaTeX 结果表）\n',
          );
          return 0;
        } finally {
          await runtime.close();
        }
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
        let output = '';
        let runtimeKind = kind;
        try {
          // Bounded correction, in the ARIS shape the idea path already uses:
          // one answer, and if the contract rejects it, the validator's own
          // words go back to the model with a second and third chance. A whole
          // figure plan used to be discarded on the first violation ("script
          // must save the figure") with the user told nothing but the error
          // text — and five scripts authored blind in one JSON envelope is the
          // same fragile shape we replaced on the idea side. Two retries is the
          // ceiling, not a loop: if the model still cannot state its outputs,
          // the answer is a tool session, not another sample.
          let instruction = request.instruction;
          let lastViolation: Error | null = null;
          for (let attempt = 1; attempt <= 3; attempt += 1) {
            const result = await harness.runTask({
              runId: 'paper-figure',
              taskId: 'paper-figure',
              profile: 'paper-planner',
              instruction,
              inputs: [{ kind: 'text', name: 'figure_context', content: request.context }],
              outputSchema: PAPER_FIGURE_SCHEMA,
              budget: { timeoutMs: 180_000, maxOutputTokens: 24_576 },
              idempotencyKey: `${request.idempotencyKey}:r${attempt}`,
            });
            output = result.output;
            runtimeKind = result.runtime.kind;
            try {
              parsePaperFigureOutput(output, context);
              lastViolation = null;
              break;
            } catch (error) {
              if (!(error instanceof Error)) throw error;
              lastViolation = error;
              instruction = [
                request.instruction,
                '',
                `## your previous answer was rejected by the platform (attempt ${attempt})`,
                error.message,
                'Fix exactly those fields and return the complete JSON again. Every script must',
                'call savefig(...) (or write_image) for the files it claims, and must load the',
                'results file it declares as its data source rather than drawing invented values.',
              ].join('\n');
              process.stderr.write(
                `  · figure plan rejected (attempt ${attempt}): ${error.message.slice(0, 160)}\n`,
              );
            }
          }
          if (lastViolation) throw lastViolation;
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
        const { figureLegibilityWarnings } = await import('../paper/figure.js');
        const legibility = figureLegibilityWarnings(figures.figures, context.resultSpecIds);
        for (const warning of legibility) process.stderr.write(`  ! ${warning}\n`);
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
              warnings: legibility,
              path: figurePlanPath(root),
            }),
          );
        } else {
          process.stdout.write(
            `figure plan written: reports/paper/figures-plan.json (${figures.figures.length} figure(s) · ${figures.format} @ ${figures.dpi} dpi, reviewer ${figures.reviewerFeedback.verdict})\n`,
          );
          for (const warning of legibility) process.stdout.write(`  ! ${warning}\n`);
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

  paper
    .command('compile')
    .description(
      'assemble the stored manuscript with the venue template and compile to PDF (ARIS paper-compile)',
    )
    .option('--json', 'machine-readable output')
    .option(
      '--style-dir <dir>',
      'directory holding venue class/style files (e.g. iclr2026_conference.sty) that TeX Live lacks',
    )
    .option(
      '--allow-figures <paths>',
      'comma-separated figures/ files to include without an accepted render (hand-made figures; ' +
        'cannot overrule a paper review-figure verdict)',
    )
    .option(
      '--place-figures',
      'insert LaTeX floats for figures the render records verify and the manuscript does not place',
    )
    .action(
      action(
        async (opts: {
          json?: boolean;
          styleDir?: string;
          allowFigures?: string;
          placeFigures?: boolean;
        }) => {
          const root = await findRoot();
          const { loadArisSkill } = await import('../aris/skill.js');
          // Provenance only: this workflow is deterministic platform code that
          // follows the vendored skill — no model call, integrity still checked.
          const skill = await loadArisSkill('paper-compile');
          const { PAPER_COMPILE_SCHEMA, compileManuscript } = await import('../paper/compile.js');
          const { report, mainPath, placement } = await compileManuscript(
            root,
            {
              name: skill.name,
              sha256: skill.sha256,
            },
            {
              ...(opts.styleDir ? { styleDir: opts.styleDir } : {}),
              ...(opts.allowFigures?.trim()
                ? { allowFigures: opts.allowFigures.split(',').map((entry) => entry.trim()) }
                : {}),
              ...(opts.placeFigures ? { placeFigures: true } : {}),
            },
          );
          if (placement && !opts.json) {
            process.stdout.write(
              `figure placement: ${placement.inserted} inserted, ${placement.already} already in the ` +
                `manuscript, ${placement.skipped} skipped → ${placement.mainTexPath}\n`,
            );
            for (const figure of placement.figures) {
              if (figure.action === 'skipped') {
                process.stdout.write(
                  `  SKIP  ${figure.id}: ${(figure.reason ?? '').slice(0, 160)}\n`,
                );
              } else {
                process.stdout.write(
                  `  ${figure.action.padEnd(8)}${figure.id} → ${figure.includePath}\n`,
                );
              }
            }
            // The table is the artifact that needs no plotting stack at all, so
            // its outcome must not hide behind the figure counts.
            process.stdout.write(
              `  table   ${placement.table.action}` +
                `${
                  placement.table.action === 'inserted'
                    ? ` — ${placement.table.rowCount} run(s) × ${placement.table.columns.length} metric(s)`
                    : placement.table.action === 'skipped'
                      ? ` — ${placement.table.reason ?? ''}`
                      : ''
                }\n`,
            );
          }

          await ensureDir(join(root, 'reports', 'paper'));
          await writeFileAtomic(
            join(root, 'reports', 'paper', 'compile-report.json'),
            `${JSON.stringify({ contract: PAPER_COMPILE_SCHEMA, mainPath, ...report }, null, 2)}\n`,
          );

          let eventSeq: number | null = null;
          const { ProjectRuntime } = await import('../workflow/runtime.js');
          const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
          try {
            const run = await runtime.db.getLatestRun(runtime.project.id);
            if (run) {
              const event = await runtime.db.appendEvent({
                runId: run.runId,
                phase: 'PAPER',
                objectId: 'paper-compile',
                role: 'system',
                eventType: 'paper_compile',
                summary:
                  report.status === 'compiled'
                    ? `paper compiled to PDF (${report.pageCount ?? '?'} page(s), venue ${report.venue}, template ${report.template})`
                    : `paper compile ${report.status}: ${(report.blockers[0] ?? 'see report').slice(0, 120)}`,
                status: report.status,
              });
              eventSeq = event.seq;
            }
          } finally {
            await runtime.close();
          }

          if (opts.json) {
            process.stdout.write(
              jsonLine({ contract: PAPER_COMPILE_SCHEMA, eventSeq, mainPath, ...report }),
            );
            return report.status === 'compiled' ? 0 : report.status === 'blocked' ? 2 : 1;
          }
          if (report.status === 'compiled') {
            process.stdout.write(
              `compiled ${report.pdfPath} (${report.pageCount ?? '?'} page(s) · ${report.venue} · template ${report.template})\n`,
            );
            process.stdout.write(`  source: ${mainPath}\n`);
            process.stdout.write(
              `  latexmk exit 0 · skill ${skill.name}@${skill.sha256.slice(0, 12)}…\n`,
            );
            process.stdout.write(
              'next: check the PDF; paper/ holds main.tex, references.bib, compile.log\n',
            );
            return 0;
          }
          if (report.status === 'blocked') {
            process.stderr.write(`paper compile blocked: ${report.blockers.join('; ')}\n`);
            process.stderr.write('nothing was compiled — resolve the blocker and rerun\n');
            return 2;
          }
          process.stderr.write(
            `paper compile failed (exit ${report.exitCode ?? 'n/a'}): ${report.blockers.join('; ')}\n`,
          );
          process.stderr.write(
            `  log tail:\n${report.logTail.split('\n').slice(-15).join('\n')}\n`,
          );
          process.stderr.write(
            'next: fix paper/main.tex (or provide the missing style file) and rerun ideaseek paper compile\n',
          );
          return 1;
        },
      ),
    );

  paper
    .command('rebuttal')
    .description('draft the rebuttal grounded in persisted reviews and results (ARIS rebuttal)')
    .option(
      '--harness <kind>',
      'model harness: fake | dsh (default: dsh when a key is configured, else fake)',
    )
    .option('--force', 'ignore a stored rebuttal.json and regenerate')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { harness?: string; force?: boolean; json?: boolean }) =>
        runEngagement('rebuttal', opts),
      ),
    );

  paper
    .command('slides')
    .description('build the slide deck content bound to the stored plan (ARIS paper-slides)')
    .option(
      '--harness <kind>',
      'model harness: fake | dsh (default: dsh when a key is configured, else fake)',
    )
    .option('--force', 'ignore a stored slides.json and regenerate')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { harness?: string; force?: boolean; json?: boolean }) =>
        runEngagement('slides', opts),
      ),
    );

  paper
    .command('talk')
    .description('prepare the talk readiness checklist and Q&A (ARIS paper-talk)')
    .option(
      '--harness <kind>',
      'model harness: fake | dsh (default: dsh when a key is configured, else fake)',
    )
    .option('--force', 'ignore a stored talk.json and regenerate')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { harness?: string; force?: boolean; json?: boolean }) =>
        runEngagement('talk', opts),
      ),
    );

  paper
    .command('render-figures')
    .description(
      'execute the persisted figure scripts and hash the rendered outputs (Phase 7 pipeline)',
    )
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { json?: boolean }) => {
        const root = await findRoot();
        const { loadArisSkill } = await import('../aris/skill.js');
        // Provenance: the scripts come from the paper-figure skill output.
        const skill = await loadArisSkill('paper-figure');
        const { FIGURE_RENDER_SCHEMA, renderFigures } = await import('../paper/render-figures.js');
        const { report, figuresDir } = await renderFigures(root, {
          name: skill.name,
          sha256: skill.sha256,
        });

        await ensureDir(join(root, 'reports', 'paper'));
        await writeFileAtomic(
          join(root, 'reports', 'paper', 'figure-render.json'),
          `${JSON.stringify({ contract: FIGURE_RENDER_SCHEMA, ...report }, null, 2)}\n`,
        );

        let eventSeq: number | null = null;
        const { ProjectRuntime } = await import('../workflow/runtime.js');
        const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
        try {
          const run = await runtime.db.getLatestRun(runtime.project.id);
          if (run) {
            const okCount = report.figures.filter((figure) => figure.ok).length;
            const event = await runtime.db.appendEvent({
              runId: run.runId,
              phase: 'PAPER',
              objectId: 'figure-render',
              role: 'system',
              eventType: 'figure_render',
              summary: `figure render ${report.status}: ${okCount}/${report.figures.length} script(s) produced hashed outputs`,
              status: report.status,
            });
            eventSeq = event.seq;
          }
        } finally {
          await runtime.close();
        }

        if (opts.json) {
          process.stdout.write(jsonLine({ contract: FIGURE_RENDER_SCHEMA, eventSeq, ...report }));
          return report.status === 'rendered' ? 0 : 1;
        }
        const okCount = report.figures.filter((figure) => figure.ok).length;
        process.stdout.write(
          `figure render ${report.status}: ${okCount}/${report.figures.length} script(s) → ${figuresDir}\n`,
        );
        for (const warning of report.warnings) process.stdout.write(`  ! ${warning}\n`);
        for (const figure of report.figures) {
          if (figure.ok) {
            process.stdout.write(
              `  ok    ${figure.id} → ${figure.outputs.map((output) => `${output.path} (${output.bytes} B)`).join(', ')}\n`,
            );
          } else {
            process.stdout.write(
              `  FAIL  ${figure.id}: ${(figure.error ?? 'unknown').slice(0, 200)}\n`,
            );
          }
        }
        process.stdout.write(
          `  python ${report.python} · skill ${report.skill.name}@${report.skill.sha256.slice(0, 12)}…\n`,
        );
        process.stdout.write(
          'next: reports/paper/figure-render.json records per-output sha256 (source manifest trail)\n',
        );
        return report.status === 'rendered' ? 0 : 1;
      }),
    );

  paper
    .command('diagram')
    .description(
      'render a FigureSpec JSON (architecture / pipeline / audit cascade) to SVG with the vendored ' +
        'deterministic renderer — no plotting library, no model',
    )
    .option(
      '--spec <path>',
      'FigureSpec JSON, relative to the project or absolute',
      'reports/paper/diagram.json',
    )
    .option('--output <path>', 'SVG output path (default: figures/<spec name>.svg)')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { spec: string; output?: string; json?: boolean }) => {
        const root = await findRoot();
        const { basename, extname, isAbsolute } = await import('node:path');
        const specPath = isAbsolute(opts.spec) ? opts.spec : join(root, opts.spec);
        const stem = basename(specPath, extname(specPath));
        const figuresDir = join(root, 'figures');
        await ensureDir(figuresDir);
        const outputPath = opts.output
          ? isAbsolute(opts.output)
            ? opts.output
            : join(root, opts.output)
          : join(figuresDir, `${stem}.svg`);

        const { renderDiagram } = await import('../paper/diagram.js');
        // Integrity first, and the same gate the model routes use: the vendored
        // renderer is the skill's own script, so a tampered SKILL.md must stop a
        // render rather than be reported afterwards in a provenance field.
        const { loadArisSkill } = await import('../aris/skill.js');
        const skill = await loadArisSkill('figure-spec');
        type DiagramRender = Awaited<ReturnType<typeof renderDiagram>>;
        let render: DiagramRender;
        try {
          render = await renderDiagram({ specPath, outputPath, cwd: root });
        } catch (error) {
          if (!opts.json) {
            process.stderr.write(
              `  提示：spec 由上游 figure-spec 技能自己的 schema 校验，平台不复制那份规则；` +
                `示例见 aris-skills/skills/figure-spec/SKILL.md\n`,
            );
          }
          throw error;
        }

        // Append-only record so a figure in the bundle can be re-checked: the
        // determinism claim is (spec hash, renderer hash) → output hash.
        const recordPath = join(root, 'reports', 'paper', 'diagram-render.json');
        const record = await readDiagramRenderRecord(recordPath);
        const entry = {
          specPath,
          specSha256: render.specSha256,
          outputPath,
          bytes: render.bytes,
          sha256: render.sha256,
          rendererPath: render.rendererPath,
          rendererSha256: render.rendererSha256,
          skill: { name: skill.name, sha256: skill.sha256 },
          renderedAt: Date.now(),
        };
        record.renders = [
          ...record.renders.filter(
            (previous) => (previous as { outputPath?: string }).outputPath !== outputPath,
          ),
          entry,
        ];
        await ensureDir(join(root, 'reports', 'paper'));
        await writeFileAtomic(recordPath, `${JSON.stringify(record, null, 2)}\n`);

        let eventSeq: number | null = null;
        const { ProjectRuntime } = await import('../workflow/runtime.js');
        const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
        try {
          const run = await runtime.db.getLatestRun(runtime.project.id);
          if (run) {
            const event = await runtime.db.appendEvent({
              runId: run.runId,
              phase: 'PAPER',
              objectId: stem,
              role: 'system',
              eventType: 'diagram_render',
              summary: `FigureSpec ${stem} → ${basename(outputPath)} (${render.bytes} B, deterministic)`,
              status: 'rendered',
            });
            eventSeq = event.seq;
          }
        } finally {
          await runtime.close();
        }

        if (opts.json) {
          process.stdout.write(jsonLine({ eventSeq, ...entry }));
          return 0;
        }
        process.stdout.write(
          `diagram ${stem}: ${render.bytes} B → ${outputPath}\n` +
            `  spec ${render.specSha256.slice(0, 19)}… renderer ${render.rendererSha256.slice(0, 19)}…\n` +
            `  record: ${recordPath}\n`,
        );
        process.stdout.write(
          'next: ideaseek paper compile --place-figures   （表格与可嵌入的矢量图由放置步骤写进稿件；' +
            'SVG 需要 Inkscape/rsvg 转换成 PDF 才能被 graphicx 引入，缺失时这一步会报 SKIP 并说明原因）\n',
        );
        return 0;
      }),
    );

  paper
    .command('review-figure')
    .description('record the human review status of a rendered figure (source manifest)')
    .argument('<id>', 'figure id from the render report')
    .requiredOption('--status <status>', 'approved | rejected')
    .option('--note <text>', 'review note')
    .option('--json', 'machine-readable output')
    .action(
      action(async (id: string, opts: { status: string; note?: string; json?: boolean }) => {
        const root = await findRoot();
        if (opts.status !== 'approved' && opts.status !== 'rejected') {
          throw new IdeaseekError('INVALID_ARGUMENT', '--status must be approved | rejected');
        }
        const path = join(root, 'reports', 'paper', 'figure-render.json');
        let stored: {
          contract: string;
          figures: {
            id: string;
            review?: {
              status: string;
              note: string | null;
              at: number | null;
              history: { status: string; note: string | null; at: number }[];
            };
          }[];
        };
        try {
          stored = JSON.parse(await readFile(path, 'utf8'));
        } catch {
          throw new IdeaseekError(
            'USER_INPUT_REQUIRED',
            'no figure render report — run: ideaseek paper render-figures',
          );
        }
        if (stored.contract !== 'figure-render-v1') {
          throw new IdeaseekError(
            'INVALID_ARTIFACT',
            'reports/paper/figure-render.json is not a figure-render-v1 artifact',
          );
        }
        // Same reasoning as the review block below: without this, a hand-edited
        // report reaches `.find` and crashes instead of naming the artifact.
        if (!Array.isArray(stored.figures)) {
          throw new IdeaseekError(
            'INVALID_ARTIFACT',
            'reports/paper/figure-render.json has no figures[] array — rerun: ' +
              'ideaseek paper render-figures',
          );
        }
        const figure = stored.figures.find((entry) => entry.id === id);
        if (!figure) {
          const known = stored.figures.map((entry) => entry.id).join(', ') || 'none';
          throw new IdeaseekError(
            'INVALID_ARGUMENT',
            `unknown figure id "${id}" — rendered figures: ${known}`,
          );
        }
        const now = Date.now();
        const previous = storedReview(figure, 'reports/paper/figure-render.json');
        figure.review = {
          status: opts.status,
          note: opts.note ?? null,
          at: now,
          history: [
            ...previous.history,
            { status: previous.status, note: previous.note, at: previous.at ?? now },
          ],
        };
        await writeFileAtomic(path, `${JSON.stringify(stored, null, 2)}\n`);

        if (opts.json) {
          process.stdout.write(jsonLine({ id, review: figure.review, path }));
        } else {
          process.stdout.write(
            `figure ${id} review: ${opts.status}${opts.note ? ` — ${opts.note}` : ''}\n`,
          );
          process.stdout.write(
            `  previous: ${previous.status} · history kept in reports/paper/figure-render.json\n`,
          );
          // Spell out what the verdict now does: this record is read by
          // `paper compile`, and a rejection it obeys is not a suggestion.
          process.stdout.write(
            opts.status === 'approved'
              ? '  effect: paper compile accepts this figure while the render report marks it ok\n'
              : '  effect: paper compile now refuses to build while the manuscript includes this ' +
                  'figure; --allow-figures does not overrule this verdict\n',
          );
          process.stdout.write(
            'next: include the caption in the paper; re-render only after regenerating the plan\n',
          );
        }
        return 0;
      }),
    );

  paper
    .command('export-overleaf')
    .description(
      'bundle main.tex + references.bib + figures + provenance into an Overleaf-ready ZIP (no secrets)',
    )
    .option('--to <dir>', 'target directory (default: reports/paper/overleaf-<ts>)')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { to?: string; json?: boolean }) => {
        const root = await findRoot();
        const { buildOverleafExport } = await import('../paper/overleaf.js');
        // Source data behind the figures: experiment registry + protocol
        // locks (read-only dumps into provenance/).
        const extraProvenance: Record<string, string> = {};
        const { ProjectRuntime } = await import('../workflow/runtime.js');
        const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
        try {
          const experiments = await runtime.db.listExperiments();
          const locks = await runtime.db.listProtocolLocks();
          extraProvenance['experiments.json'] = `${JSON.stringify(experiments, null, 2)}\n`;
          extraProvenance['protocol-locks.json'] = `${JSON.stringify(locks, null, 2)}\n`;
        } finally {
          await runtime.close();
        }
        const manifest = await buildOverleafExport(root, {
          to: opts.to,
          extraProvenance,
        });
        if (opts.json) {
          process.stdout.write(jsonLine(manifest));
          return 0;
        }
        const figureCount = manifest.files.filter((file) =>
          file.path.startsWith('figures/'),
        ).length;
        process.stdout.write(`overleaf bundle: ${manifest.bundleDir}\n`);
        process.stdout.write(
          `  zip: ${manifest.zipPath} · ${manifest.files.length} file(s), ${figureCount} figure(s), ${manifest.provenance.length} provenance record(s)\n`,
        );
        process.stdout.write(`  ${manifest.notes.join('\n  ')}\n`);
        process.stdout.write(
          'next: upload the ZIP to Overleaf (or extract and sync); full-scale runs stay in the handoff package\n',
        );
        return 0;
      }),
    );

  paper
    .command('visual')
    .description(
      'analyze a PDF page/figure via DSH image attachment when the route supports images, else low-confidence text fallback',
    )
    .requiredOption('--pdf <path>', 'project-relative PDF path')
    .requiredOption('--page <n>', '1-based page number', (value) => Number(value))
    .option('--figure <id>', 'figure id to bind in the result')
    .option('--question <text>', 'what to ask about the page')
    .option(
      '--harness <kind>',
      'model harness: fake | dsh (default: dsh when a key is configured, else fake)',
    )
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (opts: {
          pdf: string;
          page: number;
          figure?: string;
          question?: string;
          harness?: string;
          json?: boolean;
        }) => {
          const root = await findRoot();
          if (!Number.isInteger(opts.page) || opts.page < 1) {
            throw new IdeaseekError('INVALID_ARGUMENT', '--page must be an integer >= 1');
          }
          const { join: joinPath } = await import('node:path');
          const pdfPath = joinPath(root, ...opts.pdf.split('/'));
          const { sha256OfFile } = await import('../core/hash.js');
          const paperHash = await sha256OfFile(pdfPath).catch(() => {
            throw new IdeaseekError('FILE_NOT_FOUND', `PDF not found: ${opts.pdf}`);
          });

          // Capability BEFORE any model call — never inferred from the name.
          const { describeTierBindings } = await import('../models/routing.js');
          const { resolveImageCapability } = await import('../models/image-capability.js');
          const fast = describeTierBindings().find((binding) => binding.tier === 'fast');
          const capability = resolveImageCapability({
            model: fast?.model ?? 'deepseek-v4-flash',
            provider: fast?.provider ?? undefined,
            declaredImageInput: fast?.imageInput,
          });

          // Fallback text: the committed parsed-paper artifact for this PDF.
          let pageText: string | undefined;
          if (!capability.supported) {
            try {
              const { readFile: read } = await import('node:fs/promises');
              const artifacts = await (
                await import('../workflow/runtime.js')
              ).ProjectRuntime.open({ cwd: root, recover: false }).then(async (runtime) => {
                try {
                  const rows = await runtime.db.listArtifactsByKind('parsed-paper');
                  for (const row of rows) {
                    const parsed = JSON.parse(
                      await runtime.store.readFinalText(row.contentHash),
                    ) as {
                      source?: string;
                      sourceHash?: string;
                      pages?: { page: number; text: string }[];
                    };
                    if (parsed.sourceHash === paperHash && Array.isArray(parsed.pages)) {
                      return parsed.pages.find((p) => p.page === opts.page)?.text ?? '';
                    }
                  }
                  return '';
                } finally {
                  await runtime.close();
                }
              });
              pageText = artifacts;
              void read;
            } catch {
              pageText = undefined;
            }
          }

          // Vision path only when capability passed; harness built lazily.
          let harness: HarnessAdapter | null = null;
          if (capability.supported) {
            const { buildHarness } = await import('./shared.js');
            const keyPresent = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
            const kind =
              opts.harness ?? process.env.IDEASEEK_ASK_HARNESS ?? (keyPresent ? 'dsh' : 'fake');
            harness = buildHarness(kind);
          }
          const { analyzePageVisual, PAGE_VISUAL_SCHEMA } = await import('../knowledge/visual.js');
          let result: Awaited<ReturnType<typeof analyzePageVisual>>;
          try {
            result = await analyzePageVisual({
              paperHash,
              page: opts.page,
              pdfPath,
              capability,
              figureId: opts.figure ?? null,
              question: opts.question,
              pageTextFallback: pageText,
              harness,
            });
          } finally {
            await harness?.shutdown().catch(() => undefined);
          }

          // Persist the hash-bound analysis (knowledge/visual/…).
          const { visualInputHash } = await import('../knowledge/visual.js');
          const inputHash = visualInputHash(result);
          const fileName = `${paperHash.slice(7, 19)}-p${opts.page}${opts.figure ? `-fig-${opts.figure}` : ''}.json`;
          const { ensureDir, writeFileAtomic } = await import('../core/atomic.js');
          await ensureDir(joinPath(root, 'knowledge', 'visual'));
          await writeFileAtomic(
            joinPath(root, 'knowledge', 'visual', fileName),
            `${JSON.stringify(
              { contract: PAGE_VISUAL_SCHEMA, inputHash, generatedAt: Date.now(), ...result },
              null,
              2,
            )}\n`,
          );

          if (opts.json) {
            process.stdout.write(
              jsonLine({
                contract: PAGE_VISUAL_SCHEMA,
                inputHash,
                capability: { supported: capability.supported, basis: capability.basis },
                path: `knowledge/visual/${fileName}`,
                result,
              }),
            );
            return 0;
          }
          process.stdout.write(
            `page visual [${result.source}]: p.${result.page} conf=${result.confidence.toFixed(2)} model=${result.model ?? 'none'}\n`,
          );
          process.stdout.write(`  route: ${result.route}\n`);
          process.stdout.write(`  caption: ${result.caption.slice(0, 200) || '(none)'}\n`);
          process.stdout.write(`  uncertainty: ${result.uncertainty.slice(0, 200)}\n`);
          if (result.attachmentSha256) {
            process.stdout.write(`  attachment: ${result.attachmentSha256}\n`);
          }
          process.stdout.write(`  file: knowledge/visual/${fileName}\n`);
          if (result.needsUserReview) {
            process.stdout.write(
              `next: REVIEW REQUIRED — ${result.source === 'text-fallback' ? 'vision unavailable on this route; provide an image-capable route or OCR' : 'low confidence; verify the caption against the page'}\n`,
            );
          } else {
            process.stdout.write(
              'next: caption accepted (confidence ≥ 0.7); cite it with the page hash\n',
            );
          }
          return 0;
        },
      ),
    );
}

/* ------------------------------------------------------------------ */
/* Rebuttal / slides / talk — one shared runner (Phase 4.5C)           */
/* ------------------------------------------------------------------ */

type EngagementMode = 'rebuttal' | 'slides' | 'talk';

const ENGAGEMENT_META: Record<
  EngagementMode,
  { skill: string; file: string; event: string; label: string }
> = {
  rebuttal: { skill: 'rebuttal', file: 'rebuttal.json', event: 'rebuttal', label: 'rebuttal' },
  slides: {
    skill: 'paper-slides',
    file: 'slides.json',
    event: 'paper_slides',
    label: 'slide deck',
  },
  talk: { skill: 'paper-talk', file: 'talk.json', event: 'paper_talk', label: 'talk plan' },
};

interface StoredEngagement {
  contract: string;
  inputHash: string;
  skill: { name: string; sha256: string };
  snapshot: unknown;
  harnessRuntime: string;
  generatedAt: number;
  payload: Record<string, unknown>;
}

function engagementPath(root: string, mode: EngagementMode): string {
  return join(root, 'reports', 'paper', ENGAGEMENT_META[mode].file);
}

async function runEngagement(
  mode: EngagementMode,
  opts: { harness?: string; force?: boolean; json?: boolean },
): Promise<number> {
  const root = await findRoot();
  const meta = ENGAGEMENT_META[mode];
  const { loadArisSkill } = await import('../aris/skill.js');
  // Integrity gate BEFORE any model call (ADR-008).
  const skill = await loadArisSkill(meta.skill);
  const engagement = await import('../paper/engagement.js');
  const context = await engagement.collectEngagementContext(root);
  const contract =
    mode === 'rebuttal'
      ? engagement.REBUTTAL_SCHEMA
      : mode === 'slides'
        ? engagement.SLIDES_SCHEMA
        : engagement.TALK_SCHEMA;
  const request = engagement.buildEngagementRequest(skill, context, mode, contract);
  const path = engagementPath(root, mode);

  if (!opts.force) {
    let stored: StoredEngagement | null = null;
    try {
      stored = JSON.parse(await readFile(path, 'utf8')) as StoredEngagement;
    } catch {
      stored = null;
    }
    if (stored && stored.inputHash === request.inputHash) {
      if (opts.json) {
        process.stdout.write(
          jsonLine({
            contract: stored.contract,
            inputHash: stored.inputHash,
            skill: stored.skill,
            harnessRuntime: stored.harnessRuntime,
            reused: true,
            payload: stored.payload,
            path,
          }),
        );
      } else {
        process.stdout.write(
          `reused ${meta.label} (same inputHash ${stored.inputHash.slice(0, 12)}…, skill ${stored.skill.name}@${stored.skill.sha256.slice(0, 12)})\n`,
        );
        process.stdout.write(`  file: ${path}\n`);
        process.stdout.write(`next: review the stored ${meta.label}; regenerate with --force\n`);
      }
      return 0;
    }
  }

  const keyPresent = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
  const kind = opts.harness ?? process.env.IDEASEEK_ASK_HARNESS ?? (keyPresent ? 'dsh' : 'fake');
  const harness = buildHarness(kind);
  await harness.initialize();
  let output: string;
  let runtimeKind = kind;
  try {
    const result = await harness.runTask({
      runId: contract,
      taskId: contract,
      profile: 'paper-planner',
      instruction: request.instruction,
      inputs: [{ kind: 'text', name: 'engagement_context', content: request.context }],
      outputSchema: contract,
      budget: { timeoutMs: 180_000, maxOutputTokens: 16_384 },
      idempotencyKey: request.idempotencyKey,
    });
    output = result.output;
    runtimeKind = result.runtime.kind;
  } catch (error) {
    if (error instanceof Error && error.name === 'HarnessBlockError') {
      const block = (error as { block?: string }).block ?? 'BLOCKED';
      if (opts.json) {
        process.stdout.write(jsonLine({ blocked: block, written: false, contract }));
      } else {
        process.stderr.write(
          `paper ${mode} blocked [${block}]: ${(error as Error).message}\n` +
            'nothing was written — restore quota/auth/network and rerun the same command\n',
        );
      }
      return 2;
    }
    throw error;
  } finally {
    await harness.shutdown().catch(() => undefined);
  }

  const payload =
    mode === 'rebuttal'
      ? (engagement.parseRebuttal(output) as unknown as Record<string, unknown>)
      : mode === 'slides'
        ? (engagement.parseSlidesDeck(output, context) as unknown as Record<string, unknown>)
        : (engagement.parseTalkPlan(output) as unknown as Record<string, unknown>);

  const stored: StoredEngagement = {
    contract,
    inputHash: request.inputHash,
    skill: { name: skill.name, sha256: skill.sha256 },
    snapshot: context.snapshot,
    harnessRuntime: runtimeKind,
    generatedAt: Date.now(),
    payload,
  };
  await ensureDir(join(root, 'reports', 'paper'));
  await writeFileAtomic(path, `${JSON.stringify(stored, null, 2)}\n`);

  let eventSeq: number | null = null;
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  try {
    const run = await runtime.db.getLatestRun(runtime.project.id);
    if (run) {
      const event = await runtime.db.appendEvent({
        runId: run.runId,
        phase: 'PAPER',
        objectId: contract,
        role: 'system',
        eventType: meta.event,
        summary: `${meta.label} generated (${contract}, ARIS ${meta.skill})`,
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
        contract,
        inputHash: stored.inputHash,
        skill: stored.skill,
        harnessRuntime: stored.harnessRuntime,
        reused: false,
        eventSeq,
        payload,
        path,
      }),
    );
    return 0;
  }
  process.stdout.write(
    `${meta.label} written: reports/paper/${meta.file} (contract ${contract}, harness ${runtimeKind})\n`,
  );
  process.stdout.write(
    `  inputHash ${stored.inputHash.slice(0, 19)}… · skill ${skill.name}@${skill.sha256.slice(0, 12)}…\n`,
  );
  if (mode === 'slides') {
    process.stdout.write('  deck content only — assembly/compile is Phase 7\n');
  }
  process.stdout.write(`next: review reports/paper/${meta.file}; regenerate with --force\n`);
  return 0;
}

async function findRoot(): Promise<string> {
  const { findProjectRoot } = await import('../config/paths.js');
  const root = await findProjectRoot(process.cwd());
  if (!root) {
    throw new IdeaseekError('NOT_INITIALIZED', 'no IdeaSeek project here; run: ideaseek init');
  }
  return root;
}
