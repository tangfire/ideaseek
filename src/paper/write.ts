import { sha256Of } from '../core/hash.js';
import { IdeaseekError } from '../core/errors.js';
import { normalizeEscapedLayout } from './compile.js';
import { stableJson } from '../experiment/spec.js';
import { renderArisSkill, type LoadedArisSkill } from '../aris/skill.js';
import type { PaperPlanSnapshot } from './plan.js';
import { assertAgainstSchema } from '../core/schema/index.js';

/**
 * paper-write capability (Phase 4.5C, skill integration): the vendored
 * ARIS paper-write skill produces a `paper-write-v1` manuscript artifact —
 * structured LaTeX sections + bibliography bound to the STORED paper plan
 * (same venue, sections derived from its structure). Assembly into a
 * compilable project and the compile step belong to paper-compile (next)
 * and the Phase 7 delivery pipeline; this capability persists content,
 * never claims a built PDF.
 */

export const PAPER_WRITE_SCHEMA = 'paper-write-v1';

export const WRITE_VENUES = [
  'ICLR',
  'NeurIPS',
  'ICML',
  'CVPR',
  'ACL',
  'AAAI',
  'ACM',
  'IEEE_JOURNAL',
  'IEEE_CONF',
] as const;

export interface ManuscriptSection {
  id: string;
  heading: string;
  latex: string;
  /** Context sources this section's content rests on (plan ids, specIds…). */
  sources: string[];
}

export interface BibliographyEntry {
  key: string;
  bibtex: string;
}

export interface Manuscript {
  venue: (typeof WRITE_VENUES)[number];
  title: string;
  abstract: string;
  sections: ManuscriptSection[];
  bibliography: BibliographyEntry[];
  /** Step-5/7 quality passes the writer actually performed. */
  qualityPasses: string[];
  /** Honest list of fixes left for a human (formatting, camera-ready). */
  manualFixes: string[];
  reviewerFeedback: { verdict: 'ACCEPT' | 'REVISE' | 'REVIEW_UNAVAILABLE'; notes: string[] };
}

