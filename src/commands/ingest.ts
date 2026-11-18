import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { ProjectRuntime } from '../workflow/runtime.js';
import { chooseStrategy, countInputs } from '../workflow/strategy.js';
import { performScan } from './inputs.js';
import { LATEX_PARSER_VERSION } from '../knowledge/latex.js';
import {
  action,
  assertConfigUsable,
  buildHandlers,
  jsonLine,
  runWorkerInteractive,
} from './shared.js';
import type { InputManifest } from '../knowledge/scan.js';

export interface PendingPdf {
  relPath: string;
  sha256: string;
}

/**
 * Pure incremental decision: which scanned PDFs still need `paper.parse`?
 * A paper is done when a committed parsed-paper artifact already carries its
 * content hash — cross-run reuse without re-parsing (docs: 增量处理).
 */
export function partitionPdfs(
  manifest: InputManifest,
  parsedHashes: ReadonlySet<string>,
): { pending: PendingPdf[]; alreadyParsed: number } {
  const pending: PendingPdf[] = [];
  let alreadyParsed = 0;
  for (const file of manifest.files) {
    const isPdf = file.ext === '.pdf' || file.relPath.toLowerCase().endsWith('.pdf');
    if (!isPdf || !file.sha256) continue;
    if (parsedHashes.has(file.sha256)) {
      alreadyParsed += 1;
    } else {
      pending.push({ relPath: file.relPath, sha256: file.sha256 });
    }
  }
  pending.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { pending, alreadyParsed };
}

/** Content hashes of every committed parsed-paper artifact (cross-run). */
/** Source hashes of papers whose table grids are already extracted. */
export async function collectTabledSourceHashes(runtime: ProjectRuntime): Promise<Set<string>> {
  const hashes = new Set<string>();
  for (const artifact of await runtime.db.listArtifactsByKind('paper-tables')) {
    try {
      const payload = JSON.parse(await runtime.store.readFinalText(artifact.contentHash)) as {
        sourceHash?: string;
      };
      if (payload.sourceHash) hashes.add(payload.sourceHash);
    } catch {
      // Unreadable artifact: the paper re-extracts tables (idempotent).
    }
  }
  return hashes;
}

/**
 * Parser revision the current PDF extractor produces, asserted against the
 * worker by tests/pdf.test.ts. A paper parsed by an older revision is not
 * "done": its text may be missing pages the current extractor recovers, and
 * comparing content hashes alone would cache that hole forever.
 */
export const EXPECTED_PARSER_REVISION = '+rev2';

/**
 * Whether an artifact was produced by a parser still in use, judged per source
 * kind.
 *
 * This test used to be `parser.includes('+rev2')` for every parsed-paper
 * artifact, which silently decided that LaTeX sources are never current:
 * `latex.ts` stamps `latex-v1`, so `collectParsedHashes` dropped every .tex
 * result and `ingest` re-parsed each one and created a fresh run on every
 * invocation — observed in tests/latex.test.ts, where the "incremental rerun
 * is a no-op" assertion saw `latexEnqueued: 1` a second time. A rule written
 * for one extractor was applied to a second extractor that was never part of
 * its design, and nothing failed loudly: the source just stopped being
 * cacheable.
 *
 * The identity of a parser is the artifact's own `parser` string, so the
 * branch is on the producer's prefix: the PDF stamp is `<engine>+rev2` (engine
 * varies with what is installed, hence the substring test) while the LaTeX
 * stamp is an exact version (`latex-v1`, hence equality — bumping it is the
 * documented way to invalidate .tex results).
 */
export function parserIsCurrent(parser: string | undefined): boolean {
  const value = parser ?? '';
  if (value.startsWith('latex-')) return value === LATEX_PARSER_VERSION;
  return value.includes(EXPECTED_PARSER_REVISION);
}

export async function collectParsedHashes(runtime: ProjectRuntime): Promise<Set<string>> {
  const hashes = new Set<string>();
  const artifacts = await runtime.db.listArtifactsByKind('parsed-paper');
  for (const artifact of artifacts) {
    try {
      const payload = JSON.parse(await runtime.store.readFinalText(artifact.contentHash)) as {
        sourceHash?: string;
        parser?: string;
      };
      if (payload.sourceHash && parserIsCurrent(payload.parser)) {
        hashes.add(payload.sourceHash);
      }
    } catch {
      // Unreadable artifact does not poison the set; the paper re-parses.
    }
  }
  return hashes;
}

