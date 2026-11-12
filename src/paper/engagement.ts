import { sha256Of } from '../core/hash.js';
import { IdeaseekError } from '../core/errors.js';
import { stableJson } from '../experiment/spec.js';
import { renderArisSkill, type LoadedArisSkill } from '../aris/skill.js';
import { WRITE_VENUES, type Manuscript } from './write.js';
import type { PaperPlanSnapshot } from './plan.js';

/**
 * Rebuttal / slides / talk workflows (Phase 4.5C, skill integration):
 * three sibling capabilities over one shared, read-only engagement
 * context — stored paper plan, stored manuscript, persisted experiment
 * snapshot and the latest persisted idea reviews (the honest stand-in for
 * external reviewer input; the hosted reviewer backends remain
 * REVIEW_UNAVAILABLE). Each contract pins back to that context so every
 * claim/answer traces to a hashable artifact.
 */

export const REBUTTAL_SCHEMA = 'rebuttal-v1';
export const SLIDES_SCHEMA = 'paper-slides-v1';
export const TALK_SCHEMA = 'paper-talk-v1';

export interface ReviewerFeedback {
  verdict: 'ACCEPT' | 'REVISE' | 'REVIEW_UNAVAILABLE';
  notes: string[];
}

export interface EvidenceRef {
  source: string;
  location: string;
}

/* ------------------------------------------------------------------ */
/* rebuttal-v1                                                         */
/* ------------------------------------------------------------------ */

export interface RebuttalPoint {
  point: string;
  response: string;
  evidence: EvidenceRef[];
}

export interface Rebuttal {
  overallResponse: string;
  pointResponses: RebuttalPoint[];
  newEvidence: EvidenceRef[];
  revisedClaims: string[];
  reviewerFeedback: ReviewerFeedback;
}

export const REBUTTAL_OUTPUT_CONTRACT = [
  `OUTPUT CONTRACT (${REBUTTAL_SCHEMA}) — return ONLY one JSON object, no prose, no fences:`,
  '{',
  '  "overallResponse": string, // non-empty framing of how the evidence base answers the concerns',
  '  "pointResponses": [{"point": string, "response": string, "evidence": [{"source": string, "location": string}]}] — at least 1; each evidence.source must come from the context (specId, protocol id, review id, plan claim)',
  '  "newEvidence": [{"source": string, "location": string, "what": string}] — may be empty; only artifacts that exist in the context',
  '  "revisedClaims": [string], // claims you would weaken/clarify (may be empty)',
  '  "reviewerFeedback": {"verdict": "ACCEPT"|"REVISE"|"REVIEW_UNAVAILABLE", "notes": [string]}',
  '}',
  'Rules:',
  '- Persisted idea reviews in the context are the ONLY reviewer input — never invent reviewer quotes beyond them.',
  '- No hosted reviewer backend: verdict must be REVIEW_UNAVAILABLE unless the context carries reviewer notes.',
].join('\n');

/* ------------------------------------------------------------------ */
/* paper-slides-v1                                                     */
/* ------------------------------------------------------------------ */

export interface Slide {
  number: number;
  title: string;
  bullets: string[];
  speakerNotes: string;
  claimSources: string[];
}

export interface SlidesDeck {
  venue: (typeof WRITE_VENUES)[number];
  talkType: 'conference' | 'seminar' | 'poster-pitch';
  slideCount: number;
  slides: Slide[];
  talkScript: string;
  timeBudgetMinutes: number;
  qaPrep: { question: string; answer: string; source: string }[];
  reviewerFeedback: ReviewerFeedback;
}

