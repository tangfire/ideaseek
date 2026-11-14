import type { Command } from 'commander';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { ProjectRuntime } from '../workflow/runtime.js';
import { buildCsvSlices } from '../experiment/slice-csv.js';
import { profileCsv, renderDatasetCard } from '../experiment/dataset-card.js';
import { isContentHash, sha256OfFile, type ContentHash } from '../core/hash.js';
import { writeFileAtomic } from '../core/atomic.js';
import type { SliceScale } from '../experiment/slices.js';
import { profileFederatedDataset } from '../knowledge/federated.js';
import { acquireDataset } from '../knowledge/dataset-acquire.js';
import { buildAllFederatedSlices } from '../experiment/federated-slices.js';
import { ensureDir } from '../core/atomic.js';
import { action, buildHarness, jsonLine } from './shared.js';
import { isHarnessBlockError } from '../dsh/adapter.js';
import { assertAutonomy, parseAutonomyMode, recordDecision } from '../workflow/autonomy.js';
import { readManifest } from '../knowledge/organize.js';
import {
  DEFAULT_DISCOVERY_SOURCES,
  DISCOVERY_SCHEMA,
  authorizeCandidate,
  buildDeterministicCandidates,
  buildDiscoveryContext,
  buildDiscoveryRequest,
  candidateExperimentReadiness,
  collectDiscoverySources,
  computeDiscoveryInputHash,
  linkCandidateLocal,
  mergeModelIntoDeterministic,
  mergeWithPrevious,
  normalizeSourceList,
  parseDatasetCandidatesOutput,
  readDiscoveryArtifact,
  recordAcquisition,
  requiresUserConfirmation,
  stampModelCandidates,
  writeDiscoveryExports,
  type DatasetCandidate,
  type DatasetDiscoveryArtifact,
} from '../knowledge/dataset-discovery.js';

const SCALES: SliceScale[] = ['smoke', 'quick', 'standard'];
const CANDIDATE_STATUSES = [
  'recommended',
  'needs-access',
  'user-provided',
  'validated',
  'rejected',
];
/** Inline hashing guard: bigger files must come from `ideaseek scan` hashes. */
const MAX_INLINE_HASH_BYTES = 256 * 1024 * 1024;

async function requireDiscoveryArtifact(root: string): Promise<DatasetDiscoveryArtifact> {
  const artifact = await readDiscoveryArtifact(root);
  if (!artifact) {
    throw new IdeaseekError(
      'FILE_NOT_FOUND',
      'no dataset discovery artifact — run: ideaseek datasets discover',
    );
  }
  return artifact;
}

function requireCandidate(
  artifact: DatasetDiscoveryArtifact,
  candidateId: string,
): DatasetCandidate {
  const candidate = artifact.candidates.find((entry) => entry.candidateId === candidateId);
  if (!candidate) {
    throw new IdeaseekError(
      'TASK_NOT_FOUND',
      `dataset candidate ${candidateId} not found — run: ideaseek datasets list`,
      { candidateId },
    );
  }
  return candidate;
}

/**
 * Append-only acquisition ledger (knowledge/dataset-acquisitions.json): what
 * was fetched, from where, with which hash. The URL is stored without its
 * query string, which is where signed-download tokens live.
 */
interface AcquisitionRecord {
  candidateId: string;
  name: string;
  relPath: string;
  sha256: string;
  bytes: number;
  sourceUrl: string;
  at: number;
}

async function appendAcquisition(
  root: string,
  record: AcquisitionRecord,
): Promise<{ path: string; records: number }> {
  const path = join(root, 'knowledge', 'dataset-acquisitions.json');
  const existing = await readFile(path, 'utf8')
    .then((text) => JSON.parse(text) as { records?: AcquisitionRecord[] })
    .catch(() => ({ records: [] }));
  const records = [...(Array.isArray(existing.records) ? existing.records : []), record];
  await writeFileAtomic(path, `${JSON.stringify({ schemaVersion: 1, records }, null, 2)}\n`);
  return { path, records: records.length };
}