export const PAPER_WRITE_OUTPUT_CONTRACT = [
  `OUTPUT CONTRACT (${PAPER_WRITE_SCHEMA}) — return ONLY one JSON object, no prose, no fences:`,
  '{',
  `  "venue": ${WRITE_VENUES.map((venue) => `"${venue}"`).join(' | ')},`,
  '  "title": string,',
  '  "abstract": string, // non-empty, ≤ 250 words worth of text',
  '  "sections": [{"id": string, "heading": string, "latex": string, "sources": [string]}] — at least 1; ids stable (intro, related, method, experiments, conclusion, …); latex is body-only (no \\documentclass)',
  '  "bibliography": [{"key": string, "bibtex": string}] — at least 1 full BibTeX entry each',
  '  "qualityPasses": [string] — at least 1 (e.g. "reverse-outline", "citation-discipline", "claim-evidence-audit")',
  '  "manualFixes": [string], // camera-ready/human fixes left (may be empty)',
  '  "reviewerFeedback": {"verdict": "ACCEPT"|"REVISE"|"REVIEW_UNAVAILABLE", "notes": [string]}',
  '}',
  'Rules:',
  '- venue MUST equal the stored plan venue when one exists (context line `Venue:`).',
  '- Every section.sources entry must cite real context ids (plan sections, specId, comparison id, idea id) — no invented sources.',
  '- No reviewer backend is hosted here: verdict must be REVIEW_UNAVAILABLE unless the context carries reviewer notes.',
  '- Do not claim the paper compiles — assembly/compile is a separate step.',
].join('\n');

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateManuscript(value: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isObject(value)) return { ok: false, errors: ['manuscript must be an object'] };

  if (
    typeof value.venue !== 'string' ||
    !(WRITE_VENUES as readonly string[]).includes(value.venue)
  ) {
    errors.push(`venue must be one of ${WRITE_VENUES.join(' | ')}`);
  }
  if (!nonEmpty(value.title)) errors.push('title must be a non-empty string');
  if (!nonEmpty(value.abstract)) errors.push('abstract must be a non-empty string');

  if (!Array.isArray(value.sections) || value.sections.length === 0) {
    errors.push('sections must be a non-empty array');
  } else {
    const ids = new Set<string>();
    value.sections.forEach((section, index) => {
      if (!isObject(section)) {
        errors.push(`sections[${index}] must be an object`);
        return;
      }
      if (!nonEmpty(section.id)) errors.push(`sections[${index}].id must be non-empty`);
      else if (ids.has(section.id)) errors.push(`sections[${index}].id duplicates "${section.id}"`);
      else ids.add(section.id);
      if (!nonEmpty(section.heading)) errors.push(`sections[${index}].heading must be non-empty`);
      if (!nonEmpty(section.latex)) errors.push(`sections[${index}].latex must be non-empty`);
      else if (section.latex.includes('\\documentclass')) {
        errors.push(`sections[${index}].latex must be body-only (no \\documentclass)`);
      }
      if (!Array.isArray(section.sources) || section.sources.length === 0) {
        errors.push(`sections[${index}].sources must be a non-empty array`);
      } else if (section.sources.some((source) => !nonEmpty(source))) {
        errors.push(`sections[${index}].sources entries must be non-empty strings`);
      }
    });
  }

  if (!Array.isArray(value.bibliography) || value.bibliography.length === 0) {
    errors.push('bibliography must be a non-empty array');
  } else {
    const keys = new Set<string>();
    value.bibliography.forEach((entry, index) => {
      if (!isObject(entry) || !nonEmpty(entry.key) || !nonEmpty(entry.bibtex)) {
        errors.push(`bibliography[${index}] needs a non-empty key and bibtex`);
      } else if (keys.has(entry.key)) {
        errors.push(`bibliography[${index}].key duplicates "${entry.key}"`);
      } else {
        keys.add(entry.key);
        if (!entry.bibtex.includes('@')) {
          errors.push(`bibliography[${index}].bibtex must look like a BibTeX entry`);
        }
      }
    });
  }

  if (!Array.isArray(value.qualityPasses) || value.qualityPasses.length === 0) {
    errors.push('qualityPasses must be a non-empty array');
  } else if (value.qualityPasses.some((pass) => !nonEmpty(pass))) {
    errors.push('qualityPasses entries must be non-empty strings');
  }
  if (!Array.isArray(value.manualFixes) || value.manualFixes.some((fix) => !nonEmpty(fix))) {
    errors.push('manualFixes must be an array of non-empty strings');
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

export interface WriteContext {
  /** Stored plan venue/sections (null when no plan exists). */
  plan: { venue: string; sections: string[]; claims: string[] } | null;
  snapshot: PaperPlanSnapshot;
  question: string;
}

export async function collectWriteContext(root: string): Promise<WriteContext> {
  const { collectPaperPlanSnapshot } = await import('./plan.js');
  const snapshot = await collectPaperPlanSnapshot(root);
  let plan: WriteContext['plan'] = null;
  try {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const stored = JSON.parse(
      await readFile(join(root, 'reports', 'paper', 'plan.json'), 'utf8'),
    ) as {
      plan?: {
        venue?: unknown;
        structure?: { section?: unknown }[];
        claimsEvidence?: { claim?: unknown }[];
      };
    };
    const inner = stored.plan;
    if (inner && typeof inner.venue === 'string') {
      plan = {
        venue: inner.venue,
        sections: (inner.structure ?? [])
          .map((section) => (typeof section?.section === 'string' ? section.section : null))
          .filter((section): section is string => section !== null),
        claims: (inner.claimsEvidence ?? [])
          .map((claim) => (typeof claim?.claim === 'string' ? claim.claim : null))
          .filter((claim): claim is string => claim !== null),
      };
    }
  } catch {
    plan = null;
  }
  return { plan, snapshot, question: snapshot.question };
}

function renderWriteContext(context: WriteContext): string {
  const lines = [`Research question: ${context.question}`];
  lines.push(
    context.plan
      ? `Venue: ${context.plan.venue} (MUST be used verbatim in your output)`
      : 'Venue: none stored — choose one from the contract list and say so',
  );
  lines.push(
    context.plan && context.plan.sections.length > 0
      ? `Plan structure (cover with your sections): ${context.plan.sections.join(' | ')}`
      : 'Plan structure: none stored',
  );
  if (context.plan && context.plan.claims.length > 0) {
    lines.push('Claims to argue (from the stored plan):');
    for (const claim of context.plan.claims) lines.push(`  - ${claim}`);
  } else {
    lines.push('Claims to argue: none stored');
  }
  if (context.snapshot.experiments.length > 0) {
    lines.push('Experiment results (cite by specId in section sources):');
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
    context.snapshot.protocol
      ? `Locked protocol: ${context.snapshot.protocol.protocolId} (${context.snapshot.protocol.protocolHash})`
      : 'Locked protocol: none',
  );
  return lines.join('\n');
}

export interface WriteRequest {
  instruction: string;
  context: string;
  inputHash: string;
  idempotencyKey: string;
}

export function buildWriteRequest(skill: LoadedArisSkill, context: WriteContext): WriteRequest {
  const rendered = renderWriteContext(context);
  const inputHash = sha256Of(
    stableJson({
      contract: PAPER_WRITE_SCHEMA,
      skillSha256: skill.sha256,
      context: { plan: context.plan, snapshot: context.snapshot },
    }),
  );
  const instruction = [
    renderArisSkill(skill, { arguments: rendered }),
    '',
    '---',
    '',
    PAPER_WRITE_OUTPUT_CONTRACT,
    '',
    'Context (persisted, hashable sources only):',
    rendered,
  ].join('\n');
  return {
    instruction,
    context: rendered,
    inputHash,
    idempotencyKey: `paper-write:${inputHash}`,
  };
}

/**
 * Parses + validates; when a stored plan pins the venue, the manuscript
 * must use exactly that venue (traceability to the locked plan).
 */
export function parseManuscriptOutput(output: string, context: WriteContext): Manuscript {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `paper-write output is not valid JSON: ${(error as Error).message}`,
    );
  }
  const validation = validateManuscript(parsed);
  if (!validation.ok) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `paper-write output violates ${PAPER_WRITE_SCHEMA}: ${validation.errors.slice(0, 5).join('; ')}`,
      { errors: validation.errors },
    );
  }
  // Defense in depth (JSON Schema authority): the TS validator ran first.
  assertAgainstSchema('paper-write-v1', parsed);
  const manuscript = normalizeManuscriptLayout(parsed as Manuscript);
  if (context.plan && manuscript.venue !== context.plan.venue) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `paper-write venue "${manuscript.venue}" does not match the stored plan venue "${context.plan.venue}"`,
      { expected: context.plan.venue, actual: manuscript.venue },
    );
  }
  return manuscript;
}

