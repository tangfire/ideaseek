import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
  /**
   * Project-relative path of the bytes — `figures/<name>` whenever the file is
   * inside the figures tree, and the script's own string when it is not (see
   * `canonicalOutputPath`).
   */
  path: string;
  bytes: number;
  sha256: string;
  /** The script's declared target, recorded only when it differs from `path`. */
  declared?: string;
  /**
   * Set when this output can never satisfy `\includegraphics{figures/…}`: the
   * reason says so, so a compile blocker quotes it instead of inventing one.
   */
  unmatchable?: string;
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

/** Platform paths use forward slashes; scripts on Windows may not. */
function toPosix(path: string): string {
  return path.split('\\').join('/');
}

/**
 * The one basis on which a rendered file is recorded: where its bytes actually
 * are, project-relative.
 *
 * WHY. The scan loop records `figures/<name>` (its names come from listing the
 * figures directory) while declared targets used to be recorded from the
 * script's own `savefig` string — a path relative to the script's working
 * directory, which IS `figures/`. So `savefig("plots/x.pdf")` was recorded as
 * `plots/x.pdf` for a file sitting at `figures/plots/x.pdf`, and `paper
 * compile` compares those strings against `\includegraphics{figures/…}`. Every
 * figure saved into a subdirectory, or by absolute path, could therefore never
 * be approved: compile blocked and blamed the renderer for a mismatch the
 * platform itself created by mixing two bases.
 *
 * Kept honest:
 * - inside the figures tree → one canonical `figures/…` path; `declared` is
 *   recorded only when the script's string differs (it differs for the
 *   double-nested `savefig("figures/x.pdf")`, which lands at
 *   `figures/figures/x.pdf`), so a blocker can quote both instead of guessing;
 * - outside it (absolute, or escaping with `../`) → the declared string stays
 *   the recorded path, because inventing a `figures/…` name would advertise a
 *   file that does not exist, and `unmatchable` states in the artifact itself
 *   that no `\includegraphics{figures/…}` can ever refer to these bytes.
 */
export function canonicalOutputPath(
  target: string,
  figuresDir: string,
  figuresRel: string,
): { path: string; abs: string; declared: string | null; unmatchable: string | null } {
  const normalized = toPosix(target);
  const abs = isAbsolute(normalized)
    ? resolve(normalized)
    : resolve(figuresDir, normalized.replace(/^\/+/, ''));
  const between = toPosix(relative(figuresDir, abs));
  const escapes =
    between === '' || between === '..' || between.startsWith('../') || isAbsolute(between);
  if (escapes) {
    const rooted = normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized);
    return {
      path: normalized,
      abs,
      declared: null,
      unmatchable:
        `recorded at ${normalized}, ${rooted ? 'an absolute' : 'a'} path outside the figures tree; ` +
        'the manuscript includes files under figures/, so no \\includegraphics can name this file',
    };
  }
  const path = `${figuresRel}/${between}`;
  // A bare `savefig("x.pdf")` and the canonical `figures/x.pdf` are the same
  // statement, so recording `declared` there would be noise: it is kept only
  // when the script's string carries a directory of its own, which is exactly
  // when the two paths differ for a reason a reader has to see.
  const differs = path !== normalized && normalized.includes('/');
  return { path, abs, declared: differs ? normalized : null, unmatchable: null };
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
 *
 * The source is located through the recorded path rather than by gluing the
 * file name onto the figures root, so a figure saved into `figures/sub/` can
 * still get its raster; the derived PNG is recorded on the same basis as every
 * other output (see `canonicalOutputPath`).
 */
