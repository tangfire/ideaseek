import type { Command } from 'commander';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { ProjectRuntime } from '../workflow/runtime.js';
import { runCli } from '../cli/runner.js';
import { detectInputDrift, readInputManifest } from '../knowledge/input-drift.js';
import {
  MODEL_OUTPUT_MARKERS,
  WATCH_CONTRACT,
  WATCH_OUTPUT_MARKERS,
  evaluateWatchGate,
  type WatchReason,
} from '../knowledge/surveillance.js';
import { collectParsedHashes, partitionPdfs } from './ingest.js';
import { committedSourcesOf, selectPendingExtracts } from './extract.js';
import { performScan } from './inputs.js';
import { action, assertConfigUsable, jsonLine } from './shared.js';

/**
 * `ideaseek literature watch` — continuous literature surveillance (design
 * review #13: synthesize/wiki were one-shot). One cron-friendly entry that
 * decides whether ANY refresh work exists, then drives the incremental
 * chain: scan → ingest → data describe → extract/synthesize (model-backed,
 * skipped without credentials) → wiki → assessment.
 *
 * Exit contract for automation: 0 = ran or nothing to do (JSON `changed`
 * and `reason` say which), 1 = a refresh step failed, 2 = the refreshed
 * assessment has blocking gaps. The gate (evaluateWatchGate) is pure and
 * unit-tested; every chain step keeps its own incremental reuse, so a
 * chain that opens because of one new paper costs one parse.
 */

