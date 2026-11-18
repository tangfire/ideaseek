import { copyFile, readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { arisSkillsRoot } from '../aris/skill.js';
import { IdeaseekError } from '../core/errors.js';
import { redactSecrets } from '../core/redact.js';
import { ensureDir } from '../core/atomic.js';
import { runProcess } from '../core/proc.js';
import type { PlacementResult } from './place-figures.js';
import type { Manuscript } from './write.js';

/**
 * paper-compile capability (Phase 4.5C, skill integration): implements the
 * vendored ARIS paper-compile workflow as deterministic platform code —
 * assemble the stored manuscript into a LaTeX project using the vendored
 * venue template, run latexmk through the shared subprocess adapter, and
 * report honestly (compiled / failed with log tail / blocked with a
 * concrete next step). The model-assisted error-fix loop (skill Steps 3-4)
 * is NOT claimed here: failures surface the log for the next round.
 *
 * Provenance: the report records the paper-compile skill hash and the
 * manuscript inputHash it built from (locked-plan content).
 */

export const PAPER_COMPILE_SCHEMA = 'paper-compile-v1';

export type CompileStatus = 'compiled' | 'failed' | 'blocked';

export interface CompileReport {
  status: CompileStatus;
  venue: string;
  template: string | null;
  engine: 'pdflatex';
  buildCommand: string[];
  attempts: number;
  exitCode: number | null;
  pdfPath: string | null;
  pageCount: number | null;
  /** Redacted tail of compile.log when the build fails. */
  logTail: string;
  /** Why status=blocked (missing template/style) — with the next step. */
  blockers: string[];
  skill: { name: string; sha256: string };
  manuscriptInputHash: string;
  compiledAt: number;
}

/** Venue → vendored template file (only what aris-skills actually ships). */
export const VENUE_TEMPLATES: Record<string, string> = {
  ICLR: 'iclr2026.tex',
  NeurIPS: 'neurips2025.tex',
  ICML: 'icml2025.tex',
  IEEE_CONF: 'ieee_conference.tex',
  IEEE_JOURNAL: 'ieee_journal.tex',
};

export interface StoredManuscriptDoc {
  contract: string;
  inputHash: string;
  skill: { name: string; sha256: string };
  manuscript: Manuscript;
}

export async function readManuscriptDoc(root: string): Promise<StoredManuscriptDoc> {
  let stored: StoredManuscriptDoc;
  try {
    stored = JSON.parse(
      await readFile(join(root, 'reports', 'paper', 'manuscript.json'), 'utf8'),
    ) as StoredManuscriptDoc;
  } catch {
    throw new IdeaseekError(
      'USER_INPUT_REQUIRED',
      'no manuscript found — run: ideaseek paper write (then paper compile)',
    );
  }
  if (stored.contract !== 'paper-write-v1' || !stored.manuscript) {
    throw new IdeaseekError(
      'INVALID_ARTIFACT',
      'reports/paper/manuscript.json is not a paper-write-v1 artifact — rerun: ideaseek paper write',
    );
  }
  return stored;
}

export function templatePathFor(venue: string): string | null {
  const file = VENUE_TEMPLATES[venue];
  if (!file) return null;
  return join(arisSkillsRoot(), 'skills', 'paper-write', 'templates', file);
}

/**
 * Assembles paper/main.tex + references.bib from the stored manuscript and
 * the venue template preamble. Deterministic and template-agnostic: the
 * template contributes its preamble (up to \\begin{document}) and
 * bibliographystyle; content comes from the manuscript.
 */
export async function assembleLaTeXProject(
  root: string,
  manuscript: Manuscript,
): Promise<{ mainPath: string; bibPath: string; template: string }> {
  const templateFile = VENUE_TEMPLATES[manuscript.venue] ?? null;
  const templateAbs = templateFile ? templatePathFor(manuscript.venue) : null;
  if (!templateFile || !templateAbs) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `no vendored template for venue ${manuscript.venue} — available: ${Object.keys(VENUE_TEMPLATES).join(', ')}`,
      { venue: manuscript.venue },
    );
  }
  let templateText: string;
  try {
    templateText = normalizeEscapedLayout(await readFile(templateAbs, 'utf8'));
  } catch {
    throw new IdeaseekError('FILE_NOT_FOUND', `vendored template missing: ${templateFile}`);
  }

  const docStart = templateText.indexOf('\\begin{document}');
  if (docStart < 0) {
    throw new IdeaseekError('PARSE_FAILED', `template ${templateFile} has no \\begin{document}`);
  }
  const preamble = templateText.slice(0, docStart).trimEnd();
  const styleMatch = templateText.match(/\\bibliographystyle\{([^}]+)\}/);
  const bibStyle = styleMatch ? styleMatch[1] : 'plain';

  const paperDir = join(root, 'paper');
  await mkdir(paperDir, { recursive: true });

  // Stage the style files the venue template declares, from the vendored ARIS
  // templates directory. This used to be a hardcoded pair (IEEEtran.cls/.bst)
  // guarded by `includes('IEEEtran')`, which is exactly the shape that breaks:
  // the ICLR template needs iclr2026_conference.sty, that file exists in the
  // upstream ARIS checkout, and nothing in IdeaSeek ever brought it along — so
  // every non-IEEE submission failed compile on a clean install while the
  // capability looked present. The dependency names come from the template
  // itself (`latexDependencyNames`), so a new venue works as soon as its style
  // file is vendored, with no rule to edit.
  const templateDir = join(arisSkillsRoot(), 'skills', 'paper-write', 'templates');
  const neededAssets = new Set<string>();
  for (const name of latexDependencyNames(templateText)) {
    for (const suffix of ['.sty', '.cls', '.bst', '.tex']) neededAssets.add(name + suffix);
  }
  for (const asset of neededAssets) {
    try {
      await writeFile(join(paperDir, asset), await readFile(join(templateDir, asset)));
    } catch {
      // Not vendored here: the preflight in compileManuscript names it, rather
      // than this loop swallowing the absence.
    }
  }

  const abstractStart = manuscript.abstract;
  const body = [
    '\\begin{document}',
    '',
    `\\title{${escapeLatex(manuscript.title)}}`,
    '\\maketitle',
    '',
    '\\begin{abstract}',
    escapeLatex(abstractStart),
    '\\end{abstract}',
    '',
    ...manuscript.sections.map((section) => normalizeEscapedLayout(section.latex).trim()),
    '',
    `\\bibliographystyle{${bibStyle}}`,
    '\\bibliography{references}',
    '',
    '\\end{document}',
  ].join('\n');

  const mainPath = join(paperDir, 'main.tex');
  await writeFile(mainPath, `${preamble}\n${body}\n`, 'utf8');

  const bibPath = join(paperDir, 'references.bib');
  await writeFile(
    bibPath,
    `${manuscript.bibliography.map((entry) => entry.bibtex.trim()).join('\n\n')}\n`,
    'utf8',
  );
  return { mainPath, bibPath, template: templateFile };
}

