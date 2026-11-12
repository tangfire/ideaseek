import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { arisSkillsRoot } from '../aris/skill.js';
import { IdeaseekError } from '../core/errors.js';
import { redactSecrets } from '../core/redact.js';
import { runProcess } from '../core/proc.js';
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

/** Style files copied next to main.tex when the template needs them. */
const BUNDLED_STYLE_FILES = ['IEEEtran.cls', 'IEEEtran.bst'];

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
    templateText = await readFile(templateAbs, 'utf8');
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

  // IEEE templates need their vendored class/style files beside main.tex.
  for (const style of BUNDLED_STYLE_FILES) {
    if (templateText.includes('IEEEtran')) {
      try {
        const source = join(arisSkillsRoot(), 'skills', 'paper-write', 'templates', style);
        await writeFile(join(paperDir, style), await readFile(source));
      } catch {
        // missing style file surfaces as a compile failure with log tail
      }
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
    ...manuscript.sections.map((section) => section.latex.trim()),
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

export interface CompileOptions {
  /** Bounds the latexmk run (tree-killed on timeout by runProcess). */
  timeoutMs?: number;
  now?: number;
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
): Promise<{ report: CompileReport; mainPath: string }> {
  const stored = await readManuscriptDoc(root);
  const manuscript = stored.manuscript;

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
      return { report, mainPath: '' };
    }
    throw error;
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
    return { report, mainPath: assembled.mainPath };
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
    return { report, mainPath: assembled.mainPath };
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
    return { report, mainPath: assembled.mainPath };
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
  return { report, mainPath: assembled.mainPath };
}
