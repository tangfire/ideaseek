import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Of } from '../core/hash.js';
import { IdeaseekError } from '../core/errors.js';
import { stableJson } from '../experiment/spec.js';
import { renderArisSkill, type LoadedArisSkill } from '../aris/skill.js';
import type { PaperPlanSnapshot } from './plan.js';
import { assertAgainstSchema } from '../core/schema/index.js';
import { describeResultsForPrompt, readPaperResults } from './results-export.js';

/**
 * paper-figure capability (Phase 4.5C, skill integration): the vendored
 * ARIS paper-figure skill produces a `paper-figure-v1` artifact — figure
 * specs with plotting script sources, LaTeX includes and honest lists of
 * what CANNOT be auto-generated (architecture diagrams, photo grids).
 *
 * Scope boundary: this capability persists the figure PLAN + scripts
 * bound to the stored paper plan and experiment snapshot; EXECUTING the
 * scripts (sandboxed matplotlib runs, source manifests, PDF/PNG render
 * checks) is Phase 7's dedicated figure pipeline — this integration
 * never pretends a figure was rendered.
 */

export const PAPER_FIGURE_SCHEMA = 'paper-figure-v1';

export const FIGURE_TYPES = [
  'line',
  'bar',
  'scatter',
  'heatmap',
  'box',
  'violin',
  'table',
  'multi-panel',
  'resource',
  'sensitivity',
] as const;

export interface FigureDataSource {
  kind: 'experiment-spec' | 'result-file' | 'existing-figure' | 'context';
  ref: string;
}

export interface FigureSpec {
  id: string;
  type: (typeof FIGURE_TYPES)[number];
  title: string;
  /** Publication caption (source-manifest field). */
  caption: string;
  dataSources: FigureDataSource[];
  /** What the figure computes — the statistics definition (source-manifest field). */
  statistics: string[];
  /** Python plotting source (matplotlib) — persisted, not executed here. */
  script: string;
  /** LaTeX snippet placing the rendered figure/table. */
  latexInclude: string;
  claims: string[];
}

export interface PaperFigurePlan {
  style: 'publication' | 'poster' | 'slide';
  dpi: number;
  format: 'pdf' | 'png';
  figures: FigureSpec[];
  /** Manually created figures detected and kept as-is. */
  preservedExisting: string[];
  /** What still needs a human (hero/architecture/qualitative images). */
  manualRemaining: string[];
  reviewerFeedback: { verdict: 'ACCEPT' | 'REVISE' | 'REVIEW_UNAVAILABLE'; notes: string[] };
}