function escapeLatex(text: string): string {
  return text.replace(/([&%$#_])/g, '\\$1');
}

/** Why one included figure is not trustworthy, in the platform's own records. */
export type UnapprovedReason =
  /** A human recorded a verdict that is not an approval. */
  | 'review-rejected'
  /**
   * The renderer hashed these bytes but recorded them outside `figures/`, so
   * the manuscript's `figures/…` include can never name them: nothing the
   * researcher can approve, and re-running the render will not change it.
   */
  | 'outside-figures-tree'
  /** The renderer did not accept the figure (no entry, or `ok: false`). */
  | 'not-rendered';

export interface UnapprovedFigure {
  /** The path exactly as the manuscript includes it, extension filled in. */
  path: string;
  /** The figure the render report attributes these bytes to, when it can. */
  figureId: string | null;
  /** `figures[].review.status` of that figure, when the report carries one. */
  reviewStatus: string | null;
  reason: UnapprovedReason;
  /**
   * Whether `--allow-figures` may excuse it. False for a review verdict: that
   * flag exists for hand-made files the renderer never judged, and letting it
   * wave a researcher's rejection through would turn an escape hatch into a
   * way of ignoring the record.
   */
  overridable: boolean;
  /** What the render report says about this path, quoted by the blocker. */
  detail: string | null;
}

/**
 * Figure files the manuscript includes that the platform's own records do not
 * vouch for.
 *
 * The hole this closes was observed on FDG: `paper render-figures` reported
 * `partial: 0/6` because six scripts drew identical placeholder bars, and
 * `paper compile` then produced a 7-page PDF embedding exactly those six
 * rejected files. The platform's own verdict that no figure is trustworthy had
 * no effect on the artifact people actually read — a report nobody obeys is
 * decoration.
 *
 * Presence, not hash: an included figure must be listed as an output of a
 * figure the renderer marked ok. That also catches stale files left by an older
 * plan, which is what happened here. A human-drawn figure is reported rather
 * than silently trusted, and `--allow-figures` names the ones you mean.
 *
 * The human verdict is obeyed the same way (DEFECT: `review.status` used to be
 * written by `paper review-figure` and read by nobody, so a figure explicitly
 * REJECTED still reached the PDF). `unreviewed` is deliberately NOT a veto: it
 * is what the renderer itself writes for every freshly rendered figure, so
 * treating absence of a verdict as a rejection would block every ordinary
 * compile until someone approved each file one by one — a check that gets
 * deleted under pressure is worth less than one that survives. Anything other
 * than `approved`/`unreviewed` blocks, because an unrecognized status is not an
 * approval either.
 */
export async function unapprovedFigureIncludes(
  root: string,
  mainTexText: string,
  allowed: string[] = [],
): Promise<UnapprovedFigure[]> {
  const includes = [...mainTexText.matchAll(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g)]
    .map((match) => (match[1] ?? '').trim())
    .filter((path) => path.startsWith('figures/'))
    .map((path) => (/\.[a-z]+$/i.test(path) ? path : `${path}.pdf`));
  if (includes.length === 0) return [];

  interface ReportOutput {
    path?: unknown;
    declared?: unknown;
    unmatchable?: unknown;
  }
  interface ReportFigure {
    id?: unknown;
    ok?: unknown;
    outputs?: ReportOutput[];
    review?: { status?: unknown };
  }
  const accepted = new Set<string>();
  /** Every recorded output path, so a block can name the figure it belongs to. */
  const recorded = new Map<
    string,
    {
      figureId: string;
      status: string;
      note: string | null;
      unmatchable: string | null;
      ok: boolean;
    }
  >();
  /** By figure id, for the case where the recorded path can never be the include. */
  const byId = new Map<
    string,
    { status: string; outputs: { path: string; unmatchable: string | null }[] }
  >();
  try {
    const report = JSON.parse(
      await readFile(join(root, 'reports', 'paper', 'figure-render.json'), 'utf8'),
    ) as { figures?: ReportFigure[] };
    for (const figure of report.figures ?? []) {
      const id = typeof figure?.id === 'string' ? figure.id : '';
      const status = typeof figure?.review?.status === 'string' ? figure.review.status : null;
      const entries: { path: string; unmatchable: string | null }[] = [];
      for (const output of figure?.outputs ?? []) {
        const path = typeof output?.path === 'string' ? output.path : '';
        if (!path) continue;
        const declared = typeof output.declared === 'string' ? output.declared : null;
        const unmatchable = typeof output.unmatchable === 'string' ? output.unmatchable : null;
        const note = unmatchable
          ? `the render report records these bytes as ${path} — ${unmatchable}`
          : declared
            ? `the render report records these bytes as ${path}, from savefig(${JSON.stringify(
                declared,
              )}); the script's working directory is figures/, which is why the two strings differ`
            : null;
        entries.push({ path, unmatchable });
        recorded.set(path, {
          figureId: id,
          status: status ?? 'unreviewed',
          note,
          unmatchable,
          ok: figure?.ok === true,
        });
      }
      if (id) byId.set(id, { status: status ?? 'unreviewed', outputs: entries });
      if (figure?.ok !== true) continue;
      if (status && status !== 'approved' && status !== 'unreviewed') continue;
      for (const output of entries) accepted.add(output.path);
    }
  } catch {
    // No report means nothing in figures/ has ever been accepted — the honest
    // reading, since an unrendered figure is not a figure.
  }

  const allowedNames = new Set(allowed);
  const isNamed = (path: string): boolean =>
    allowedNames.has(path) || allowedNames.has(path.replace(/^figures\//, ''));

  const findings = new Map<string, UnapprovedFigure>();
  for (const path of [...new Set(includes)]) {
    if (accepted.has(path)) continue;
    const entry = recorded.get(path);
    // The id convention is used only to EXPLAIN a block, never to grant one:
    // the renderer writes each script to `figures/<id>.py`, so an include's stem
    // names the figure that produced it even when no recorded output matches.
    const stem = (path.split('/').pop() ?? '').replace(/\.[a-z]+$/i, '');
    const figure = entry ? byId.get(entry.figureId) : byId.get(stem);
    const figureId = entry?.figureId ?? (byId.has(stem) ? stem : null);
    const status = entry?.status ?? figure?.status ?? null;
    const rejected = status !== null && status !== 'approved' && status !== 'unreviewed';
    // An output recorded outside the figures tree cannot be named by any
    // `\includegraphics{figures/…}`, so this is not a missing approval and the
    // blocker must not pretend the researcher only needs to run the render
    // again: the bytes are somewhere the manuscript cannot point at.
    const unmatchable =
      entry?.unmatchable ??
      (figure && figure.outputs.length > 0 && figure.outputs.every((o) => o.unmatchable !== null)
        ? (figure.outputs[0]?.unmatchable ?? null)
        : null);
    // A hand-made file may be named on the command line; a verdict may not be
    // overruled by a flag whose documentation says nothing about review, so
    // `--allow-figures` is consulted only where nothing was ever judged.
    const overridable = !rejected;
    if (overridable && isNamed(path)) continue;
    const reason: UnapprovedReason = rejected
      ? 'review-rejected'
      : unmatchable
        ? 'outside-figures-tree'
        : 'not-rendered';
    // Each cause gets its own sentence, because each has a different fixer: a
    // verdict is changed by `review-figure`, a path basis by the script's
    // savefig target, and an unaccepted render by `render-figures` itself.
    let detail: string | null = null;
    if (reason === 'review-rejected') {
      detail = `figure ${figureId ?? 'unknown'} carries review.status "${status}" in the render report`;
    } else if (entry) {
      // The exact path the manuscript names IS in the report, so the only
      // remaining reading is that the renderer recorded it without accepting it.
      detail =
        entry.note ??
        `the render report records figure ${entry.figureId || 'unknown'} at ${path} with ok: ` +
          `${entry.ok} — an output the renderer did not accept is not an approved figure, rerun: ` +
          'ideaseek paper render-figures';
    } else if (unmatchable) {
      detail = `${path} is not a recorded path; ${unmatchable}`;
    } else if (figure && figure.outputs.length > 0) {
      detail =
        `the render report knows figure ${figureId ?? stem} only at ${figure.outputs
          .map((output) => output.path)
          .join(', ')} — the manuscript includes ${path} instead, which is what a savefig string ` +
        'beginning with figures/ produces (the script already runs in figures/), so either place ' +
        'the recorded path or drop the prefix in the script';
    }
    findings.set(path, {
      path,
      figureId,
      reviewStatus: status,
      reason,
      overridable,
      detail,
    });
  }
  return [...findings.values()];
}

/**
 * The blocker sentences for the findings above, grouped by who can fix them.
 *
 * Grouping is the point: one message for three different causes is how a
 * researcher ends up being told to re-render a figure whose bytes are in
 * `/tmp`, or to fix a script that the platform's own path basis made
 * unmatchable. Each group names the artifact that decides it and the command
 * that changes it.
 */
export function unapprovedFigureBlockers(findings: UnapprovedFigure[]): string[] {
  const blockers: string[] = [];
  const rejected = findings.filter((finding) => finding.reason === 'review-rejected');
  if (rejected.length > 0) {
    blockers.push(
      rejected
        .map(
          (finding) =>
            `${finding.path} is included but figure ${finding.figureId ?? 'unknown'} was reviewed ` +
            `"${finding.reviewStatus}" — the verdict of record is changed with ` +
            `ideaseek paper review-figure ${finding.figureId ?? '<id>'} --status approved; ` +
            '--allow-figures cannot overrule it, because that flag is for hand-made files the ' +
            'renderer never judged',
        )
        .join('; '),
    );
  }
  const outside = findings.filter((finding) => finding.reason === 'outside-figures-tree');
  if (outside.length > 0) {
    blockers.push(
      outside
        .map(
          (finding) =>
            `${finding.path} is included but was never recorded under figures/ — ` +
            `${finding.detail ?? 'the render report has no such path'}. This is the recorded path, ` +
            'not a missing approval: point the script savefig at a file under figures/ (its ' +
            'working directory already is figures/) and rerun: ideaseek paper render-figures',
        )
        .join('; '),
    );
  }
  const unaccepted = findings.filter(
    (finding) => finding.reason === 'not-rendered' && !finding.detail,
  );
  const explained = findings.filter(
    (finding) => finding.reason === 'not-rendered' && finding.detail,
  );
  if (unaccepted.length > 0) {
    blockers.push(
      `figures included but not accepted by the renderer: ${unaccepted
        .map((finding) => finding.path)
        .join(', ')} — ` +
        'rerun: ideaseek paper render-figures (it reports ok per figure), or name deliberately ' +
        'hand-made files with: ideaseek paper compile --allow-figures <path>',
    );
  }
  for (const finding of explained) {
    blockers.push(`${finding.path} — ${finding.detail}`);
  }
  return blockers;
}

/** Classifies a failed latexmk log into an actionable blocker. */
export function classifyCompileFailure(log: string): string[] {
  const blockers: string[] = [];
  const missing = [...log.matchAll(/(?:File|LaTeX) `([^']+)' not found/g)].map((m) => m[1]!);
  for (const file of [...new Set(missing)].slice(0, 5)) {
    if (file.endsWith('.sty') || file.endsWith('.cls')) {
      blockers.push(
        `missing style file ${file} — install/provide it next to paper/main.tex (venue style files are not vendored), then rerun: ideaseek paper compile`,
      );
    } else {
      blockers.push(
        `missing input file ${file} — add it under paper/ and rerun: ideaseek paper compile`,
      );
    }
  }
  if (blockers.length === 0 && /Emergency stop|Fatal error/i.test(log)) {
    blockers.push('LaTeX fatal error — read paper/compile.log and fix the source, then rerun');
  }
  return blockers;
}

/** Extracts `Output written on main.pdf (N pages` from the latexmk log. */
export function extractPageCount(log: string): number | null {
  const match = log.match(/Output written on [^(]*\((\d+) pages?/);
  return match ? Number(match[1]) : null;
}

/**
 * The support files a LaTeX source declares: document class, packages, and the files it
 * \input or \include — the ARIS templates split their math setup into math_commands.tex,
 * and a venue whose style pulls in a companion file is only buildable if that file comes
 * along too (the first ICLR compile failed on exactly that).
 *
 * Pure and exported so the parsing can be tested without a TeX distribution:
 * which of these the engine can actually resolve is a machine question, which
 * ones the document asks for is not.
 */
/**
 * Repair escaped newlines that a source asset carries verbatim.
 *
 * The vendored ICLR template contains literal backslash-n between preamble
 * lines (`...{hyperref}\\n\\usepackage[capitalize]{cleveref}`), because it was
 * written out by a model and committed without decoding — and pdflatex reads
 * that as an undefined control sequence, so `paper compile` could not produce
 * a PDF on any venue whose template shipped that way, while every check the
 * platform had (style files present, inputs resolvable, dependencies staged)
 * passed. Repairing at assemble time rather than editing the vendored bytes
 * keeps `ideaseek aris verify` meaningful: the manifest still describes exactly
 * what upstream shipped, and the deviation lives in code where it can be seen.
 *
 * Only a `\\n` NOT followed by a letter is replaced, because `\nu` and `\neg` are real
 * LaTeX commands; the same rule is applied to tabs and carriage returns.
 */
export function normalizeEscapedLayout(text: string): string {
  // Decided by what FOLLOWS, not by a list of LaTeX macros: a control word
  // after `\n` must be lowercase (`\newtheorem`, `\normalsize`, `\times`),
  // while an escaped newline from double-escaped model output is followed by
  // prose. An allowlist of names would need extending for every package; this
  // needs nothing.
  //
  // The comment this function carried claimed that prose starts with "a
  // capital, a space, punctuation or the end". A test fixture proved that
  // wrong: `…show\nthat this works` is prose starting with a lowercase word,
  // and the rule left it broken. Two escape characters in a row, by contrast,
  // cannot be two control words (`\n\n` is never valid LaTeX), so the doubled
  // pair — the paragraph break that double-encoding actually produces — is
  // repaired unconditionally, and what stays ambiguous is reported by
  // `ambiguousEscapes` in paper/write.ts rather than guessed at.
  return text
    .replace(/\\n\\n/g, '\n\n')
    .replace(/\\n(?![a-z])/g, '\n')
    .replace(/\\t(?![a-z])/g, '\t')
    .replace(/\\r(?![a-z])/g, '\r');
}

export function latexDependencyNames(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(
    /\\(?:usepackage|documentclass|input|include)(?:\[[^\]]*\])?\{([^}]*)\}/g,
  )) {
    for (const raw of (match[1] ?? '').split(',')) {
      const name = raw.trim();
      if (name) names.add(name);
    }
  }
  return [...names];
}

/**
 * Support files the assembled document needs but the engine cannot find.
 *
 * `kpsewhich` is asked per file because it is the same resolver LaTeX uses — a
 * maintained list of "styles we expect" would be a rule needing an entry per
 * venue, which is the pattern this project is removing.
 */
async function findMissingStyles(mainTex: string): Promise<string[]> {
  const source = await readFile(mainTex, 'utf8').catch(() => '');
  if (!source) return [];
  const paperDir = join(mainTex, '..');
  const resolves = async (name: string, suffix: string): Promise<boolean> => {
    // A file beside main.tex is found by the engine whatever the search paths
    // say: the manuscript \inputs the section files it assembled itself, and
    // asking kpsewhich about those would report real files missing.
    const local = await stat(join(paperDir, `${name}${suffix}`)).catch(() => null);
    if (local?.isFile()) return true;
    const probe = await runProcess('kpsewhich', [`${name}${suffix}`], {
      cwd: join(mainTex, '..'),
      timeoutMs: 20_000,
      env: process.env,
    }).catch(() => null);
    return Boolean(probe && probe.code === 0 && probe.stdout.trim());
  };
  // Sanity probe first. `article.cls` ships with every TeX distribution, so if
  // it cannot be resolved the resolver itself is unusable (no kpsewhich on
  // PATH) — and announcing that every package is missing would be a far worse
  // lie than letting latexmk produce the real error.
  if (!(await resolves('article', '.cls'))) return [];
  const names = latexDependencyNames(source);
  const missing: string[] = [];
  for (const name of names) {
    // Extensions the engine may resolve for one base name: a bare
    // \documentclass{article} is a .cls, a package is .sty or .tex.
    let found = false;
    for (const suffix of ['.sty', '.cls', '.tex', '']) {
      if (await resolves(name, suffix)) {
        found = true;
        break;
      }
    }
    if (!found) missing.push(name);
  }
  return missing;
}

/**
 * Copy a caller-supplied style directory next to main.tex.
 *
 * Same mechanism the bundled IEEE files use, so nothing about TEXINPUTS has to
 * be reasoned about: TeX finds the file when it sits beside the document.
 */
async function stageStyleDir(styleDir: string, paperDir: string): Promise<string[]> {
  const staged: string[] = [];
  const entries = await readdir(styleDir, { withFileTypes: true }).catch(() => null);
  if (!entries) {
    throw new IdeaseekError('FILE_NOT_FOUND', `--style-dir not readable: ${styleDir}`);
  }
  await ensureDir(paperDir);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(sty|cls|bst|tex|cfg)$/i.test(entry.name)) continue;
    await copyFile(join(styleDir, entry.name), join(paperDir, basename(entry.name)));
    staged.push(entry.name);
  }
  return staged;
}

interface CompileOptions {
  /** Bounds the latexmk run (tree-killed on timeout by runProcess). */
  timeoutMs?: number;
  now?: number;
  /** Directory holding venue class/style files TeX Live does not provide. */
  styleDir?: string;
  /** Figure paths to treat as approved without a render report entry. */
  allowFigures?: string[];
  /**
   * Insert floats for figures the render records verify, before the plan
   * cross-check runs. Without it the only route a verified artifact has into
   * the document is another model turn — see `placeVerifiedFigures`.
   */
  placeFigures?: boolean;
}

/**
 * Full compile: read manuscript → assemble → latexmk → honest report.
 * Throws USER_INPUT_REQUIRED without a manuscript; returns the report for
 * every build outcome (compiled | failed | blocked).
 */
export async function compileManuscript(
  root: string,
  skillMeta: { name: string; sha256: string },
  opts: CompileOptions = {},
): Promise<{ report: CompileReport; mainPath: string; placement: PlacementResult | null }> {
  const stored = await readManuscriptDoc(root);
  const manuscript = stored.manuscript;

  let placement: PlacementResult | null = null;
  let assembled: { mainPath: string; template: string };
  try {
    assembled = await assembleLaTeXProject(root, manuscript);
  } catch (error) {
    // Missing/broken venue template → blocked report, not a crash.
    if (error instanceof IdeaseekError && error.code === 'INVALID_ARGUMENT') {
      const report: CompileReport = {
        status: 'blocked',
        venue: manuscript.venue,
        template: null,
        engine: 'pdflatex',
        buildCommand: [],
        attempts: 0,
        exitCode: null,
        pdfPath: null,
        pageCount: null,
        logTail: '',
        blockers: [error.message],
        skill: skillMeta,
        manuscriptInputHash: stored.inputHash,
        compiledAt: opts.now ?? Date.now(),
      };
      return { report, mainPath: '', placement };
    }
    throw error;
  }

  if (opts.placeFigures) {
    const { placeVerifiedFigures } = await import('./place-figures.js');
    placement = await placeVerifiedFigures(root);
  }

  const mainTexText = await readFile(join(root, 'paper', 'main.tex'), 'utf8').catch(() => '');
  // The check that FDG actually needed. `paper plan` listed six figures,
  // `paper write` produced a manuscript containing no \includegraphics at all,
  // and `paper compile` reported success with a 7-page PDF — a figure-less
  // paper that looked finished. The plan is a commitment: an id it names that
  // the manuscript never places is a gap, and silence about a gap in a
  // research artifact is the defect, not the missing figure itself.
  const unplacedFigures: string[] = [];
  try {
    const plan = JSON.parse(
      await readFile(join(root, 'reports', 'paper', 'figures-plan.json'), 'utf8'),
    ) as {
      figures?: { figures?: { id?: unknown }[] };
      preservedExisting?: unknown;
      manualRemaining?: unknown;
    };
    const excused = new Set(
      [
        ...(Array.isArray(plan.preservedExisting) ? plan.preservedExisting : []),
        ...(Array.isArray(plan.manualRemaining) ? plan.manualRemaining : []),
      ].map(String),
    );
    for (const figure of plan.figures?.figures ?? []) {
      const id = String(figure?.id ?? '').trim();
      if (!id || excused.has(id)) continue;
      if (!mainTexText.includes(`figures/${id}`)) unplacedFigures.push(id);
    }
  } catch {
    // No stored plan: nothing to cross-check, and inventing a requirement would
    // block manuscripts that never planned figures.
  }
  if (unplacedFigures.length > 0) {
    const report: CompileReport = {
      status: 'blocked',
      venue: manuscript.venue,
      template: null,
      engine: 'pdflatex',
      buildCommand: [],
      attempts: 0,
      exitCode: null,
      pdfPath: null,
      pageCount: null,
      logTail: '',
      blockers: [
        `the figure plan commits to figures the manuscript never places: ${unplacedFigures.join(', ')} — ` +
          'place the ones already rendered with: ideaseek paper compile --place-figures; ' +
          'otherwise add them to the manuscript (ideaseek paper write) or record them as ' +
          'manual/preserved in the plan; compiling without them would publish a paper missing its own evidence',
      ],
      skill: skillMeta,
      manuscriptInputHash: stored.inputHash,
      compiledAt: opts.now ?? Date.now(),
    };
    return { report, mainPath: join(root, 'paper', 'main.tex'), placement };
  }

  const unapprovedFigures = await unapprovedFigureIncludes(
    root,
    mainTexText,
    opts.allowFigures ?? [],
  );
  if (unapprovedFigures.length > 0) {
    const report: CompileReport = {
      status: 'blocked',
      venue: manuscript.venue,
      template: null,
      engine: 'pdflatex',
      buildCommand: [],
      attempts: 0,
      exitCode: null,
      pdfPath: null,
      pageCount: null,
      logTail: '',
      blockers: unapprovedFigureBlockers(unapprovedFigures),
      skill: skillMeta,
      manuscriptInputHash: stored.inputHash,
      compiledAt: opts.now ?? Date.now(),
    };
    return { report, mainPath: join(root, 'paper', 'main.tex'), placement };
  }

  // Preflight the style dependencies before spending a latexmk run. The venue
  // templates reference class/style files (ICLR needs
  // iclr2026_conference.sty) that are not part of TeX Live and are not
  // vendored here, so the first user on a clean machine got a latexmk failure
  // whose message pointed at `main.tex` instead of at the one missing file.
  // `\usepackage{a,b,c}` is resolved with kpsewhich, which knows every search
  // path the engine itself will use — no list of expected files to maintain.
  if (opts.styleDir) {
    await stageStyleDir(opts.styleDir, join(root, 'paper'));
  }
  const missingStyles = await findMissingStyles(join(root, 'paper', 'main.tex'));
  if (missingStyles.length > 0) {
    const report: CompileReport = {
      status: 'blocked',
      venue: manuscript.venue,
      template: null,
      engine: 'pdflatex',
      buildCommand: [],
      attempts: 0,
      exitCode: null,
      pdfPath: null,
      pageCount: null,
      logTail: '',
      blockers: [
        `missing LaTeX support file(s): ${missingStyles.join(', ')} — these are not part of ` +
          'TeX Live and not vendored with IdeaSeek. Place them in paper/ (next to main.tex), or ' +
          'pass their directory with: ideaseek paper compile --style-dir <dir>',
      ],
      skill: skillMeta,
      manuscriptInputHash: stored.inputHash,
      compiledAt: opts.now ?? Date.now(),
    };
    return { report, mainPath: join(root, 'paper', 'main.tex'), placement };
  }

  const buildCommand = [
    'latexmk',
    '-pdf',
    '-interaction=nonstopmode',
    '-halt-on-error',
    'main.tex',
  ];
  let result: Awaited<ReturnType<typeof runProcess>>;
  try {
    result = await runProcess(buildCommand[0]!, buildCommand.slice(1), {
      cwd: join(root, 'paper'),
      timeoutMs: opts.timeoutMs ?? 180_000,
      env: process.env,
    });
  } catch (error) {
    // latexmk missing / not spawnable → honest failed report, not a crash.
    const report: CompileReport = {
      status: 'failed',
      venue: manuscript.venue,
      template: assembled.template,
      engine: 'pdflatex',
      buildCommand,
      attempts: 0,
      exitCode: null,
      pdfPath: null,
      pageCount: null,
      logTail: '',
      blockers: [
        `latexmk could not be started (${(error as Error).message}) — install TeX Live (latexmk + pdflatex) and rerun`,
      ],
      skill: skillMeta,
      manuscriptInputHash: stored.inputHash,
      compiledAt: opts.now ?? Date.now(),
    };
    return { report, mainPath: assembled.mainPath, placement };
  }
  const logTail = redactSecrets(
    `${result.stdout}\n${result.stderr}`.slice(-8_000) || '(no output)',
  );

  let logText = logTail;
  try {
    logText = redactSecrets(await readFile(join(root, 'paper', 'compile.log'), 'utf8'));
  } catch {
    // latexmk may die before writing the log — the combined tail stands in
  }

  const pdfPath = join(root, 'paper', 'main.pdf');
  let pdfExists = false;
  try {
    await readFile(pdfPath);
    pdfExists = true;
  } catch {
    pdfExists = false;
  }

  if (result.timedOut) {
    const report: CompileReport = {
      status: 'failed',
      venue: manuscript.venue,
      template: assembled.template,
      engine: 'pdflatex',
      buildCommand,
      attempts: 1,
      exitCode: result.code,
      pdfPath: null,
      pageCount: null,
      logTail: logTail.slice(-4_000),
      blockers: [
        `compile timed out after ${opts.timeoutMs ?? 180_000} ms — the process tree was killed; simplify the document or raise the bound, then rerun`,
      ],
      skill: skillMeta,
      manuscriptInputHash: stored.inputHash,
      compiledAt: opts.now ?? Date.now(),
    };
    return { report, mainPath: assembled.mainPath, placement };
  }

  if (result.code === 0 && pdfExists) {
    const report: CompileReport = {
      status: 'compiled',
      venue: manuscript.venue,
      template: assembled.template,
      engine: 'pdflatex',
      buildCommand,
      attempts: 1,
      exitCode: 0,
      pdfPath,
      pageCount: extractPageCount(logText),
      logTail: '',
      blockers: [],
      skill: skillMeta,
      manuscriptInputHash: stored.inputHash,
      compiledAt: opts.now ?? Date.now(),
    };
    return { report, mainPath: assembled.mainPath, placement };
  }

  const blockers = classifyCompileFailure(logText);
  const report: CompileReport = {
    status: 'failed',
    venue: manuscript.venue,
    template: assembled.template,
    engine: 'pdflatex',
    buildCommand,
    attempts: 1,
    exitCode: result.code,
    pdfPath: null,
    pageCount: null,
    logTail: logTail.slice(-4_000),
    blockers:
      blockers.length > 0
        ? blockers
        : ['compile failed — read paper/compile.log, fix the source, rerun ideaseek paper compile'],
    skill: skillMeta,
    manuscriptInputHash: stored.inputHash,
    compiledAt: opts.now ?? Date.now(),
  };
  return { report, mainPath: assembled.mainPath, placement };
}
