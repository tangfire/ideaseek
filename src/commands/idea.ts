import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { IdeaseekError } from '../core/errors.js';
import { assessIdeaCard, type IdeaCard } from '../idea/card.js';
import type { CandidatesIndex } from '../idea/generate.js';
import type { NoveltyCandidate } from '../idea/novelty.js';
import { runIdeaChecks, saveCheckReport, scaffoldIdea } from '../idea/check.js';
import { runIdeaExperiment, runReadyExperiments, type IdeaScale } from '../idea/experiment.js';
import { runAblations } from '../idea/ablation.js';
import { runAnalysis } from '../idea/analyze.js';
import { buildIdeaHandoff } from '../idea/handoff.js';
import {
  assertAutonomy,
  checkAutonomy,
  getAutonomyMode,
  parseAutonomyMode,
  recordDecision,
} from '../workflow/autonomy.js';
import {
  IDEA_TRANSITIONS,
  assertEngineeringRevision,
  checkpointCode,
  createWorkspace,
  ideaDir,
  listWorkspaces,
  loadIdeaCard,
  loadVersionRecords,
  loadWorkspaceMeta,
  reviseEngineering,
  setIdeaStatus,
  verifyWorkspace,
  type IdeaRunStatus,
} from '../idea/workspace.js';
import { findProjectRoot } from '../config/paths.js';
import { action, jsonLine } from './shared.js';

async function openRoot(): Promise<string> {
  const root = await findProjectRoot(process.cwd());
  if (!root) {
    throw new IdeaseekError('NOT_INITIALIZED', 'no IdeaSeek project here; run: ideaseek init');
  }
  return root;
}