export const SLIDES_OUTPUT_CONTRACT = [
  `OUTPUT CONTRACT (${SLIDES_SCHEMA}) — return ONLY one JSON object, no prose, no fences:`,
  '{',
  `  "venue": ${WRITE_VENUES.map((venue) => `"${venue}"`).join(' | ')}, // MUST equal the stored plan venue when one exists`,
  '  "talkType": "conference" | "seminar" | "poster-pitch",',
  '  "slideCount": integer ≥ 3, // must equal slides.length',
  '  "slides": [{"number": integer ≥ 1 unique ascending, "title": string, "bullets": [string] ≥ 1, "speakerNotes": string, "claimSources": [string] ≥ 1}] — at least 3',
  '  "talkScript": string, // word-for-word script, non-empty',
  '  "timeBudgetMinutes": number > 0',
  '  "qaPrep": [{"question": string, "answer": string, "source": string}] — at least 1',
  '  "reviewerFeedback": {"verdict": "ACCEPT"|"REVISE"|"REVIEW_UNAVAILABLE", "notes": [string]}',
  '}',
  'Rules:',
  '- claimSources must cite real context ids (plan claims, specId, comparison id) — no invented sources.',
  '- No hosted reviewer backend: verdict must be REVIEW_UNAVAILABLE unless the context carries reviewer notes.',
].join('\n');

/* ------------------------------------------------------------------ */
/* paper-talk-v1                                                       */
/* ------------------------------------------------------------------ */

export interface TalkChecklistItem {
  item: string;
  status: 'pass' | 'fail' | 'na';
  detail: string;
}

export interface TalkPlan {
  readiness: 'draft' | 'ready' | 'blocked';
  checklist: TalkChecklistItem[];
  talkTrack: string;
  qAndA: { question: string; answer: string; source: string }[];
  blockers: string[];
  reviewerFeedback: ReviewerFeedback;
}

export const TALK_OUTPUT_CONTRACT = [
  `OUTPUT CONTRACT (${TALK_SCHEMA}) — return ONLY one JSON object, no prose, no fences:`,
  '{',
  '  "readiness": "draft" | "ready" | "blocked",',
  '  "checklist": [{"item": string, "status": "pass"|"fail"|"na", "detail": string}] — at least 1 (slides present, claims traceable, Q&A prepared, …)',
  '  "talkTrack": string, // the narrative spine of the talk, non-empty',
  '  "qAndA": [{"question": string, "answer": string, "source": string}] — at least 1',
  '  "blockers": [string], // non-empty only when readiness is blocked',
  '  "reviewerFeedback": {"verdict": "ACCEPT"|"REVISE"|"REVIEW_UNAVAILABLE", "notes": [string]}',
  '}',
  'Rules:',
  '- readiness "ready" requires every checklist item pass|na and zero blockers; "blocked" requires ≥1 blocker.',
  '- answers must rest on context sources (slides, plan claims, specId) — no invented results.',
  '- No hosted reviewer backend: verdict must be REVIEW_UNAVAILABLE unless the context carries reviewer notes.',
].join('\n');

/* ------------------------------------------------------------------ */
/* Shared validation helpers                                           */
/* ------------------------------------------------------------------ */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function checkReviewerFeedback(value: unknown, errors: string[], label: string): void {
  const feedback = (value as { reviewerFeedback?: unknown } | null)?.reviewerFeedback;
  if (!isObject(feedback)) {
    errors.push(`${label} reviewerFeedback must be an object`);
    return;
  }
  if (!['ACCEPT', 'REVISE', 'REVIEW_UNAVAILABLE'].includes(String(feedback.verdict))) {
    errors.push(`${label} reviewerFeedback.verdict must be ACCEPT | REVISE | REVIEW_UNAVAILABLE`);
  }
  if (!Array.isArray(feedback.notes) || feedback.notes.some((note) => !nonEmpty(note))) {
    errors.push(`${label} reviewerFeedback.notes must be non-empty strings`);
  }
}