/**
 * Escape pairs whose meaning cannot be decided from the text alone.
 *
 * `
` followed by a lowercase letter is the ambiguous case: it is either a
 * broken escape (`...
that this works`) or a real control word
 * (`
ewtheorem`, `$
u$`). Only a reader who knows LaTeX can tell, and the
 * platform refuses to guess with a name list that would need extending per
 * package — so the ambiguous residue is reported, naming the surrounding text,
 * and a human decides. Reporting rather than guessing matters because a silent
 * half-repair leaves the stored artifact neither clean nor visibly broken.
 */
export function ambiguousEscapes(text: string): string[] {
  const found: string[] = [];
  const pattern = new RegExp('\\\\[ntr][a-z][^\\\\]{0,24}', 'g');
  for (const match of text.matchAll(pattern)) {
    found.push(match[0].slice(0, 40));
    if (found.length >= 3) break;
  }
  return found;
}

/**
 * Repair double-escaped layout before anything is stored.
 *
 * The model's answer arrives with literal `
` sequences where the document
 * needs real line breaks: the text was JSON-encoded twice somewhere upstream,
 * and every consumer then sees prose with visible escape pairs. Assembly has
 * normalised this since the compile fix, but the STORED artifact stayed dirty,
 * so (a) the paper in the repository is not the paper that compiles, and
 * (b) anything reading manuscript.json — a claim audit, an exporter, a person
 * — inherits the damage. Normalising on the way in is the only version of this
 * that makes the stored evidence trustworthy; the assembly-side rule stays for
 * artifacts written before it.
 */
/**
 * Repairs and reports: the returned manuscript is what is stored, and the
 * second element lists escape pairs whose meaning could not be decided.
 *
 * Returning the residue rather than swallowing it matters for the same reason
 * the platform reports discarded baseline values: an operator looking at a
 * "clean" result has no way to know that part of the text was neither repaired
 * nor examined.
 */
export function normalizeManuscriptLayout(manuscript: Manuscript): Manuscript & {
  ambiguousEscapes: string[];
} {
  // Every stored text field is scanned, bibliography included: an entry whose
  // escaped comma-newline survives is exactly as unreadable as a broken
  // paragraph, and reporting only the prose would suggest the artifact is clean.
  const residue = [
    manuscript.abstract,
    ...manuscript.sections.map((section) => section.latex),
    ...manuscript.bibliography.map((entry) => entry.bibtex),
  ].flatMap((text) => ambiguousEscapes(text));
  return {
    ...manuscript,
    ambiguousEscapes: residue,
    abstract: normalizeEscapedLayout(manuscript.abstract),
    sections: manuscript.sections.map((section) => ({
      ...section,
      heading: normalizeEscapedLayout(section.heading),
      latex: normalizeEscapedLayout(section.latex),
    })),
    bibliography: manuscript.bibliography.map((entry) => ({
      ...entry,
      bibtex: normalizeEscapedLayout(entry.bibtex),
    })),
  };
}