async function ensurePng(
  figuresDir: string,
  figuresRel: string,
  id: string,
  outputs: RenderedOutput[],
  seen: Set<string>,
): Promise<void> {
  if (outputs.some((output) => output.path.endsWith('.png'))) return;
  const vector = outputs.find((output) => output.path.endsWith('.pdf'));
  if (!vector) return;
  const vectorRel = vector.path.startsWith(`${figuresRel}/`)
    ? vector.path.slice(figuresRel.length + 1)
    : (vector.path.split('/').pop() ?? '');
  if (!vectorRel || vectorRel.includes('\\')) return;
  const vectorAbs = join(figuresDir, ...vectorRel.split('/'));
  const dir = dirname(vectorAbs);
  const prefix = join(dir, `${id}-conv`);
  try {
    const result = await runProcess('pdftoppm', ['-png', '-r', '144', vectorAbs, prefix], {
      cwd: figuresDir,
      timeoutMs: 60_000,
      env: process.env,
    });
    if (result.timedOut || result.code !== 0) return;
    const files = (await readdir(dir)).filter(
      (name) => name.startsWith(`${id}-conv`) && name.endsWith('.png'),
    );
    if (files.length === 0) return;
    files.sort();
    const target = `${id}.png`;
    await rename(join(dir, files[0]!), join(dir, target));
    for (const extra of files.slice(1)) {
      await rm(join(dir, extra), { force: true });
    }
    const abs = join(dir, target);
    const info = await stat(abs);
    seen.add(target);
    outputs.push({
      path: `${figuresRel}/${toPosix(relative(figuresDir, abs))}`,
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
  // The prefix every recorded output path starts with. Derived from the two
  // directories rather than hardcoded, so the basis `paper compile` matches
  // `\includegraphics{figures/…}` against is the same string the layout makes.
  const figuresRel = toPosix(relative(root, figuresDir)) || 'figures';
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
    const declaredTargets = parseSaveTargets(spec.script).map((target) =>
      canonicalOutputPath(target, figuresDir, figuresRel),
    );
    const digestsBefore = new Map<string, string>();
    for (const target of declaredTargets) {
      const digest = await sha256OfFile(target.abs).catch(() => null);
      if (digest) digestsBefore.set(target.path, digest);
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
    const unreadable: string[] = [];
    for (const name of current) {
      if (seenOutputs.has(name) || name.endsWith('.py')) continue;
      seenOutputs.add(name);
      const abs = join(figuresDir, name);
      // A directory in this listing is not an output. `savefig("sub/x.pdf")`
      // creates one, and hashing the name as if it were a file used to throw
      // EISDIR out of `sha256OfFile` — killing the whole run for the figure
      // that legitimately wrote into a subdirectory.
      const info = await stat(abs).catch(() => null);
      if (!info?.isFile()) continue;
      const digest = await sha256OfFile(abs).catch(() => null);
      if (!digest) {
        unreadable.push(`${figuresRel}/${name}`);
        continue;
      }
      outputs.push({ path: `${figuresRel}/${name}`, bytes: info.size, sha256: digest });
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

    // Declared targets decide the verdict: written-with-changed-bytes, written
    // but byte-identical (unchanged), or never written (failure). Judging by
    // "names not present when this command started" made a re-render of an
    // unchanged plan report `produced no new files` for every figure — a
    // failure that looked like a broken script and was really the platform
    // refusing its own idempotent path.
    const declaredMissing: { where: string; why: string }[] = [];
    const unchanged: string[] = [];
    for (const target of declaredTargets) {
      const original = target.declared ?? target.path;
      const info = await stat(target.abs).catch(() => null);
      if (!info?.isFile()) {
        // Say WHERE the platform looked, and why that location is where the
        // script's own string points: the run's cwd is figures/, so a target
        // that already begins with `figures/` lands one level deeper than the
        // name suggests. Attributing that to "the script did not write" with no
        // further word sends the researcher to the wrong file.
        declaredMissing.push({
          where: target.path,
          why:
            target.declared && target.declared.startsWith(`${figuresRel}/`)
              ? `savefig(${JSON.stringify(original)}) is resolved against the script's working ` +
                `directory, which is already ${figuresRel}/ — the file therefore belongs at ` +
                `${target.path}, where nothing was written`
              : `nothing was written at ${target.path} for savefig(${JSON.stringify(original)})`,
        });
        continue;
      }
      const digest = await sha256OfFile(target.abs).catch(() => null);
      if (!digest) {
        unreadable.push(target.path);
        continue;
      }
      const known = outputs.find((output) => output.path === target.path);
      if (known) {
        known.sha256 = digest;
        known.bytes = info.size;
        if (target.unmatchable) known.unmatchable = target.unmatchable;
        if (target.declared) known.declared = target.declared;
      } else {
        outputs.push({
          path: target.path,
          bytes: info.size,
          sha256: digest,
          ...(target.declared ? { declared: target.declared } : {}),
          ...(target.unmatchable ? { unmatchable: target.unmatchable } : {}),
        });
      }
      if (digestsBefore.get(target.path) === digest) unchanged.push(target.path);
    }
    if (outputs.length === 0 || declaredMissing.length > 0) {
      const formatsAfter = formatsOf(outputs);
      const reason =
        declaredMissing.length > 0
          ? `script did not write its declared output(s): ${declaredMissing
              .map((entry) => `${entry.where} (${entry.why})`)
              .join('; ')} — a savefig target that never appears on disk is not a figure`
          : unreadable.length > 0
            ? `declared output(s) exist but could not be read: ${unreadable.join(', ')} — ` +
              'this is a filesystem permission problem, not a broken script'
            : 'script exited 0 without saving any figure file';
      results.push({
        id: spec.id,
        ok: false,
        outputs,
        formats: formatsAfter,
        ...base,
        error: reason,
        durationMs,
      });
      continue;
    }
    if (unreadable.length > 0) {
      // Some outputs were hashed, so the figure rendered — but silently
      // dropping a declared file that could not be read would report success
      // over an incomplete trail.
      results.push({
        id: spec.id,
        ok: false,
        outputs,
        formats: formatsOf(outputs),
        ...base,
        error:
          `these files were written but could not be read, so they are missing from the digest ` +
          `trail: ${unreadable.join(', ')} — a filesystem permission problem, not a broken script`,
        durationMs,
      });
      continue;
    }
    // Only now, with the declared outputs recorded, can the raster be derived
    // and the formats judged: formats were computed before this loop, so a
    // figure whose vector was written into a subdirectory — and therefore
    // appears only in the declared records — was reported as having "no vector
    // output", the platform calling a file it had just hashed a missing figure.
    await ensurePng(figuresDir, figuresRel, spec.id, outputs, seenOutputs);
    const formats = formatsOf(outputs);
    const hasVector = formats.includes('pdf') || formats.includes('svg');
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
