import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { IdeaseekError } from '../core/errors.js';
import { identicalValueGroupsOf } from './results-export.js';

/**
 * Convert SVG to PDF using Inkscape or rsvg-convert.
 * Returns the PDF path on success, null on failure.
 */
async function convertSvgToPdf(svgPath: string): Promise<string | null> {
  const pdfPath = svgPath.replace(/\.svg$/i, '.pdf');
  const binDir = process.platform === 'win32' ? 'C:\\Program Files\\Inkscape\\bin' : '';
  const inkscape = binDir ? `${binDir}\\inkscape.exe` : 'inkscape';
  const rsvg = 'rsvg-convert';

  try {
    // Try Inkscape first
    execSync(`"${inkscape}" --export-type=pdf --export-filename="${pdfPath}" "${svgPath}"`, {
      stdio: 'pipe',
      timeout: 30000,
    });
    // Verify the file was created
    const stat = await import('node:fs/promises').then((fs) => fs.stat(pdfPath));
    if (stat.size > 0) return pdfPath;
  } catch {
    // Inkscape failed, try rsvg-convert
  }

  try {
    execSync(`"${rsvg}" -f pdf -o "${pdfPath}" "${svgPath}"`, {
      stdio: 'pipe',
      timeout: 30000,
    });
    const stat = await import('node:fs/promises').then((fs) => fs.stat(pdfPath));
    if (stat.size > 0) return pdfPath;
  } catch {
    // Both converters failed
  }

  return null;
}

/**
 * Deterministic placement of figures the platform has already PROVEN exist.
 *
 * The chain had a hole at its last step: `paper figure` plans figures,
 * `render-figures`/`paper diagram` produce bytes and hash them, and `paper
 * compile` cross-checks the manuscript against the plan. On the real project
 * that cross-check was the only thing standing between a figure-less PDF and a
 * "success" report — and the sole remedy it offered was another model turn
 * (`paper write`), which is exactly the step that had already produced zero
 * `\includegraphics` once. A verified artifact with no deterministic route into
 * the document is a dead end wearing an escape hatch.
 *
 * So placement reads the render records and inserts the floats itself. Two
 * rules keep it honest:
 *
 * 1. Only artifacts that a record vouches for AND that are still on disk with
 *    non-zero size get inserted. A stale report naming a deleted figure would
 *    otherwise become a LaTeX "file not found" three layers away from its
 *    cause — the same shape as the compile-side "Undefined control sequence"
 *    that a stored-but-dirty manuscript used to produce.
 * 2. Nothing is removed or reordered. A figure the manuscript already places is
 *    left alone, so running this twice converges instead of stacking duplicates.
 */

export interface PlacedFigure {
  id: string;
  /** What was written inside `\includegraphics{…}`, project-relative. */
  includePath: string;
  caption: string;
  action: 'inserted' | 'already' | 'skipped';
  reason: string | null;
}

export interface PlacementResult {
  inserted: number;
  already: number;
  skipped: number;
  figures: PlacedFigure[];
  /** The deterministic results table, placed in the same pass. */
  table: TablePlacement;
  mainTexPath: string;
}

interface Candidate {
  id: string;
  /** Absolute path of the verified bytes. */
  absPath: string;
  captionHint: string;
}