export const PAPER_FIGURE_OUTPUT_CONTRACT = [
  `OUTPUT CONTRACT (${PAPER_FIGURE_SCHEMA}) — return ONLY one JSON object, no prose, no fences:`,
  '{',
  '  "style": "publication" | "poster" | "slide",',
  '  "dpi": integer ≥ 72,',
  '  "format": "pdf" | "png",',
  '  "figures": [{"id": string, "type": "line"|"bar"|"scatter"|"heatmap"|"box"|"violin"|"table"|"multi-panel"|"resource"|"sensitivity", "title": string, "caption": string (publication caption), "statistics": [string] (what the figure computes — at least 1), "dataSources": [{"kind": "experiment-spec"|"result-file"|"existing-figure"|"context", "ref": string}], "script": string (save BOTH a vector pdf/svg and a png via savefig), "latexInclude": string, "claims": [string]}] — at least 1; every id from the stored plan figure list MUST appear exactly once',
  '  "preservedExisting": [string],  // existing manual figures you detected and did not overwrite',
  '  "manualRemaining": [string],    // hero/architecture/qualitative figures a human must draw',
  '  "reviewerFeedback": {"verdict": "ACCEPT"|"REVISE"|"REVIEW_UNAVAILABLE", "notes": [string]}',
  '}',
  'Rules:',
  '- scripts must be self-contained matplotlib sources reading only the declared dataSources (write them for the project layout in the context).',
  '- This harness runs no figure reviewer: verdict must be REVIEW_UNAVAILABLE unless the context carries reviewer notes.',
  '- Never claim a figure was rendered — this contract plans and sources scripts only.',
  '- dataSources.ref must cite real context entries (spec ids, file paths, existing figure names) — no invented sources.',
].join('\n');

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validatePaperFigurePlan(value: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isObject(value)) return { ok: false, errors: ['figure plan must be an object'] };

  if (!['publication', 'poster', 'slide'].includes(String(value.style))) {
    errors.push('style must be publication | poster | slide');
  }
  if (typeof value.dpi !== 'number' || !Number.isInteger(value.dpi) || value.dpi < 72) {
    errors.push('dpi must be an integer >= 72');
  }
  if (!['pdf', 'png'].includes(String(value.format))) {
    errors.push('format must be pdf | png');
  }

  if (!Array.isArray(value.figures) || value.figures.length === 0) {
    errors.push('figures must be a non-empty array');
  } else {
    const ids = new Set<string>();
    value.figures.forEach((figure, index) => {
      if (!isObject(figure)) {
        errors.push(`figures[${index}] must be an object`);
        return;
      }
      if (!nonEmpty(figure.id)) errors.push(`figures[${index}].id must be non-empty`);
      else if (ids.has(figure.id)) errors.push(`figures[${index}].id duplicates "${figure.id}"`);
      else ids.add(figure.id);
      if (!FIGURE_TYPES.includes(figure.type as (typeof FIGURE_TYPES)[number])) {
        errors.push(`figures[${index}].type must be one of ${FIGURE_TYPES.join(' | ')}`);
      }
      if (!nonEmpty(figure.title)) errors.push(`figures[${index}].title must be non-empty`);
      if (!nonEmpty(figure.caption)) errors.push(`figures[${index}].caption must be non-empty`);
      if (
        !Array.isArray(figure.statistics) ||
        figure.statistics.length === 0 ||
        figure.statistics.some((stat) => !nonEmpty(stat))
      ) {
        errors.push(`figures[${index}].statistics must be non-empty strings`);
      }
      if (!nonEmpty(figure.script)) errors.push(`figures[${index}].script must be non-empty`);
      // The contract is that the script PRODUCES the file the manuscript
      // includes, not that it names a particular library. The previous rule
      // demanded the substring "matplotlib" and rejected all five scripts of
      // the first real model plan, which was a preference posed as a check —
      // and it passed plans that draw without saving, the failure
      // `paper render-figures` then had to discover (it requires a vector
      // output and treats exit-0-without-a-file as failure). Both saving forms
      // are accepted so a different plotting backend is not silently banned.
      else if (!/(savefig|write_image)\s*\(/.test(figure.script)) {
        errors.push(
          `figures[${index}].script must save the figure (savefig(...) or write_image(...)) — ` +
            'the renderer requires the output file the manuscript includes',
        );
      }
      if (!nonEmpty(figure.latexInclude)) {
        errors.push(`figures[${index}].latexInclude must be non-empty`);
      }
      if (!Array.isArray(figure.dataSources) || figure.dataSources.length === 0) {
        errors.push(`figures[${index}].dataSources must be a non-empty array`);
      } else {
        figure.dataSources.forEach((source, s) => {
          if (
            !isObject(source) ||
            !['experiment-spec', 'result-file', 'existing-figure', 'context'].includes(
              String(source.kind),
            ) ||
            !nonEmpty(source.ref)
          ) {
            errors.push(`figures[${index}].dataSources[${s}] needs a known kind and non-empty ref`);
          }
        });
        // Provenance, structurally rather than by keyword blacklist: a figure
        // that declares it comes from a recorded experiment or result file must
        // name that source in the script that draws it. The first real FDG
        // render produced six "publication figures" from scripts that called
        // `ax.bar(['fake'], [1.0])` and reported `rendered 6/6` — the plan said
        // where the data came from and the code ignored it, and nothing in the
        // platform compared those two statements.
        const grounded = figure.dataSources.filter(
          (source) =>
            isObject(source) &&
            ['experiment-spec', 'result-file', 'existing-figure'].includes(String(source.kind)),
        );
        for (const source of grounded) {
          const ref = String((source as { ref?: unknown }).ref ?? '');
          if (ref && !String(figure.script).includes(ref)) {
            errors.push(
              `figures[${index}].script does not read its declared data source ${ref} — ` +
                'a figure may not draw invented values and claim they come from a recorded run',
            );
          }
        }
      }
      if (
        !Array.isArray(figure.claims) ||
        figure.claims.length === 0 ||
        figure.claims.some((claim) => !nonEmpty(claim))
      ) {
        errors.push(`figures[${index}].claims must be non-empty strings`);
      }
    });
  }

  for (const field of ['preservedExisting', 'manualRemaining'] as const) {
    const list = value[field];
    if (!Array.isArray(list) || list.some((item) => !nonEmpty(item))) {
      errors.push(`${field} must be an array of non-empty strings`);
    }
  }

  const feedback = value.reviewerFeedback;
  if (!isObject(feedback)) {
    errors.push('reviewerFeedback must be an object');
  } else {
    if (!['ACCEPT', 'REVISE', 'REVIEW_UNAVAILABLE'].includes(String(feedback.verdict))) {
      errors.push('reviewerFeedback.verdict must be ACCEPT | REVISE | REVIEW_UNAVAILABLE');
    }
    if (!Array.isArray(feedback.notes) || feedback.notes.some((note) => !nonEmpty(note))) {
      errors.push('reviewerFeedback.notes must be non-empty strings');
    }
  }

  return { ok: errors.length === 0, errors };
}

