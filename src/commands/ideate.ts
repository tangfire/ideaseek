import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import {
  FEEDBACK_LABELS,
  appendFeedback,
  createRound,
  loadRound,
  listRounds,
  type FeedbackLabel,
} from '../idea/rounds.js';
import { action, jsonLine } from './shared.js';

/**
 * Multi-round ideation surface (docs/IDEATION_ROUNDS.md):
 * - `ideate --round new` freezes an immutable round snapshot with dedup
 *   fingerprints + novelty constraints and honestly reports whether ANY
 *   new information exists (never pads candidates);
 * - `rounds list/show` are read-only views;
 * - `feedback` appends user labels to an idea (append-only) and records a
 *   feedback RunEvent so reviews enter the auditable trail.
 * Candidate GENERATION runs through `ideaseek idea generate` (model-gated,
 * ARIS idea-creator skill backend); this command prepares and reports the
 * deterministic context and points at it.
 */
export function registerIdeateCommands(program: Command): void {
  program
    .command('ideate')
    .description('create or continue an IdeationRound with dedup context and change detection')
    .option('--round <id>', "round id: 'new' (default) or an existing rN with --continue")
    .option('--continue', 'load an existing round instead of creating one')
    .option('--question <text>', 'user directive recorded on the round')
    .option('--ideas <n>', 'idea limit for this round', (value) => Number(value))
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (opts: {
          round?: string;
          continue?: boolean;
          question?: string;
          ideas?: number;
          json?: boolean;
        }) => {
          const { findProjectRoot, projectPaths } = await import('../config/paths.js');
          const root = await findProjectRoot(process.cwd());
          if (!root) {
            throw new IdeaseekError(
              'NOT_INITIALIZED',
              'no IdeaSeek project here; run: ideaseek init',
            );
          }
          const { loadConfig } = await import('../config/config.js');
          const config = await loadConfig(projectPaths(root));
          const ideaLimit =
            Number.isFinite(opts.ideas) && (opts.ideas as number) > 0
              ? Math.floor(opts.ideas as number)
              : config.resolved.research.ideaLimit;

          const roundId = opts.round && opts.round !== 'new' ? opts.round : null;

          // Targeting an existing round (--round r1 [--continue]): read-only load.
          if (roundId) {
            const round = await loadRound(root, roundId);
            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  mode: 'continue',
                  round,
                  hasNewInformation: true,
                  next: 'Idea Generator consumes this context (model-gated); new candidates must differ from noveltyConstraints and knownFingerprints',
                }),
              );
              return 0;
            }
            printRoundSummary(round);
            process.stdout.write(
              `continuing ${round.roundId}: ${round.inherited.length} inherited idea(s), ` +
                `${round.noveltyConstraints.length} novelty constraint(s)\n`,
            );
            process.stdout.write(
              `next: ideaseek idea generate --round ${round.roundId}` +
                ' (add evidence/feedback first if nothing changed)\n',
            );
            return 0;
          }

          // --round new (default): create the next immutable round.
          const result = await createRound(root, {
            question: opts.question ?? config.resolved.research.question ?? null,
            ideaLimit,
            modelRoute: config.resolved.runtime.modelRoute,
            instructions: opts.question ? [opts.question] : [],
          });

          if (opts.json) {
            process.stdout.write(
              jsonLine({
                mode: 'new',
                roundId: result.round.roundId,
                hasNewInformation: result.hasNewInformation,
                note: result.newInformationNote,
                stopReason: result.round.stopReason,
                parentRoundId: result.round.parentRoundId,
                snapshots: result.round.snapshots,
                inherited: result.round.inherited,
                noveltyConstraints: result.round.noveltyConstraints,
                ideaLimit: result.round.ideaLimit,
                next: `ideaseek idea generate --round ${result.round.roundId}`,
              }),
            );
            return 0;
          }
          printRoundSummary(result.round);
          if (!result.hasNewInformation) {
            process.stdout.write(`honest gate: ${result.newInformationNote}\n`);
            process.stdout.write(
              '没有足够新信息生成高质量新 idea — add papers/data/feedback or refine the question, ' +
                'then rerun ideate (candidates are never padded)\n',
            );
            return 0;
          }
          process.stdout.write(
            `round ${result.round.roundId} created · new information: ${result.newInformationNote}\n`,
          );
          process.stdout.write(
            `next: ideaseek idea generate --round ${result.round.roundId}` +
              '   (ARIS idea-creator backend; the dsh harness needs model credentials)\n',
          );
          return 0;
        },
      ),
    );

  const rounds = program.command('rounds').description('inspect ideation rounds (read-only)');

  rounds
    .command('list', { isDefault: true })
    .description('list ideation rounds with snapshots and inherited idea counts')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { json?: boolean }) => {
        const { findProjectRoot } = await import('../config/paths.js');
        const root = await findProjectRoot(process.cwd());
        if (!root) {
          throw new IdeaseekError(
            'NOT_INITIALIZED',
            'no IdeaSeek project here; run: ideaseek init',
          );
        }
        const list = await listRounds(root);
        if (opts.json) {
          process.stdout.write(
            jsonLine({
              rounds: list.map((round) => ({
                roundId: round.roundId,
                createdAt: round.createdAt,
                question: round.question,
                status: round.status,
                stopReason: round.stopReason,
                parentRoundId: round.parentRoundId,
                inheritedIdeas: round.inherited.length,
                noveltyConstraints: round.noveltyConstraints.length,
                paperCards: round.snapshots.paperCardCount,
                protocolId: round.snapshots.protocolId,
              })),
            }),
          );
          return 0;
        }
        if (list.length === 0) {
          process.stdout.write('no ideation rounds (ideaseek ideate --round new)\n');
          return 0;
        }
        process.stdout.write(`${list.length} round(s):\n`);
        for (const round of list) {
          process.stdout.write(
            `  ${round.roundId}  ${round.status.padEnd(6)} cards=${round.snapshots.paperCardCount} ` +
              `ideas=${round.inherited.length} constraints=${round.noveltyConstraints.length}` +
              `${round.stopReason ? `  stop=${round.stopReason}` : ''}\n`,
          );
          if (round.question) process.stdout.write(`      ${round.question}\n`);
        }
        return 0;
      }),
    );

  rounds
    .command('show')
    .description('show one round: snapshots, inherited ideas, feedback and novelty constraints')
    .argument('<roundId>', 'e.g. r1')
    .option('--json', 'machine-readable output')
    .action(
      action(async (roundId: string, opts: { json?: boolean }) => {
        const { findProjectRoot } = await import('../config/paths.js');
        const root = await findProjectRoot(process.cwd());
        if (!root) {
          throw new IdeaseekError(
            'NOT_INITIALIZED',
            'no IdeaSeek project here; run: ideaseek init',
          );
        }
        const round = await loadRound(root, roundId);
        if (opts.json) {
          process.stdout.write(jsonLine({ round }));
          return 0;
        }
        printRoundSummary(round);
        if (round.inherited.length > 0) {
          process.stdout.write('inherited ideas:\n');
          for (const ref of round.inherited) {
            process.stdout.write(
              `  ${ref.ideaId}  ${ref.status}  ${ref.fingerprint.slice(0, 12)}…` +
                `${ref.feedbackLabels.length > 0 ? `  feedback: ${ref.feedbackLabels.join(',')}` : ''}\n`,
            );
          }
        }
        if (round.noveltyConstraints.length > 0) {
          process.stdout.write('novelty constraints (must differ):\n');
          for (const constraint of round.noveltyConstraints.slice(0, 10)) {
            process.stdout.write(`  · ${constraint}\n`);
          }
        }
        return 0;
      }),
    );

  program
    .command('feedback')
    .description('record a user feedback label on an idea (append-only + feedback event)')
    .argument('<label>', `one of: ${FEEDBACK_LABELS.join(' | ')}`)
    .requiredOption('--idea <ideaId>', 'idea id the feedback applies to')
    .option('--reason <text>', 'optional explanation')
    .option('--json', 'machine-readable output')
    .action(
      action(async (label: string, opts: { idea: string; reason?: string; json?: boolean }) => {
        if (!(FEEDBACK_LABELS as readonly string[]).includes(label)) {
          throw new IdeaseekError(
            'INVALID_ARGUMENT',
            `label must be one of: ${FEEDBACK_LABELS.join(' | ')}`,
          );
        }
        const { findProjectRoot } = await import('../config/paths.js');
        const root = await findProjectRoot(process.cwd());
        if (!root) {
          throw new IdeaseekError(
            'NOT_INITIALIZED',
            'no IdeaSeek project here; run: ideaseek init',
          );
        }
        const { total } = await appendFeedback(
          root,
          opts.idea,
          label as FeedbackLabel,
          opts.reason ?? null,
        );

        // Feedback enters the auditable trail (gaps #8) when a run exists.
        let eventSeq: number | null = null;
        try {
          const { ProjectRuntime } = await import('../workflow/runtime.js');
          const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
          try {
            const run = await runtime.db.getLatestRun(runtime.project.id);
            if (run) {
              const event = await runtime.db.appendEvent({
                runId: run.runId,
                phase: 'FEEDBACK',
                objectId: opts.idea,
                role: 'user',
                eventType: 'feedback',
                summary: `feedback ${label} on ${opts.idea}${opts.reason ? `: ${opts.reason}` : ''}`,
                status: label,
              });
              eventSeq = event.seq;
            }
          } finally {
            await runtime.close();
          }
        } catch {
          // no run yet — file-level feedback still recorded
        }

        if (opts.json) {
          process.stdout.write(
            jsonLine({
              ideaId: opts.idea,
              label,
              reason: opts.reason ?? null,
              totalFeedback: total,
              eventSeq,
            }),
          );
        } else {
          process.stdout.write(`feedback recorded: ${opts.idea} → ${label} (${total} total)\n`);
          if (eventSeq !== null) {
            process.stdout.write(`  event #${eventSeq} appended to the current run\n`);
          } else {
            process.stdout.write('  no run yet — recorded in ideas/feedback.json only\n');
          }
        }
        return 0;
      }),
    );
}

