import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { writeFileAtomic } from '../core/atomic.js';
import { sha256Of, sha256OfFile } from '../core/hash.js';
import {
  SCALE_FRACTIONS,
  SLICE_RULE_VERSION,
  selectRows,
  type DatasetSlice,
  type SliceScale,
} from './slices.js';
import { checkDistributionPreservation } from './distribution.js';

/**
 * Minimal RFC-4180-style CSV parser (quotes, escaped quotes, embedded
 * newlines). Enough for Phase 3 slice generation over user CSVs; exotic
 * dialects (sep=, BOM variants) are normalized or rejected loudly.
 */
export function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const clean = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };
  while (i < clean.length) {
    const char = clean[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }
    if (char === '"' && field === '') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ',') {
      pushField();
      i += 1;
      continue;
    }
    if (char === '\r') {
      i += 1;
      continue;
    }
    if (char === '\n') {
      pushRow();
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }
  if (field !== '' || row.length > 0) pushRow();
  if (rows.length === 0) {
    throw new IdeaseekError('PARSE_FAILED', 'CSV has no rows');
  }
  const header = rows[0]!;
  const body = rows.slice(1).filter((entry) => entry.some((cell) => cell !== ''));
  return { header, rows: body };
}

export function serializeCsv(header: string[], rows: string[][]): string {
  const escape = (cell: string): string =>
    /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
  const lines = [header.map(escape).join(',')];
  for (const row of rows) lines.push(row.map(escape).join(','));
  return `${lines.join('\n')}\n`;
}

export interface BuildSlicesOptions {
  csvPath: string;
  datasetSnapshotId: string;
  /** Directory receiving `<sliceId>.csv` + `<sliceId>.json` (managed only). */
  outDir: string;
  scales?: SliceScale[];
  seed?: number;
  generatedBy: string;
  now: number;
}

/**
 * Builds deterministic smoke/quick/standard slices from a CSV: source is
 * read-only, outputs are written atomically under the managed outDir, and
 * each slice records input/output hashes, seed, rule and boundary limits so
 * experiment results can cite exactly what data they used.
 */
export async function buildCsvSlices(opts: BuildSlicesOptions): Promise<DatasetSlice[]> {
  const scales = opts.scales ?? (['smoke', 'quick', 'standard'] as SliceScale[]);
  const seed = opts.seed ?? 20260101;
  const text = await readFile(opts.csvPath, 'utf8');
  const inputHash = await sha256OfFile(opts.csvPath);
  const { header, rows } = parseCsv(text);

  const slices: DatasetSlice[] = [];
  for (const scale of scales) {
    const selection = selectRows({ scale, totalRows: rows.length, seed });
    const selectedRows = selection.indices.map((index) => rows[index]!);
    const body = serializeCsv(header, selectedRows);
    const outputHash = sha256Of(body);
    const sliceId = `ds-${inputHash.slice(7, 19)}-${scale}-r${SLICE_RULE_VERSION}`;

    const distribution = checkDistributionPreservation({
      header,
      sourceRows: rows,
      selectedIndices: selection.indices,
      now: opts.now,
    });

    await writeFileAtomic(join(opts.outDir, `${sliceId}.csv`), body);
    const slice: DatasetSlice = {
      sliceId,
      datasetSnapshotId: opts.datasetSnapshotId,
      scale,
      rule: selection.rule,
      ruleVersion: SLICE_RULE_VERSION,
      inputHash,
      outputHash,
      stats: { totalRows: rows.length, selectedRows: selectedRows.length },
      seed,
      boundaries: ['row-level selection (rule v1): no subject/group/time boundary preserved'],
      generatedBy: opts.generatedBy,
      generatedAt: opts.now,
      limits: [
        `fraction for ${scale} is ${SCALE_FRACTIONS[scale]}`,
        'group/time-aware splitting requires a domain adapter before leakage-sensitive use',
      ],
      distributionCheck: {
        ok: distribution.ok,
        warnings: distribution.drifts
          .filter((drift) => drift.severity !== 'ok')
          .map((drift) => `${drift.column}: ${drift.detail}`),
      },
    };
    await writeFileAtomic(
      join(opts.outDir, `${sliceId}.json`),
      `${JSON.stringify(slice, null, 2)}\n`,
    );
    slices.push(slice);
  }
  return slices;
}