export function registerDataCommand(program: Command): void {
  const data = program.command('data').description('dataset inventory and slices');

  data
    .command('slices')
    .description('list registered dataset slices, or build them from a CSV')
    .option('--dataset <id>', 'filter by dataset snapshot id')
    .option('--scale <scale>', 'filter by scale (smoke|quick|standard)')
    .option('--build-from <csv>', 'project-relative CSV to slice (experimental Phase 3 entry)')
    .option('--scales <list>', 'comma-separated scales when building', 'smoke,quick,standard')
    .option('--seed <n>', 'selection seed when building', (value) => Number(value))
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (opts: {
          dataset?: string;
          scale?: string;
          buildFrom?: string;
          scales?: string;
          seed?: number;
          json?: boolean;
        }) => {
          const runtime = await ProjectRuntime.open({ cwd: process.cwd() });
          try {
            if (opts.buildFrom) {
              if (opts.scale) {
                throw new IdeaseekError(
                  'INVALID_ARGUMENT',
                  '--scale is a list filter; use --scales when building',
                );
              }
              const csvPath = resolve(runtime.paths.root, opts.buildFrom);
              if (!csvPath.startsWith(runtime.paths.root)) {
                throw new IdeaseekError(
                  'INVALID_ARGUMENT',
                  '--build-from must be a project-relative CSV path',
                );
              }
              const scales = (opts.scales ?? 'smoke,quick,standard')
                .split(',')
                .map((entry) => entry.trim())
                .filter(Boolean);
              for (const scale of scales) {
                if (!SCALES.includes(scale as SliceScale)) {
                  throw new IdeaseekError(
                    'INVALID_ARGUMENT',
                    `unknown scale "${scale}" (expected smoke|quick|standard)`,
                  );
                }
              }
              const inputHash = await sha256OfFile(csvPath);
              const datasetSnapshotId = `data-${inputHash.slice(7, 19)}`;
              const outDir = join(runtime.paths.researchDir, 'slices', datasetSnapshotId);
              const slices = await buildCsvSlices({
                csvPath,
                datasetSnapshotId,
                outDir,
                scales: scales as SliceScale[],
                seed: Number.isFinite(opts.seed) ? opts.seed : undefined,
                generatedBy: 'ideaseek data slices --build-from',
                now: Date.now(),
              });
              for (const slice of slices) {
                await runtime.db.upsertSlice({
                  sliceId: slice.sliceId,
                  datasetSnapshotId: slice.datasetSnapshotId,
                  scale: slice.scale,
                  record: slice as unknown as Record<string, unknown>,
                  createdAt: slice.generatedAt,
                });
              }
              if (opts.json) {
                process.stdout.write(
                  jsonLine({
                    built: slices.length,
                    datasetSnapshotId,
                    outDir,
                    slices: slices.map((slice) => ({
                      sliceId: slice.sliceId,
                      scale: slice.scale,
                      selectedRows: slice.stats.selectedRows,
                      totalRows: slice.stats.totalRows,
                    })),
                  }),
                );
                return 0;
              }
              process.stdout.write(
                `built ${slices.length} slice(s) for ${datasetSnapshotId} → ${outDir}\n`,
              );
              for (const slice of slices) {
                process.stdout.write(
                  `  ${slice.sliceId}  ${slice.scale}  ${slice.stats.selectedRows}/${slice.stats.totalRows} rows  seed=${slice.seed}\n`,
                );
                const warnings = slice.distributionCheck?.warnings ?? [];
                if (warnings.length > 0) {
                  process.stdout.write(`    distribution warnings: ${warnings.length}\n`);
                  for (const warning of warnings) {
                    process.stdout.write(`      ! ${warning}\n`);
                  }
                }
              }
              process.stdout.write('next: ideaseek data slices\n');
              return 0;
            }

            // External read-only datasets: build missing selection manifests
            // deterministically (selections only — never copies of the data).
            for (const rootPath of runtime.config.inputs.readonlyDatasets) {
              try {
                const fedProfile = await profileFederatedDataset(rootPath);
                const selections = buildAllFederatedSlices(fedProfile, {
                  seed: Number.isFinite(opts.seed) ? (opts.seed as number) : 42,
                  generatedBy: 'ideaseek data slices',
                  now: Date.now(),
                });
                for (const selection of selections) {
                  const existing = await runtime.db.getSlice(selection.sliceId);
                  if (existing) continue;
                  await runtime.db.upsertSlice({
                    sliceId: selection.sliceId,
                    datasetSnapshotId: selection.datasetSnapshotId,
                    scale: selection.scale,
                    record: selection as unknown as Record<string, unknown>,
                    createdAt: selection.generatedAt,
                  });
                  const outDir = join(
                    runtime.paths.researchDir,
                    'slices',
                    selection.datasetSnapshotId,
                  );
                  await ensureDir(outDir);
                  await writeFileAtomic(
                    join(outDir, selection.sliceId + '.json'),
                    JSON.stringify(selection, null, 2) + String.fromCharCode(10),
                  );
                }
              } catch (error) {
                const message = (error as Error).message;
                if (opts.json) {
                  process.stdout.write(jsonLine({ externalError: rootPath + ': ' + message }));
                } else {
                  process.stdout.write(
                    '  ! external dataset ' +
                      rootPath +
                      ' failed: ' +
                      message +
                      String.fromCharCode(10),
                  );
                }
              }
            }

            const slices = await runtime.db.listSlices({
              datasetSnapshotId: opts.dataset,
              scale: opts.scale,
            });
            if (opts.json) {
              process.stdout.write(jsonLine({ slices }));
              return 0;
            }
            if (slices.length === 0) {
              process.stdout.write(
                'no dataset slices registered (build one: ideaseek data slices --build-from <csv>)\n',
              );
              return 0;
            }
            process.stdout.write(`${slices.length} slice(s):\n`);
            for (const entry of slices) {
              const record = entry.record as {
                stats?: {
                  selectedRows?: number;
                  totalRows?: number;
                  rowsSelected?: number;
                  rowsTotal?: number;
                  clientsSelected?: number;
                };
                seed?: number;
                rule?: string;
                kind?: string;
                split?: string;
              };
              const kept = record.stats?.selectedRows ?? record.stats?.rowsSelected ?? '?';
              const total = record.stats?.totalRows ?? record.stats?.rowsTotal ?? '?';
              const extra =
                record.kind === 'federated'
                  ? `  ${record.split}  clients=${record.stats?.clientsSelected ?? '?'}`
                  : '';
              process.stdout.write(
                `  ${entry.sliceId}  ${entry.scale}  ${kept}/${total} rows  seed=${record.seed ?? '?'}${extra}\n`,
              );
              if (opts.scale || opts.dataset) {
                process.stdout.write(`    rule: ${record.rule ?? '—'}\n`);
              }
            }
            return 0;
          } finally {
            await runtime.close();
          }
        },
      ),
    );

  data
    .command('describe')
    .description('profile dataset files into a deterministic dataset card')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { json?: boolean }) => {
        const runtime = await ProjectRuntime.open({ cwd: process.cwd() });
        try {
          const { readManifest } = await import('../knowledge/organize.js');
          const manifest = await readManifest(
            join(runtime.paths.knowledgeDir, 'input-manifest.json'),
          );
          const dataFiles = (manifest?.files ?? []).filter(
            (file) => file.role === 'data' && file.ext === '.csv',
          );

          const profiles = [];
          for (const file of dataFiles) {
            try {
              profiles.push(
                await profileCsv(join(runtime.paths.root, file.relPath), {
                  now: Date.now(),
                  generatedBy: 'ideaseek data describe',
                }),
              );
            } catch {
              // Unreadable/corrupt file: skip its profile; scan still lists it.
            }
          }

          const generatedAt = Date.now();
          const cardPath = join(runtime.paths.knowledgeDir, 'dataset-card.json');
          const mdPath = join(runtime.paths.knowledgeDir, 'dataset-card.md');
          if (profiles.length > 0) {
            await writeFileAtomic(
              cardPath,
              `${JSON.stringify({ generatedAt, profiles }, null, 2)}\n`,
            );
            await writeFileAtomic(mdPath, renderDatasetCard(profiles, generatedAt));
          }

          // External read-only datasets: full checklist profile + manifest export.
          const external: {
            path: string;
            profile?: Awaited<ReturnType<typeof profileFederatedDataset>>;
            error?: string;
          }[] = [];
          for (const rootPath of runtime.config.inputs.readonlyDatasets) {
            try {
              const profile = await profileFederatedDataset(rootPath);
              external.push({ path: rootPath, profile });
            } catch (error) {
              external.push({ path: rootPath, error: (error as Error).message });
            }
          }
          let manifestPath: string | null = null;
          if (external.length > 0) {
            manifestPath = join(runtime.paths.knowledgeDir, 'dataset-manifest.json');
            await writeFileAtomic(
              manifestPath,
              JSON.stringify({ generatedAt: Date.now(), datasets: external }, null, 2) +
                String.fromCharCode(10),
            );
          }

          const slices = await runtime.db.listSlices();
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                dataFiles: dataFiles.length,
                profiles,
                slices: slices.length,
                externalDatasets: external.map((entry) =>
                  entry.profile
                    ? {
                        path: entry.path,
                        clientCount: entry.profile.clientCount,
                        rootHash: entry.profile.rootHash,
                        nonIid: entry.profile.nonIid,
                        splits: Object.fromEntries(
                          Object.entries(entry.profile.splits).map(([name, split]) => [
                            name,
                            {
                              clientCount: split.clientCount,
                              totalSamples: split.totalSamples,
                              sampleStats: split.sampleStats,
                              labelDistribution: split.labelDistribution,
                              firstClient: split.clients[0] ?? null,
                            },
                          ]),
                        ),
                        fileCount: entry.profile.fileCount,
                        readOnly: entry.profile.readOnly,
                      }
                    : { path: entry.path, error: entry.error },
                ),
                datasetManifestPath: manifestPath,
                cardPath: profiles.length > 0 ? cardPath : null,
              }),
            );
            return 0;
          }

          process.stdout.write(`dataset CSV files (from scan): ${dataFiles.length}\n`);
          for (const profile of profiles) {
            process.stdout.write(
              `  ${profile.source.path}: ${profile.rows} rows × ${profile.columns.length} columns, missing=${profile.quality.missingCells}, dup=${profile.quality.duplicateRows}\n`,
            );
            for (const candidate of profile.labelCandidates) {
              process.stdout.write(
                `    label candidate: ${candidate.column} (confidence ${candidate.confidence}) — needs confirmation\n`,
              );
            }
            if (!profile.licenseHint) {
              process.stdout.write('    license: no license file found next to the data\n');
            }
          }
          process.stdout.write(`registered slices: ${slices.length}\n`);
          for (const entry of external) {
            process.stdout.write(`  external: ${entry.path}\n`);
            if (!entry.profile) {
              process.stdout.write(`    ! profile failed: ${entry.error}\n`);
              continue;
            }
            const p = entry.profile;
            process.stdout.write(
              `    splits: ${Object.keys(p.splits).join(', ')} · clients: ${p.clientCount} · files: ${p.fileCount} · rootHash: ${p.rootHash.slice(0, 26)}…\n`,
            );
            for (const [name, split] of Object.entries(p.splits)) {
              const stats = split.sampleStats;
              process.stdout.write(
                `    ${name}: ${split.clientCount} clients, ${split.totalSamples} samples (min ${stats.min} / max ${stats.max} / mean ${stats.mean} / std ${stats.std})\n`,
              );
            }
            const trainSplit = p.splits.train ?? p.splits.test;
            if (trainSplit) {
              const first = trainSplit.clients[0];
              if (first) {
                process.stdout.write(
                  `    sample client [${first.id}]: x=${JSON.stringify(first.xShape)} ${first.xDtype}, y=${JSON.stringify(first.yShape)} ${first.yDtype}, ${first.samples} rows\n`,
                );
              }
              const labels = Object.entries(trainSplit.labelDistribution)
                .map(([k, v]) => `${k}:${v}`)
                .join(' ');
              process.stdout.write(`    label distribution: ${labels}\n`);
            }
            process.stdout.write(
              `    non-IID: tvMean=${p.nonIid.tvDistanceMean} tvMax=${p.nonIid.tvDistanceMax} samplesCv=${p.nonIid.samplesCv} classes/client=${p.nonIid.classesPerClientMean}\n`,
            );
            process.stdout.write(
              `    read-only: rootWritable=${p.readOnly.rootWritableByProcess} filesWritable=${p.readOnly.sampleWritableByProcess} (policy: platform opens read-only; slices written under .research)\n`,
            );
            if (manifestPath) process.stdout.write(`  dataset manifest: ${manifestPath}\n`);
          }
          if (profiles.length > 0) {
            process.stdout.write(`dataset card: ${mdPath}\n`);
          } else if (dataFiles.length === 0) {
            process.stdout.write('hint: put CSV datasets under datasets/ and run ideaseek scan\n');
          }
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );

  // --- Dataset Discovery (Phase 4.5B, docs/CLI_SPEC.md `datasets …`) --------
  // Registered on the existing `program` argument so the entry file (cli.ts)
  // and the TUI (src/cli/) stay untouched; discovery writes only the
  // knowledge/ artifact — never datasets/, slices or experiment inputs.
  const datasets = program
    .command('datasets')
    .description('dataset discovery candidates (recommendations only — never experiment inputs)');

  datasets
    .command('discover')
    .description(
      'discover dataset candidates from papers, experiment tables, comparison READMEs, the research map and allowed indexes',
    )
    .option('--question <text>', 'override the configured research question for this run')
    .option(
      '--harness <kind>',
      'model enrichment: none | fake | dsh (default: dsh when a key is configured, else fake)',
    )
    .option(
      '--sources <list>',
      `comma-separated sources (default: ${DEFAULT_DISCOVERY_SOURCES.join(',')}; academic-index joins automatically when research.external_search is on)`,
    )
    .option('--force', 'regenerate even when the inputs are unchanged')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (opts: {
          question?: string;
          harness?: string;
          sources?: string;
          force?: boolean;
          json?: boolean;
        }) => {
          const runtime = await ProjectRuntime.open({ cwd: process.cwd() });
          try {
            const question =
              (opts.question ?? runtime.config.research.question ?? '').trim() || null;
            const sources = normalizeSourceList(
              opts.sources
                ? [opts.sources]
                : runtime.config.research.externalSearch
                  ? [...DEFAULT_DISCOVERY_SOURCES, 'academic-index']
                  : undefined,
            );
            const keyPresent = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
            const mode =
              opts.harness ?? process.env.IDEASEEK_ASK_HARNESS ?? (keyPresent ? 'dsh' : 'fake');
            if (!['none', 'fake', 'dsh'].includes(mode)) {
              throw new IdeaseekError(
                'INVALID_ARGUMENT',
                `unknown harness kind "${mode}" (use none|fake|dsh)`,
              );
            }

            const now = Date.now();
            const collected = await collectDiscoverySources(runtime, { question, sources, now });
            const ctx = buildDiscoveryContext(collected, question);
            const inputHash = computeDiscoveryInputHash(ctx, mode);
            const root = runtime.paths.root;
            const existing = await readDiscoveryArtifact(root);

            if (!opts.force && existing && existing.inputHash === inputHash) {
              if (opts.json) {
                process.stdout.write(
                  jsonLine({
                    reused: true,
                    inputHash,
                    mode,
                    candidates: existing.candidates.length,
                    incompleteSources: existing.incompleteSources,
                    path: 'knowledge/dataset-candidates.json',
                  }),
                );
              } else {
                process.stdout.write(
                  `reused dataset discovery for unchanged inputs: ${existing.candidates.length} candidate(s)\n`,
                );
                process.stdout.write(
                  'next: ideaseek datasets list — or rerun with --force after new evidence\n',
                );
              }
              return 0;
            }

            const deterministic = buildDeterministicCandidates(ctx, now);
            let enriched = deterministic;
            let harnessRuntime: string | null = null;
            if (mode !== 'none') {
              const request = buildDiscoveryRequest({
                question,
                sources: ctx.sources,
                evidence: ctx.evidence,
                mode,
              });
              const harness = buildHarness(mode);
              await harness.initialize();
              let output: string;
              try {
                const result = await harness.runTask({
                  runId: 'datasets:discover',
                  taskId: `datasets-discover-${inputHash.slice(7, 15)}`,
                  profile: 'dataset-discovery',
                  instruction: request.instruction,
                  inputs: [
                    {
                      kind: 'text',
                      name: 'discovery_context',
                      content: JSON.stringify({
                        question,
                        providedPaperRefs: request.providedPaperRefs,
                        evidence: request.evidence.map((item) => ({
                          evidenceId: item.evidenceId,
                          kind: item.kind,
                          ref: item.ref,
                          name: item.name,
                          quote: item.quote,
                          url: item.url,
                          indexId: item.indexId,
                          paperKey: item.paperKey,
                        })),
                        sources: ctx.sources.map((source) => ({
                          kind: source.kind,
                          status: source.status,
                          reason: source.reason,
                        })),
                      }),
                    },
                  ],
                  outputSchema: 'dataset-candidates-v1',
                  budget: { timeoutMs: 120_000, maxOutputTokens: 8192 },
                  idempotencyKey: request.idempotencyKey,
                });
                output = result.output;
                harnessRuntime = result.runtime.kind;
              } catch (error) {
                if (isHarnessBlockError(error)) {
                  if (opts.json) {
                    process.stdout.write(jsonLine({ blocked: error.block, written: false }));
                  } else {
                    process.stderr.write(
                      `dataset discovery blocked [${error.block}]: ${error.message}\n` +
                        'nothing was written — restore quota/auth/network and rerun the same command\n',
                    );
                  }
                  return 2;
                }
                throw error;
              } finally {
                await harness.shutdown().catch(() => undefined);
              }
              const raw = parseDatasetCandidatesOutput(output, {
                evidence: request.evidence.map((item) => ({
                  evidenceId: item.evidenceId,
                  name: item.name,
                })),
                paperRefs: request.providedPaperRefs,
              });
              enriched = mergeModelIntoDeterministic(
                deterministic,
                stampModelCandidates(raw, ctx, now),
              );
            }

            const localReport = ctx.sources.find((source) => source.kind === 'local-inputs');
            const localSourcesChecked =
              localReport !== undefined &&
              (localReport.status === 'ok' || localReport.status === 'empty');
            const candidates = mergeWithPrevious(enriched, existing?.candidates ?? null, {
              localSourcesChecked,
            });
            const incompleteSources = ctx.sources.some(
              (source) =>
                source.status === 'missing' ||
                source.status === 'refused' ||
                source.status === 'failed',
            );
            const notes: string[] = [];
            if (mode === 'none') {
              notes.push(
                'model enrichment skipped (--harness none): fields stay "unknown" unless the evidence states them',
              );
            }
            const badSources = ctx.sources.filter(
              (source) => source.status !== 'ok' && source.status !== 'empty',
            );
            if (badSources.length > 0) {
              notes.push(
                `incomplete sources: ${badSources.map((source) => `${source.kind}=${source.status}`).join(', ')}`,
              );
            }
            const artifact: DatasetDiscoveryArtifact = {
              contract: DISCOVERY_SCHEMA,
              generatedAt: now,
              inputHash,
              mode,
              harnessRuntime,
              question,
              sources: ctx.sources,
              evidence: ctx.evidence,
              candidates,
              incompleteSources,
              notes,
            };
            await writeDiscoveryExports(root, artifact);

            let eventSeq: number | null = null;
            const run = await runtime.db.getLatestRun(runtime.project.id);
            if (run) {
              const event = await runtime.db.appendEvent({
                runId: run.runId,
                phase: 'DATA_READY',
                objectId: null,
                role: 'system',
                eventType: 'dataset_discovery',
                summary:
                  `dataset discovery: ${candidates.length} candidate(s) from ${sources.length} source(s) — ` +
                  'recommendations only, not experiment inputs',
                status: incompleteSources ? 'incomplete' : 'complete',
              });
              eventSeq = event.seq;
            }

            const byStatus: Record<string, number> = {};
            for (const candidate of candidates) {
              byStatus[candidate.status] = (byStatus[candidate.status] ?? 0) + 1;
            }
            const needsConfirmation = candidates.filter(requiresUserConfirmation).length;

            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  reused: false,
                  inputHash,
                  mode,
                  harnessRuntime,
                  candidates: candidates.length,
                  byStatus,
                  needsConfirmation,
                  incompleteSources,
                  sources: ctx.sources.map((source) => ({
                    kind: source.kind,
                    status: source.status,
                    reason: source.reason,
                    evidenceCount: source.evidenceCount,
                  })),
                  path: 'knowledge/dataset-candidates.json',
                  recommendationsPath: 'knowledge/dataset-recommendations.md',
                  eventSeq,
                }),
              );
              return 0;
            }

            process.stdout.write(
              `dataset discovery: ${candidates.length} candidate(s) · mode=${mode} · ` +
                `inputHash=${inputHash.slice(0, 19)}…\n`,
            );
            for (const source of ctx.sources) {
              process.stdout.write(
                `  ${source.status.padEnd(8)} ${source.kind.padEnd(14)} ${source.evidenceCount} evidence` +
                  `${source.reason ? ` — ${source.reason}` : ''}\n`,
              );
            }
            for (const candidate of candidates) {
              process.stdout.write(
                `  ${candidate.status.padEnd(14)} conf=${candidate.confidence.toFixed(2)} ` +
                  `${candidate.candidateId}  ${candidate.name}\n`,
              );
            }
            if (candidates.length === 0) {
              process.stdout.write(
                '  no candidates yet — add papers (ideaseek extract), data (ideaseek scan) or a research map (ideaseek synthesize)\n',
              );
            }
            process.stdout.write(
              '  artifact: knowledge/dataset-candidates.json · reading view: knowledge/dataset-recommendations.md\n',
            );
            if (incompleteSources) {
              process.stdout.write(
                '  note: some sources were incomplete — absence above is not proof of absence\n',
              );
            }
            if (needsConfirmation > 0) {
              process.stdout.write(
                `  ${needsConfirmation} candidate(s) need user confirmation before download/authorization ` +
                  '(large, restricted or unknown access)\n',
              );
            }
            if (eventSeq !== null) process.stdout.write(`  event #${eventSeq} recorded\n`);
            process.stdout.write('next: ideaseek datasets list · ideaseek datasets explain <id>\n');
            return 0;
          } finally {
            await runtime.close();
          }
        },
      ),
    );

  datasets
    .command('list')
    .description('list discovered dataset candidates (status, confidence, download/authorization)')
    .option('--status <status>', `filter by status (${CANDIDATE_STATUSES.join('|')})`)
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { status?: string; json?: boolean }) => {
        const runtime = await ProjectRuntime.open({ cwd: process.cwd() });
        try {
          const artifact = await requireDiscoveryArtifact(runtime.paths.root);
          let candidates = artifact.candidates;
          if (opts.status) {
            if (!CANDIDATE_STATUSES.includes(opts.status)) {
              throw new IdeaseekError(
                'INVALID_ARGUMENT',
                `unknown status "${opts.status}" (valid: ${CANDIDATE_STATUSES.join(', ')})`,
              );
            }
            candidates = candidates.filter((entry) => entry.status === opts.status);
          }
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                question: artifact.question,
                generatedAt: artifact.generatedAt,
                mode: artifact.mode,
                incompleteSources: artifact.incompleteSources,
                candidates,
              }),
            );
            return 0;
          }
          if (candidates.length === 0) {
            process.stdout.write(
              artifact.candidates.length === 0
                ? 'no dataset candidates yet — run: ideaseek datasets discover\n'
                : `no candidates with status "${opts.status}"\n`,
            );
            return 0;
          }
          process.stdout.write(
            `${candidates.length} dataset candidate(s) (discovered ${new Date(artifact.generatedAt).toISOString()}, mode=${artifact.mode}):\n`,
          );
          for (const candidate of candidates) {
            const confirmation = requiresUserConfirmation(candidate) ? ' confirm-required' : '';
            process.stdout.write(
              `  ${candidate.status.padEnd(14)} conf=${candidate.confidence.toFixed(2)} ` +
                `${candidate.candidateId.padEnd(24)} ${candidate.name} ` +
                `[${candidate.downloadStatus}/auth:${candidate.authorization.state}${confirmation}]\n`,
            );
          }
          if (artifact.incompleteSources) {
            process.stdout.write(
              'note: some discovery sources were incomplete — see ideaseek datasets explain for provenance\n',
            );
          }
          process.stdout.write('next: ideaseek datasets explain <candidate-id>\n');
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );

  datasets
    .command('explain')
    .description(
      'show one candidate with full provenance (sources, time, hash, license, authorization, readiness)',
    )
    .argument('<candidateId>', 'candidate id from datasets list')
    .option('--json', 'machine-readable output')
    .action(
      action(async (candidateId: string, opts: { json?: boolean }) => {
        const runtime = await ProjectRuntime.open({ cwd: process.cwd() });
        try {
          const artifact = await requireDiscoveryArtifact(runtime.paths.root);
          const candidate = requireCandidate(artifact, candidateId);
          const evidence = candidate.evidenceIds.map(
            (id) => artifact.evidence.find((item) => item.evidenceId === id) ?? null,
          );
          const readiness = candidateExperimentReadiness(candidate);
          const requiresConfirmation = requiresUserConfirmation(candidate);
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                candidate,
                evidence,
                readiness,
                requiresConfirmation,
                artifact: {
                  path: 'knowledge/dataset-candidates.json',
                  inputHash: artifact.inputHash,
                  generatedAt: artifact.generatedAt,
                  mode: artifact.mode,
                  incompleteSources: artifact.incompleteSources,
                  question: artifact.question,
                },
              }),
            );
            return 0;
          }
          process.stdout.write(`${candidate.name} (${candidate.candidateId})\n`);
          process.stdout.write(
            `  status: ${candidate.status} · confidence ${candidate.confidence} · ` +
              `discovered ${new Date(candidate.discoveredAt).toISOString()}\n`,
          );
          process.stdout.write(`  task: ${candidate.task}\n`);
          process.stdout.write(`  字段/样本单位 (unit): ${candidate.unit}\n`);
          process.stdout.write(`  scale: ${candidate.scale ?? 'unknown'}\n`);
          process.stdout.write(
            `  license: ${candidate.license.value} (${candidate.license.confidence}) — ${candidate.license.note}\n`,
          );
          process.stdout.write(
            `  access: ${candidate.access.acquisition}, restricted=${candidate.access.restricted}, ` +
              `size=${candidate.access.size}${candidate.access.url ? `, url=${candidate.access.url}` : ''}\n`,
          );
          process.stdout.write(`  获取方式: ${candidate.access.instructions}\n`);
          process.stdout.write(
            `  download proposal requires user confirmation: ${requiresConfirmation ? 'YES' : 'no'}\n`,
          );
          process.stdout.write(
            `  related papers: ${candidate.relatedPapers.join(', ') || 'none in the local index'}\n`,
          );
          process.stdout.write(
            `  relevance [${candidate.relevance.question || 'no question'}]: ${candidate.relevance.reason}\n`,
          );
          process.stdout.write(`  confidence basis: ${candidate.confidenceBasis.join('; ')}\n`);
          process.stdout.write(
            candidate.local
              ? `  local: ${candidate.local.path} (snapshot ${candidate.local.datasetSnapshotId ?? 'none'})\n`
              : '  local: not provided yet\n',
          );
          process.stdout.write(
            `  download status: ${candidate.downloadStatus} · authorization: ${candidate.authorization.state}` +
              `${candidate.authorization.reason ? ` (${candidate.authorization.reason})` : ''}\n`,
          );
          if (readiness.ready) {
            process.stdout.write('  experiment readiness: READY (user-provided data + snapshot)\n');
          } else {
            process.stdout.write('  experiment readiness: BLOCKED (recommendation only):\n');
            for (const reason of readiness.reasons) process.stdout.write(`    - ${reason}\n`);
          }
          process.stdout.write(
            `  sources (${evidence.filter(Boolean).length}/${candidate.evidenceIds.length}):\n`,
          );
          for (const [index, item] of evidence.entries()) {
            if (!item) {
              process.stdout.write(
                `    - ${candidate.evidenceIds[index]} (missing — artifact incomplete)\n`,
              );
              continue;
            }
            process.stdout.write(
              `    - ${item.evidenceId} ${item.kind} · ${item.ref} · ` +
                `${new Date(item.retrievedAt).toISOString()} · ${item.contentHash.slice(0, 19)}… (${item.hashBasis})\n`,
            );
            process.stdout.write(`      “${item.quote.slice(0, 160)}”\n`);
          }
          process.stdout.write(
            `  artifact: knowledge/dataset-candidates.json · mode=${artifact.mode} · ` +
              `inputHash=${artifact.inputHash.slice(0, 19)}… · ` +
              `${artifact.incompleteSources ? 'INCOMPLETE sources' : 'all sources answered'}\n`,
          );
          process.stdout.write(
            candidate.authorization.state === 'none'
              ? `next: ideaseek datasets authorize ${candidate.candidateId} --grant --confirm --reason "..." ` +
                  `| ideaseek datasets link ${candidate.candidateId} --path <file>\n`
              : `next: ideaseek datasets link ${candidate.candidateId} --path <file> (after providing the data)\n`,
          );
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );

  datasets
    .command('authorize')
    .description(
      'record the researcher grant/deny decision for a candidate (no download happens here)',
    )
    .argument('<candidateId>', 'candidate id')
    .option('--grant', 'grant: the researcher may obtain/download this dataset')
    .option('--deny', 'deny: reject the recommendation (status → rejected)')
    .option('--reason <text>', 'reason (required for --deny)')
    .option('--confirm', 'guided-mode confirmation for change-data-usage (Decision/Event recorded)')
    .option('--by <who>', 'who decides (default: researcher)', 'researcher')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (
          candidateId: string,
          opts: {
            grant?: boolean;
            deny?: boolean;
            reason?: string;
            confirm?: boolean;
            by?: string;
            json?: boolean;
          },
        ) => {
          const runtime = await ProjectRuntime.open({ cwd: process.cwd() });
          try {
            if (Boolean(opts.grant) === Boolean(opts.deny)) {
              throw new IdeaseekError('INVALID_ARGUMENT', 'pass exactly one of --grant or --deny');
            }
            const root = runtime.paths.root;
            const artifact = await requireDiscoveryArtifact(root);
            const candidate = requireCandidate(artifact, candidateId);
            const grant = opts.grant === true;
            const reason = opts.reason?.trim() ?? '';
            // Reason gate runs before any policy confirmation (same precedence
            // as comparison set-status excluded): no silent rejections.
            if (!grant && !reason) {
              throw new IdeaseekError(
                'USER_INPUT_REQUIRED',
                '--deny requires --reason (no silent rejections)',
              );
            }
            // Large/restricted/unknown-access (and reversals of a previous
            // deny) need explicit confirmation; a public small dataset grant
            // stays low-friction (docs/ARIS_INTEGRATION_PLAN §P1).
            const needsConfirm =
              grant && (requiresUserConfirmation(candidate) || candidate.status === 'rejected');
            const mode = parseAutonomyMode(runtime.config.policy.autonomyMode);
            if (needsConfirm) {
              assertAutonomy(mode, 'change-data-usage', { confirmed: opts.confirm === true });
            }

            const now = Date.now();
            const updated = authorizeCandidate(artifact, candidateId, {
              grant,
              reason,
              by: opts.by ?? 'researcher',
              now,
            });
            await writeDiscoveryExports(root, updated.artifact);

            const decision = await recordDecision(runtime.db, runtime.project.id, {
              action: 'change-data-usage',
              target: `dataset-candidate:${candidateId} ${grant ? 'grant' : 'deny'}`,
              mode,
              reason,
              status: mode === 'autonomous' ? 'auto' : 'confirmed',
            });

            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  candidateId,
                  status: updated.candidate.status,
                  downloadStatus: updated.candidate.downloadStatus,
                  authorization: updated.candidate.authorization,
                  requiresConfirmation: needsConfirm,
                  decisionSeq: decision?.seq ?? null,
                }),
              );
              return 0;
            }
            process.stdout.write(
              `${grant ? 'granted' : 'denied'} ${candidateId}: status=${updated.candidate.status} ` +
                `download=${updated.candidate.downloadStatus} auth=${updated.candidate.authorization.state}\n`,
            );
            if (grant) {
              process.stdout.write(
                candidate.access.acquisition === 'public-download' && candidate.access.url
                  ? `  authorized — fetch it with: ideaseek datasets acquire ${candidateId}\n`
                  : `  authorized — acquisition is "${candidate.access.acquisition}", so there is nothing to ` +
                      'fetch; obtain it yourself or mount it, then ideaseek scan + ideaseek datasets link\n',
              );
            }
            if (decision) process.stdout.write(`  decision event #${decision.seq} recorded\n`);
            else {
              process.stdout.write(
                '  no run exists yet — the Decision/Event binds to a run (start one with ideaseek run)\n',
              );
            }
            process.stdout.write(`next: ideaseek datasets explain ${candidateId}\n`);
            return 0;
          } finally {
            await runtime.close();
          }
        },
      ),
    );

  datasets
    .command('acquire')
    .description(
      'download an authorized public dataset file into the project datasets directory (staging only — datasets link stays the only promotion path)',
    )
    .argument('<candidateId>', 'candidate id')
    .option('--max-gib <n>', 'hard byte ceiling for this download', '50')
    .option('--timeout-ms <ms>', 'per-request timeout', '120000')
    .option('--confirm', 'confirm a large or unknown-size download')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (
          candidateId: string,
          opts: { maxGib?: string; timeoutMs?: string; confirm?: boolean; json?: boolean },
        ) => {
          const runtime = await ProjectRuntime.open({ cwd: process.cwd() });
          try {
            const root = runtime.paths.root;
            const artifact = await requireDiscoveryArtifact(root);
            const candidate = requireCandidate(artifact, candidateId);

            if (candidate.authorization.state !== 'granted') {
              throw new IdeaseekError(
                'USER_INPUT_REQUIRED',
                `dataset ${candidateId} is not granted (authorization=${candidate.authorization.state}) — ` +
                  `run: ideaseek datasets authorize ${candidateId} --grant`,
              );
            }
            if (candidate.access.acquisition !== 'public-download') {
              throw new IdeaseekError(
                'USER_INPUT_REQUIRED',
                `acquisition for ${candidateId} is "${candidate.access.acquisition}", not a public download — ` +
                  candidate.access.instructions,
              );
            }
            if (!candidate.access.url) {
              throw new IdeaseekError(
                'USER_INPUT_REQUIRED',
                `no source url recorded for ${candidateId} — run: ideaseek datasets discover`,
              );
            }
            if (candidate.local || candidate.downloadStatus === 'local-present') {
              throw new IdeaseekError(
                'ALREADY_COMMITTED',
                `${candidateId} already has data at ${candidate.local?.path ?? '(local mount)'} — ` +
                  'acquire never re-downloads or overwrites',
              );
            }
            if (!runtime.config.runtime.allowNetwork) {
              throw new IdeaseekError(
                'NETWORK_BLOCKED',
                'runtime.allow_network is false — set allow_network: true in research.yaml to let IdeaSeek fetch data',
              );
            }

            const maxGib = Number(opts.maxGib);
            if (!Number.isFinite(maxGib) || maxGib <= 0 || maxGib > 2000) {
              throw new IdeaseekError('INVALID_ARGUMENT', '--max-gib must be a positive GiB count');
            }
            const timeoutMs = Number(opts.timeoutMs);
            if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3_600_000) {
              throw new IdeaseekError(
                'INVALID_ARGUMENT',
                '--timeout-ms must be between 1000 and 3600000',
              );
            }

            // Size is the disk-budget decision: a small public file stays
            // low-friction, large or unknown-size downloads always need an
            // explicit confirmation (docs/ARIS_INTEGRATION_PLAN §P1).
            const needsConfirm =
              requiresUserConfirmation(candidate) || candidate.access.size === 'unknown';
            const mode = parseAutonomyMode(runtime.config.policy.autonomyMode);
            if (needsConfirm) {
              assertAutonomy(mode, 'change-data-usage', { confirmed: opts.confirm === true });
            }

            const acquired = await acquireDataset({
              url: candidate.access.url,
              destDir: resolve(root, runtime.config.inputs.datasetsDir),
              maxBytes: Math.floor(maxGib * 1024 * 1024 * 1024),
              timeoutMs,
            });
            const relPath = relative(root, acquired.path).replace(/\\/g, '/');
            const at = Date.now();
            const ledger = await appendAcquisition(root, {
              candidateId,
              name: candidate.name,
              relPath,
              sha256: acquired.sha256,
              bytes: acquired.bytes,
              sourceUrl: acquired.sourceUrl,
              at,
            });
            const updated = recordAcquisition(artifact, candidateId, {
              relPath,
              sha256: acquired.sha256,
              bytes: acquired.bytes,
              sourceUrl: acquired.sourceUrl,
              at,
            });
            await writeDiscoveryExports(root, updated.artifact);
            const decision = await recordDecision(runtime.db, runtime.project.id, {
              action: 'change-data-usage',
              target: `dataset-acquire:${candidateId} ${relPath}`,
              mode,
              reason: `staged ${acquired.bytes} bytes from ${acquired.sourceUrl}`,
              status: mode === 'autonomous' ? 'auto' : 'confirmed',
            });

            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  candidateId,
                  relPath,
                  sha256: acquired.sha256,
                  bytes: acquired.bytes,
                  sourceUrl: acquired.sourceUrl,
                  requiresConfirmation: needsConfirm,
                  ledgerRecords: ledger.records,
                  decisionSeq: decision?.seq ?? null,
                }),
              );
              return 0;
            }
            process.stdout.write(
              `acquired ${candidateId} → ${relPath} (${(acquired.bytes / 1024 / 1024).toFixed(1)} MiB)\n` +
                `  sha256: ${acquired.sha256}\n` +
                `  source: ${acquired.sourceUrl}\n` +
                `  ledger: knowledge/dataset-acquisitions.json (${ledger.records} record(s))\n`,
            );
            if (decision) process.stdout.write(`  decision event #${decision.seq} recorded\n`);
            process.stdout.write(
              `next: ideaseek datasets link ${candidateId} --path ${relPath}\n` +
                '  (link profiles the file and is the only promotion path to user-provided/validated)\n',
            );
            return 0;
          } finally {
            await runtime.close();
          }
        },
      ),
    );

  datasets
    .command('link')
    .description(
      'bind researcher-provided data to a candidate (status → user-provided/validated; the only promotion path)',
    )
    .argument('<candidateId>', 'candidate id')
    .option('--path <path>', 'project-relative data file, or a configured readonly dataset path')
    .option('--json', 'machine-readable output')
    .action(
      action(async (candidateId: string, opts: { path?: string; json?: boolean }) => {
        const runtime = await ProjectRuntime.open({ cwd: process.cwd() });
        try {
          if (!opts.path?.trim()) {
            throw new IdeaseekError('INVALID_ARGUMENT', '--path <path> is required');
          }
          const root = runtime.paths.root;
          const artifact = await requireDiscoveryArtifact(root);
          requireCandidate(artifact, candidateId);

          const readonlyRoots = runtime.config.inputs.readonlyDatasets;
          const inside = (base: string, target: string): boolean => {
            const rel = relative(base, target);
            return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
          };
          const resolved = isAbsolute(opts.path) ? resolve(opts.path) : resolve(root, opts.path);
          const readonlyEntry = readonlyRoots.find((entry) => inside(resolve(entry), resolved));
          const relFromRoot = relative(root, resolved);
          const rel =
            !readonlyEntry &&
            relFromRoot &&
            !relFromRoot.startsWith('..') &&
            !isAbsolute(relFromRoot)
              ? relFromRoot.replace(/\\/g, '/')
              : null;
          if (!rel && !readonlyEntry) {
            throw new IdeaseekError(
              'INVALID_ARGUMENT',
              '--path must be inside the project or a configured readonly dataset root',
            );
          }

          const datasetsPrefix = `${runtime.config.inputs.datasetsDir.replace(/\\/g, '/')}/`;
          const manifest = await readManifest(
            join(runtime.paths.knowledgeDir, 'input-manifest.json'),
          );
          const manifestEntry =
            rel !== null
              ? manifest?.files.find(
                  (file) => file.role === 'data' && file.relPath.replace(/\\/g, '/') === rel,
                )
              : undefined;
          const underDatasets =
            rel !== null &&
            (rel === runtime.config.inputs.datasetsDir || rel.startsWith(datasetsPrefix));
          if (rel !== null && !underDatasets && !manifestEntry && !readonlyEntry) {
            throw new IdeaseekError(
              'USER_INPUT_REQUIRED',
              `path "${opts.path}" is not a discovered input — put it under ${runtime.config.inputs.datasetsDir}/ ` +
                '(or scan it) and run ideaseek scan first, or pass a configured readonly dataset path',
            );
          }

          let info;
          try {
            info = await stat(resolved);
          } catch {
            throw new IdeaseekError('FILE_NOT_FOUND', `path not found: ${opts.path}`);
          }

          let path = rel ?? readonlyEntry ?? opts.path;
          let sha256: ContentHash | null = null;
          let bytes: number | null = null;
          let snapshotId: string | null = null;
          let licenseHint: string | null = null;
          let profiled = false;
          let scaleHint: string | null = null;

          if (info.isFile()) {
            bytes = info.size;
            const manifestHash =
              manifestEntry?.sha256 && isContentHash(manifestEntry.sha256)
                ? manifestEntry.sha256
                : null;
            if (manifestHash) {
              sha256 = manifestHash;
            } else {
              if (info.size > MAX_INLINE_HASH_BYTES) {
                throw new IdeaseekError(
                  'USER_INPUT_REQUIRED',
                  `file is ${(info.size / (1024 * 1024)).toFixed(0)} MiB without a scan hash — ` +
                    'run ideaseek scan first (inline hashing of large files is refused)',
                );
              }
              sha256 = await sha256OfFile(resolved);
            }
            snapshotId = `data-${sha256.slice(7, 19)}`;
          } else if (info.isDirectory() && readonlyEntry && resolve(readonlyEntry) === resolved) {
            // Whole readonly mount: identity comes from the federated profile.
            const externalFile = await readJsonFrom(
              join(runtime.paths.knowledgeDir, 'dataset-manifest.json'),
            );
            const entry = (
              externalFile as { datasets?: Record<string, unknown>[] } | null
            )?.datasets?.find((item) => item.path === readonlyEntry || item.path === resolved);
            const profile = entry?.profile as
              | { rootHash?: string; clientCount?: number; splits?: Record<string, unknown> }
              | undefined;
            if (profile?.rootHash && isContentHash(profile.rootHash)) {
              sha256 = profile.rootHash;
              snapshotId = `data-fed-${profile.rootHash.slice(7, 19)}`;
              profiled = true;
              scaleHint = `${profile.clientCount ?? '?'} clients, splits ${
                Object.keys(profile.splits ?? {}).join('/') || 'unknown'
              }`;
              path = readonlyEntry;
            } else {
              throw new IdeaseekError(
                'USER_INPUT_REQUIRED',
                `readonly directory ${opts.path} has no dataset-manifest profile — run: ideaseek data describe`,
              );
            }
          } else {
            throw new IdeaseekError(
              'INVALID_ARGUMENT',
              'link expects a single data file (or a configured readonly dataset root directory)',
            );
          }

          if (snapshotId) {
            const cardFile = await readJsonFrom(
              join(runtime.paths.knowledgeDir, 'dataset-card.json'),
            );
            const profile = (
              cardFile as { profiles?: Record<string, unknown>[] } | null
            )?.profiles?.find((item) => item.datasetSnapshotId === snapshotId);
            if (profile) {
              profiled = true;
              licenseHint = (profile.licenseHint as string | null) ?? null;
              const rows = profile.rows;
              const columns = (profile.columns as { name: string }[] | undefined)?.length;
              if (typeof rows === 'number' && typeof columns === 'number') {
                scaleHint = `${rows} rows × ${columns} columns`;
              }
            }
          }

          const now = Date.now();
          const updated = linkCandidateLocal(artifact, candidateId, {
            path,
            sha256,
            bytes,
            snapshotId,
            licenseHint,
            profiled,
            scaleHint,
            now,
          });
          await writeDiscoveryExports(root, updated.artifact);

          let eventSeq: number | null = null;
          const run = await runtime.db.getLatestRun(runtime.project.id);
          if (run) {
            const event = await runtime.db.appendEvent({
              runId: run.runId,
              phase: 'DATA_READY',
              objectId: candidateId,
              role: 'user',
              eventType: 'dataset_linked',
              summary: `dataset linked: ${candidateId} → ${path} (snapshot ${snapshotId ?? 'none'})`,
              status: updated.candidate.status,
            });
            eventSeq = event.seq;
          }

          if (opts.json) {
            process.stdout.write(
              jsonLine({
                candidateId,
                status: updated.candidate.status,
                downloadStatus: updated.candidate.downloadStatus,
                local: updated.candidate.local,
                profiled,
                eventSeq,
              }),
            );
            return 0;
          }
          process.stdout.write(
            `linked ${candidateId} → ${path}\n` +
              `  status=${updated.candidate.status} snapshot=${snapshotId ?? 'none'} ` +
              `download=${updated.candidate.downloadStatus}\n`,
          );
          if (eventSeq !== null) process.stdout.write(`  event #${eventSeq} recorded\n`);
          process.stdout.write(
            'next: ideaseek data describe (dataset card) · ideaseek data slices · ' +
              `ideaseek datasets explain ${candidateId}\n`,
          );
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );
}

async function readJsonFrom(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}