export interface FigureContext {
  /** Figure ids from the stored paper plan (traceability anchor). */
  plannedFigureIds: string[];
  snapshot: PaperPlanSnapshot;
  existingFigures: string[];
  question: string;
  /** How to read reports/paper/results.json, or why it does not exist yet. */
  resultsGuide: string;
  resultsFile: string | null;
}

/** Reads the stored plan (if any) and the figures/ directory (read-only). */
export async function collectFigureContext(root: string): Promise<FigureContext> {
  const { collectPaperPlanSnapshot } = await import('./plan.js');
  const snapshot = await collectPaperPlanSnapshot(root);
  let plannedFigureIds: string[] = [];
  try {
    const { readFile } = await import('node:fs/promises');
    const stored = JSON.parse(
      await readFile(join(root, 'reports', 'paper', 'plan.json'), 'utf8'),
    ) as {
      plan?: { figurePlan?: { id?: unknown }[] };
    };
    plannedFigureIds = (stored.plan?.figurePlan ?? [])
      .map((figure) => (typeof figure?.id === 'string' ? figure.id : null))
      .filter((id): id is string => id !== null);
  } catch {
    plannedFigureIds = [];
  }
  let existingFigures: string[] = [];
  try {
    existingFigures = (await readdir(join(root, 'figures'))).filter((name) =>
      /\.(pdf|png|svg|jpg|jpeg)$/i.test(name),
    );
  } catch {
    existingFigures = [];
  }
  // The recorded numbers, or the honest absence of them. Before this existed
  // the figure author was shown the research question and the protocol id, so
  // it invented data and `ax.bar(['fake'], [1.0])` reached a "publication
  // figure" plan; the file the scripts must read is now part of the request.
  const resultsExport = await readPaperResults(root);
  return {
    plannedFigureIds,
    snapshot,
    existingFigures,
    question: snapshot.question,
    resultsGuide: resultsExport
      ? describeResultsForPrompt(resultsExport)
      : 'NO results export exists yet — run: ideaseek paper results (figures may not invent values)',
    resultsFile: resultsExport ? resultsExport.rowPath : null,
  };
}

