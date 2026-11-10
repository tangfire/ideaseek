import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { ProjectRuntime } from '../workflow/runtime.js';
import { countInputs, resolveStrategy } from '../workflow/strategy.js';
import { performScan } from './inputs.js';
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
export async function collectParsedHashes(runtime: ProjectRuntime): Promise<Set<string>> {
  const hashes = new Set<string>();
  const artifacts = await runtime.db.listArtifactsByKind('parsed-paper');
  for (const artifact of artifacts) {
    try {
      const payload = JSON.parse(await runtime.store.readFinalText(artifact.contentHash)) as {
        sourceHash?: string;
      };
      if (payload.sourceHash) hashes.add(payload.sourceHash);
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
  const run = await runtime.db.createRun({
    projectId: runtime.project.id,
    question,
    config: runtime.config,
    strategy: resolveStrategy(runtime.config.research.mode, counts),
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
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { enqueueOnly?: boolean; json?: boolean }) => {
        const runtime = await ProjectRuntime.open({ cwd: process.cwd() });
        try {
          assertConfigUsable(runtime.configLoad);

          await performScan(process.cwd()); // refresh manifest before deciding what is new
          const manifest = await loadManifest(runtime);
          const parsedHashes = await collectParsedHashes(runtime);
          const { pending, alreadyParsed } = partitionPdfs(manifest, parsedHashes);

          if (pending.length === 0) {
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

          if (opts.enqueueOnly) {
            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  pending: pending.length,
                  alreadyParsed,
                  enqueued: enqueued.length,
                  runId,
                  actions,
                }),
              );
            } else {
              process.stdout.write(
                `ingest: ${enqueued.length} parse task(s) enqueued into ${runId} (${alreadyParsed} already parsed)\n`,
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
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                pending: pending.length,
                alreadyParsed,
                enqueued: enqueued.length,
                runId,
                status: finalRun?.status,
                exitReason: exit.reason,
                indexed: refreshed,
                actions,
              }),
            );
          } else {
            process.stdout.write(
              `ingest → ${finalRun?.status}: parsed ${enqueued.length} new paper(s), skipped ${alreadyParsed}\n`,
            );
            process.stdout.write(`  index: ${refreshed} paper(s) searchable\n`);
            process.stdout.write('next: ideaseek search <terms>\n');
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
