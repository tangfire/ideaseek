import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sha256Of } from '../core/hash.js';
import { redactSecrets } from '../core/redact.js';
import { metricIdentifier } from '../core/metric-id.js';

/**
 * A results file the manuscript can actually read.
 *
 * `paper figure` asks a model to write plotting scripts and `paper write` asks
 * one to write tables, but until now the platform handed them neither a file to
 * read nor the recorded numbers — the context contained the research question
 * and the protocol id. The first FDG plan therefore "planned publication
 * figures" whose scripts drew `ax.bar(['fake'], [1.0])`, and `render-figures`
 * printed `rendered 6/6` over them. A figure that cannot be traced to a
 * recorded run is decoration, not evidence.
 *
 * This export is deterministic: one row per recorded experiment, with the
 * metric values exactly as stored, the scale it ran at, and the provenance
 * hashes that let a reader get back to the code, data and protocol. Nothing is
 * averaged, rounded or re-derived here — that is analysis' job — because a
 * plotting script must be able to reproduce the same number from this file
 * alone.
 */
export const PAPER_RESULTS_FILE = join('reports', 'paper', 'results.json');

export interface PaperResultRow {
  specId: string;
  ideaId: string | null;
  methodIds: string[];
  /**
   * Mechanical provenance so a table can never present the wrong row as a
   * competing method: `ablation` = control run (ablation.ts marks them
   * `ablation:<id>` in notes; legacy rows carry `idea-<id>-abl-<slug>`),
   * `baseline` = spec.idea is null (spec.ts: baseline/protocol runs),
   * `own` = the idea's own method run. Which baseline is *established* is an
   * agent judgment (baseline-adequacy), not this field's job.
   */
  sourceKind: 'own' | 'ablation' | 'baseline';
  scale: string;
  status: string;
  seeds: number[];
  metrics: { name: string; identifier: string; value: number }[];
  codeHash: string | null;
  dataSnapshotId: string | null;
  protocolId: string | null;
  artifactRefs: string[];
}

export interface PaperResultsExport {
  schemaVersion: 1;
  generatedAt: number;
  /** Provenance of the export itself, so a figure can say what it read. */
  inputHash: string;
  rowPath: string;
  rows: PaperResultRow[];
  /** Ablation-control rows withheld from this export (0 unless excluded). */
  excludedAblations: number;
  /**
   * Runs whose numbers are indistinguishable from each other.
   *
   * Found on the real project: five ablation runs and their parent exported the
   * SAME value for every metric — which cannot mean the ablations did nothing
   * and the mechanism still held, only that the ablation code ignored its own
   * flag (or a stored result got reused). A table over these rows looks like a
   * completed ablation study, so the export names the groups instead of leaving
   * the reader to diff nine long floats by eye.
   */
  identicalValueGroups: { specIds: string[]; metrics: string[] }[];
}

interface ResultSource {
  metrics?: { name?: unknown; value?: unknown }[];
  status?: unknown;
  artifactRefs?: unknown;
}

interface SpecSource {
  specId?: unknown;
  idea?: { ideaId?: unknown } | null;
  comparisonIds?: unknown;
  metrics?: { name?: unknown }[];
  seeds?: unknown;
  environment?: { notes?: unknown };
  codeCommit?: unknown;
  dataSnapshotId?: unknown;
  protocolId?: unknown;
  result?: unknown;
  spec?: unknown;
}

function scaleOf(spec: SpecSource): string {
  const notes = spec.environment?.notes;
  if (!Array.isArray(notes)) return 'unknown';
  const note = notes.find((entry) => String(entry).startsWith('scale:'));
  return note ? String(note).slice('scale:'.length) : 'unknown';
}