async function readCardFile(path: string): Promise<IdeaCard> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new IdeaseekError('FILE_NOT_FOUND', `cannot read ${path}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(raw) as IdeaCard;
  } catch (error) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `${path} is not valid JSON: ${(error as Error).message}`,
    );
  }
}

/**
 * `ideaseek idea validate <file>` — IdeaCard contract + mechanism gate.
 * Structural errors exit 2; a DRAFT_COMPOSITION card passes validation but is
 * reported as blocked from the experiment queue (add --require-candidate to
 * make that a failing exit, for pre-experiment checks).
 */
export function registerIdeaCommand(program: Command): void {
  const idea = program
    .command('idea')
    .description('idea cards, workspaces, versions and the mechanism gate');

  idea
    .command('validate')
    .description('validate an IdeaCard JSON and run the DRAFT_COMPOSITION mechanism gate')
    .argument('<file>', 'path to the idea card JSON')
    .option('--require-candidate', 'fail when the card is held at DRAFT_COMPOSITION')
    .option('--json', 'machine-readable output')
    .action(
      action(async (file: string, opts: { requireCandidate?: boolean; json?: boolean }) => {
        let raw: string;
        try {
          raw = await readFile(file, 'utf8');
        } catch (error) {
          throw new IdeaseekError(
            'FILE_NOT_FOUND',
            `cannot read ${file}: ${(error as Error).message}`,
          );
        }
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch (error) {
          throw new IdeaseekError(
            'PARSE_FAILED',
            `${file} is not valid JSON: ${(error as Error).message}`,
          );
        }

        const { validation, gate, ok } = assessIdeaCard(value);
        const ideaId =
          value &&
          typeof value === 'object' &&
          typeof (value as { ideaId?: unknown }).ideaId === 'string'
            ? (value as { ideaId: string }).ideaId
            : null;
        const version =
          value &&
          typeof value === 'object' &&
          typeof (value as { version?: unknown }).version === 'number'
            ? (value as { version: number }).version
            : null;

        if (opts.json) {
          process.stdout.write(
            jsonLine({
              ideaId,
              version,
              valid: ok,
              errors: validation.errors,
              gate: gate.status,
              blockers: gate.blockers,
              eligibleForQueue: ok && gate.ok,
            }),
          );
        } else {
          if (validation.errors.length > 0) {
            process.stdout.write(`invalid idea card (${validation.errors.length} error(s)):\n`);
            for (const error of validation.errors) process.stdout.write(`  ✗ ${error}\n`);
          } else {
            process.stdout.write(`valid idea card: ${ideaId ?? '?'} v${version ?? '?'}\n`);
          }
          process.stdout.write(`mechanism gate: ${gate.status}\n`);
          for (const blocker of gate.blockers) process.stdout.write(`  • ${blocker}\n`);
          if (ok && gate.ok) {
            process.stdout.write(
              'eligible for the experiment queue (subject to user confirmation)\n',
            );
          } else if (ok) {
            process.stdout.write(
              'held at DRAFT_COMPOSITION: complete the mechanism chain before experiments\n',
            );
          }
        }

        if (!ok) return 2;
        if (opts.requireCandidate && !gate.ok) return 2;
        return 0;
      }),
    );

  idea
    .command('generate')
    .description(
      'generate candidate IdeaCards for an ideation round (ARIS idea-creator skill backend)',
    )
    .requiredOption('--round <id>', 'ideation round id, e.g. r1')
    .option(
      '--harness <kind>',
      'model harness: fake | dsh (default: dsh when a key is configured, else fake)',
    )
    .option('--force', 'ignore a previous candidates.json and regenerate')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { round: string; harness?: string; force?: boolean; json?: boolean }) => {
        const root = await openRoot();
        const { loadRound } = await import('../idea/rounds.js');
        const round = await loadRound(root, opts.round);
        const { loadArisSkill } = await import('../aris/skill.js');
        const skill = await loadArisSkill('idea-creator');
        const {
          IDEA_CANDIDATES_SCHEMA,
          buildGenerationRequest,
          candidatesIndexPath,
          parseCandidatesOutput,
          readCandidatesIndex,
          writeCandidates,
        } = await import('../idea/generate.js');
        const request = buildGenerationRequest(round, skill);
        const cardList = (cards: { ideaId: string }[]): string =>
          cards
            .map(
              (card) => `knowledge/ideation-rounds/${round.roundId}/candidates/${card.ideaId}.json`,
            )
            .join(', ');

        // Idempotent reuse: same round + same skill hash = same inputHash.
        if (!opts.force) {
          const existing = await readCandidatesIndex(root, round.roundId);
          if (existing && existing.inputHash === request.inputHash) {
            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  roundId: round.roundId,
                  reused: true,
                  inputHash: existing.inputHash,
                  skill: existing.skill,
                  count: existing.candidates.length,
                  reason: existing.reason ?? null,
                  paths: existing.candidates.map(
                    (card) =>
                      `knowledge/ideation-rounds/${round.roundId}/candidates/${card.ideaId}.json`,
                  ),
                }),
              );
            } else {
              process.stdout.write(
                `reused ${existing.candidates.length} candidate(s) for ${round.roundId} ` +
                  `(same inputHash ${existing.inputHash.slice(0, 12)}…, skill ${existing.skill.name}@${existing.skill.sha256.slice(0, 12)})\n`,
              );
              if (existing.reason) process.stdout.write(`  reason: ${existing.reason}\n`);
              if (existing.candidates.length > 0) {
                process.stdout.write(`  files: ${cardList(existing.candidates)}\n`);
              }
              process.stdout.write(
                'next: ideaseek rounds show ' + `${round.roundId} · regenerate with --force\n`,
              );
            }
            return 0;
          }
        }

        const { buildHarness } = await import('./shared.js');
        const keyPresent = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
        const kind =
          opts.harness ?? process.env.IDEASEEK_ASK_HARNESS ?? (keyPresent ? 'dsh' : 'fake');
        const harness = buildHarness(kind);
        await harness.initialize();
        let output: string;
        let runtimeKind = kind;
        try {
          const result = await harness.runTask({
            runId: `round:${round.roundId}`,
            taskId: `idea-generate-${round.roundId}`,
            profile: 'idea-generator',
            instruction: request.instruction,
            inputs: [{ kind: 'text', name: 'round_context', content: request.roundContext }],
            outputSchema: IDEA_CANDIDATES_SCHEMA,
            budget: { timeoutMs: 120_000, maxOutputTokens: 8_192 },
            idempotencyKey: request.idempotencyKey,
          });
          output = result.output;
          runtimeKind = result.runtime.kind;
        } catch (error) {
          if (error instanceof Error && error.name === 'HarnessBlockError') {
            const block = (error as { block?: string }).block ?? 'BLOCKED';
            if (opts.json) {
              process.stdout.write(
                jsonLine({ roundId: round.roundId, blocked: block, written: false }),
              );
            } else {
              process.stderr.write(
                `idea generate blocked [${block}]: ${(error as Error).message}\n` +
                  'nothing was written — restore quota/auth/network and rerun the same command\n',
              );
            }
            return 2;
          }
          throw error;
        } finally {
          await harness.shutdown().catch(() => undefined);
        }

        const parsed = parseCandidatesOutput(output, round);
        const index: CandidatesIndex = {
          contract: IDEA_CANDIDATES_SCHEMA,
          roundId: round.roundId,
          inputHash: request.inputHash,
          skill: { name: skill.name, sha256: skill.sha256 },
          generatedAt: Date.now(),
          harnessRuntime: runtimeKind,
          ...(parsed.reason ? { reason: parsed.reason } : {}),
          candidates: parsed.cards,
          rejected: parsed.rejected,
        };
        const written = await writeCandidates(root, round.roundId, index);

        // Audit trail: candidates land as a RunEvent when a run exists.
        let eventSeq: number | null = null;
        const { ProjectRuntime } = await import('../workflow/runtime.js');
        const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
        try {
          const run = await runtime.db.getLatestRun(runtime.project.id);
          if (run) {
            const event = await runtime.db.appendEvent({
              runId: run.runId,
              phase: 'IDEATION',
              objectId: round.roundId,
              role: 'system',
              eventType: 'idea_candidates',
              summary:
                parsed.cards.length > 0
                  ? `generated ${parsed.cards.length} candidate(s) for ${round.roundId} (ARIS idea-creator)`
                  : `no new candidates for ${round.roundId}: ${parsed.reason ?? 'empty'}`,
              status: parsed.cards.length > 0 ? 'generated' : 'empty',
            });
            eventSeq = event.seq;
          }
        } finally {
          await runtime.close();
        }

        if (opts.json) {
          process.stdout.write(
            jsonLine({
              roundId: round.roundId,
              reused: false,
              inputHash: request.inputHash,
              skill: { name: skill.name, sha256: skill.sha256 },
              harness: runtimeKind,
              count: parsed.cards.length,
              reason: parsed.reason,
              rejected: parsed.rejected,
              paths: written,
              eventSeq,
            }),
          );
          return 0;
        }

        process.stdout.write(
          `generated ${parsed.cards.length} candidate(s) for round ${round.roundId} ` +
            `(ARIS ${skill.name} @ ${skill.sha256.slice(0, 12)}, harness ${runtimeKind})\n`,
        );
        for (const card of parsed.cards) {
          process.stdout.write(
            `  + knowledge/ideation-rounds/${round.roundId}/candidates/${card.ideaId}.json  [${card.status}]\n`,
          );
        }
        if (parsed.reason) process.stdout.write(`  reason: ${parsed.reason}\n`);
        for (const entry of parsed.rejected) {
          process.stdout.write(
            `  ✗ ${entry.ideaId ?? '(missing id)'}: ${entry.errors[0] ?? 'invalid'}\n`,
          );
        }
        if (eventSeq !== null) process.stdout.write(`  event #${eventSeq} recorded\n`);
        if (parsed.cards.length > 0) {
          const first = parsed.cards[0]!;
          process.stdout.write(
            `next: ideaseek idea validate knowledge/ideation-rounds/${round.roundId}/candidates/${first.ideaId}.json --require-candidate\n` +
              `      ideaseek idea create ${first.ideaId} --from-card knowledge/ideation-rounds/${round.roundId}/candidates/${first.ideaId}.json\n`,
          );
        } else {
          process.stdout.write(
            `next: add evidence/feedback and rerun ideate — index kept at ${candidatesIndexPath(root, round.roundId).replace(`${root}/`, '')}\n`,
          );
        }
        return 0;
      }),
    );

  idea
    .command('ablation-plan')
    .description(
      'propose the ablation set from the mechanism chain (ARIS ablation-planner backend)',
    )
    .argument('<ideaId>', 'kebab-case idea id')
    .option(
      '--harness <kind>',
      'model harness: fake | dsh (default: dsh when a key is configured, else fake)',
    )
    .option('--force', 'ignore a previous ablation-plan.json and regenerate')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (ideaId: string, opts: { harness?: string; force?: boolean; json?: boolean }) => {
          const root = await openRoot();
          const meta = await loadWorkspaceMeta(root, ideaId);
          const card = await loadIdeaCard(root, ideaId);
          const { loadArisSkill } = await import('../aris/skill.js');
          const skill = await loadArisSkill('ablation-planner');
          const {
            ablationPlanPath,
            buildAblationPlanRequest,
            parseAblationPlanOutput,
            readAblationPlan,
            writeAblationPlan,
          } = await import('../idea/ablation-plan.js');
          const { loadStoredPlan } = await import('../experiment/plan.js');
          const { ProjectRuntime: PlanRuntime } = await import('../workflow/runtime.js');
          const planRuntime = await PlanRuntime.open({ cwd: root, recover: false });
          let experimentPlan: Awaited<ReturnType<typeof loadStoredPlan>> = null;
          try {
            experimentPlan = await loadStoredPlan(planRuntime, ideaId);
          } finally {
            await planRuntime.close();
          }
          const request = buildAblationPlanRequest(skill, {
            ideaId,
            cardVersion: meta.currentVersion,
            cardJson: JSON.stringify(card, null, 2),
            planJson: experimentPlan ? JSON.stringify(experimentPlan, null, 2) : null,
          });

          if (!opts.force) {
            const existing = await readAblationPlan(root, ideaId);
            if (existing && existing.inputHash === request.inputHash) {
              if (opts.json) {
                process.stdout.write(
                  jsonLine({
                    ideaId,
                    reused: true,
                    inputHash: existing.inputHash,
                    skill: existing.skill,
                    entries: existing.entries.length,
                    path: `ideas/${ideaId}/experiments/ablation-plan.json`,
                  }),
                );
              } else {
                process.stdout.write(
                  `reused ablation plan for ${ideaId} (${existing.entries.length} entr(ies), ` +
                    `inputHash ${existing.inputHash.slice(0, 12)}…)\n`,
                );
                process.stdout.write(
                  'next: ideaseek idea ablate <ideaId> · regenerate with --force\n',
                );
              }
              return 0;
            }
          }

          const { buildHarness } = await import('./shared.js');
          const keyPresent = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
          const kind =
            opts.harness ?? process.env.IDEASEEK_ASK_HARNESS ?? (keyPresent ? 'dsh' : 'fake');
          const harness = buildHarness(kind);
          await harness.initialize();
          let output: string;
          let runtimeKind = kind;
          try {
            const result = await harness.runTask({
              runId: `idea:${ideaId}`,
              taskId: `ablation-plan-${ideaId}`,
              profile: 'idea-generator',
              instruction: request.instruction,
              inputs: [
                {
                  kind: 'text',
                  name: 'idea_context',
                  content: JSON.stringify({ ideaId, cardVersion: meta.currentVersion }),
                },
                { kind: 'text', name: 'idea_card', content: JSON.stringify(card) },
              ],
              outputSchema: 'ablation-plan-v1',
              budget: { timeoutMs: 120_000, maxOutputTokens: 8_192 },
              idempotencyKey: request.idempotencyKey,
            });
            output = result.output;
            runtimeKind = result.runtime.kind;
          } catch (error) {
            if (error instanceof Error && error.name === 'HarnessBlockError') {
              const block = (error as { block?: string }).block ?? 'BLOCKED';
              if (opts.json) {
                process.stdout.write(jsonLine({ ideaId, blocked: block, written: false }));
              } else {
                process.stderr.write(
                  `idea ablation-plan blocked [${block}]: ${(error as Error).message}\n` +
                    'nothing was written — restore quota/auth/network and rerun the same command\n',
                );
              }
              return 2;
            }
            throw error;
          } finally {
            await harness.shutdown().catch(() => undefined);
          }

          const plan = parseAblationPlanOutput(
            output,
            { ideaId, cardVersion: meta.currentVersion, card },
            {
              inputHash: request.inputHash,
              skill: { name: skill.name, sha256: skill.sha256 },
              harnessRuntime: runtimeKind,
            },
          );
          await writeAblationPlan(root, plan);

          let eventSeq: number | null = null;
          const { ProjectRuntime } = await import('../workflow/runtime.js');
          const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
          try {
            const run = await runtime.db.getLatestRun(runtime.project.id);
            if (run) {
              const event = await runtime.db.appendEvent({
                runId: run.runId,
                phase: 'ANALYZING',
                objectId: ideaId,
                role: 'system',
                eventType: 'ablation_plan',
                summary: `ablation plan generated for ${ideaId} (ARIS ablation-planner)`,
                status: 'generated',
              });
              eventSeq = event.seq;
            }
          } finally {
            await runtime.close();
          }

          const deferred = plan.entries.filter((entry) => entry.target === null);
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                ideaId,
                reused: false,
                inputHash: plan.inputHash,
                skill: plan.skill,
                harness: runtimeKind,
                entries: plan.entries.length,
                runnable: plan.entries.length - deferred.length,
                deferred: deferred.length,
                estimatedGpuMinutes: plan.estimatedGpuMinutes,
                path: `ideas/${ideaId}/experiments/ablation-plan.json`,
                eventSeq,
              }),
            );
            return 0;
          }

          process.stdout.write(
            `ablation plan for ${ideaId} v${meta.currentVersion} ` +
              `(ARIS ${skill.name} @ ${skill.sha256.slice(0, 12)}, harness ${runtimeKind})\n`,
          );
          for (const entry of plan.entries) {
            process.stdout.write(
              `  [p${entry.priority}] ${entry.name} (${entry.kind}${entry.target ? `: ${entry.target}` : ''})\n` +
                `        tests: ${entry.whatItTests}\n` +
                `        expect: ${entry.expectedOutcome}\n`,
            );
          }
          process.stdout.write(`  coverage: ${plan.coverageAssessment}\n`);
          if (plan.unnecessary.length > 0) {
            process.stdout.write(`  unnecessary: ${plan.unnecessary.join('; ')}\n`);
          }
          if (deferred.length > 0) {
            process.stdout.write(
              `  deferred (scaffold cannot run, reported not dropped): ${deferred
                .map((entry) => entry.name)
                .join(', ')}\n`,
            );
          }
          process.stdout.write(
            `  file: ${ablationPlanPath(root, ideaId).replace(`${root}/`, '')}\n`,
          );
          if (eventSeq !== null) process.stdout.write(`  event #${eventSeq} recorded\n`);
          process.stdout.write(
            'next: ideaseek idea ablate <ideaId> — the queue follows plan priorities and each ' +
              'spec records its expected outcome\n',
          );
          return 0;
        },
      ),
    );

  idea
    .command('novelty')
    .description(
      'novelty + prior-art verdict bound to the local paper index (ARIS novelty-check backend)',
    )
    .argument('<ideaId>', 'kebab-case idea id')
    .option(
      '--harness <kind>',
      'model harness: fake | dsh (default: dsh when a key is configured, else fake)',
    )
    .option('--force', 'ignore a previous novelty.json and regenerate')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (ideaId: string, opts: { harness?: string; force?: boolean; json?: boolean }) => {
          const root = await openRoot();
          const meta = await loadWorkspaceMeta(root, ideaId);
          const card = await loadIdeaCard(root, ideaId);
          const { loadArisSkill } = await import('../aris/skill.js');
          const noveltySkill = await loadArisSkill('novelty-check');
          const priorArtSkill = await loadArisSkill('prior-art-search');
          const {
            buildNoveltyRequest,
            noveltyPath,
            parseNoveltyOutput,
            readNoveltyReport,
            writeNoveltyReport,
          } = await import('../idea/novelty.js');
          const { listRounds } = await import('../idea/rounds.js');
          const { ProjectRuntime } = await import('../workflow/runtime.js');

          // Local candidates: FTS over the project's PaperCard index — the ONLY
          // closestPaperRef values the report may cite (anti-hallucination).
          const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
          let candidates: NoveltyCandidate[] = [];
          let constraints: string[] = [];
          let question: string | null = null;
          try {
            question = runtime.config.research.question;
            const rounds = await listRounds(root);
            if (rounds.length > 0) constraints = rounds[rounds.length - 1]!.noveltyConstraints;
            const queries = [
              card.hypothesis.statement,
              card.novelty.claim,
              card.hypothesis.targetProblem,
            ];
            const byKey = new Map<string, NoveltyCandidate>();
            for (const query of queries) {
              const hits = await runtime.db.searchPapers(query, { limit: 8 });
              for (const hit of hits) {
                const existing = byKey.get(hit.paperKey);
                if (!existing || hit.snippet.length > existing.snippet.length) {
                  byKey.set(hit.paperKey, {
                    paperKey: hit.paperKey,
                    source: hit.source,
                    snippet: hit.snippet,
                  });
                }
              }
            }
            candidates = [...byKey.values()].slice(0, 12);
          } finally {
            await runtime.close();
          }

          const request = buildNoveltyRequest(
            { novelty: noveltySkill, priorArt: priorArtSkill },
            {
              ideaId,
              cardVersion: meta.currentVersion,
              cardJson: JSON.stringify(card, null, 2),
              constraints,
              candidates,
              question,
            },
          );

          if (!opts.force) {
            const existing = await readNoveltyReport(root, ideaId);
            if (existing && existing.inputHash === request.inputHash) {
              if (opts.json) {
                process.stdout.write(
                  jsonLine({
                    ideaId,
                    reused: true,
                    inputHash: existing.inputHash,
                    verdict: existing.verdict,
                    score: existing.score,
                    priorArtDegraded: existing.priorArtDegraded,
                    path: `ideas/${ideaId}/novelty.json`,
                  }),
                );
              } else {
                process.stdout.write(
                  `reused novelty report for ${ideaId}: ${existing.verdict} (score ${existing.score})\n`,
                );
                process.stdout.write('next: regenerate with --force after new evidence\n');
              }
              return 0;
            }
          }

          const { buildHarness } = await import('./shared.js');
          const keyPresent = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
          const kind =
            opts.harness ?? process.env.IDEASEEK_ASK_HARNESS ?? (keyPresent ? 'dsh' : 'fake');
          const harness = buildHarness(kind);
          await harness.initialize();
          let output: string;
          let runtimeKind = kind;
          try {
            const result = await harness.runTask({
              runId: `idea:${ideaId}`,
              taskId: `novelty-${ideaId}`,
              profile: 'idea-generator',
              instruction: request.instruction,
              inputs: [
                {
                  kind: 'text',
                  name: 'novelty_context',
                  content: JSON.stringify({
                    ideaId,
                    cardVersion: meta.currentVersion,
                    candidateRefs: candidates.map((candidate) => candidate.paperKey),
                    constraints,
                  }),
                },
                { kind: 'text', name: 'idea_card', content: JSON.stringify(card) },
              ],
              outputSchema: 'novelty-check-v1',
              budget: { timeoutMs: 120_000, maxOutputTokens: 8_192 },
              idempotencyKey: request.idempotencyKey,
            });
            output = result.output;
            runtimeKind = result.runtime.kind;
          } catch (error) {
            if (error instanceof Error && error.name === 'HarnessBlockError') {
              const block = (error as { block?: string }).block ?? 'BLOCKED';
              if (opts.json) {
                process.stdout.write(jsonLine({ ideaId, blocked: block, written: false }));
              } else {
                process.stderr.write(
                  `idea novelty blocked [${block}]: ${(error as Error).message}\n` +
                    'nothing was written — restore quota/auth/network and rerun the same command\n',
                );
              }
              return 2;
            }
            throw error;
          } finally {
            await harness.shutdown().catch(() => undefined);
          }

          const report = parseNoveltyOutput(
            output,
            {
              ideaId,
              cardVersion: meta.currentVersion,
              candidateRefs: candidates.map((c) => c.paperKey),
            },
            {
              inputHash: request.inputHash,
              skills: {
                novelty: { name: noveltySkill.name, sha256: noveltySkill.sha256 },
                priorArt: { name: priorArtSkill.name, sha256: priorArtSkill.sha256 },
              },
              harnessRuntime: runtimeKind,
            },
          );
          await writeNoveltyReport(root, report);

          let eventSeq: number | null = null;
          const audit = await ProjectRuntime.open({ cwd: root, recover: false });
          try {
            const run = await audit.db.getLatestRun(audit.project.id);
            if (run) {
              const event = await audit.db.appendEvent({
                runId: run.runId,
                phase: 'ANALYZING',
                objectId: ideaId,
                role: 'system',
                eventType: 'novelty_verdict',
                summary: `novelty ${report.verdict} (score ${report.score}) for ${ideaId} — ARIS novelty-check`,
                status: report.verdict.toLowerCase(),
              });
              eventSeq = event.seq;
            }
          } finally {
            await audit.close();
          }

          if (opts.json) {
            process.stdout.write(
              jsonLine({
                ideaId,
                reused: false,
                inputHash: report.inputHash,
                verdict: report.verdict,
                score: report.score,
                claims: report.claims.length,
                closestPapers: report.claims.filter((claim) => claim.closestPaperRef !== null)
                  .length,
                patents: report.patents.length,
                priorArtDegraded: report.priorArtDegraded,
                candidates: candidates.length,
                path: `ideas/${ideaId}/novelty.json`,
                eventSeq,
              }),
            );
            return 0;
          }

          process.stdout.write(
            `novelty ${ideaId} v${meta.currentVersion}: ${report.verdict} (score ${report.score}/10)\n`,
          );
          for (const claim of report.claims) {
            process.stdout.write(
              `  • ${claim.claim}\n    closest: ${claim.closestPaperRef ?? 'none in local index'} — ${claim.delta}\n`,
            );
          }
          process.stdout.write(`  positioning: ${report.positioning}\n`);
          process.stdout.write(
            `  prior-art: ${report.patents.length} patent hit(s)` +
              `${report.priorArtDegraded ? ' (degraded: no web tools — honest local-only pass)' : ''}\n`,
          );
          process.stdout.write(`  file: ${noveltyPath(root, ideaId).replace(`${root}/`, '')}\n`);
          if (eventSeq !== null) process.stdout.write(`  event #${eventSeq} recorded\n`);
          if (report.verdict === 'ABANDON') {
            process.stdout.write(
              `next: experiments are blocked — ideaseek idea set-status ${ideaId} REJECTED --reason "..." ` +
                `or address the overlap then ideaseek idea novelty ${ideaId} --force\n`,
            );
          } else {
            process.stdout.write(`next: ideaseek idea experiment ${ideaId}\n`);
          }
          return 0;
        },
      ),
    );

  idea
    .command('review')
    .description(
      "fresh-context independent review of an idea's artifacts (ARIS auto-review-loop backend)",
    )
    .argument('<ideaId>', 'kebab-case idea id')
    .option(
      '--harness <kind>',
      'model harness: fake | dsh (default: dsh when a key is configured, else fake)',
    )
    .option('--force', 'start a NEW review round instead of reusing the latest one')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (ideaId: string, opts: { harness?: string; force?: boolean; json?: boolean }) => {
          const root = await openRoot();
          const meta = await loadWorkspaceMeta(root, ideaId);
          const card = await loadIdeaCard(root, ideaId);
          const { loadArisSkill } = await import('../aris/skill.js');
          const skill = await loadArisSkill('auto-review-loop');
          const {
            buildReviewRequest,
            evidenceDigest,
            isReviewPassing,
            latestReviewRound,
            parseReviewOutput,
            readReviewRound,
            reviewRoundPath,
            writeReviewRound,
          } = await import('../idea/review.js');
          const { collectIdeaEvidence } = await import('../idea/evidence.js');
          const { ProjectRuntime } = await import('../workflow/runtime.js');

          // Evidence bundle: raw artifacts only — the reviewer never sees an
          // executor summary or its own prior rounds (fresh context, ARIS).
          const gather = await ProjectRuntime.open({ cwd: root, recover: false });
          let bundle: Awaited<ReturnType<typeof collectIdeaEvidence>>;
          let latest = 0;
          try {
            bundle = await collectIdeaEvidence(root, ideaId, card, gather, {
              includeReviews: false,
            });
            latest = await latestReviewRound(root, ideaId);
          } finally {
            await gather.close();
          }

          const nextRound = latest + 1;
          const request = buildReviewRequest(skill, {
            ideaId,
            cardVersion: meta.currentVersion,
            round: opts.force ? nextRound : Math.max(latest, 1),
            bundle,
          });

          // Reuse the latest round when the evidence digest is unchanged.
          if (!opts.force && latest > 0) {
            const existing = await readReviewRound(root, ideaId, latest);
            if (existing && existing.inputHash === request.inputHash) {
              if (opts.json) {
                process.stdout.write(
                  jsonLine({
                    ideaId,
                    reused: true,
                    round: existing.round,
                    score: existing.score,
                    verdict: existing.verdict,
                    reviewerModel: existing.reviewerModel,
                    passing: isReviewPassing(existing),
                    path: `ideas/${ideaId}/reviews/round-${existing.round}.json`,
                  }),
                );
              } else {
                process.stdout.write(
                  `reused review round ${existing.round} for ${ideaId}: ` +
                    `${existing.verdict} (score ${existing.score}/10, reviewer ${existing.reviewerModel ?? 'unknown'})\n`,
                );
                process.stdout.write(
                  isReviewPassing(existing)
                    ? 'next: ideaseek idea experiment <ideaId>\n'
                    : 'next: address the weaknesses, then ideaseek idea review <ideaId> --force\n',
                );
              }
              return 0;
            }
          }

          const round = nextRound;
          const { buildHarness } = await import('./shared.js');
          const keyPresent = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
          const kind =
            opts.harness ?? process.env.IDEASEEK_ASK_HARNESS ?? (keyPresent ? 'dsh' : 'fake');
          const harness = buildHarness(kind);
          await harness.initialize();
          let output: string;
          let runtimeKind = kind;
          let reviewerModel: string | null = null;
          try {
            const result = await harness.runTask({
              runId: `idea:${ideaId}`,
              taskId: `idea-review-${ideaId}-r${round}`,
              profile: 'idea-generator',
              instruction: request.instruction,
              inputs: [
                {
                  kind: 'text',
                  name: 'evidence_bundle',
                  content: JSON.stringify({
                    ideaId,
                    cardVersion: meta.currentVersion,
                    round,
                    evidenceDigest: evidenceDigest(bundle),
                  }),
                },
              ],
              outputSchema: 'idea-review-v1',
              budget: { timeoutMs: 120_000, maxOutputTokens: 8_192 },
              idempotencyKey: request.idempotencyKey,
            });
            output = result.output;
            runtimeKind = result.runtime.kind;
            reviewerModel = result.model;
          } catch (error) {
            if (error instanceof Error && error.name === 'HarnessBlockError') {
              const block = (error as { block?: string }).block ?? 'BLOCKED';
              if (opts.json) {
                process.stdout.write(jsonLine({ ideaId, blocked: block, written: false }));
              } else {
                process.stderr.write(
                  `idea review blocked [${block}]: ${(error as Error).message}\n` +
                    'nothing was written — restore quota/auth/network and rerun the same command\n',
                );
              }
              return 2;
            }
            throw error;
          } finally {
            await harness.shutdown().catch(() => undefined);
          }

          const review = parseReviewOutput(
            output,
            { ideaId, cardVersion: meta.currentVersion, round },
            {
              inputHash: request.inputHash,
              skill: { name: skill.name, sha256: skill.sha256 },
              harnessRuntime: runtimeKind,
              reviewerModel,
              evidenceDigest: evidenceDigest(bundle),
            },
          );
          await writeReviewRound(root, review);

          let eventSeq: number | null = null;
          const audit = await ProjectRuntime.open({ cwd: root, recover: false });
          try {
            const run = await audit.db.getLatestRun(audit.project.id);
            if (run) {
              const event = await audit.db.appendEvent({
                runId: run.runId,
                phase: 'ANALYZING',
                objectId: ideaId,
                role: 'reviewer',
                eventType: 'idea_review',
                summary:
                  `review round ${review.round} for ${ideaId}: ${review.verdict} ` +
                  `(score ${review.score}/10, reviewer ${review.reviewerModel ?? 'unknown'})`,
                status: review.verdict === 'not ready' ? 'changes-requested' : review.verdict,
              });
              eventSeq = event.seq;
            }
          } finally {
            await audit.close();
          }

          const passing = isReviewPassing(review);
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                ideaId,
                reused: false,
                round: review.round,
                score: review.score,
                verdict: review.verdict,
                passing,
                reviewerModel: review.reviewerModel,
                weaknesses: review.weaknesses.length,
                evidenceDigest: review.evidenceDigest,
                path: `ideas/${ideaId}/reviews/round-${review.round}.json`,
                eventSeq,
              }),
            );
            return 0;
          }

          process.stdout.write(
            `review ${ideaId} round ${review.round}: ${review.verdict} ` +
              `(score ${review.score}/10) · reviewer ${review.reviewerModel ?? 'unknown'} ` +
              `(ARIS ${skill.name} @ ${skill.sha256.slice(0, 12)}, fresh context)\n`,
          );
          process.stdout.write(`  ${review.summary}\n`);
          for (const weakness of review.weaknesses) {
            process.stdout.write(`  [${weakness.severity}] ${weakness.text}\n`);
          }
          process.stdout.write(
            `  file: ${reviewRoundPath(root, ideaId, review.round).replace(`${root}/`, '')}\n`,
          );
          if (eventSeq !== null) process.stdout.write(`  event #${eventSeq} recorded\n`);
          if (passing) {
            process.stdout.write('next: ideaseek idea experiment <ideaId>\n');
          } else {
            process.stdout.write(
              `next: address the weaknesses, then ideaseek idea review ${ideaId} --force ` +
                '(a fresh independent round) · experiments are blocked meanwhile\n',
            );
          }
          return 0;
        },
      ),
    );

  idea
    .command('audit')
    .description(
      'cross-model experiment audit over the artifact bundle (ARIS experiment-audit backend)',
    )
    .argument('<ideaId>', 'kebab-case idea id')
    .option(
      '--harness <kind>',
      'model harness: fake | dsh (default: dsh when a key is configured, else fake)',
    )
    .option('--force', 'ignore a previous audit.json and regenerate')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (ideaId: string, opts: { harness?: string; force?: boolean; json?: boolean }) => {
          const root = await openRoot();
          const meta = await loadWorkspaceMeta(root, ideaId);
          const card = await loadIdeaCard(root, ideaId);
          const { loadArisSkill } = await import('../aris/skill.js');
          const auditSkill = await loadArisSkill('experiment-audit');
          const analyzeSkill = await loadArisSkill('analyze-results');
          const { auditPath, buildAuditRequest, parseAuditOutput, readAudit, writeAudit } =
            await import('../idea/audit.js');
          const { collectIdeaEvidence } = await import('../idea/evidence.js');
          const { ProjectRuntime } = await import('../workflow/runtime.js');

          const gather = await ProjectRuntime.open({ cwd: root, recover: false });
          let bundle: unknown;
          try {
            bundle = await collectIdeaEvidence(root, ideaId, card, gather);
          } finally {
            await gather.close();
          }

          const request = buildAuditRequest(
            { audit: auditSkill, analyze: analyzeSkill },
            { ideaId, cardVersion: meta.currentVersion, bundle },
          );

          if (!opts.force) {
            const existing = await readAudit(root, ideaId);
            if (existing && existing.inputHash === request.inputHash) {
              if (opts.json) {
                process.stdout.write(
                  jsonLine({
                    ideaId,
                    reused: true,
                    inputHash: existing.inputHash,
                    overallVerdict: existing.overallVerdict,
                    checks: existing.checks.length,
                    path: `ideas/${ideaId}/experiments/audit.json`,
                  }),
                );
              } else {
                process.stdout.write(
                  `reused experiment audit for ${ideaId}: ${existing.overallVerdict} ` +
                    `(${existing.checks.length} check(s))\n`,
                );
                process.stdout.write('next: regenerate with --force after new results\n');
              }
              return 0;
            }
          }

          const { buildHarness } = await import('./shared.js');
          const keyPresent = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
          const kind =
            opts.harness ?? process.env.IDEASEEK_ASK_HARNESS ?? (keyPresent ? 'dsh' : 'fake');
          const harness = buildHarness(kind);
          await harness.initialize();
          let output: string;
          let runtimeKind = kind;
          let reviewerModel: string | null = null;
          try {
            const result = await harness.runTask({
              runId: `idea:${ideaId}`,
              taskId: `idea-audit-${ideaId}`,
              profile: 'idea-generator',
              instruction: request.instruction,
              inputs: [
                {
                  kind: 'text',
                  name: 'evidence_bundle',
                  content: JSON.stringify({
                    ideaId,
                    cardVersion: meta.currentVersion,
                    evidenceDigest: request.inputHash,
                  }),
                },
              ],
              outputSchema: 'experiment-audit-v1',
              budget: { timeoutMs: 120_000, maxOutputTokens: 8_192 },
              idempotencyKey: request.idempotencyKey,
            });
            output = result.output;
            runtimeKind = result.runtime.kind;
            reviewerModel = result.model;
          } catch (error) {
            if (error instanceof Error && error.name === 'HarnessBlockError') {
              const block = (error as { block?: string }).block ?? 'BLOCKED';
              if (opts.json) {
                process.stdout.write(jsonLine({ ideaId, blocked: block, written: false }));
              } else {
                process.stderr.write(
                  `idea audit blocked [${block}]: ${(error as Error).message}\n` +
                    'nothing was written — restore quota/auth/network and rerun the same command\n',
                );
              }
              return 2;
            }
            throw error;
          } finally {
            await harness.shutdown().catch(() => undefined);
          }

          const audit = parseAuditOutput(
            output,
            { ideaId, cardVersion: meta.currentVersion },
            {
              inputHash: request.inputHash,
              skills: {
                audit: { name: auditSkill.name, sha256: auditSkill.sha256 },
                analyze: { name: analyzeSkill.name, sha256: analyzeSkill.sha256 },
              },
              harnessRuntime: runtimeKind,
              reviewerModel,
              evidenceDigest: request.evidenceDigest,
            },
          );
          await writeAudit(root, audit);

          let eventSeq: number | null = null;
          const runAudit = await ProjectRuntime.open({ cwd: root, recover: false });
          try {
            const run = await runAudit.db.getLatestRun(runAudit.project.id);
            if (run) {
              const event = await runAudit.db.appendEvent({
                runId: run.runId,
                phase: 'ANALYZING',
                objectId: ideaId,
                role: 'reviewer',
                eventType: 'experiment_audit',
                summary:
                  `experiment audit ${audit.overallVerdict} for ${ideaId} ` +
                  `(${audit.checks.length} check(s), reviewer ${audit.reviewerModel ?? 'unknown'})`,
                status: audit.overallVerdict.toLowerCase(),
              });
              eventSeq = event.seq;
            }
          } finally {
            await runAudit.close();
          }

          if (opts.json) {
            process.stdout.write(
              jsonLine({
                ideaId,
                reused: false,
                inputHash: audit.inputHash,
                overallVerdict: audit.overallVerdict,
                checks: audit.checks.map((check) => ({ id: check.id, verdict: check.verdict })),
                claims: audit.claims.length,
                reviewerModel: audit.reviewerModel,
                path: `ideas/${ideaId}/experiments/audit.json`,
                eventSeq,
              }),
            );
            return 0;
          }

          process.stdout.write(
            `experiment audit ${ideaId} v${meta.currentVersion}: ${audit.overallVerdict} ` +
              `· reviewer ${audit.reviewerModel ?? 'unknown'} ` +
              `(ARIS ${auditSkill.name} @ ${auditSkill.sha256.slice(0, 12)})\n`,
          );
          for (const check of audit.checks) {
            process.stdout.write(
              `  ${check.verdict.padEnd(4)} ${check.id.padEnd(22)} ${check.detail}\n` +
                `       evidence: ${check.evidence}\n`,
            );
          }
          process.stdout.write(`  ${audit.summary}\n`);
          process.stdout.write(`  file: ${auditPath(root, ideaId).replace(`${root}/`, '')}\n`);
          if (eventSeq !== null) process.stdout.write(`  event #${eventSeq} recorded\n`);
          if (audit.overallVerdict === 'FAIL') {
            process.stdout.write(
              'next: handoff delivery is blocked while this audit FAILs — fix the findings, ' +
                `then ideaseek idea audit ${ideaId} --force\n`,
            );
          } else if (audit.overallVerdict === 'WARN') {
            process.stdout.write(
              'next: warnings ship inside the handoff package (visible, non-blocking)\n',
            );
          } else {
            process.stdout.write('next: ideaseek idea handoff <ideaId>\n');
          }
          return 0;
        },
      ),
    );

  idea
    .command('claim-audit')
    .description(
      'verify card evidence against indexed papers and registered comparisons (deterministic)',
    )
    .argument('<ideaId>', 'kebab-case idea id')
    .option('--json', 'machine-readable output')
    .action(
      action(async (ideaId: string, opts: { json?: boolean }) => {
        const root = await openRoot();
        const { runClaimAudit, writeClaimAudit, claimAuditPath } =
          await import('../idea/claim-audit.js');
        const audit = await runClaimAudit(root, ideaId);
        await writeClaimAudit(root, audit);

        let eventSeq: number | null = null;
        const { ProjectRuntime } = await import('../workflow/runtime.js');
        const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
        try {
          const run = await runtime.db.getLatestRun(runtime.project.id);
          if (run) {
            const event = await runtime.db.appendEvent({
              runId: run.runId,
              phase: 'ANALYZING',
              objectId: ideaId,
              role: 'system',
              eventType: 'claim_audit',
              summary:
                `claim audit ${audit.verdict} for ${ideaId} ` +
                `(${audit.stats.found} found, ${audit.stats.missing} missing, ${audit.stats.unverified} unverified)`,
              status: audit.verdict,
            });
            eventSeq = event.seq;
          }
        } finally {
          await runtime.close();
        }

        if (opts.json) {
          process.stdout.write(
            jsonLine({
              ideaId,
              cardVersion: audit.cardVersion,
              verdict: audit.verdict,
              stats: audit.stats,
              checks: audit.checks,
              path: `ideas/${ideaId}/evidence-audit.json`,
              eventSeq,
            }),
          );
          return audit.verdict === 'fail' ? 2 : 0;
        }

        process.stdout.write(
          `claim audit ${ideaId} v${audit.cardVersion}: ${audit.verdict.toUpperCase()} ` +
            `(${audit.stats.found} found · ${audit.stats.missing} missing · ${audit.stats.unverified} unverified)\n`,
        );
        for (const check of audit.checks) {
          const mark =
            check.verdict === 'found' ? 'ok  ' : check.verdict === 'missing' ? 'FAIL' : '??  ';
          process.stdout.write(
            `  ${mark} [${check.kind}] ${check.ref}${check.page !== null ? ` (p.${check.page})` : ''}\n` +
              `        ${check.detail}\n`,
          );
        }
        process.stdout.write(`  file: ${claimAuditPath(root, ideaId).replace(`${root}/`, '')}\n`);
        if (eventSeq !== null) process.stdout.write(`  event #${eventSeq} recorded\n`);
        if (audit.verdict === 'fail') {
          process.stdout.write(
            'next: fix the card evidence or register the comparison — handoff delivery is blocked while this FAILs\n',
          );
        } else if (audit.verdict === 'warn') {
          process.stdout.write('next: ingest the missing sources to reach a full pass\n');
        } else {
          process.stdout.write('next: ideaseek idea handoff <ideaId>\n');
        }
        return audit.verdict === 'fail' ? 2 : 0;
      }),
    );

  idea
    .command('create')
    .description(
      'create ideas/<id>/ workspace (card, versions, src/config/data/experiments, README)',
    )
    .argument('<ideaId>', 'kebab-case idea id')
    .requiredOption('--from-card <file>', 'validated IdeaCard JSON (must be version 1)')
    .option(
      '--data <path>',
      'bind an input file hash (repeatable)',
      (v, p: string[]) => [...p, v],
      [] as string[],
    )
    .option('--json', 'machine-readable output')
    .action(
      action(async (ideaId: string, opts: { fromCard: string; data: string[]; json?: boolean }) => {
        const root = await openRoot();
        const card = await readCardFile(opts.fromCard);
        const { meta, resumed } = await createWorkspace(root, {
          ideaId,
          card,
          dataPaths: opts.data,
        });
        if (opts.json) {
          process.stdout.write(
            jsonLine({
              ideaId,
              status: meta.status,
              version: meta.currentVersion,
              resumed,
              workspace: ideaDir(root, ideaId),
            }),
          );
        } else {
          process.stdout.write(
            `${resumed ? 'completed partial workspace' : 'created idea workspace'} ${ideaId} ` +
              `(status=${meta.status}, v${meta.currentVersion})\n`,
          );
          process.stdout.write(`  path: ${ideaDir(root, ideaId)}\n`);
          process.stdout.write(`next: ideaseek idea show ${ideaId}\n`);
        }
        return 0;
      }),
    );

  idea
    .command('list')
    .description('list idea workspaces with lifecycle status and version')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { json?: boolean }) => {
        const root = await openRoot();
        const ideas = await listWorkspaces(root);
        if (opts.json) {
          process.stdout.write(jsonLine({ ideas }));
          return 0;
        }
        if (ideas.length === 0) {
          process.stdout.write(
            'no idea workspaces (ideaseek idea create <id> --from-card <file>)\n',
          );
          return 0;
        }
        process.stdout.write(`${ideas.length} idea(s):\n`);
        for (const entry of ideas) {
          process.stdout.write(
            `  ${entry.ideaId}  ${entry.status.padEnd(15)} v${entry.currentVersion}` +
              `${entry.parentIdeaId ? `  ← ${entry.parentIdeaId}` : ''}` +
              `${entry.childIdeaIds.length > 0 ? `  → ${entry.childIdeaIds.join(',')}` : ''}\n`,
          );
        }
        return 0;
      }),
    );

  idea
    .command('show')
    .description('show one idea workspace: status, version chain, gate and links')
    .argument('<ideaId>', 'idea id')
    .option('--json', 'machine-readable output')
    .action(
      action(async (ideaId: string, opts: { json?: boolean }) => {
        const root = await openRoot();
        const meta = await loadWorkspaceMeta(root, ideaId);
        const card = await loadIdeaCard(root, ideaId);
        const versions = await loadVersionRecords(root, ideaId);
        const assessment = assessIdeaCard(card);
        const next = IDEA_TRANSITIONS[meta.status];
        if (opts.json) {
          process.stdout.write(
            jsonLine({
              ideaId,
              status: meta.status,
              statusReason: meta.statusReason,
              currentVersion: meta.currentVersion,
              parentIdeaId: meta.parentIdeaId,
              childIdeaIds: meta.childIdeaIds,
              cardGate: assessment.gate.status,
              cardValid: assessment.ok,
              versions: versions.map((v) => ({
                version: v.version,
                parentVersion: v.parentVersion,
                changeKind: v.changeKind,
                codeHash: v.codeHash,
                summary: v.summary,
                checkpoint: v.checkpoint ?? null,
              })),
              nextTransitions: next,
              history: meta.history,
            }),
          );
          return 0;
        }
        process.stdout.write(
          `${ideaId}  ${meta.status}  v${meta.currentVersion}  gate=${assessment.gate.status}\n`,
        );
        if (meta.statusReason) process.stdout.write(`  reason: ${meta.statusReason}\n`);
        process.stdout.write(
          `  parent: ${meta.parentIdeaId ?? 'none'}  children: ${meta.childIdeaIds.join(', ') || 'none'}\n`,
        );
        process.stdout.write('  versions:\n');
        for (const v of versions) {
          process.stdout.write(
            `    v${v.version}  ${v.changeKind}  ${v.codeHash ?? '(no checkpoint)'}  ${v.summary}\n`,
          );
        }
        process.stdout.write(`  next: ${next.length > 0 ? next.join(' | ') : '(terminal)'}\n`);
        return 0;
      }),
    );

  idea
    .command('revise')
    .description('engineering revision: bump this idea to a new version (same hypothesis)')
    .argument('<ideaId>', 'idea id')
    .requiredOption('--kind <kind>', 'engineering | scientific (scientific must use idea branch)')
    .requiredOption('--summary <text>', 'what changed and why')
    .option('--json', 'machine-readable output')
    .action(
      action(async (ideaId: string, opts: { kind: string; summary: string; json?: boolean }) => {
        const root = await openRoot();
        assertAutonomy(await getAutonomyMode(root), 'write-code');
        assertEngineeringRevision(opts.kind);
        const { version, meta } = await reviseEngineering(root, ideaId, opts.summary);
        if (opts.json) {
          process.stdout.write(
            jsonLine({
              ideaId,
              version: version.version,
              parentVersion: version.parentVersion,
              codeHash: version.codeHash,
              currentVersion: meta.currentVersion,
            }),
          );
        } else {
          process.stdout.write(
            `${ideaId}: v${version.parentVersion} → v${version.version} (engineering)\n`,
          );
          process.stdout.write(`  summary: ${version.summary}\n`);
          process.stdout.write(`  codeHash: ${version.codeHash ?? '(no checkpoint yet)'}\n`);
        }
        return 0;
      }),
    );

  idea
    .command('branch')
    .description('scientific hypothesis change: new idea id linked to its parent idea')
    .argument('<parentIdeaId>', 'existing idea id')
    .argument('<newIdeaId>', 'new kebab-case idea id')
    .requiredOption('--from-card <file>', 'IdeaCard for the new idea (version 1)')
    .option(
      '--confirm',
      'guided-mode confirmation for the hypothesis change (Decision/Event recorded)',
    )
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (
          parentIdeaId: string,
          newIdeaId: string,
          opts: { fromCard: string; confirm?: boolean; json?: boolean },
        ) => {
          const root = await openRoot();
          if (parentIdeaId === newIdeaId) {
            throw new IdeaseekError(
              'INVALID_ARGUMENT',
              'branch target must differ from the parent',
            );
          }
          // Protected change: a new scientific hypothesis needs the mode's
          // approval BEFORE any workspace is created (no partial side effects).
          const mode = await getAutonomyMode(root);
          assertAutonomy(mode, 'change-hypothesis', { confirmed: opts.confirm });

          const card = await readCardFile(opts.fromCard);
          const { meta } = await createWorkspace(root, {
            ideaId: newIdeaId,
            card,
            parentIdeaId,
            changeKind: 'scientific-branch',
          });

          // Branches always leave a Decision/Event (every mode — never silent).
          let decision: { seq: number } | null = null;
          {
            const { ProjectRuntime } = await import('../workflow/runtime.js');
            const runtime = await ProjectRuntime.open({ cwd: root });
            try {
              decision = await recordDecision(runtime.db, runtime.project.id, {
                action: 'change-hypothesis',
                target: `${parentIdeaId} → ${newIdeaId}`,
                mode,
                reason: 'scientific branch (new idea id)',
              });
            } finally {
              await runtime.close();
            }
          }

          if (opts.json) {
            process.stdout.write(
              jsonLine({
                ideaId: newIdeaId,
                parentIdeaId,
                status: meta.status,
                version: meta.currentVersion,
                decisionSeq: decision?.seq ?? null,
              }),
            );
          } else {
            process.stdout.write(
              `branched ${newIdeaId} from ${parentIdeaId} (scientific change, v1)\n`,
            );
            if (decision) process.stdout.write(`  decision recorded (event #${decision.seq})\n`);
            else process.stdout.write('  decision not recorded (no run exists yet)\n');
            process.stdout.write(`next: ideaseek idea show ${newIdeaId}\n`);
          }
          return 0;
        },
      ),
    );

  idea
    .command('set-status')
    .description('transition the idea lifecycle (PROPOSED → … → SUPPORTED/REJECTED)')
    .argument('<ideaId>', 'idea id')
    .argument('<status>', 'target lifecycle status')
    .option('--reason <text>', 'required for REJECTED')
    .option('--json', 'machine-readable output')
    .action(
      action(async (ideaId: string, status: string, opts: { reason?: string; json?: boolean }) => {
        const root = await openRoot();
        if (!(status in IDEA_TRANSITIONS)) {
          throw new IdeaseekError(
            'INVALID_ARGUMENT',
            `unknown status "${status}" (valid: ${Object.keys(IDEA_TRANSITIONS).join(', ')})`,
          );
        }
        const meta = await setIdeaStatus(root, ideaId, status as IdeaRunStatus, opts.reason);
        if (opts.json) {
          process.stdout.write(
            jsonLine({
              ideaId,
              status: meta.status,
              statusReason: meta.statusReason,
              nextTransitions: IDEA_TRANSITIONS[meta.status],
            }),
          );
        } else {
          process.stdout.write(
            `${ideaId}: → ${meta.status}${meta.statusReason ? ` (${meta.statusReason})` : ''}\n`,
          );
          const next = IDEA_TRANSITIONS[meta.status];
          process.stdout.write(`  next: ${next.length > 0 ? next.join(' | ') : '(terminal)'}\n`);
        }
        return 0;
      }),
    );

  idea
    .command('checkpoint')
    .description('bind the current src/ content hash to the current idea version')
    .argument('<ideaId>', 'idea id')
    .requiredOption('--message <text>', 'what changed in this checkpoint')
    .option('--json', 'machine-readable output')
    .action(
      action(async (ideaId: string, opts: { message: string; json?: boolean }) => {
        const root = await openRoot();
        assertAutonomy(await getAutonomyMode(root), 'write-code');
        const result = await checkpointCode(root, ideaId, opts.message);
        if (opts.json) {
          process.stdout.write(
            jsonLine({
              ideaId,
              version: result.version,
              codeHash: result.codeHash,
              changed: result.changed,
              message: result.message,
            }),
          );
        } else {
          process.stdout.write(
            `checkpoint ${ideaId} v${result.version}: ` +
              (result.changed
                ? `${result.codeHash ?? '(empty src/)'} recorded\n`
                : 'unchanged (idempotent)\n'),
          );
        }
        return 0;
      }),
    );

  idea
    .command('scaffold')
    .description(
      'write the Code Implementer starter skeleton (train/check_data/check_metrics/smoke/tests; never overwrites)',
    )
    .argument('<ideaId>', 'idea id')
    .option('--json', 'machine-readable output')
    .action(
      action(async (ideaId: string, opts: { json?: boolean }) => {
        const root = await openRoot();
        assertAutonomy(await getAutonomyMode(root), 'write-code');
        const result = await scaffoldIdea(root, ideaId);
        if (opts.json) {
          process.stdout.write(jsonLine({ ideaId, ...result }));
        } else {
          process.stdout.write(
            `scaffold ${ideaId}: ${result.created.length} file(s) created, ${result.skipped.length} kept\n`,
          );
          for (const file of result.created) process.stdout.write(`  + ${file}\n`);
          if (result.skipped.length > 0) {
            process.stdout.write(`  kept (existing): ${result.skipped.join(', ')}\n`);
          }
          process.stdout.write(`next: ideaseek idea check ${ideaId}\n`);
        }
        return 0;
      }),
    );

  idea
    .command('check')
    .description(
      'Code Implementer gate: static + unit tests + data/metrics interface + smoke micro-run',
    )
    .argument('<ideaId>', 'idea id')
    .option('--timeout <ms>', 'per-phase command timeout', (value) => Number(value), 60_000)
    .option('--json', 'machine-readable output')
    .action(
      action(async (ideaId: string, opts: { timeout: number; json?: boolean }) => {
        const root = await openRoot();
        if (!Number.isFinite(opts.timeout) || opts.timeout < 100) {
          throw new IdeaseekError('INVALID_ARGUMENT', '--timeout must be >= 100 ms');
        }
        const report = await runIdeaChecks(root, ideaId, { timeoutMs: opts.timeout });
        const reportPath = await saveCheckReport(root, report);

        // Queue discipline: a full pass from IMPLEMENTING advances to
        // SMOKE_TESTED (plan §E.3). Failures keep the status — implementation
        // errors are fixed and re-checked, not treated as hypothesis failures.
        let status = (await loadWorkspaceMeta(root, ideaId)).status;
        if (report.outcome === 'passed' && status === 'IMPLEMENTING') {
          status = (await setIdeaStatus(root, ideaId, 'SMOKE_TESTED')).status;
        }

        if (opts.json) {
          process.stdout.write(
            jsonLine({
              ideaId,
              outcome: report.outcome,
              status,
              version: report.version,
              codeHash: report.codeHash,
              reportPath,
              phases: report.phases.map((phase) => ({
                phase: phase.phase,
                ok: phase.ok,
                skipped: phase.skipped,
                failureKind: phase.failureKind ?? null,
                summary: phase.summary ?? null,
              })),
            }),
          );
        } else {
          process.stdout.write(
            `check ${ideaId} v${report.version}: ${report.outcome.toUpperCase()} (status=${status})\n`,
          );
          for (const phase of report.phases) {
            const mark = phase.skipped ? 'skip' : phase.ok ? 'ok  ' : 'FAIL';
            process.stdout.write(
              `  ${mark} ${phase.phase.padEnd(11)} ${phase.durationMs}ms` +
                `${phase.failureKind ? `  ${phase.failureKind}` : ''}` +
                `${phase.summary && !phase.ok ? `  ${phase.summary}` : ''}\n`,
            );
          }
          process.stdout.write(`  report: ${reportPath}\n`);
          if (report.outcome === 'failed') {
            process.stdout.write(
              `next: fix the failing phase, then rerun: ideaseek idea check ${ideaId}\n`,
            );
          } else if (report.outcome === 'smoke-missing') {
            process.stdout.write(
              `next: write src/smoke.py (or ideaseek idea scaffold ${ideaId}) to reach SMOKE_TESTED\n`,
            );
          } else {
            process.stdout.write(
              `next: ideaseek idea set-status ${ideaId} RUNNING   (experiments stay quick/standard)\n`,
            );
          }
        }
        return report.outcome === 'failed' ? 1 : 0;
      }),
    );

  idea
    .command('experiment')
    .description(
      'run a bounded smoke/quick experiment and record unified ExperimentSpec/RunResult (requires passing check)',
    )
    .argument('<ideaId>', 'idea id')
    .option('--scale <scale>', 'smoke | quick (never full training)', 'smoke')
    .option('--timeout <ms>', 'run timeout', (value) => Number(value), 120_000)
    .option('--resume', 'resume from the last compatible checkpoint (task-level recovery refuses)')
    .option(
      '--waive-novelty <reason>',
      'proceed despite a current ABANDON novelty verdict (records a Decision/Event)',
    )
    .option(
      '--waive-review <reason>',
      'proceed despite a current failing independent review (records a Decision/Event)',
    )
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (
          ideaId: string,
          opts: {
            scale: string;
            timeout: number;
            resume?: boolean;
            waiveNovelty?: string;
            waiveReview?: string;
            json?: boolean;
          },
        ) => {
          const root = await openRoot();
          if (opts.scale !== 'smoke' && opts.scale !== 'quick') {
            throw new IdeaseekError('INVALID_ARGUMENT', '--scale must be smoke | quick');
          }
          if (!Number.isFinite(opts.timeout) || opts.timeout < 100) {
            throw new IdeaseekError('INVALID_ARGUMENT', '--timeout must be >= 100 ms');
          }
          const { ProjectRuntime } = await import('../workflow/runtime.js');
          const runtime = await ProjectRuntime.open({ cwd: root });
          try {
            assertAutonomy(
              parseAutonomyMode(runtime.config.policy.autonomyMode),
              'start-experiment',
            );

            // Audited novelty/review waivers: record the Decision BEFORE
            // running so any gate bypass is visible in the event trail.
            let waiverSeq: number | null = null;
            if (opts.waiveNovelty || opts.waiveReview) {
              const { readNoveltyReport } = await import('../idea/novelty.js');
              const { readLatestReview, isReviewPassing } = await import('../idea/review.js');
              const { loadWorkspaceMeta } = await import('../idea/workspace.js');
              const metaW = await loadWorkspaceMeta(root, ideaId);
              const run = await runtime.db.getLatestRun(runtime.project.id);
              const report = opts.waiveNovelty ? await readNoveltyReport(root, ideaId) : null;
              if (
                run &&
                report &&
                report.cardVersion === metaW.currentVersion &&
                report.verdict === 'ABANDON'
              ) {
                const event = await runtime.db.appendEvent({
                  runId: run.runId,
                  phase: 'DECISION',
                  objectId: ideaId,
                  role: 'user',
                  eventType: 'decision',
                  summary: `novelty-waived: ${ideaId} ABANDON (score ${report.score}) — ${opts.waiveNovelty}`,
                  status: 'confirmed',
                });
                waiverSeq = event.seq;
              }
              const review = opts.waiveReview ? await readLatestReview(root, ideaId) : null;
              if (
                run &&
                review &&
                review.cardVersion === metaW.currentVersion &&
                !isReviewPassing(review)
              ) {
                const event = await runtime.db.appendEvent({
                  runId: run.runId,
                  phase: 'DECISION',
                  objectId: ideaId,
                  role: 'user',
                  eventType: 'decision',
                  summary:
                    `review-waived: ${ideaId} round ${review.round} ${review.verdict} ` +
                    `(score ${review.score}) — ${opts.waiveReview}`,
                  status: 'confirmed',
                });
                waiverSeq = event.seq;
              }
            }

            const outcome = await runIdeaExperiment(
              root,
              ideaId,
              {
                scale: opts.scale as IdeaScale,
                timeoutMs: opts.timeout,
                resume: opts.resume,
                waiveNovelty: opts.waiveNovelty,
                waiveReview: opts.waiveReview,
              },
              runtime,
              runtime.db,
            );
            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  ideaId,
                  specId: outcome.specId,
                  version: outcome.version,
                  attempt: outcome.attempt,
                  scale: opts.scale,
                  alreadyRecorded: outcome.alreadyRecorded,
                  resultStatus: outcome.resultStatus,
                  metrics: outcome.metrics,
                  failure: outcome.failure,
                  statusAfter: outcome.statusAfter,
                  waiverSeq,
                }),
              );
            } else if (outcome.alreadyRecorded) {
              process.stdout.write(
                `experiment ${outcome.specId} v${outcome.version}: already recorded (idempotent)\n`,
              );
            } else if (outcome.resultStatus === 'succeeded') {
              process.stdout.write(
                `experiment ${outcome.specId} v${outcome.version}: SUCCEEDED → ${outcome.statusAfter}\n`,
              );
              for (const metric of outcome.metrics) {
                process.stdout.write(`  ${metric.name} = ${metric.value}\n`);
              }
            } else {
              process.stdout.write(
                `experiment ${outcome.specId} v${outcome.version}: FAILED ` +
                  `(${outcome.failure?.category}: ${outcome.failure?.summary ?? ''}) → ${outcome.statusAfter}\n`,
              );
              process.stdout.write(
                `next: fix and re-check, then walk back: ideaseek idea set-status ${ideaId} NEEDS_REVISION\n`,
              );
            }
            if (waiverSeq !== null && !opts.json) {
              const parts = [
                opts.waiveNovelty ? `novelty ABANDON waived: ${opts.waiveNovelty}` : null,
                opts.waiveReview ? `failing review waived: ${opts.waiveReview}` : null,
              ].filter(Boolean);
              process.stdout.write(`${parts.join(' · ')} (decision event #${waiverSeq})\n`);
            }
            if (!outcome.alreadyRecorded) {
              const expMode = parseAutonomyMode(runtime.config.policy.autonomyMode);
              const expCheck = checkAutonomy(expMode, 'start-experiment');
              if (expCheck.needsDecision) {
                const decision = await recordDecision(runtime.db, runtime.project.id, {
                  action: 'start-experiment',
                  target: `${ideaId} ${opts.scale}`,
                  mode: expMode,
                });
                if (decision && !opts.json) {
                  process.stdout.write(`  decision recorded (event #${decision.seq})\n`);
                }
              }
            }
            return outcome.exitCode;
            return outcome.exitCode;
          } finally {
            await runtime.close();
          }
        },
      ),
    );

  idea
    .command('run-ready')
    .description(
      'admit all SMOKE_TESTED ideas through the capacity planner and run their experiments in parallel',
    )
    .option('--scale <scale>', 'smoke | quick (never full training)', 'smoke')
    .option('--timeout <ms>', 'per-idea run timeout', (value) => Number(value), 120_000)
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { scale: string; timeout: number; json?: boolean }) => {
        const root = await openRoot();
        if (opts.scale !== 'smoke' && opts.scale !== 'quick') {
          throw new IdeaseekError('INVALID_ARGUMENT', '--scale must be smoke | quick');
        }
        if (!Number.isFinite(opts.timeout) || opts.timeout < 100) {
          throw new IdeaseekError('INVALID_ARGUMENT', '--timeout must be >= 100 ms');
        }
        const { ProjectRuntime } = await import('../workflow/runtime.js');
        const runtime = await ProjectRuntime.open({ cwd: root });
        try {
          assertAutonomy(parseAutonomyMode(runtime.config.policy.autonomyMode), 'start-experiment');
          const result = await runReadyExperiments(
            root,
            {
              scale: opts.scale as IdeaScale,
              timeoutMs: opts.timeout,
              maxParallelIdeas: runtime.config.resources.maxParallelIdeas,
            },
            runtime,
            runtime.db,
          );
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                scale: opts.scale,
                admitted: result.admitted,
                queued: result.queued,
                constraints: result.constraints,
                allOk: result.allOk,
                outcomes: result.outcomes.map((entry) => ({
                  ideaId: entry.ideaId,
                  ok: entry.ok,
                  error: entry.error ?? null,
                  resultStatus: entry.outcome?.resultStatus ?? null,
                  alreadyRecorded: entry.outcome?.alreadyRecorded ?? false,
                  metrics: entry.outcome?.metrics ?? [],
                  statusAfter: entry.outcome?.statusAfter ?? null,
                })),
              }),
            );
          } else {
            if (result.admitted.length === 0 && result.queued.length === 0) {
              process.stdout.write('run-ready: no SMOKE_TESTED ideas waiting\n');
            } else {
              process.stdout.write(
                `run-ready: ${result.admitted.length} admitted · ${result.queued.length} queued` +
                  `${result.constraints.length > 0 ? ` (${result.constraints.join(' · ')})` : ''}\n`,
              );
            }
            for (const entry of result.outcomes) {
              if (entry.error) {
                process.stdout.write(`  FAIL ${entry.ideaId}  ${entry.error}\n`);
              } else {
                const outcome = entry.outcome!;
                process.stdout.write(
                  `  ${entry.ok ? 'ok  ' : 'FAIL'} ${outcome.specId} v${outcome.version}  ` +
                    `${outcome.alreadyRecorded ? 'already recorded' : outcome.resultStatus}` +
                    `${outcome.failure ? ` (${outcome.failure.category}: ${outcome.failure.summary})` : ''}\n`,
                );
                for (const metric of outcome.metrics) {
                  process.stdout.write(`        ${metric.name} = ${metric.value}\n`);
                }
              }
            }
            for (const entry of result.queued) {
              process.stdout.write(`  WAIT ${entry.ideaId}  ${entry.reason}\n`);
            }
            if (result.admitted.length > 0 && result.allOk) {
              process.stdout.write('next: ideaseek idea list   (results await analysis)\n');
            }
          }
          if (result.admitted.length > 0) {
            const rrMode = parseAutonomyMode(runtime.config.policy.autonomyMode);
            const rrCheck = checkAutonomy(rrMode, 'start-experiment');
            if (rrCheck.needsDecision) {
              const decision = await recordDecision(runtime.db, runtime.project.id, {
                action: 'start-experiment',
                target: `run-ready(${result.admitted.join(',')}) ${opts.scale}`,
                mode: rrMode,
              });
              if (decision && !opts.json) {
                process.stdout.write(`  decision recorded (event #${decision.seq})\n`);
              }
            }
          }
          return result.allOk ? 0 : 1;
        } finally {
          await runtime.close();
        }
      }),
    );

  idea
    .command('ablate')
    .description(
      'run the mechanism-chain ablation matrix (each ablation bound to idea version + spec + code hash)',
    )
    .argument('<ideaId>', 'idea id')
    .option('--scale <scale>', 'smoke | quick', 'smoke')
    .option('--timeout <ms>', 'per-ablation timeout', (value) => Number(value), 120_000)
    .option('--json', 'machine-readable output')
    .action(
      action(async (ideaId: string, opts: { scale: string; timeout: number; json?: boolean }) => {
        const root = await openRoot();
        if (opts.scale !== 'smoke' && opts.scale !== 'quick') {
          throw new IdeaseekError('INVALID_ARGUMENT', '--scale must be smoke | quick');
        }
        const { ProjectRuntime } = await import('../workflow/runtime.js');
        const runtime = await ProjectRuntime.open({ cwd: root });
        try {
          assertAutonomy(parseAutonomyMode(runtime.config.policy.autonomyMode), 'start-experiment');
          const result = await runAblations(
            root,
            ideaId,
            { scale: opts.scale as IdeaScale, timeoutMs: opts.timeout },
            runtime,
            runtime.db,
          );
          if (opts.json) {
            process.stdout.write(jsonLine(result));
          } else {
            process.stdout.write(
              `ablate ${ideaId} v${result.ideaVersion}: ${result.entries.length} entr(ies) · ` +
                `${result.allOk ? 'all ok' : 'some failed'}\n`,
            );
            for (const entry of result.entries) {
              process.stdout.write(
                `  ${entry.exitCode === 0 ? 'ok  ' : 'FAIL'} ${entry.specId} v${entry.version}  ` +
                  `${entry.alreadyRecorded ? 'already recorded' : entry.resultStatus}` +
                  `${entry.failure ? ` (${entry.failure.category})` : ''}  ${entry.label}\n`,
              );
              for (const metric of entry.metrics) {
                process.stdout.write(`        ${metric.name} = ${metric.value}\n`);
              }
            }
            if (result.plan) {
              process.stdout.write(
                `ablation plan (ARIS, ${result.plan.matched} matched): ${result.plan.coverageAssessment}\n`,
              );
              if (result.plan.deferred.length > 0) {
                process.stdout.write(
                  `  deferred (scaffold cannot run): ${result.plan.deferred
                    .map((entry) => entry.name)
                    .join(', ')}\n`,
                );
              }
              if (result.plan.unmatchedTargets.length > 0) {
                process.stdout.write(
                  `  coverage gap (plan target without derived ablation): ${result.plan.unmatchedTargets.join(', ')}\n`,
                );
              }
            }
            if (result.allOk) {
              process.stdout.write(`next: ideaseek idea analyze ${ideaId}\n`);
            }
          }
          if (result.entries.some((entry) => !entry.alreadyRecorded)) {
            const abMode = parseAutonomyMode(runtime.config.policy.autonomyMode);
            const abCheck = checkAutonomy(abMode, 'start-experiment');
            if (abCheck.needsDecision) {
              const decision = await recordDecision(runtime.db, runtime.project.id, {
                action: 'start-experiment',
                target: `ablate ${ideaId}`,
                mode: abMode,
              });
              if (decision && !opts.json) {
                process.stdout.write(`  decision recorded (event #${decision.seq})\n`);
              }
            }
          }
          return result.allOk ? 0 : 1;
        } finally {
          await runtime.close();
        }
      }),
    );

  idea
    .command('analyze')
    .description(
      'Result Analyst: verdict from baselines + main run + ablations + coverage (crash ≠ hypothesis failure)',
    )
    .argument('<ideaId>', 'idea id')
    .option('--json', 'machine-readable output')
    .action(
      action(async (ideaId: string, opts: { json?: boolean }) => {
        const root = await openRoot();
        const { ProjectRuntime } = await import('../workflow/runtime.js');
        const runtime = await ProjectRuntime.open({ cwd: root });
        try {
          const { analysis, paths } = await runAnalysis(root, ideaId, runtime.db);
          if (opts.json) {
            process.stdout.write(jsonLine({ analysis, paths }));
            return 0;
          }
          process.stdout.write(
            `analysis ${ideaId} v${analysis.ideaVersion}: ${analysis.verdict.toUpperCase()}` +
              `${analysis.failureClass !== 'none' ? ` (failure class: ${analysis.failureClass})` : ''}\n`,
          );
          process.stdout.write(
            `  coverage: scales=[${analysis.coverage.scales.join(', ')}] ` +
              `datasets=${analysis.coverage.datasets.length} seeds=${analysis.coverage.seeds}` +
              `${analysis.coverage.missing.length > 0 ? ` · missing: ${analysis.coverage.missing.join('; ')}` : ''}\n`,
          );
          if (analysis.primaryDelta !== null) {
            process.stdout.write(`  primary delta vs best baseline: ${analysis.primaryDelta}\n`);
          }
          for (const reason of analysis.reasons) process.stdout.write(`  reason: ${reason}\n`);
          for (const failure of analysis.failures) {
            process.stdout.write(
              `  failure kept: ${failure.specId} ${failure.category ?? '?'} → ${failure.class}\n`,
            );
          }
          for (const step of analysis.nextSteps) process.stdout.write(`  next: ${step}\n`);
          process.stdout.write(`  written: ${paths.join(', ')}\n`);
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );

  idea
    .command('handoff')
    .description(
      'build the full-scale reproduction package (config/split/lock/commands/provenance) behind the HANDOFF_READY gate',
    )
    .argument('<ideaId>', 'idea id')
    .option('--confirm', 'accept a HANDOFF_READY delivery (guided mode; Decision/Event recorded)')
    .option('--json', 'machine-readable output')
    .action(
      action(async (ideaId: string, opts: { confirm?: boolean; json?: boolean }) => {
        const root = await openRoot();
        const { ProjectRuntime } = await import('../workflow/runtime.js');
        const runtime = await ProjectRuntime.open({ cwd: root });
        try {
          const mode = parseAutonomyMode(runtime.config.policy.autonomyMode);
          if (mode === 'review-only') {
            // Review-only never delivers packages (analysis only).
            assertAutonomy(mode, 'finalize-handoff', { confirmed: opts.confirm });
          }
          const result = await buildIdeaHandoff(root, ideaId, runtime.db);
          if (result.gate.handoffReady) {
            const check = checkAutonomy(mode, 'finalize-handoff', { confirmed: opts.confirm });
            if (!check.allowed) {
              process.stdout.write(
                `handoff ${ideaId}: package written (${result.files.length} files) but ` +
                  'the HANDOFF_READY delivery is NOT accepted yet\n',
              );
              process.stdout.write(`  reason: ${check.reason ?? ''}\n`);
              process.stdout.write(
                `next: ideaseek idea handoff ${ideaId} --confirm   (records a Decision/Event)\n`,
              );
              return 2;
            }
            if (check.needsDecision) {
              const decision = await recordDecision(runtime.db, runtime.project.id, {
                action: 'finalize-handoff',
                target: `${ideaId} ${result.gate.level}`,
                mode,
              });
              if (decision) {
                process.stdout.write(`  decision recorded (event #${decision.seq})\n`);
              }
            }
          }
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                ideaId,
                level: result.gate.level,
                handoffReady: result.gate.handoffReady,
                blockers: result.gate.blockers,
                analysisVerdict: result.analysisVerdict,
                dir: result.dir,
                files: result.files,
              }),
            );
            return 0;
          }
          process.stdout.write(
            `handoff ${ideaId}: ${result.gate.level}` +
              `${result.gate.handoffReady ? ' (HANDOFF_READY)' : ''}\n`,
          );
          process.stdout.write(`  dir: ${result.dir}\n`);
          for (const file of result.files) process.stdout.write(`  + ${file}\n`);
          for (const blocker of result.gate.blockers) {
            process.stdout.write(`  blocker: ${blocker}\n`);
          }
          if (result.gate.handoffReady) {
            process.stdout.write(
              'next: confirm delivery (guided gate) — the package is ready for your full-scale run\n',
            );
          } else {
            process.stdout.write(
              'next: clear the blockers above, then rerun ideaseek idea handoff\n',
            );
          }
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );

  idea
    .command('verify')
    .description('verify structure, version chain, parent links and input hashes')
    .argument('<ideaId>', 'idea id')
    .option('--json', 'machine-readable output')
    .action(
      action(async (ideaId: string, opts: { json?: boolean }) => {
        const root = await openRoot();
        const result = await verifyWorkspace(root, ideaId);
        if (opts.json) {
          process.stdout.write(
            jsonLine({
              ideaId,
              ok: result.ok,
              status: result.status,
              currentVersion: result.currentVersion,
              cardGate: result.cardGate,
              inputsChanged: result.inputsChanged,
              issues: result.issues,
            }),
          );
        } else {
          process.stdout.write(
            `verify ${ideaId}: ${result.ok ? 'OK' : `${result.issues.length} issue(s)`} ` +
              `(${result.status}, v${result.currentVersion}, gate=${result.cardGate})\n`,
          );
          for (const issue of result.issues) {
            process.stdout.write(`  ✗ [${issue.kind}] ${issue.detail}\n`);
          }
        }
        return result.ok ? 0 : 2;
      }),
    );
}