interface WatchStep {
  step: string;
  status: 'ran' | 'skipped' | 'failed';
  detail: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function stepSnippet(result: { stdout: string; stderr: string }): string {
  return (result.stderr || result.stdout).trim().slice(0, 200);
}

interface DriftSummary {
  added: number;
  modified: number;
  removed: number;
  files: string[];
}

function summarizeDrift(drifted: { relPath: string; change: string }[]): DriftSummary {
  const counts = new Map<string, number>();
  for (const file of drifted) counts.set(file.change, (counts.get(file.change) ?? 0) + 1);
  return {
    added: counts.get('added') ?? 0,
    modified: counts.get('modified') ?? 0,
    removed: counts.get('removed') ?? 0,
    files: drifted.map((file) => file.relPath),
  };
}

function chainHeader(
  reason: WatchReason,
  drift: DriftSummary | null,
  pending: { ingest: number; extract: number },
  missing: string[],
): string {
  switch (reason) {
    case 'forced':
      return 'literature watch: --force → refresh chain';
    case 'first-run':
      return 'literature watch: first run → building the literature state';
    case 'outputs-missing': {
      const names = missing.map((marker) => marker.split('/').pop()).join(', ');
      return `literature watch: outputs not built yet (${names}) → refresh chain`;
    }
    case 'new-or-changed-inputs':
      return (
        `literature watch: ${drift?.added ?? 0} new, ${drift?.modified ?? 0} modified, ` +
        `${drift?.removed ?? 0} removed input(s) → refresh chain`
      );
    case 'unprocessed-inputs':
      return (
        `literature watch: ${pending.ingest} unparsed paper(s), ` +
        `${pending.extract} unextracted → refresh chain`
      );
    default:
      return 'literature watch: refresh chain';
  }
}

export function registerLiteratureCommand(program: Command): void {
  const literature = program
    .command('literature')
    .description('continuous literature surveillance (incremental refresh of the reading chain)');

  literature
    .command('watch')
    .description(
      'detect new/changed literature and refresh scan → ingest → data → extract/synthesize → wiki → assessment incrementally (0 = current, 1 = step failed, 2 = blocking gaps)',
    )
    .option('--force', 'refresh even when inputs and outputs are current')
    .option(
      '--skip-model',
      'skip model-backed extract/synthesize steps (deterministic refresh only)',
    )
    .option('--harness <kind>', 'model harness for extract/synthesize: fake | dsh')
    .option('--question <text>', 'research question for the assessment step')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (opts: {
          force?: boolean;
          skipModel?: boolean;
          harness?: string;
          question?: string;
          json?: boolean;
        }) => {
          const { findProjectRoot } = await import('../config/paths.js');
          const root = await findProjectRoot(process.cwd());
          if (!root) {
            throw new IdeaseekError(
              'NOT_INITIALIZED',
              'no IdeaSeek project here; run: ideaseek init',
            );
          }

          const keyPresent = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
          const modelHarness =
            opts.harness ?? process.env.IDEASEEK_ASK_HARNESS ?? (keyPresent ? 'dsh' : null);
          const modelEnabled = !opts.skipModel && modelHarness !== null;

          // ---- gate inputs (cheap: fs + artifact metas, no model) ----
          const missingAll: string[] = [];
          for (const marker of WATCH_OUTPUT_MARKERS) {
            if (!(await exists(join(root, marker)))) missingAll.push(marker);
          }
          // Model-only outputs are "missing" only while a model can make them.
          const deferred = modelEnabled
            ? []
            : missingAll.filter((marker) => MODEL_OUTPUT_MARKERS.includes(marker));
          const missing = missingAll.filter((marker) => !deferred.includes(marker));

          const driftReport = await detectInputDrift(root);
          const drift = driftReport.hasBaseline ? summarizeDrift(driftReport.drifted) : null;

          let pendingIngest = 0;
          let pendingExtract = 0;
          {
            const rt = await ProjectRuntime.open({ cwd: root, recover: false });
            try {
              const manifest = await readInputManifest(root);
              if (manifest) {
                pendingIngest = partitionPdfs(manifest, await collectParsedHashes(rt)).pending
                  .length;
                const parsedSources = await committedSourcesOf(rt, 'parsed-paper');
                const extracted = await committedSourcesOf(rt, 'papercard');
                pendingExtract = selectPendingExtracts(parsedSources, extracted).length;
              }
            } finally {
              await rt.close();
            }
          }

          const decision = evaluateWatchGate({
            force: Boolean(opts.force),
            hasBaseline: driftReport.hasBaseline,
            missing,
            driftChanges: driftReport.hasBaseline ? driftReport.drifted.length : 0,
            pendingIngest,
            pendingExtract,
            modelEnabled,
          });
          const pending = { ingest: pendingIngest, extract: pendingExtract };
          const at = Date.now();

          if (!decision.changed) {
            // Surface the STORED assessment verdict so cron consumers get the
            // same fields on both paths without rebuilding anything.
            let storedVerdict: string | null = null;
            let storedBlocking: number | null = null;
            try {
              const stored = JSON.parse(
                await readFile(
                  join(root, 'knowledge', 'research-material-assessment.json'),
                  'utf8',
                ),
              ) as { verdict?: unknown; gaps?: { priority?: unknown }[] };
              if (typeof stored.verdict === 'string') storedVerdict = stored.verdict;
              if (Array.isArray(stored.gaps)) {
                storedBlocking = stored.gaps.filter((gap) => gap?.priority === 'blocking').length;
              }
            } catch {
              // no stored report — the chain that opens next will build one
            }
            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  contract: WATCH_CONTRACT,
                  changed: false,
                  reason: decision.reason,
                  drift,
                  missing: missingAll,
                  deferred,
                  pending,
                  verdict: storedVerdict,
                  blockingGaps: storedBlocking,
                  at,
                }),
              );
              return 0;
            }
            process.stdout.write(
              'literature watch: no change — inputs match the baseline and outputs are current\n',
            );
            if (!modelEnabled && (deferred.length > 0 || pending.extract > 0)) {
              const parts = [
                pending.extract > 0 ? `${pending.extract} extraction(s)` : null,
                deferred.length > 0 ? `${deferred.length} model output(s)` : null,
              ].filter(Boolean);
              // --skip-model is an explicit choice; keyless is an absence.
              // Saying "waiting for a key" after --skip-model would lie.
              const cause = opts.skipModel
                ? 'skipped by --skip-model'
                : 'until a model key is configured (/models setup)';
              process.stdout.write(`  deferred ${cause}: ${parts.join(', ')}\n`);
            }
            return 0;
          }

          // ---- refresh chain ----
          if (!opts.json) {
            process.stdout.write(`${chainHeader(decision.reason, drift, pending, missing)}\n`);
          }
          const steps: WatchStep[] = [];
          const total = 7;
          const emit = (index: number, step: WatchStep): void => {
            steps.push(step);
            if (!opts.json) process.stdout.write(`  [${index}/${total}] ${step.detail}\n`);
          };

          // 1. scan (records the new input baseline; incremental hash reuse).
          const scan = await performScan(root);
          emit(1, {
            step: 'scan',
            status: 'ran',
            detail: `scan: ${scan.files} file(s) (reused ${scan.reusedHashes} hash(es))`,
          });

          // 2. ingest — parses only PDFs without a committed parsed-paper.
          const ingestRes = await runCli(['ingest', '--json'], { timeoutMs: 180_000 });
          emit(
            2,
            ingestRes.code === 0
              ? { step: 'ingest', status: 'ran', detail: 'ingest: incremental parse complete' }
              : {
                  step: 'ingest',
                  status: 'failed',
                  detail: `ingest: failed — ${stepSnippet(ingestRes)}`,
                },
          );

          // 3. dataset profile (feeds the assessment context; skips when no
          //    dataset inputs exist), plus counts the model steps need.
          let hasDatasetInput = false;
          let parsedCount = 0;
          {
            const rt = await ProjectRuntime.open({ cwd: root, recover: false });
            try {
              assertConfigUsable(rt.configLoad);
              parsedCount = (await rt.db.listArtifactsByKind('parsed-paper')).length;
              hasDatasetInput =
                rt.config.inputs.readonlyDatasets.length > 0 ||
                (await exists(join(root, 'knowledge', 'input-manifest.json')));
            } finally {
              await rt.close();
            }
          }
          if (hasDatasetInput) {
            const dataRes = await runCli(['data', 'describe', '--json'], { timeoutMs: 120_000 });
            emit(
              3,
              dataRes.code === 0
                ? {
                    step: 'data-describe',
                    status: 'ran',
                    detail: 'data describe: dataset profile updated',
                  }
                : {
                    step: 'data-describe',
                    status: 'failed',
                    detail: `data describe: failed — ${stepSnippet(dataRes)}`,
                  },
            );
          } else {
            emit(3, {
              step: 'data-describe',
              status: 'skipped',
              detail: 'data describe: skipped (no datasets found)',
            });
          }

          // 4+5. model-backed extract & synthesize (same availability rule as
          // `prepare`: explicit --harness > env > key present, else skip — a
          // keyless cron must never fail or fake its way through these).
          if (opts.skipModel || !modelHarness) {
            const reason = opts.skipModel
              ? '--skip-model set'
              : 'no DEEPSEEK_API_KEY configured (pass --harness or run /models setup)';
            emit(4, { step: 'extract', status: 'skipped', detail: `extract: skipped (${reason})` });
            emit(5, {
              step: 'synthesize',
              status: 'skipped',
              detail: `synthesize: skipped (${reason})`,
            });
          } else if (parsedCount === 0) {
            emit(4, {
              step: 'extract',
              status: 'skipped',
              detail: 'extract: skipped (no parsed papers yet)',
            });
            emit(5, {
              step: 'synthesize',
              status: 'skipped',
              detail: 'synthesize: skipped (no parsed papers yet)',
            });
          } else {
            const extRes = await runCli(['extract', '--harness', modelHarness, '--json'], {
              timeoutMs: 300_000,
            });
            emit(
              4,
              extRes.code === 0
                ? { step: 'extract', status: 'ran', detail: 'extract: PaperCards synced' }
                : {
                    step: 'extract',
                    status: 'failed',
                    detail: `extract: failed — ${stepSnippet(extRes)}`,
                  },
            );
            const synthRes = await runCli(['synthesize', '--harness', modelHarness, '--json'], {
              timeoutMs: 300_000,
            });
            emit(
              5,
              synthRes.code === 0
                ? {
                    step: 'synthesize',
                    status: 'ran',
                    detail: 'synthesize: topic synthesis & research map synced',
                  }
                : {
                    step: 'synthesize',
                    status: 'failed',
                    detail: `synthesize: failed — ${stepSnippet(synthRes)}`,
                  },
            );
          }

          // 6. wiki — deterministic full rebuild (no model; cheap), which is
          //    exactly what makes it no longer one-shot.
          let wikiStats: { nodes: number; edges: number; helper: string } | null = null;
          try {
            const { buildResearchWiki } = await import('../knowledge/wiki.js');
            const wiki = await buildResearchWiki(root);
            wikiStats = { nodes: wiki.nodes, edges: wiki.edges, helper: wiki.helper };
            emit(6, {
              step: 'wiki',
              status: 'ran',
              detail: `wiki: ${wiki.nodes} node(s), ${wiki.edges} edge(s) → knowledge/research-wiki`,
            });
          } catch (error) {
            emit(6, {
              step: 'wiki',
              status: 'failed',
              detail: `wiki: failed — ${(error as Error).message.slice(0, 200)}`,
            });
          }

          // 7. assessment — rebuilds only when its contextHash moved.
          let verdict: string | null = null;
          let reused = false;
          let blockingGaps = 0;
          try {
            const { loadOrBuildAssessment } = await import('../knowledge/assessment.js');
            const built = await loadOrBuildAssessment(root, { question: opts.question });
            verdict = built.assessment.verdict;
            reused = built.reused;
            blockingGaps = built.assessment.gaps.filter(
              (gap) => gap.priority === 'blocking',
            ).length;
            const sufficient = built.assessment.sufficientFor;
            emit(7, {
              step: 'assessment',
              status: 'ran',
              detail:
                `assessment: ${verdict.toUpperCase()} · ` +
                `protocol=${sufficient.protocolDesign ? 'OK' : 'BLOCKED'} · ` +
                `smoke=${sufficient.smokeQuick ? 'OK' : 'BLOCKED'} · ` +
                `blocking=${blockingGaps} (reused=${reused})`,
            });
          } catch (error) {
            emit(7, {
              step: 'assessment',
              status: 'failed',
              detail: `assessment: failed — ${(error as Error).message.slice(0, 200)}`,
            });
          }

          const failed = steps.some((step) => step.status === 'failed');
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                contract: WATCH_CONTRACT,
                changed: true,
                reason: decision.reason,
                drift,
                missing: missingAll,
                deferred,
                pending,
                steps,
                verdict,
                blockingGaps,
                assessmentReused: reused,
                wiki: wikiStats,
                at,
              }),
            );
          } else if (failed) {
            process.stdout.write(
              'next: fix the failed step(s) above, then rerun ideaseek literature watch\n',
            );
          } else if (blockingGaps > 0) {
            process.stdout.write(
              'next: clear the BLOCKING gaps above (ideaseek assessment --detail), then rerun ideaseek literature watch\n',
            );
          } else {
            process.stdout.write('next: literature state is current — ideaseek next\n');
          }
          if (failed) return 1;
          return blockingGaps > 0 ? 2 : 0;
        },
      ),
    );
}
