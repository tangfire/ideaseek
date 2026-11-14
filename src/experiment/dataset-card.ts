import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { sha256OfFile } from '../core/hash.js';
import { parseCsv } from './slice-csv.js';

/** Column-level profile facts (deterministic, model-free). */
export interface ColumnProfile {
  name: string;
  missing: number;
  distinct: number;
  numeric: boolean;
  samples: string[];
}

export interface LabelCandidate {
  column: string;
  confidence: number;
  basis: string;
}

export interface DatasetProfile {
  datasetSnapshotId: string;
  source: {
    path: string;
    bytes: number;
    sha256: string;
    /** CSV, or an image corpus in any of the shapes the image profiler reads. */
    format: 'csv' | 'parquet' | 'parquet-shards' | 'image-dir';
  };
  rows: number;
  columns: ColumnProfile[];
  quality: { missingCells: number; duplicateRows: number; constantColumns: string[] };
  labelCandidates: LabelCandidate[];
  licenseHint: string | null;
  generatedAt: number;
  generatedBy: string;
}

const LABEL_NAME = /^(label|labels|target|y|class|classes|outcome|churn|diagnosis)$/i;
const MAX_SAMPLES = 3;

function isNumeric(values: string[]): boolean {
  const nonEmpty = values.filter((value) => value.trim() !== '');
  if (nonEmpty.length === 0) return false;
  return nonEmpty.every((value) => Number.isFinite(Number(value)));
}

/** Profiles one CSV file into a DatasetProfile (content-hash addressed). */
export async function profileCsv(
  path: string,
  opts: { now: number; generatedBy: string },
): Promise<DatasetProfile> {
  const [text, hash] = await Promise.all([readFile(path, 'utf8'), sha256OfFile(path)]);
  const { header, rows } = parseCsv(text);
  const missing = header.map(() => 0);
  const distinctSets = header.map(() => new Set<string>());
  const samples = header.map(() => [] as string[]);
  const seenRows = new Set<string>();
  let duplicateRows = 0;
  let missingCells = 0;
  for (const row of rows) {
    const key = row.join('|');
    if (seenRows.has(key)) duplicateRows += 1;
    else seenRows.add(key);
    header.forEach((_, columnIndex) => {
      const cell = (row[columnIndex] ?? '').trim();
      if (cell === '') {
        missing[columnIndex] = (missing[columnIndex] ?? 0) + 1;
        missingCells += 1;
        return;
      }
      distinctSets[columnIndex]?.add(cell);
      if (samples[columnIndex]!.length < MAX_SAMPLES && !samples[columnIndex]!.includes(cell)) {
        samples[columnIndex]!.push(cell.slice(0, 40));
      }
    });
  }
  const columns: ColumnProfile[] = header.map((name, index) => {
    const columnValues = rows.map((row) => row[index] ?? '');
    return {
      name,
      missing: missing[index] ?? 0,
      distinct: distinctSets[index]?.size ?? 0,
      numeric: isNumeric(columnValues),
      samples: samples[index] ?? [],
    };
  });
  const constantColumns = columns
    .filter((column) => column.distinct === 1 && rows.length > 1)
    .map((column) => column.name);
  const labelCandidates: LabelCandidate[] = columns
    .filter((column) => LABEL_NAME.test(column.name))
    .map((column) => ({
      column: column.name,
      confidence: 0.6,
      basis: `column name matches label heuristic (${column.name}) - needs user confirmation`,
    }));
  const licenseHint = await detectLicenseHint(path);
  return {
    datasetSnapshotId: `data-${hash.slice(7, 19)}`,
    source: {
      path: basename(path),
      bytes: Buffer.byteLength(text, 'utf8'),
      sha256: hash,
      format: 'csv',
    },
    rows: rows.length,
    columns,
    quality: { missingCells, duplicateRows, constantColumns },
    labelCandidates,
    licenseHint,
    generatedAt: opts.now,
    generatedBy: opts.generatedBy,
  };
}

/** Best-effort license clue: a LICENSE file next to the dataset file. */
async function detectLicenseHint(path: string): Promise<string | null> {
  const { dirname, join } = await import('node:path');
  const { access, readFile: rf } = await import('node:fs/promises');
  const dir = dirname(path);
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license']) {
    const candidate = join(dir, name);
    try {
      await access(candidate);
      const head = (await rf(candidate, 'utf8')).slice(0, 200).replace(/\s+/g, ' ').trim();
      return `${name}: ${head.slice(0, 120)}`;
    } catch {
      continue;
    }
  }
  return null;
}

/** Renders the human-readable dataset card companion (knowledge/dataset-card). */
export function renderDatasetCard(profiles: DatasetProfile[], generatedAt: number): string {
  const lines: string[] = [
    '# Dataset Card',
    '',
    `Generated at ${new Date(generatedAt).toISOString()} from deterministic profiling (no model).`,
    '',
  ];
  for (const profile of profiles) {
    lines.push(`## ${profile.source.path}`);
    lines.push('');
    lines.push(`- snapshot: ${profile.datasetSnapshotId}`);
    lines.push(`- sha256: ${profile.source.sha256}`);
    lines.push(`- rows: ${profile.rows} / columns: ${profile.columns.length}`);
    lines.push(
      `- quality: ${profile.quality.missingCells} missing cells, ${profile.quality.duplicateRows} duplicate rows, constant: ${profile.quality.constantColumns.join(', ') || 'none'}`,
    );
    lines.push(`- license: ${profile.licenseHint ?? 'no license file found next to the data'}`);
    if (profile.labelCandidates.length > 0) {
      lines.push('- label candidates (need confirmation):');
      for (const candidate of profile.labelCandidates) {
        lines.push(
          `  - ${candidate.column} (confidence ${candidate.confidence}): ${candidate.basis}`,
        );
      }
    } else {
      lines.push('- label candidates: none detected by name heuristic');
    }
    lines.push('');
    lines.push('| column | missing | distinct | numeric | samples |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const column of profile.columns.slice(0, 40)) {
      lines.push(
        `| ${column.name} | ${column.missing} | ${column.distinct} | ${column.numeric ? 'yes' : 'no'} | ${column.samples.map((s) => JSON.stringify(s)).join(', ')} |`,
      );
    }
    lines.push('');
  }
  lines.push(
    'Label semantics, split meaning and leakage boundaries require user confirmation before formal conclusions (see ideaseek confirm protocol).',
    '',
  );
  return lines.join('\n');
}