function renderFigureContext(context: FigureContext): string {
  const lines = [`Research question: ${context.question}`];
  lines.push('## recorded results', context.resultsGuide);
  lines.push(
    context.plannedFigureIds.length > 0
      ? `Figure ids from the stored paper plan (every one MUST appear in your output): ${context.plannedFigureIds.join(', ')}`
      : 'Figure ids from the stored paper plan: none (no stored plan — derive ids yourself)',
  );
  lines.push(
    context.snapshot.protocol
      ? `Locked protocol: ${context.snapshot.protocol.protocolId} (${context.snapshot.protocol.protocolHash})`
      : 'Locked protocol: none',
  );
  if (context.snapshot.experiments.length > 0) {
    lines.push('Experiment results:');
    for (const entry of context.snapshot.experiments) {
      lines.push(
        `  - ${entry.specId} v${entry.version} [${entry.status}]` +
          (entry.metrics.length > 0
            ? ` ${entry.metrics.map((metric) => `${metric.name}=${metric.value}`).join(', ')}`
            : ''),
      );
    }
  } else {
    lines.push('Experiment results: none');
  }
  lines.push(
    context.existingFigures.length > 0
      ? `Existing figures (preserve, do not overwrite): ${context.existingFigures.join(', ')}`
      : 'Existing figures: none',
  );
  lines.push(
    'Scope reminder: data plots and tables only — architecture diagrams, image grids and photos go to manualRemaining.',
  );
  return lines.join('\n');
}

export interface FigureRequest {
  instruction: string;
  context: string;
  inputHash: string;
  idempotencyKey: string;
}

export function buildFigureRequest(skill: LoadedArisSkill, context: FigureContext): FigureRequest {
  const rendered = renderFigureContext(context);
  const inputHash = sha256Of(
    stableJson({
      contract: PAPER_FIGURE_SCHEMA,
      skillSha256: skill.sha256,
      context: {
        plannedFigureIds: context.plannedFigureIds,
        snapshot: context.snapshot,
        existingFigures: context.existingFigures,
      },
    }),
  );
  const instruction = [
    renderArisSkill(skill, { arguments: rendered }),
    '',
    '---',
    '',
    PAPER_FIGURE_OUTPUT_CONTRACT,
    '',
    'Context (persisted, hashable sources only):',
    rendered,
  ].join('\n');
  return {
    instruction,
    context: rendered,
    inputHash,
    idempotencyKey: `paper-figure:${inputHash}`,
  };
}

/**
 * Parses + validates output; when a stored plan pins figure ids, the
 * output must cover them all (traceability to the locked plan).
 */
export function parsePaperFigureOutput(output: string, context: FigureContext): PaperFigurePlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `paper-figure output is not valid JSON: ${(error as Error).message}`,
    );
  }
  const validation = validatePaperFigurePlan(parsed);
  if (!validation.ok) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `paper-figure output violates ${PAPER_FIGURE_SCHEMA}: ${validation.errors.slice(0, 5).join('; ')}`,
      { errors: validation.errors },
    );
  }
  // Defense in depth (JSON Schema authority): the TS validator ran first.
  assertAgainstSchema('paper-figure-v1', parsed);
  const plan = parsed as PaperFigurePlan;
  if (context.plannedFigureIds.length > 0) {
    const produced = new Set(plan.figures.map((figure) => figure.id));
    const missing = context.plannedFigureIds.filter((id) => !produced.has(id));
    if (missing.length > 0) {
      throw new IdeaseekError(
        'PARSE_FAILED',
        `paper-figure output misses planned figure id(s): ${missing.join(', ')} — the stored plan pins them`,
        { missing },
      );
    }
  }
  return plan;
}
