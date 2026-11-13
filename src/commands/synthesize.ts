import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { sha256OfJson } from '../core/hash.js';
import { ensureDir, writeFileAtomic } from '../core/atomic.js';
import { ProjectRuntime } from '../workflow/runtime.js';
import { exportPaperCards, loadCards, loadCompactCards } from '../knowledge/cards.js';
import {
  MAP_PROMPT_VERSION,
  capClusters,
  clusterCards,
  renderResearchMap,
  renderTopicSynthesis,
  synthesisInputHash,
  type ResearchMapRecord,
  type TopicSynthesisRecord,
} from '../knowledge/synthesis.js';
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

async function committedInputHashes(
  runtime: ProjectRuntime,
  kind: 'topic-synthesis' | 'research-map',
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const artifact of await runtime.db.listArtifactsByKind(kind)) {
    const inputHash = artifact.meta.inputHash;
    if (typeof inputHash === 'string') {
      map.set(String(artifact.meta.topicId ?? kind), inputHash);
    }
  }
  return map;
}

/**
 * `ideaseek synthesize` — Phase 2 map/reduce: export readable PaperCards,
 * cluster them deterministically, run one synthesis task per changed topic
 * (content+prompt hash), then reduce to research-map and syntheses/*.md
 * exports. Every LLM step is a normal resumable workflow task, so leases,
 * retries, blocks and recovery all apply unchanged.
 */