function sourceKindOf(spec: SpecSource, specId: string): PaperResultRow['sourceKind'] {
  const notes = spec.environment?.notes;
  if (Array.isArray(notes) && notes.some((entry) => String(entry).startsWith('ablation:'))) {
    return 'ablation';
  }
  // Legacy records predate the note marker; ablation.ts names them
  // idea-<ideaId>-abl-<ablationId>.
  if (specId.includes('-abl-')) return 'ablation';
  if (spec.idea == null) return 'baseline';
  return 'own';
}

/**
 * Build the export from registry rows (the same rows the analysis reads).
 *
 * Runs without a result are kept with `status` as recorded: a figure author
 * must be able to see that a method was planned but never measured, which is
 * how "Table 1 includes FedAvg in-domain accuracy" gets prevented rather than
 * discovered by a reviewer.
 */
/**
 * Runs that cannot be told apart by their numbers.
 *
 * Exported because the manuscript needs the same verdict as the export: a table
 * built from a results file written before this field existed must still carry
 * the caveat, and a second copy of the rule is how the two start disagreeing.
 */
export function identicalValueGroupsOf(
  rows: { specId: string; status: string; metrics: { name: string; value: number }[] }[],
): { specIds: string[]; metrics: string[] }[] {
  const fingerprints = new Map<string, { specIds: string[]; metrics: string[] }>();
  for (const row of rows) {
    if (row.status !== 'succeeded' || row.metrics.length === 0) continue;
    const sorted = [...row.metrics].sort((a, b) => a.name.localeCompare(b.name));
    const key = sorted.map((metric) => `${metric.name}=${metric.value}`).join(';');
    const group = fingerprints.get(key);
    if (group) group.specIds.push(row.specId);
    else
      fingerprints.set(key, {
        specIds: [row.specId],
        metrics: sorted.map((metric) => metric.name),
      });
  }
  return [...fingerprints.values()]
    .filter((group) => group.specIds.length > 1)
    .sort(
      (a, b) => b.specIds.length - a.specIds.length || a.specIds[0]!.localeCompare(b.specIds[0]!),
    );
}

export function buildPaperResults(
  entries: { spec: SpecSource; result: ResultSource | null }[],
  now: number,
  opts: { excludeAblations?: boolean } = {},
): PaperResultsExport {
  const rows: PaperResultRow[] = [];
  for (const entry of entries) {
    const spec = entry.spec;
    const result = entry.result ?? null;
    const metrics = Array.isArray(result?.metrics) ? result.metrics : [];
    const specId = String(spec.specId ?? '');
    rows.push({
      specId,
      ideaId: spec.idea?.ideaId ? String(spec.idea.ideaId) : null,
      methodIds: Array.isArray(spec.comparisonIds) ? spec.comparisonIds.map(String) : [],
      sourceKind: sourceKindOf(spec, specId),
      scale: scaleOf(spec),
      status: String(result?.status ?? 'no-result'),
      seeds: Array.isArray(spec.seeds) ? spec.seeds.map(Number) : [],
      metrics: metrics
        .filter((metric) => typeof metric?.value === 'number' && Number.isFinite(metric.value))
        .map((metric) => ({
          name: String(metric.name ?? ''),
          identifier: metricIdentifier(String(metric.name ?? '')),
          value: Number(metric.value),
        })),
      codeHash: spec.codeCommit ? String(spec.codeCommit) : null,
      dataSnapshotId: spec.dataSnapshotId ? String(spec.dataSnapshotId) : null,
      protocolId: spec.protocolId ? String(spec.protocolId) : null,
      artifactRefs: Array.isArray(result?.artifactRefs) ? result.artifactRefs.map(String) : [],
    });
  }
  rows.sort((a, b) => a.specId.localeCompare(b.specId));
  const nonEmpty = rows.filter((row) => row.specId);

  // Integrity groups always see EVERY row, including excluded controls —
  // hiding the rows must not hide the "five ablations share one value" signal.
  const identicalValueGroups = identicalValueGroupsOf(
    nonEmpty.map((row) => ({
      specId: row.specId,
      status: row.status,
      metrics: row.metrics.map((metric) => ({ name: metric.name, value: metric.value })),
    })),
  );

  const visible = opts.excludeAblations
    ? nonEmpty.filter((row) => row.sourceKind !== 'ablation')
    : nonEmpty;

  return {
    schemaVersion: 1,
    generatedAt: now,
    inputHash: sha256Of(redactSecrets(JSON.stringify(visible))),
    rowPath: PAPER_RESULTS_FILE.split('\\').join('/'),
    rows: visible,
    excludedAblations: nonEmpty.length - visible.length,
    identicalValueGroups,
  };
}