export async function ensureActiveRun(
  runtime: ProjectRuntime,
): Promise<{ runId: string; created: boolean; resumed: boolean }> {
  const latest = await runtime.db.getLatestRun(runtime.project.id);
  if (latest && !['FAILED', 'CANCELED', 'COMPLETED'].includes(latest.status)) {
    if (latest.status === 'PAUSED') {
      await runtime.db.resumeRun(latest.runId);
      return { runId: latest.runId, created: false, resumed: true };
    }
    if (isBlocked(latest.status)) {
      await runtime.db.continueRun(latest.runId);
      return { runId: latest.runId, created: false, resumed: true };
    }
    return { runId: latest.runId, created: false, resumed: false };
  }
  const question = runtime.config.research.question || 'ingest papers';
  const counts = await countInputs(runtime.paths.root, {
    papers: runtime.config.inputs.papersDir,
    datasets: runtime.config.inputs.datasetsDir,
    comparisons: runtime.config.inputs.comparisonsDir,
  });
  // Agent-first tier choice: the harness this command already carries (if
  // any) may refine the threshold rule; a model-less creator (parse-only
  // ingest) keeps the documented scale policy.
  const choice = await chooseStrategy({
    mode: runtime.config.research.mode,
    counts,
    question,
    harness: runtime.harness ?? null,
  });
  const run = await runtime.db.createRun({
    projectId: runtime.project.id,
    question,
    config: runtime.config,
    strategy: choice.strategy,
  });
  return { runId: run.runId, created: true, resumed: false };
}

function isBlocked(status: string): boolean {
  return ['QUOTA_EXHAUSTED', 'AUTH_REQUIRED', 'NETWORK_BLOCKED', 'FAILED_RECOVERABLE'].includes(
    status,
  );
}

/**
 * `ideaseek ingest` — scans the workspace and parses every not-yet-parsed
 * PDF through `paper.parse` (bounded by the worker pool), skipping papers
 * whose content hash already has a committed parsed artifact. Parse-only, so
 * it runs the inline fake worker without any model.
 */
