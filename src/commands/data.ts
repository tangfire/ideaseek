import type { Command } from 'commander';
import { join, resolve } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { ProjectRuntime } from '../workflow/runtime.js';
import { buildCsvSlices } from '../experiment/slice-csv.js';
import { profileCsv, renderDatasetCard } from '../experiment/dataset-card.js';
import { sha256OfFile } from '../core/hash.js';
import { writeFileAtomic } from '../core/atomic.js';
import type { SliceScale } from '../experiment/slices.js';
import { profileFederatedDataset } from '../knowledge/federated.js';
import { buildAllFederatedSlices } from '../experiment/federated-slices.js';
import { ensureDir } from '../core/atomic.js';
import { action, jsonLine } from './shared.js';

const SCALES: SliceScale[] = ['smoke', 'quick', 'standard'];

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
}