function printRoundSummary(round: {
  roundId: string;
  status: string;
  question: string | null;
  createdAt: number;
  ideaLimit: number;
  modelRoute: string;
  parentRoundId: string | null;
  stopReason: string | null;
  snapshots: {
    inputManifestHash: string | null;
    paperCardCount: number;
    researchMapHash: string | null;
    protocolId: string | null;
    protocolHash: string | null;
    comparisonSet: { methodId: string; status: string }[];
    datasetRootHashes: string[];
  };
  inherited: { ideaId: string; status: string }[];
}): void {
  process.stdout.write(
    `round ${round.roundId}  ${round.status}  created ${new Date(round.createdAt).toISOString()}\n`,
  );
  if (round.question) process.stdout.write(`  question: ${round.question}\n`);
  process.stdout.write(
    `  ideas limit ${round.ideaLimit} · route ${round.modelRoute} · parent ${round.parentRoundId ?? 'none'}\n`,
  );
  if (round.stopReason) process.stdout.write(`  stop reason: ${round.stopReason}\n`);
  process.stdout.write(
    `  snapshots: cards=${round.snapshots.paperCardCount} ` +
      `protocol=${round.snapshots.protocolId ?? 'none'} ` +
      `comparisons=${round.snapshots.comparisonSet.length} ` +
      `datasets=${round.snapshots.datasetRootHashes.length}\n`,
  );
  process.stdout.write(
    `  input manifest: ${round.snapshots.inputManifestHash ?? 'none'} · ` +
      `research map: ${round.snapshots.researchMapHash ?? 'none'}\n`,
  );
  if (round.inherited.length > 0) {
    process.stdout.write(
      `  inherited ideas: ${round.inherited.map((ref) => `${ref.ideaId}(${ref.status})`).join(', ')}\n`,
    );
  }
}