export function registerIngestCommand(program: Command): void {
  program
    .command('ingest')
    .description('parse all new PDFs (incremental by content hash) and index them for search')
    .option('--enqueue-only', 'enqueue parse tasks without executing them')
    .option('--tables', 'also extract table grids (pdfplumber; slower, opt-in)')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { enqueueOnly?: boolean; tables?: boolean; json?: boolean }) => {
        const runtime = await ProjectRuntime.open({ cwd: process.cwd() });
        try {
          assertConfigUsable(runtime.configLoad);

          await performScan(process.cwd()); // refresh manifest before deciding what is new
          const manifest = await loadManifest(runtime);
          const parsedHashes = await collectParsedHashes(runtime);
          const { pending, alreadyParsed } = partitionPdfs(manifest, parsedHashes);
          const tabledHashes = opts.tables ? await collectTabledSourceHashes(runtime) : null;
          const tablesPending =
            tabledHashes === null
              ? []
              : manifest.files.filter((file) => {
                  const isPdf = file.ext === '.pdf' || file.relPath.toLowerCase().endsWith('.pdf');
                  return isPdf && file.sha256 && !tabledHashes.has(file.sha256);
                });
          const latexPending = manifest.files.filter(
            (file) => file.ext === '.tex' && file.sha256 && !parsedHashes.has(file.sha256),
          );

          if (pending.length === 0 && tablesPending.length === 0 && latexPending.length === 0) {
            const indexed = await runtime.db.listIndexedPapers();
            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  pending: 0,
                  alreadyParsed,
                  indexed: indexed.length,
                  runId: null,
                  action: 'nothing-to-do',
                }),
              );
            } else {
              process.stdout.write(
                `ingest: ${alreadyParsed} paper(s) already parsed, nothing to do\n`,
              );
              process.stdout.write('next: ideaseek search <terms>\n');
            }
            return 0;
          }

          const { runId, created, resumed } = await ensureActiveRun(runtime);
          const actions: string[] = [];
          if (created) actions.push('created run');
          if (resumed) actions.push('resumed blocked/paused run');

          const enqueued: string[] = [];
          for (const pdf of pending) {
            const { task, created: wasNew } = await runtime.db.enqueueTask({
              runId,
              type: 'paper.parse',
              phase: 'DEMO',
              payload: { pdfPath: pdf.relPath, nonBlocking: true },
              dependsOn: [],
              idempotencyKey: `paper.parse:${pdf.relPath}:${pdf.sha256.slice(7, 23)}:v1`,
              maxAttempts: runtime.config.runtime.maxAttempts,
            });
            if (wasNew) enqueued.push(task.taskId);
          }

          let tablesEnqueued = 0;
          for (const pdf of tablesPending) {
            if (!pdf.sha256) continue;
            const { created } = await runtime.db.enqueueTask({
              runId,
              type: 'paper.tables',
              phase: 'DEMO',
              payload: { pdfPath: pdf.relPath, nonBlocking: true },
              dependsOn: [],
              idempotencyKey: `tables:${pdf.relPath}:${pdf.sha256.slice(7, 23)}:v1`,
              maxAttempts: runtime.config.runtime.maxAttempts,
            });
            if (created) tablesEnqueued += 1;
          }

          let latexEnqueued = 0;
          for (const tex of latexPending) {
            if (!tex.sha256) continue;
            const { created } = await runtime.db.enqueueTask({
              runId,
              type: 'paper.latex',
              phase: 'DEMO',
              payload: { texPath: tex.relPath, nonBlocking: true },
              dependsOn: [],
              idempotencyKey: `latex:${tex.relPath}:${tex.sha256.slice(7, 23)}:v1`,
              maxAttempts: runtime.config.runtime.maxAttempts,
            });
            if (created) latexEnqueued += 1;
          }

          if (opts.enqueueOnly) {
            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  pending: pending.length,
                  alreadyParsed,
                  enqueued: enqueued.length,
                  tablesEnqueued,
                  latexEnqueued,
                  runId,
                  actions,
                }),
              );
            } else {
              process.stdout.write(
                `ingest: ${enqueued.length} parse task(s) + ${tablesEnqueued} table task(s) enqueued into ${runId} (${alreadyParsed} already parsed)\n`,
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

          const finalRun = await runtime.db.getRun(runId);
          const refreshed = await refreshIndexQuiet(runtime);
          // Task outcomes, read once and reused below. The summary used to
          // report `parsed ${enqueued.length}`, which is the number of tasks
          // DISPATCHED: on a mixed run (one real paper, two unreadable ones)
          // it printed `parsed 3 new paper(s)` while the index said 1 searchable
          // and the failure list said 2 — a count that spoke for work that had
          // not happened, in the one line a researcher uses to decide whether
          // their corpus is ready for ideation.
          const runTasks = await runtime.db.listTasks(runId);
          const parsedOk = runTasks.filter(
            (task) =>
              (task.type === 'paper.parse' || task.type === 'paper.latex') &&
              task.status === 'succeeded',
          ).length;
          const tasksFailed = runTasks.filter((task) => task.status === 'failed').length;
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                pending: pending.length,
                alreadyParsed,
                enqueued: enqueued.length,
                parsedOk,
                tasksFailed,
                tablesEnqueued,
                latexEnqueued,
                runId,
                status: finalRun?.status,
                exitReason: exit.reason,
                indexed: refreshed,
                actions,
              }),
            );
          } else {
            process.stdout.write(
              `ingest → ${finalRun?.status}: parsed ${parsedOk} of ${enqueued.length} dispatched ` +
                `paper(s), tables ${tablesEnqueued}, skipped ${alreadyParsed}` +
                `${tasksFailed > 0 ? ` · ${tasksFailed} task(s) FAILED` : ''}\n`,
            );
            process.stdout.write(`  index: ${refreshed} paper(s) searchable\n`);
            // A FAILED summary that names no input is not actionable: one
            // unreadable PDF among many produced the same red word as a total
            // failure, and the reason lived only in the task table.
            if (finalRun?.status === 'FAILED') {
              const failed = runTasks.filter((task) => task.status === 'failed');
              const succeeded = runTasks.filter((task) => task.status === 'succeeded').length;
              for (const task of failed.slice(0, 5)) {
                const where = String(
                  (task.payload as { pdfPath?: string; texPath?: string }).pdfPath ??
                    (task.payload as { texPath?: string }).texPath ??
                    '',
                );
                process.stdout.write(
                  `  failed: ${task.type}${where ? ` — ${where}` : ''}` +
                    `${task.error?.message ? ` (${task.error.message})` : ''}\n`,
                );
              }
              if (failed.length > 5) {
                process.stdout.write(`  … ${failed.length - 5} more\n`);
              }
              // Stated as task counts, not as "N papers lost": a paper can
              // appear in both the parse and the table task for one file, and
              // arithmetic over those would quietly report the wrong number of
              // usable inputs.
              process.stdout.write(
                `  ${failed.length} task(s) failed, ${succeeded} succeeded — ` +
                  'the successes are kept and the failures are listed above\n',
              );
              process.stdout.write('next: ideaseek intake  (re-check the inputs)\n');
            } else {
              process.stdout.write('next: ideaseek search <terms>\n');
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
            default:
              return exit.runStatus === 'RUNNING' ? 3 : 0;
          }
        } finally {
          await runtime.close();
        }
      }),
    );
}

async function loadManifest(runtime: ProjectRuntime): Promise<InputManifest> {
  const { readManifest } = await import('../knowledge/organize.js');
  const { join } = await import('node:path');
  const manifest = await readManifest(join(runtime.paths.knowledgeDir, 'input-manifest.json'));
  if (!manifest) {
    throw new IdeaseekError('USER_INPUT_REQUIRED', 'no input manifest; run: ideaseek scan');
  }
  return manifest;
}

async function refreshIndexQuiet(runtime: ProjectRuntime): Promise<number> {
  try {
    const { refreshPaperIndex } = await import('../knowledge/search.js');
    await refreshPaperIndex(runtime.db, runtime.store);
    return (await runtime.db.listIndexedPapers()).length;
  } catch {
    return (await runtime.db.listIndexedPapers()).length;
  }
}