export function registerSynthesizeCommand(program: Command): void {
  program
    .command('synthesize')
    .description('cluster PaperCards, synthesize topics and build the research map')
    .option('--max-topics <n>', 'cap on topic clusters (tail merged)', (value) => Number(value))
    .option('--harness <kind>', 'agent harness: fake (default) or dsh', 'fake')
    .option('--enqueue-only', 'enqueue synthesis tasks without executing')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (opts: {
          maxTopics?: number;
          harness?: string;
          enqueueOnly?: boolean;
          json?: boolean;
        }) => {
          const runtime = await ProjectRuntime.open({
            cwd: process.cwd(),
            harness: buildHarness(opts.harness),
          });
          try {
            assertConfigUsable(runtime.configLoad);
            const maxTopics = Number.isFinite(opts.maxTopics) ? Math.max(2, opts.maxTopics!) : 4;

            const loaded = await loadCards(runtime);
            if (loaded.length === 0) {
              throw new IdeaseekError(
                'USER_INPUT_REQUIRED',
                'no extracted PaperCards found; run: ideaseek ingest && ideaseek extract',
              );
            }
            const exported = await exportPaperCards(runtime, loaded);

            const clusters = capClusters(clusterCards(await loadCompactCards(runtime)), maxTopics);
            const existingSynth = await committedInputHashes(runtime, 'topic-synthesis');

            let targetRunId: string | null = null;
            const enqueuedTopics: string[] = [];
            const allInputHashes: string[] = [];
            for (const cluster of clusters) {
              const inputHash = await synthesisInputHash(cluster);
              allInputHashes.push(inputHash);
              if (existingSynth.get(cluster.topicId) === inputHash) continue;
              targetRunId ??= (await ensureActiveRun(runtime)).runId;
              const { created } = await runtime.db.enqueueTask({
                runId: targetRunId,
                type: 'synth.topic',
                phase: 'DEMO',
                payload: { topicId: cluster.topicId, maxTopics },
                dependsOn: [],
                idempotencyKey: `synth:${cluster.topicId}:${inputHash.slice(7, 19)}:v1`,
                maxAttempts: runtime.config.runtime.maxAttempts,
              });
              if (created) enqueuedTopics.push(cluster.topicId);
            }

            const mapInputHash = await sha256OfJson({
              topics: [...allInputHashes],
              generator: MAP_PROMPT_VERSION,
            });
            const existingMap = (await committedInputHashes(runtime, 'research-map')).get(
              'research-map',
            );
            let mapEnqueued = false;
            if (existingMap !== mapInputHash) {
              targetRunId ??= (await ensureActiveRun(runtime)).runId;
              const waiting: string[] = [];
              for (const task of await runtime.db.listTasks(targetRunId)) {
                if (
                  task.type === 'synth.topic' &&
                  ['queued', 'leased', 'running', 'committing'].includes(task.status)
                ) {
                  waiting.push(task.taskId);
                }
              }
              const { created } = await runtime.db.enqueueTask({
                runId: targetRunId,
                type: 'synth.map',
                phase: 'DEMO',
                payload: {},
                dependsOn: waiting,
                idempotencyKey: `synth:map:${mapInputHash.slice(7, 19)}:v1`,
                maxAttempts: runtime.config.runtime.maxAttempts,
              });
              mapEnqueued = created;
            }

            if (targetRunId === null || (!mapEnqueued && enqueuedTopics.length === 0)) {
              if (opts.json) {
                process.stdout.write(
                  jsonLine({
                    clusters: clusters.length,
                    enqueued: 0,
                    action: 'nothing-to-synthesize',
                    cardsExported: exported.written,
                  }),
                );
              } else {
                process.stdout.write(
                  `synthesize: all ${clusters.length} topic(s) and the research map are current (${loaded.length} cards exported)\n`,
                );
                process.stdout.write(
                  'next: ideaseek report   (or review knowledge/research-map.md)\n',
                );
              }
              return 0;
            }

            if (opts.enqueueOnly) {
              if (opts.json) {
                process.stdout.write(
                  jsonLine({
                    clusters: clusters.length,
                    enqueuedTopics,
                    mapEnqueued,
                    runId: targetRunId,
                  }),
                );
              } else {
                process.stdout.write(
                  `synthesize: ${enqueuedTopics.length} topic task(s) + ${mapEnqueued ? 1 : 0} map task(s) enqueued into ${targetRunId}\n`,
                );
                process.stdout.write('next: ideaseek worker\n');
              }
              return 0;
            }

            const { exit } = await runWorkerInteractive(runtime, targetRunId, {
              kind: 'inline',
              handlers: buildHandlers(),
              onLog: opts.json ? undefined : (message) => process.stderr.write(`  · ${message}\n`),
            });

            // Readable exports under knowledge/syntheses/ and research-map.md.
            let mapPath: string | null = null;
            let topicsWritten = 0;
            if (exit.reason === 'completed') {
              const synthDir = join(runtime.paths.knowledgeDir, 'syntheses');
              await ensureDir(synthDir);
              for (const artifact of await runtime.db.listArtifactsByKind('topic-synthesis')) {
                try {
                  const record = JSON.parse(
                    await runtime.store.readFinalText(artifact.contentHash),
                  ) as TopicSynthesisRecord;
                  await writeFileAtomic(
                    join(synthDir, `${record.topicId}.md`),
                    renderTopicSynthesis(record),
                  );
                  topicsWritten += 1;
                } catch {
                  continue;
                }
              }
              for (const artifact of await runtime.db.listArtifactsByKind('research-map')) {
                try {
                  const record = JSON.parse(
                    await runtime.store.readFinalText(artifact.contentHash),
                  ) as ResearchMapRecord;
                  mapPath = join(runtime.paths.knowledgeDir, 'research-map.md');
                  await writeFileAtomic(mapPath, renderResearchMap(record));
                  break;
                } catch {
                  continue;
                }
              }
            }

            const finalRun = await runtime.db.getRun(targetRunId);
            const counts = countByStatus(await runtime.db.listTasks(targetRunId));
            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  runId: targetRunId,
                  status: finalRun?.status,
                  clusters: clusters.length,
                  enqueuedTopics,
                  mapEnqueued,
                  tasks: counts,
                  cardsExported: exported.written,
                  topicsWritten,
                  mapPath,
                }),
              );
            } else {
              process.stdout.write(
                `synthesize → ${finalRun?.status}: ${counts.succeeded ?? 0} task(s) done, ${exported.written} card(s) exported\n`,
              );
              if (topicsWritten > 0) {
                process.stdout.write(`  syntheses: ${join('knowledge', 'syntheses')}/\n`);
              }
              if (mapPath) process.stdout.write(`  research map: ${mapPath}\n`);
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
        },
      ),
    );

  program
    .command('mech')
    .description(
      'mechanism / design-principle / contradiction graph from persisted syntheses and failure boundaries (Mechanism Analyst role)',
    )
    .option(
      '--harness <kind>',
      'model harness: fake | dsh (default: dsh when a key is configured, else fake)',
    )
    .option('--force', 'ignore a stored mechanism graph and regenerate')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { harness?: string; force?: boolean; json?: boolean }) => {
        const { findProjectRoot } = await import('../config/paths.js');
        const root = await findProjectRoot(process.cwd());
        if (!root) {
          throw new IdeaseekError(
            'NOT_INITIALIZED',
            'no IdeaSeek project here; run: ideaseek init',
          );
        }
        const {
          MECHANISM_ANALYSIS_SCHEMA,
          collectMechanismContext,
          buildMechanismRequest,
          parseMechanismOutput,
        } = await import('../idea/mechanism.js');
        const context = await collectMechanismContext(root);
        const request = buildMechanismRequest(context);
        const graphPath = join(root, 'knowledge', 'mechanism-graph.json');

        interface StoredGraph {
          contract: string;
          inputHash: string;
          harnessRuntime: string;
          generatedAt: number;
          analysis: Record<string, unknown>;
        }

        if (!opts.force) {
          let stored: StoredGraph | null = null;
          try {
            stored = JSON.parse(await readFile(graphPath, 'utf8')) as StoredGraph;
          } catch {
            stored = null;
          }
          if (stored && stored.inputHash === request.inputHash) {
            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  contract: stored.contract,
                  inputHash: stored.inputHash,
                  reused: true,
                  analysis: stored.analysis,
                  path: graphPath,
                }),
              );
            } else {
              process.stdout.write(
                `reused mechanism graph (same inputHash ${stored.inputHash.slice(0, 12)}…)\n`,
              );
              process.stdout.write(`  file: ${graphPath}\n`);
              process.stdout.write('next: review contradictions; regenerate with --force\n');
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
            runId: 'mechanism-analysis',
            taskId: 'mechanism-analysis',
            profile: 'synthesis-analyst',
            instruction: request.instruction,
            inputs: [{ kind: 'text', name: 'mechanism_context', content: request.instruction }],
            outputSchema: MECHANISM_ANALYSIS_SCHEMA,
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
                jsonLine({ blocked: block, written: false, contract: MECHANISM_ANALYSIS_SCHEMA }),
              );
            } else {
              process.stderr.write(
                `mech blocked [${block}]: ${(error as Error).message}\n` +
                  'nothing was written — restore quota/auth/network and rerun the same command\n',
              );
            }
            return 2;
          }
          throw error;
        } finally {
          await harness.shutdown().catch(() => undefined);
        }

        const analysis = parseMechanismOutput(output, context);
        const stored: StoredGraph = {
          contract: MECHANISM_ANALYSIS_SCHEMA,
          inputHash: request.inputHash,
          harnessRuntime: runtimeKind,
          generatedAt: Date.now(),
          analysis: analysis as unknown as Record<string, unknown>,
        };
        const { ensureDir, writeFileAtomic: writeAtomic } = await import('../core/atomic.js');
        await ensureDir(join(root, 'knowledge'));
        await writeAtomic(graphPath, `${JSON.stringify(stored, null, 2)}\n`);

        let eventSeq: number | null = null;
        const { ProjectRuntime: Runtime } = await import('../workflow/runtime.js');
        const runtime = await Runtime.open({ cwd: root, recover: false });
        try {
          const run = await runtime.db.getLatestRun(runtime.project.id);
          if (run) {
            const event = await runtime.db.appendEvent({
              runId: run.runId,
              phase: 'IDEATION',
              objectId: 'mechanism-graph',
              role: 'system',
              eventType: 'mechanism_analysis',
              summary: `mechanism graph: ${analysis.mechanisms.length} mechanism(s), ${analysis.designPrinciples.length} principle(s), ${analysis.contradictions.length} contradiction(s)`,
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
              harnessRuntime: stored.harnessRuntime,
              reused: false,
              eventSeq,
              analysis,
              path: graphPath,
            }),
          );
          return 0;
        }
        process.stdout.write(
          `mechanism graph written: knowledge/mechanism-graph.json (${analysis.mechanisms.length} mechanism(s), ${analysis.designPrinciples.length} principle(s), ${analysis.contradictions.length} contradiction(s))\n`,
        );
        process.stdout.write(
          `  correlationCaution: ${analysis.correlationCaution} — ${analysis.causalityStatement.slice(0, 120)}\n`,
        );
        process.stdout.write(
          `  inputHash ${stored.inputHash.slice(0, 19)}… · harness ${runtimeKind}\n`,
        );
        process.stdout.write(
          'next: feed mechanisms into idea generation; contradictions are candidate research gaps\n',
        );
        return 0;
      }),
    );
}
