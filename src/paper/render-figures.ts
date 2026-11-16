import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { sha256Of, sha256OfFile } from '../core/hash.js';
import { redactSecrets } from '../core/redact.js';
import { runProcess } from '../core/proc.js';
import { pythonBinary } from '../knowledge/pdf.js';

/**
 * Phase 7 figure pipeline: EXECUTES the plotting scripts persisted by
 * `paper figure` inside figures/, through the shared subprocess adapter
 * (timeout + tree-kill), with MPLBACKEND=Agg so nothing opens a window.
 *
 * Source-manifest coverage (PROGRESS Phase 7 图表 source manifest):
 * - inputs: carried in the figure plan (dataSources), bound via
 *   planInputHash;
 * - statistics definitions + caption: copied from the plan per figure;
 * - code version: sha256 of the executed script;
 * - outputs: every produced file hashed (path/bytes/sha256), a vector
 *   (pdf/svg) output required for success, PNG auto-derived via pdftoppm
 *   when the script did not write one;
 * - review status: starts `unreviewed`, flipped by `paper review-figure`.
 *
 * Honest status: rendered (every figure produced a vector output) |
 * partial | failed — a script that exits 0 without writing anything is a
 * failure, never a silent pass.
 */

export const FIGURE_RENDER_SCHEMA = 'figure-render-v1';

export type FigureReviewStatus = 'unreviewed' | 'approved' | 'rejected';

export interface RenderedOutput {
  path: string;
  bytes: number;
  sha256: string;
}

export interface FigureReview {
  status: FigureReviewStatus;
  note: string | null;
  at: number | null;
  history: { status: FigureReviewStatus; note: string | null; at: number }[];
}

export interface FigureRenderResult {
  id: string;
  ok: boolean;
  outputs: RenderedOutput[];
  /** Extensions actually on disk (e.g. ['pdf','png']). */
  formats: string[];
  /** Source-manifest fields copied from the figure plan. */
  caption: string;
  statistics: string[];
  /** sha256 of the executed script (code-version manifest field). */
  scriptSha256: string;
  /**
   * Declared outputs whose bytes did not change this run. Reported so an
   * idempotent re-render reads as "unchanged" instead of "nothing happened".
   */
  unchanged?: string[];
  review: FigureReview;
  error: string | null;
  durationMs: number;
}

export interface FigureRenderReport {
  status: 'rendered' | 'partial' | 'failed';
  figures: FigureRenderResult[];
  python: string;
  skill: { name: string; sha256: string };
  planInputHash: string;
  renderedAt: number;
}

interface StoredFigurePlan {
  contract: string;
  inputHash: string;
  skill: { name: string; sha256: string };
  figures: {
    figures: {
      id: string;
      script: string;
      caption?: string;
      statistics?: string[];
    }[];
  };
}

async function readFigurePlan(root: string): Promise<StoredFigurePlan> {
  let stored: StoredFigurePlan;
  try {
    stored = JSON.parse(
      await readFile(join(root, 'reports', 'paper', 'figures-plan.json'), 'utf8'),
    ) as StoredFigurePlan;
  } catch {
    throw new IdeaseekError(
      'USER_INPUT_REQUIRED',
      'no figure plan found — run: ideaseek paper figure (then paper render-figures)',
    );
  }
  if (stored.contract !== 'paper-figure-v1' || !stored.figures?.figures) {
    throw new IdeaseekError(
      'INVALID_ARTIFACT',
      'reports/paper/figures-plan.json is not a paper-figure-v1 artifact — rerun: ideaseek paper figure',
    );
  }
  return stored;
}

/**
 * File paths the script declares it will save.
 *
 * Read off `savefig(...)` / `write_image(...)` string arguments, which the
 * authoring validator already requires — so this is the platform holding the
 * plan to what the plan promised, not guessing from a directory listing.
 * Non-literal arguments (f-strings, variables) are skipped rather than
 * guessed at; those figures are still judged by "did it save anything".
 */
