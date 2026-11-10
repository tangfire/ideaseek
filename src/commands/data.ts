import type { Command } from 'commander';
import { join, resolve } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { ProjectRuntime } from '../workflow/runtime.js';
import { buildCsvSlices } from '../experiment/slice-csv.js';
import { sha256OfFile } from '../core/hash.js';
import type { SliceScale } from '../experiment/slices.js';
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
              }
              process.stdout.write('next: ideaseek data slices\n');
              return 0;
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
                stats?: { selectedRows?: number; totalRows?: number };
                seed?: number;
                rule?: string;
              };
              process.stdout.write(
                `  ${entry.sliceId}  ${entry.scale}  ${record.stats?.selectedRows ?? '?'}/${record.stats?.totalRows ?? '?'} rows  seed=${record.seed ?? '?'}\n`,
              );
              if (opts.scale || opts.dataset)
                process.stdout.write(`    rule: ${record.rule ?? '—'}\n`);
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
    .description('dataset inventory (Phase 3 Dataset Analyst lands with the full card)')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { json?: boolean }) => {
        const runtime = await ProjectRuntime.open({ cwd: process.cwd() });
        try {
          const { readManifest } = await import('../knowledge/organize.js');
          const manifest = await readManifest(
            join(runtime.paths.knowledgeDir, 'input-manifest.json'),
          );
          const dataFiles = manifest?.files.filter((file) => file.role === 'data') ?? [];
          const slices = await runtime.db.listSlices();
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                dataFiles: dataFiles.length,
                files: dataFiles.map((f) => f.relPath),
                slices: slices.length,
              }),
            );
            return 0;
          }
          process.stdout.write(`dataset files (from scan): ${dataFiles.length}\n`);
          for (const file of dataFiles.slice(0, 50)) {
            process.stdout.write(
              `  ${file.relPath}  ${file.bytes} B  ${file.sha256 ?? file.hashStatus}\n`,
            );
          }
          process.stdout.write(`registered slices: ${slices.length}\n`);
          if (dataFiles.length === 0) {
            process.stdout.write('hint: put datasets under datasets/ and run ideaseek scan\n');
          }
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );
}
