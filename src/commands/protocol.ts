import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { sha256OfJson } from '../core/hash.js';
import { ProjectRuntime } from '../workflow/runtime.js';
import { loadCompactCards } from '../knowledge/cards.js';
import { PROTOCOL_PROMPT_VERSION, buildProtocolInput } from '../experiment/protocol-synth.js';
import { ensureActiveRun } from './ingest.js';
import {
  action,
  assertConfigUsable,
  buildHarness,
  buildHandlers,
  countByStatus,
  jsonLine,
  runWorkerInteractive,
} from './shared.js';

/**
 * `ideaseek protocol propose` — the Protocol Synthesis Agent stage of
 * docs/WORKFLOW_SPEC (PROTOCOL_PROPOSE): a resumable workflow task that
 * grounds the ExperimentalProtocolProposal in verified cards + the dataset
 * profile; `ideaseek confirm protocol` then validates/locks it (with the
 * leakage gate).
 */
export function registerProtocolCommand(program: Command): void {
  const protocol = program.command('protocol').description('experimental protocol workflow');

  protocol
    .command('propose')
    .description('synthesize an ExperimentalProtocolProposal from verified cards and data profile')
    .option('--harness <kind>', 'agent harness: fake (default) or dsh', 'fake')
    .option('--enqueue-only', 'enqueue the proposal task without executing')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { harness?: string; enqueueOnly?: boolean; json?: boolean }) => {
        const runtime = await ProjectRuntime.open({
          cwd: process.cwd(),
          harness: buildHarness(opts.harness),
        });
        try {
          assertConfigUsable(runtime.configLoad);
          const cards = await loadCompactCards(runtime);
          if (cards.length === 0) {
            throw new IdeaseekError(
              'USER_INPUT_REQUIRED',
              'no extracted PaperCards found; run: ideaseek ingest && ideaseek extract',
            );
          }

          // Incremental: skip when a proposal for identical inputs is committed.
          const datasetProfile = await loadDatasetProfileFile(runtime);
          const input = buildProtocolInput({
            question: runtime.config.research.question,
            cards,
            datasetProfile,
          });
          const inputHash = await sha256OfJson({
            inputs: input,
            generator: PROTOCOL_PROMPT_VERSION,
          });
          for (const artifact of await runtime.db.listArtifactsByKind('protocol-proposal')) {
            if (artifact.meta.inputHash === inputHash) {
              if (opts.json) {
                process.stdout.write(
                  jsonLine({ action: 'proposal-current', inputHash, papers: cards.length }),
                );
              } else {
                process.stdout.write(
                  `protocol propose: proposal is current for ${cards.length} card(s) (input ${String(inputHash).slice(0, 19)}…)\n`,
                );
                process.stdout.write('next: ideaseek confirm protocol\n');
              }
              return 0;
            }
          }

          const { runId } = await ensureActiveRun(runtime);
          const { created } = await runtime.db.enqueueTask({
            runId,
            type: 'protocol.propose',
            phase: 'DEMO',
            payload: { inputHash },
            dependsOn: [],
            idempotencyKey: `protocol:${inputHash.slice(7, 19)}:v1`,
            maxAttempts: runtime.config.runtime.maxAttempts,
          });

          if (opts.enqueueOnly) {
            if (opts.json) {
              process.stdout.write(jsonLine({ runId, enqueued: created, inputHash }));
            } else {
              process.stdout.write(
                `protocol propose: ${created ? '1 task enqueued' : 'task already queued'} in ${runId}\n`,
              );
              process.stdout.write('next: ideaseek worker\n');
            }
            return 0;
          }

          const { exit } = await runWorkerInteractive(runtime, runId, {
            kind: 'inline',
            handlers: buildHandlers(),
            onLog: opts.json ? undefined : (message) => process.stderr.write(`  · ${message}\n`),
          });

          if (opts.json) {
            process.stdout.write(
              jsonLine({
                runId,
                status: (await db(runId, runtime)) ?? exit.runStatus,
                exitReason: exit.reason,
                tasks: countByStatus(await runtime.db.listTasks(runId)),
                inputHash,
              }),
            );
          } else {
            process.stdout.write(
              `protocol propose → ${exit.reason} in ${runId}; next: ideaseek confirm protocol\n`,
            );
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
            default:
              return exit.runStatus === 'RUNNING' ? 3 : 0;
          }
        } finally {
          await runtime.close();
        }
      }),
    );
}

async function db(runId: string, runtime: ProjectRuntime): Promise<string | undefined> {
  return (await runtime.db.getRun(runId))?.status;
}

export async function loadDatasetProfileFile(
  runtime: ProjectRuntime,
): Promise<Awaited<ReturnType<typeof loadProfileInner>>> {
  return loadProfileInner(runtime);
}

async function loadProfileInner(runtime: ProjectRuntime) {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  try {
    const parsed = JSON.parse(
      await readFile(join(runtime.paths.knowledgeDir, 'dataset-card.json'), 'utf8'),
    ) as {
      profiles?: {
        source: { path: string };
        rows: number;
        columns: { name: string }[];
        labelCandidates: { column: string }[];
      }[];
    };
    const profiles = parsed.profiles ?? [];
    if (profiles.length === 0) return null;
    return {
      present: true,
      files: profiles.map((profile) => ({
        path: profile.source.path,
        rows: profile.rows,
        columns: profile.columns.length,
        labelCandidates: profile.labelCandidates.map((candidate) => candidate.column),
      })),
      note: 'dataset profile from ideaseek data describe (deterministic profiling)',
    };
  } catch {
    return null;
  }
}