export function parseSaveTargets(script: string): string[] {
  const targets = new Set<string>();
  for (const match of script.matchAll(/(?:savefig|write_image)\s*\(\s*['"]([^'"]+)['"]/g)) {
    const raw = (match[1] ?? '').trim();
    if (raw && !raw.includes('\n')) targets.add(raw);
  }
  return [...targets];
}

async function listFigureFiles(dir: string): Promise<Set<string>> {
  try {
    return new Set(await readdir(dir));
  } catch {
    return new Set();
  }
}

function formatsOf(outputs: RenderedOutput[]): string[] {
  const exts = new Set<string>();
  for (const output of outputs) {
    const match = output.path.match(/\.([a-z0-9]+)$/i);
    if (match) exts.add(match[1]!.toLowerCase());
  }
  return [...exts].sort();
}

/**
 * Ensures a PNG exists next to the vector output: uses the script's own
 * png when present, otherwise derives one with pdftoppm (texlive ships it;
 * absence degrades to vector-only formats, never a crash).
 */
async function ensurePng(
  figuresDir: string,
  id: string,
  outputs: RenderedOutput[],
  seen: Set<string>,
): Promise<void> {
  if (outputs.some((output) => output.path.endsWith('.png'))) return;
  const vector = outputs.find((output) => output.path.endsWith('.pdf'));
  if (!vector) return;
  const pdfName = vector.path.split('/').pop()!;
  const prefix = join(figuresDir, `${id}-conv`);
  try {
    const result = await runProcess(
      'pdftoppm',
      ['-png', '-r', '144', join(figuresDir, pdfName), prefix],
      { cwd: figuresDir, timeoutMs: 60_000, env: process.env },
    );
    if (result.timedOut || result.code !== 0) return;
    const files = (await readdir(figuresDir)).filter(
      (name) => name.startsWith(`${id}-conv`) && name.endsWith('.png'),
    );
    if (files.length === 0) return;
    files.sort();
    const target = `${id}.png`;
    await rename(join(figuresDir, files[0]!), join(figuresDir, target));
    for (const extra of files.slice(1)) {
      await rm(join(figuresDir, extra), { force: true });
    }
    const abs = join(figuresDir, target);
    const info = await import('node:fs/promises').then((fs) => fs.stat(abs));
    seen.add(target);
    outputs.push({
      path: `figures/${target}`,
      bytes: info.size,
      sha256: await sha256OfFile(abs),
    });
  } catch {
    // pdftoppm not installed → formats stay vector-only (reported honestly)
  }
}

export interface RenderOptions {
  /** Per-figure execution bound (tree-killed on timeout). */
  timeoutMs?: number;
  now?: number;
}

export async function renderFigures(
  root: string,
  skillMeta: { name: string; sha256: string },
  opts: RenderOptions = {},
): Promise<{ report: FigureRenderReport; figuresDir: string }> {
  const plan = await readFigurePlan(root);
  const figuresDir = join(root, 'figures');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(figuresDir, { recursive: true });

  const python = await pythonBinary();
  const initial = await listFigureFiles(figuresDir);
  const seenOutputs = new Set<string>(initial);

  const results: FigureRenderResult[] = [];
  const specs = plan.figures.figures.slice(0, 50); // hard bound
  for (const spec of specs) {
    const scriptPath = join(figuresDir, `${spec.id}.py`);
    await writeFile(scriptPath, spec.script, 'utf8');
    const scriptSha256 = sha256Of(spec.script);
    const started = Date.now();
    // What the script says it will write, and what those files contain right
    // now. Output was previously judged by "names not already in figures/ when
    // this command started", which made a re-render of an unchanged plan
    // impossible: every file already existed, so every figure reported
    // `script exited 0 but produced no new files` — a failure that looked like
    // a broken script and was really the platform refusing its own idempotent
    // path. Declared targets plus content digests distinguish the three cases
    // that directory diffing conflated: newly written, unchanged, and never
    // written (the last one is still a failure).
    const declaredTargets = parseSaveTargets(spec.script).map((target) => ({
      name: target.includes('/') ? target.split('/').pop()! : target,
      path: join(figuresDir, target),
      relative: target.includes('/') ? target : `figures/${target}`,
    }));
    const digestsBefore = new Map<string, string>();
    for (const target of declaredTargets) {
      const digest = await sha256OfFile(target.path).catch(() => null);
      if (digest) digestsBefore.set(target.relative, digest);
    }
    const env = { ...process.env, MPLBACKEND: 'Agg' };
    let outcome: Awaited<ReturnType<typeof runProcess>>;
    try {
      outcome = await runProcess(python, [scriptPath], {
        cwd: figuresDir,
        timeoutMs: opts.timeoutMs ?? 120_000,
        env,
      });
    } catch (error) {
      results.push({
        id: spec.id,
        ok: false,
        outputs: [],
        formats: [],
        caption: spec.caption ?? '',
        statistics: spec.statistics ?? [],
        scriptSha256,
        review: { status: 'unreviewed', note: null, at: null, history: [] },
        error: `python could not be started: ${(error as Error).message}`,
        durationMs: Date.now() - started,
      });
      continue;
    }

    const current = await listFigureFiles(figuresDir);
    const outputs: RenderedOutput[] = [];
    for (const name of current) {
      if (seenOutputs.has(name) || name.endsWith('.py')) continue;
      seenOutputs.add(name);
      const abs = join(figuresDir, name);
      const info = await import('node:fs/promises').then((fs) => fs.stat(abs));
      outputs.push({
        path: `figures/${name}`,
        bytes: info.size,
        sha256: await sha256OfFile(abs),
      });
    }

    const durationMs = Date.now() - started;
    const base = {
      caption: spec.caption ?? '',
      statistics: spec.statistics ?? [],
      scriptSha256,
      review: { status: 'unreviewed' as const, note: null, at: null, history: [] },
    };

    if (outcome.timedOut) {
      results.push({
        id: spec.id,
        ok: false,
        outputs,
        formats: formatsOf(outputs),
        ...base,
        error: `timed out after ${opts.timeoutMs ?? 120_000} ms (process tree killed)`,
        durationMs,
      });
      continue;
    }
    if (outcome.code !== 0) {
      results.push({
        id: spec.id,
        ok: false,
        outputs,
        formats: formatsOf(outputs),
        ...base,
        error: redactSecrets(
          `${outcome.stderr}\n${outcome.stdout}`.trim().slice(-2_000) || `exit ${outcome.code}`,
        ),
        durationMs,
      });
      continue;
    }

    // Success path: derive PNG when the script only wrote a vector.
    await ensurePng(figuresDir, spec.id, outputs, seenOutputs);
    const formats = formatsOf(outputs);
    const hasVector = formats.includes('pdf') || formats.includes('svg');
    // Declared targets decide the verdict: written-with-changed-bytes, written
    // but byte-identical (unchanged), or never written (failure). Judging by
    // "names not present when this command started" made a re-render of an
    // unchanged plan report `produced no new files` for every figure — a
    // failure that looked like a broken script and was really the platform
    // refusing its own idempotent path.
    const declaredMissing: string[] = [];
    const unchanged: string[] = [];
    for (const target of declaredTargets) {
      const info = await stat(target.path).catch(() => null);
      if (!info?.isFile()) {
        declaredMissing.push(target.relative);
        continue;
      }
      const digest = await sha256OfFile(target.path);
      const known = outputs.find((output) => output.path === target.relative);
      if (known) {
        known.sha256 = digest;
        known.bytes = info.size;
      } else {
        outputs.push({ path: target.relative, bytes: info.size, sha256: digest });
      }
      if (digestsBefore.get(target.relative) === digest) unchanged.push(target.relative);
    }
    if (outputs.length === 0 || (declaredTargets.length > 0 && declaredMissing.length > 0)) {
      const formatsAfter = formatsOf(outputs);
      results.push({
        id: spec.id,
        ok: false,
        outputs,
        formats: formatsAfter,
        ...base,
        error:
          declaredMissing.length > 0
            ? `script did not write its declared output(s): ${declaredMissing.join(', ')} — ` +
              'a savefig target that never appears on disk is not a figure'
            : 'script exited 0 without saving any figure file',
        durationMs,
      });
      continue;
    }
    if (!hasVector) {
      results.push({
        id: spec.id,
        ok: false,
        outputs,
        formats,
        ...base,
        error: 'script produced no vector output (pdf/svg) — publication figure missing',
        durationMs,
      });
      continue;
    }
    results.push({
      id: spec.id,
      ok: true,
      outputs,
      formats: formatsOf(outputs),
      ...base,
      unchanged,
      error: null,
      durationMs,
    });
  }

  const okCount = results.filter((result) => result.ok).length;
  let status: FigureRenderReport['status'] =
    results.length > 0 && okCount === results.length
      ? 'rendered'
      : okCount > 0
        ? 'partial'
        : 'failed';

  // Distinct figures must not be the same bytes. The first FDG render reported
  // `rendered 6/6` while all six PNGs shared one sha256 — a derivation step
  // that silently re-used one file, which no per-figure check can see, because
  // each figure individually "produced a vector and a raster output". Content
  // identity across figures is the only signal, and it is deterministic.
  const byDigest = new Map<string, string[]>();
  for (const result of results) {
    for (const output of result.outputs) {
      const key = `${output.sha256}:${output.path.toLowerCase().slice(-4)}`;
      byDigest.set(key, [...(byDigest.get(key) ?? []), result.id]);
    }
  }
  const duplicates = [...byDigest.entries()].filter(([, ids]) => ids.length > 1);
  if (duplicates.length > 0) {
    status = 'partial';
    for (const [, ids] of duplicates) {
      for (const id of ids) {
        const result = results.find((entry) => entry.id === id);
        if (result) {
          result.ok = false;
          result.error = `identical output bytes shared with ${ids.filter((other) => other !== id).join(', ')} — these are not distinct figures`;
        }
      }
    }
  }

  return {
    report: {
      status,
      figures: results,
      python,
      skill: skillMeta,
      planInputHash: plan.inputHash,
      renderedAt: opts.now ?? Date.now(),
    },
    figuresDir,
  };
}