function checkEvidenceList(value: unknown, errors: string[], label: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${label} must be a non-empty array`);
    return;
  }
  value.forEach((item, index) => {
    if (!isObject(item) || !nonEmpty(item.source) || !nonEmpty(item.location)) {
      errors.push(`${label}[${index}] needs non-empty source and location`);
    }
  });
}

export function validateRebuttal(value: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isObject(value)) return { ok: false, errors: ['rebuttal must be an object'] };
  if (!nonEmpty(value.overallResponse)) errors.push('overallResponse must be non-empty');
  if (!Array.isArray(value.pointResponses) || value.pointResponses.length === 0) {
    errors.push('pointResponses must be a non-empty array');
  } else {
    value.pointResponses.forEach((point, index) => {
      if (!isObject(point) || !nonEmpty(point.point) || !nonEmpty(point.response)) {
        errors.push(`pointResponses[${index}] needs non-empty point and response`);
      } else {
        checkEvidenceList(point.evidence, errors, `pointResponses[${index}].evidence`);
      }
    });
  }
  if (!Array.isArray(value.newEvidence)) {
    errors.push('newEvidence must be an array');
  } else {
    value.newEvidence.forEach((item, index) => {
      if (
        !isObject(item) ||
        !nonEmpty(item.source) ||
        !nonEmpty(item.location) ||
        !nonEmpty(item.what)
      ) {
        errors.push(`newEvidence[${index}] needs non-empty source, location and what`);
      }
    });
  }
  if (!Array.isArray(value.revisedClaims) || value.revisedClaims.some((c) => !nonEmpty(c))) {
    errors.push('revisedClaims must be an array of non-empty strings');
  }
  checkReviewerFeedback(value, errors, 'rebuttal');
  return { ok: errors.length === 0, errors };
}

export function validateSlidesDeck(value: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isObject(value)) return { ok: false, errors: ['slides must be an object'] };
  if (
    typeof value.venue !== 'string' ||
    !(WRITE_VENUES as readonly string[]).includes(value.venue)
  ) {
    errors.push(`venue must be one of ${WRITE_VENUES.join(' | ')}`);
  }
  if (!['conference', 'seminar', 'poster-pitch'].includes(String(value.talkType))) {
    errors.push('talkType must be conference | seminar | poster-pitch');
  }
  if (!Array.isArray(value.slides) || value.slides.length === 0) {
    errors.push('slides must be a non-empty array');
  } else {
    if (value.slideCount !== value.slides.length) {
      errors.push('slideCount must equal slides.length');
    }
    const numbers = new Set<number>();
    value.slides.forEach((slide, index) => {
      if (!isObject(slide)) {
        errors.push(`slides[${index}] must be an object`);
        return;
      }
      if (typeof slide.number !== 'number' || !Number.isInteger(slide.number) || slide.number < 1) {
        errors.push(`slides[${index}].number must be an integer >= 1`);
      } else if (numbers.has(slide.number)) {
        errors.push(`slides[${index}].number duplicates ${slide.number}`);
      } else {
        numbers.add(slide.number);
      }
      if (!nonEmpty(slide.title)) errors.push(`slides[${index}].title must be non-empty`);
      if (!nonEmpty(slide.speakerNotes))
        errors.push(`slides[${index}].speakerNotes must be non-empty`);
      if (
        !Array.isArray(slide.bullets) ||
        slide.bullets.length === 0 ||
        slide.bullets.some((b) => !nonEmpty(b))
      ) {
        errors.push(`slides[${index}].bullets must be non-empty strings`);
      }
      if (
        !Array.isArray(slide.claimSources) ||
        slide.claimSources.length === 0 ||
        slide.claimSources.some((c) => !nonEmpty(c))
      ) {
        errors.push(`slides[${index}].claimSources must be non-empty strings`);
      }
    });
    if (value.slides.length < 3) errors.push('slides must contain at least 3 slides');
  }
  if (
    typeof value.slideCount === 'number' &&
    (value.slideCount < 3 || !Number.isInteger(value.slideCount))
  ) {
    errors.push('slideCount must be an integer >= 3');
  }
  if (!nonEmpty(value.talkScript)) errors.push('talkScript must be non-empty');
  if (typeof value.timeBudgetMinutes !== 'number' || !(value.timeBudgetMinutes > 0)) {
    errors.push('timeBudgetMinutes must be > 0');
  }
  if (!Array.isArray(value.qaPrep) || value.qaPrep.length === 0) {
    errors.push('qaPrep must be a non-empty array');
  } else {
    value.qaPrep.forEach((entry, index) => {
      if (
        !isObject(entry) ||
        !nonEmpty(entry.question) ||
        !nonEmpty(entry.answer) ||
        !nonEmpty(entry.source)
      ) {
        errors.push(`qaPrep[${index}] needs non-empty question, answer and source`);
      }
    });
  }
  checkReviewerFeedback(value, errors, 'slides');
  return { ok: errors.length === 0, errors };
}

export function validateTalkPlan(value: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isObject(value)) return { ok: false, errors: ['talk plan must be an object'] };
  const readiness = String(value.readiness);
  if (!['draft', 'ready', 'blocked'].includes(readiness)) {
    errors.push('readiness must be draft | ready | blocked');
  }
  if (!Array.isArray(value.checklist) || value.checklist.length === 0) {
    errors.push('checklist must be a non-empty array');
  } else {
    value.checklist.forEach((entry, index) => {
      if (
        !isObject(entry) ||
        !nonEmpty(entry.item) ||
        !['pass', 'fail', 'na'].includes(String(entry.status)) ||
        !nonEmpty(entry.detail)
      ) {
        errors.push(`checklist[${index}] needs non-empty item, pass|fail|na status and detail`);
      }
    });
  }
  if (!nonEmpty(value.talkTrack)) errors.push('talkTrack must be non-empty');
  if (!Array.isArray(value.qAndA) || value.qAndA.length === 0) {
    errors.push('qAndA must be a non-empty array');
  } else {
    value.qAndA.forEach((entry, index) => {
      if (
        !isObject(entry) ||
        !nonEmpty(entry.question) ||
        !nonEmpty(entry.answer) ||
        !nonEmpty(entry.source)
      ) {
        errors.push(`qAndA[${index}] needs non-empty question, answer and source`);
      }
    });
  }
  if (!Array.isArray(value.blockers) || value.blockers.some((b) => !nonEmpty(b))) {
    errors.push('blockers must be an array of non-empty strings');
  } else {
    const failing = Array.isArray(value.checklist)
      ? value.checklist.some((entry) => isObject(entry) && String(entry.status) === 'fail')
      : false;
    if (readiness === 'ready' && (value.blockers.length > 0 || failing)) {
      errors.push('readiness "ready" requires zero blockers and no failing checklist items');
    }
    if (readiness === 'blocked' && value.blockers.length === 0) {
      errors.push('readiness "blocked" requires at least one blocker');
    }
    if (readiness === 'draft' && value.blockers.length > 0) {
      errors.push('readiness "draft" must not carry blockers (use blocked)');
    }
  }
  checkReviewerFeedback(value, errors, 'talk');
  return { ok: errors.length === 0, errors };
}

/* ------------------------------------------------------------------ */
/* Shared engagement context                                            */
/* ------------------------------------------------------------------ */

export interface EngagementContext {
  question: string;
  plan: { venue: string; contribution: string; claims: string[]; sections: string[] } | null;
  manuscript: { title: string; abstract: string } | null;
  slides: { venue: string; slideCount: number; title: string } | null;
  snapshot: PaperPlanSnapshot;
  /** Latest persisted idea reviews (honest reviewer stand-in). */
  reviews: { ideaId: string; kind: string; score?: number; verdict?: string; summary: string }[];
}

async function readJsonIfPresent(path: string): Promise<unknown | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

export async function collectEngagementContext(root: string): Promise<EngagementContext> {
  const { collectPaperPlanSnapshot } = await import('./plan.js');
  const { join } = await import('node:path');
  const snapshot = await collectPaperPlanSnapshot(root);

  const planRaw = await readJsonIfPresent(join(root, 'reports', 'paper', 'plan.json'));
  let plan: EngagementContext['plan'] = null;
  if (isObject(planRaw) && isObject(planRaw.plan)) {
    const inner = planRaw.plan as Record<string, unknown>;
    if (typeof inner.venue === 'string' && typeof inner.contribution === 'string') {
      plan = {
        venue: inner.venue,
        contribution: inner.contribution,
        claims: Array.isArray(inner.claimsEvidence)
          ? inner.claimsEvidence
              .map((claim) =>
                isObject(claim) && typeof claim.claim === 'string' ? claim.claim : null,
              )
              .filter((claim): claim is string => claim !== null)
          : [],
        sections: Array.isArray(inner.structure)
          ? inner.structure
              .map((section) =>
                isObject(section) && typeof section.section === 'string' ? section.section : null,
              )
              .filter((section): section is string => section !== null)
          : [],
      };
    }
  }

  const msRaw = await readJsonIfPresent(join(root, 'reports', 'paper', 'manuscript.json'));
  let manuscript: EngagementContext['manuscript'] = null;
  if (isObject(msRaw) && isObject(msRaw.manuscript)) {
    const inner = msRaw.manuscript as Record<string, unknown>;
    if (typeof inner.title === 'string' && typeof inner.abstract === 'string') {
      manuscript = { title: inner.title, abstract: inner.abstract };
    }
  }

  const slidesRaw = await readJsonIfPresent(join(root, 'reports', 'paper', 'slides.json'));
  let slides: EngagementContext['slides'] = null;
  if (isObject(slidesRaw) && isObject(slidesRaw.slides)) {
    const inner = slidesRaw.slides as Record<string, unknown>;
    if (typeof inner.venue === 'string' && typeof inner.slideCount === 'number') {
      const first = Array.isArray(inner.slides) ? inner.slides[0] : null;
      slides = {
        venue: inner.venue,
        slideCount: inner.slideCount,
        title: isObject(first) && typeof first.title === 'string' ? first.title : '',
      };
    }
  }

  const reviews: EngagementContext['reviews'] = [];
  const { listReviews } = await import('../review/review.js');
  for (const idea of snapshot.ideas) {
    try {
      const forIdea = await listReviews(root, idea.ideaId);
      for (const review of forIdea) {
        if (review.kind !== 'idea-review') continue;
        reviews.push({
          ideaId: idea.ideaId,
          kind: review.kind,
          score: review.score,
          verdict: review.verdict,
          summary: review.summary,
        });
      }
    } catch {
      // unreadable review history → skip (context stays honest)
    }
  }
  reviews.sort((a, b) => a.ideaId.localeCompare(b.ideaId));

  return { question: snapshot.question, plan, manuscript, slides, snapshot, reviews };
}

export function renderEngagementContext(
  context: EngagementContext,
  mode: 'rebuttal' | 'slides' | 'talk',
): string {
  const lines = [`Research question: ${context.question}`];
  lines.push(
    context.plan
      ? `Stored plan: venue=${context.plan.venue} contribution="${context.plan.contribution}"`
      : 'Stored plan: none',
  );
  lines.push(
    context.manuscript
      ? `Stored manuscript: title="${context.manuscript.title}"`
      : 'Stored manuscript: none',
  );
  if (context.plan && context.plan.claims.length > 0) {
    lines.push('Plan claims:');
    for (const claim of context.plan.claims.slice(0, 12)) lines.push(`  - ${claim}`);
  }
  if (context.slides) {
    lines.push(
      `Stored slides: venue=${context.slides.venue} slideCount=${context.slides.slideCount}`,
    );
  } else {
    lines.push('Stored slides: none');
  }
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
  if (context.snapshot.protocol) {
    lines.push(
      `Locked protocol: ${context.snapshot.protocol.protocolId} (${context.snapshot.protocol.protocolHash})`,
    );
  } else {
    lines.push('Locked protocol: none');
  }
  if (context.reviews.length > 0) {
    lines.push('Persisted idea reviews (the only reviewer input):');
    for (const review of context.reviews.slice(0, 8)) {
      lines.push(
        `  - ${review.ideaId} ${review.kind}` +
          (review.score !== undefined ? ` score=${review.score}` : '') +
          (review.verdict ? ` verdict=${review.verdict}` : '') +
          `: ${review.summary.slice(0, 240)}`,
      );
    }
  } else {
    lines.push('Persisted idea reviews: none');
  }
  if (mode === 'slides') {
    lines.push('Slide decks must argue the plan claims; cite claim/spec ids in claimSources.');
  }
  if (mode === 'talk') {
    lines.push(
      'Checklist must cover: slides present, claims traceable to sources, Q&A prepared, timing fit.',
    );
  }
  return lines.join('\n');
}

export interface EngagementRequest {
  instruction: string;
  context: string;
  inputHash: string;
  idempotencyKey: string;
}

export function buildEngagementRequest(
  skill: LoadedArisSkill,
  context: EngagementContext,
  mode: 'rebuttal' | 'slides' | 'talk',
  contract: string,
): EngagementRequest {
  const rendered = renderEngagementContext(context, mode);
  const inputHash = sha256Of(stableJson({ contract, skillSha256: skill.sha256, context, mode }));
  const instruction = [
    renderArisSkill(skill, { arguments: rendered }),
    '',
    '---',
    '',
    mode === 'rebuttal'
      ? REBUTTAL_OUTPUT_CONTRACT
      : mode === 'slides'
        ? SLIDES_OUTPUT_CONTRACT
        : TALK_OUTPUT_CONTRACT,
    '',
    'Context (persisted, hashable sources only):',
    rendered,
  ].join('\n');
  return {
    instruction,
    context: rendered,
    inputHash,
    idempotencyKey: `${contract}:${inputHash}`,
  };
}

function parseAndValidate(
  output: string,
  contract: string,
  validate: (value: unknown) => { ok: boolean; errors: string[] },
): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `${contract} output is not valid JSON: ${(error as Error).message}`,
    );
  }
  const validation = validate(parsed);
  if (!validation.ok) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `${contract} output violates the contract: ${validation.errors.slice(0, 5).join('; ')}`,
      { errors: validation.errors },
    );
  }
  return parsed;
}

export function parseRebuttal(output: string): Rebuttal {
  return parseAndValidate(output, REBUTTAL_SCHEMA, validateRebuttal) as Rebuttal;
}

export function parseSlidesDeck(output: string, context: EngagementContext): SlidesDeck {
  const deck = parseAndValidate(output, SLIDES_SCHEMA, validateSlidesDeck) as SlidesDeck;
  if (context.plan && deck.venue !== context.plan.venue) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `paper-slides venue "${deck.venue}" does not match the stored plan venue "${context.plan.venue}"`,
      { expected: context.plan.venue, actual: deck.venue },
    );
  }
  return deck;
}

export function parseTalkPlan(output: string): TalkPlan {
  return parseAndValidate(output, TALK_SCHEMA, validateTalkPlan) as TalkPlan;
}

/** Every persisted artifact this engagement context is built from. */
export function engagementAnchors(context: EngagementContext): string[] {
  const anchors: string[] = [];
  if (context.plan) anchors.push(`plan:${context.plan.venue}`);
  if (context.manuscript) anchors.push(`manuscript:${context.manuscript.title.slice(0, 40)}`);
  if (context.slides) anchors.push(`slides:${context.slides.slideCount}`);
  for (const experiment of context.snapshot.experiments) anchors.push(`spec:${experiment.specId}`);
  for (const review of context.reviews) anchors.push(`review:${review.ideaId}`);
  return anchors;
}

export type { Manuscript };