/** LaTeX-writing chars that appear in real metric names; macros are left alone. */
export function escapeCaption(text: string): string {
  return text.replace(/([&#%_])/g, '\\$1');
}

export function slugOf(id: string): string {
  const slug = id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'fig';
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Vector formats first: a PDF/SVG include is what a paper should carry. */
function pickVector(paths: string[]): string {
  for (const extension of ['.pdf', '.svg']) {
    const hit = paths.find((path) => path.toLowerCase().endsWith(extension));
    if (hit) return hit;
  }
  return paths[0]!;
}

/** Formats graphicx can include without a converter, for either engine. */
const INCLUDABLE = new Set(['.pdf', '.png', '.jpg', '.jpeg']);

async function candidatesFromRecords(root: string): Promise<Candidate[]> {
  const figuresDir = join(root, 'figures');
  const out: Candidate[] = [];

  const plan = await readJson(join(root, 'reports', 'paper', 'figures-plan.json'));
  const captions = new Map<string, string>();
  for (const figure of (plan?.figures as { figures?: Record<string, unknown>[] } | undefined)
    ?.figures ?? []) {
    const id = String(figure?.id ?? '').trim();
    const caption = String(figure?.caption ?? '').trim();
    if (id && caption) captions.set(id, caption);
  }

  // 1) Script-rendered figures: only the ones the render report marked ok.
  const render = await readJson(join(root, 'reports', 'paper', 'figure-render.json'));
  for (const figure of (render?.figures as Record<string, unknown>[] | undefined) ?? []) {
    if (figure?.ok !== true) continue;
    const id = String(figure.id ?? '').trim();
    const outputs = ((figure.outputs as { path?: unknown }[] | undefined) ?? [])
      .map((entry) => String(entry?.path ?? ''))
      .filter((path) => path.length > 0);
    if (!id || outputs.length === 0) continue;
    const chosen = pickVector(outputs);
    out.push({
      id,
      absPath: isAbsolute(chosen) ? chosen : resolve(root, chosen),
      captionHint: captions.get(id) ?? id,
    });
  }

  // 2) Deterministic FigureSpec renders (no plotting library involved).
  const diagram = await readJson(join(root, 'reports', 'paper', 'diagram-render.json'));
  for (const entry of (diagram?.renders as Record<string, unknown>[] | undefined) ?? []) {
    const abs = String(entry?.outputPath ?? '');
    if (!abs) continue;
    const stem = basename(abs).replace(/\.[a-z]+$/i, '');
    // The caption goes into the manuscript, so it is paper text: fall back to
    // an English description rather than a platform-flavoured label, and prefer
    // whatever the spec itself declares as its figure label.
    let caption = `Diagram: ${stem}`;
    const spec = await readJson(String(entry?.specPath ?? ''));
    const firstLabel = (spec?.labels as { text?: unknown }[] | undefined)?.[0]?.text;
    if (typeof firstLabel === 'string' && firstLabel.trim()) caption = firstLabel.trim();
    out.push({
      id: stem,
      absPath: isAbsolute(abs) ? abs : resolve(root, abs),
      captionHint: caption,
    });
  }

  // Same id twice (script + diagram) must not become two floats.
  const byPath = new Map<string, Candidate>();
  for (const candidate of out) {
    const key = relative(figuresDir, candidate.absPath) || candidate.absPath;
    if (!byPath.has(key)) byPath.set(key, candidate);
  }
  return [...byPath.values()];
}

function figureFloat(includePath: string, caption: string, id: string): string {
  // Spaces in a graphic name are legal on disk but fragile in LaTeX argument
  // parsing, so the basename is brace-wrapped when one occurs.
  const spaced = basename(includePath).includes(' ');
  const target = spaced
    ? `${includePath.slice(0, includePath.lastIndexOf('/') + 1)}{${basename(includePath)}}`
    : includePath;
  return (
    `\n% IdeaSeek: verified figure placed deterministically (paper compile --place-figures)\n` +
    `\\begin{figure}[t]\\centering\n` +
    `\\includegraphics[width=0.9\\linewidth]{${target}}\n` +
    `\\caption{${escapeCaption(caption)}}\\label{fig:${slugOf(id)}}\n` +
    `\\end{figure}\n`
  );
}

/**
 * The deterministic results table.
 *
 * A figure needs a plotting library; a table of recorded numbers needs neither,
 * and on this machine that difference decides whether real evidence reaches the
 * compiled PDF at all (ambient matplotlib cannot import against numpy 2, and no
 * SVG→PDF converter is installed — Windows `convert` is the disk utility). The
 * rows come from `paper results`, which is itself exported from stored
 * RunResults, so every cell traces to a run rather than to a model's memory.
 *
 * Two honesty rules: only `succeeded` rows are shown, and a value is printed in
 * the unit it was STORED in — the caption says so, because silently rescaling
 * fractions to percent is how a table starts disagreeing with the protocol.
 */
export interface TablePlacement {
  action: 'inserted' | 'already' | 'skipped';
  reason: string | null;
  columns: string[];
  rowCount: number;
}

const TABLE_MARKER = '% IdeaSeek: results table (deterministic, from reports/paper/results.json)';

function formatValue(value: number): string {
  return Number(value.toPrecision(4)).toString();
}

async function placeResultsTableBody(
  root: string,
  insert: (body: string) => boolean,
): Promise<TablePlacement> {
  const skipped = (reason: string): TablePlacement => ({
    action: 'skipped',
    reason,
    columns: [],
    rowCount: 0,
  });

  const mainTex = await readFile(join(root, 'paper', 'main.tex'), 'utf8').catch(() => '');
  if (mainTex.includes(TABLE_MARKER)) {
    return { action: 'already', reason: null, columns: [], rowCount: 0 };
  }
  const results = await readJson(join(root, 'reports', 'paper', 'results.json'));
  const rows = ((results?.rows as Record<string, unknown>[] | undefined) ?? []).filter(
    (row) => row?.status === 'succeeded',
  );
  if (rows.length === 0) {
    return skipped(
      'reports/paper/results.json has no succeeded rows — run: ideaseek paper results (after experiments)',
    );
  }

  const coverage = new Map<string, number>();
  for (const row of rows) {
    for (const metric of (row?.metrics as Record<string, unknown>[] | undefined) ?? []) {
      const name = String(metric?.name ?? '').trim();
      if (name) coverage.set(name, (coverage.get(name) ?? 0) + 1);
    }
  }
  const columns = [...coverage.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([name]) => name);

  // Keyed by specId, which identifies ONE run. Keying by ideaId would let an
  // ablation row stand in for its parent (they share an idea), and `paper
  // results` sorts rows by specId — so "last wins" would silently elect the
  // alphabetically last ablation as the idea's headline number.
  const entries: { label: string; scale: string; values: Map<string, number> }[] = [];
  for (const row of rows) {
    const label = String(row?.specId ?? '').trim();
    if (!label) continue;
    const values = new Map<string, number>();
    for (const metric of (row?.metrics as Record<string, unknown>[] | undefined) ?? []) {
      const name = String(metric?.name ?? '').trim();
      if (name && typeof metric?.value === 'number') values.set(name, metric.value);
    }
    entries.push({ label, scale: String(row?.scale ?? ''), values });
  }
  const maxRows = 14;
  const shown = entries.slice(0, maxRows);

  const body = shown
    .map(
      (entry) =>
        `    ${escapeCaption(entry.label)} & ${escapeCaption(entry.scale || '-')} & ` +
        `${columns
          .map((column) => {
            const v = entry.values.get(column);
            return v === undefined ? 'n/a' : formatValue(v);
          })
          .join(' & ')} \\\\`,
    )
    .join('\n');

  // Computed from the rows rather than read from the file's own field: a
  // results.json written before that field existed must still carry the caveat,
  // and `identicalValueGroupsOf` keeps the rule in one place for both.
  const identical = identicalValueGroupsOf(
    ((results?.rows as Record<string, unknown>[] | undefined) ?? []).map((row) => ({
      specId: String(row?.specId ?? ''),
      status: String(row?.status ?? ''),
      metrics: ((row?.metrics as Record<string, unknown>[] | undefined) ?? []).map((metric) => ({
        name: String(metric?.name ?? ''),
        value: Number(metric?.value ?? 0),
      })),
    })),
  );
  const caveat =
    identical.length > 0
      ? ` Note: ${identical.length} group(s) of these runs report identical values for every ` +
        `metric, so those rows do not distinguish their changes.`
      : '';

  const table =
    `\n${TABLE_MARKER}\n` +
    `\\begin{table}[t]\\centering\\small\n` +
    `\\caption{Recorded experiment results, exported by the platform from stored runs. ` +
    `Values appear in the unit each run stored them in; the locked protocol declares the ` +
    `unit basis per metric.${caveat}}\\label{tab:ideaseek-results}\n` +
    `\\begin{tabular}{@{}ll${'r'.repeat(columns.length)}@{}}\n` +
    `\\hline\n` +
    `    Run & Scale & ${columns.map(escapeCaption).join(' & ')} \\\\\n` +
    `\\hline\n` +
    `${body}\n` +
    `\\hline\n` +
    `\\end{tabular}\n` +
    `\\end{table}\n`;

  if (!insert(table)) {
    return skipped('main.tex has no \\end{document}, so it is not a complete LaTeX document');
  }
  return {
    action: 'inserted',
    reason:
      entries.length > shown.length
        ? `table shows the first ${shown.length} of ${entries.length} succeeded runs`
        : null,
    columns,
    rowCount: shown.length,
  };
}

/**
 * Insert every verified, still-present figure that main.tex does not already
 * place. Returns what it did, per figure, so the caller can report the skipped
 * ones instead of silently compiling around them.
 */
export async function placeVerifiedFigures(root: string): Promise<PlacementResult> {
  const mainTexPath = join(root, 'paper', 'main.tex');
  let mainTex: string;
  try {
    mainTex = await readFile(mainTexPath, 'utf8');
  } catch {
    throw new IdeaseekError(
      'INVALID_ARTIFACT',
      `no assembled main.tex at ${mainTexPath} — assemble first (ideaseek paper compile)`,
    );
  }
  const figuresDir = join(root, 'figures');
  const results: PlacedFigure[] = [];

  for (const candidate of await candidatesFromRecords(root)) {
    const between = relative(figuresDir, candidate.absPath).split('\\').join('/');
    let includePath = between.startsWith('..') ? null : `../figures/${between}`;
    if (includePath === null) {
      results.push({
        id: candidate.id,
        includePath: candidate.absPath,
        caption: candidate.captionHint,
        action: 'skipped',
        reason: 'the verified bytes sit outside figures/, so no \\includegraphics can name them',
      });
      continue;
    }
    // Brace-insensitive comparison: the inserted form wraps a spaced basename
    // (`figures/{Fig 1.pdf}`), and matching only the plain path would let a
    // second run stack a duplicate float for the same figure.
    const flatten = (value: string): string => value.replace(/[{}]/g, '').replace(/\.[a-z]+$/i, '');
    if (flatten(mainTex).includes(flatten(includePath))) {
      results.push({
        id: candidate.id,
        includePath,
        caption: candidate.captionHint,
        action: 'already',
        reason: null,
      });
      continue;
    }
    let size: number;
    try {
      size = (await stat(candidate.absPath)).size;
    } catch {
      size = 0;
    }
    if (size === 0) {
      // Existence is checked BEFORE the format gate: telling the user to install
      // a converter for a file that is not there sends them to fix the wrong
      // thing, and the record (not the disk) is what is stale.
      results.push({
        id: candidate.id,
        includePath,
        caption: candidate.captionHint,
        action: 'skipped',
        reason: 'a record vouches for this figure but the file is gone or empty',
      });
      continue;
    }
    const extension = (includePath.match(/\.[a-z]+$/i)?.[0] ?? '').toLowerCase();
    if (!INCLUDABLE.has(extension)) {
      // graphicx includes PDF/PNG/JPG under pdflatex and xelatex; SVG needs a
      // converter. Try Inkscape first (most reliable on Windows), then
      // rsvg-convert. If neither works, skip with a clear install instruction.
      if (extension === '.svg') {
        const converted = await convertSvgToPdf(candidate.absPath);
        if (converted) {
          // Replace the SVG path with the converted PDF path
          includePath = includePath.replace(/\.svg$/i, '.pdf');
          // Update the candidate to point to the converted file
          candidate.absPath = converted;
        } else {
          results.push({
            id: candidate.id,
            includePath,
            caption: candidate.captionHint,
            action: 'skipped',
            reason:
              'SVG cannot be converted to PDF — install Inkscape (https://inkscape.org/) ' +
              'or rsvg-convert, then re-run: ideaseek paper compile --place-figures',
          });
          continue;
        }
      } else {
        results.push({
          id: candidate.id,
          includePath,
          caption: candidate.captionHint,
          action: 'skipped',
          reason:
            `${extension || 'no extension'} cannot be included by pdflatex/xelatex graphicx — ` +
            'export the figure as PDF/PNG instead',
        });
        continue;
      }
    }
    const marker = '\\end{document}';
    const at = mainTex.lastIndexOf(marker);
    if (at === -1) {
      results.push({
        id: candidate.id,
        includePath,
        caption: candidate.captionHint,
        action: 'skipped',
        reason: 'main.tex has no \\end{document}, so it is not a complete LaTeX document',
      });
      continue;
    }
    mainTex =
      mainTex.slice(0, at) +
      figureFloat(includePath, candidate.captionHint, candidate.id) +
      '\n' +
      mainTex.slice(at);
    results.push({
      id: candidate.id,
      includePath,
      caption: candidate.captionHint,
      action: 'inserted',
      reason: null,
    });
  }

  const table = await placeResultsTableBody(root, (body) => {
    const at = mainTex.lastIndexOf('\\end{document}');
    if (at === -1) return false;
    mainTex = mainTex.slice(0, at) + body + '\n' + mainTex.slice(at);
    return true;
  });

  const changed =
    results.some((figure) => figure.action === 'inserted') || table.action === 'inserted';
  if (changed) await writeFile(mainTexPath, mainTex, 'utf8');

  return {
    inserted: results.filter((figure) => figure.action === 'inserted').length,
    already: results.filter((figure) => figure.action === 'already').length,
    skipped: results.filter((figure) => figure.action === 'skipped').length,
    figures: results,
    table,
    mainTexPath,
  };
}