/**
 * Read an existing export, or null when none has been produced yet.
 *
 * Figures and tables read the file rather than the database, so this is the
 * only source they are allowed to cite; a stale file is the author's problem to
 * rerun `paper results`, and the guide below says which hash it was built at.
 */
export async function readPaperResults(root: string): Promise<PaperResultsExport | null> {
  try {
    const stored = JSON.parse(
      await readFile(join(root, PAPER_RESULTS_FILE), 'utf8'),
    ) as PaperResultsExport;
    return stored && Array.isArray(stored.rows) ? stored : null;
  } catch {
    return null;
  }
}

/** Write the export and return it, so callers can report rows and the path. */
export async function exportPaperResults(
  root: string,
  entries: { spec: SpecSource; result: ResultSource | null }[],
  now = Date.now(),
  opts: { includeAblations?: boolean } = {},
): Promise<{ export: PaperResultsExport; path: string }> {
  const built = buildPaperResults(entries, now, {
    excludeAblations: opts.includeAblations !== true,
  });
  const path = join(root, PAPER_RESULTS_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(built, null, 2)}\n`, 'utf8');
  return { export: built, path };
}

/**
 * The lines a model needs to write a script against this file: the path, the
 * metric identifiers available, and one example row. Short by design — the full
 * file is for the script to read at run time, not for the prompt to restate.
 */
export function describeResultsForPrompt(exported: PaperResultsExport): string {
  if (exported.rows.length === 0) {
    return '(no recorded results exported yet — figures must wait for experiments, they may not invent values)';
  }
  const identifiers = new Set<string>();
  for (const row of exported.rows) {
    for (const metric of row.metrics) identifiers.add(metric.identifier);
  }
  const byKind = { own: 0, baseline: 0, ablation: 0 };
  for (const row of exported.rows) byKind[row.sourceKind] += 1;
  const example = exported.rows.find((row) => row.metrics.length > 0) ?? exported.rows[0]!;
  return [
    `Recorded results file (READ THIS in scripts and tables; do not restate or invent numbers): ${
      exported.rowPath
    }`,
    `rows: ${exported.rows.length}; status values: ${[...new Set(exported.rows.map((row) => row.status))].join(', ')}`,
    `sourceKind of exported rows: own=${byKind.own}, baseline=${byKind.baseline}, ablation=${byKind.ablation}` +
      (exported.excludedAblations > 0
        ? `; ${exported.excludedAblations} ablation-control row(s) excluded — rerun: ideaseek paper results --include-ablations to plot controls`
        : ''),
    'sourceKind is mechanical provenance: ablation rows are controls and must NEVER be presented as competing methods; whether a baseline row is an established/published method is a separate agent judgment (baseline-adequacy), not something this file can assert.',
    `metric identifiers available: ${[...identifiers].join(', ') || '(none)'}`,
    `example row shape: {"specId":"${example.specId}","scale":"${example.scale}",` +
      `"status":"${example.status}","metrics":[{"name":…,"identifier":…,"value":…}],` +
      `"codeHash":…,"dataSnapshotId":…,"protocolId":…}`,
    'a plotting script must load this file and select rows by specId/scale/metric identifier;',
    'a figure whose script does not read the file it declares will be refused by the validator.',
  ].join('\n');
}
