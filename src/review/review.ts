import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { sha256Of, type ContentHash } from '../core/hash.js';
import { ensureDir, writeFileAtomic } from '../core/atomic.js';
import { stableJson } from '../experiment/spec.js';
import { loadArisSkill, renderArisSkill, type LoadedArisSkill } from '../aris/skill.js';
import type { HarnessAdapter } from '../dsh/adapter.js';
import type { ProjectRuntime } from '../workflow/runtime.js';
import {
  collectReviewInputs,
  type CollectedReviewInputs,
  type ReviewInput,
  type ReviewKind,
  type ReviewTarget,
} from './inputs.js';
import { assertAgainstSchema } from '../core/schema/index.js';

/**
 * Fresh-context independent reviewer + experiment audit (Phase 4.5,
 * docs/ARIS_INTEGRATION_PLAN §交叉评审原则): the vendored ARIS skills
 * `auto-review-loop` (idea review) and `experiment-audit` (integrity audit)
 * supply the review methodology; this module owns the IdeaSeek contract —
 * read-only artifact inputs with hashes, a fresh one-shot harness task per
 * review (no prior review content, no executor summary — reviewer
 * independence), a versioned Review artifact that never overwrites an older
 * review, and a Decision/Event-trail RunEvent. Execution always goes through
 * HarnessAdapter (no second agent loop).
 *
 * Hard rules (goals 4–8):
 * - the artifact records reviewer identity (actual model/session/runtime),
 *   route (skill + sha + profile + harness), scope (refs/unavailable/gaps)
 *   and every input's content hash plus the combined inputHash;
 * - the reviewer NEVER writes Idea/protocol/metric/handoff state — this
 *   module only writes knowledge/reviews/** and appends one RunEvent;
 * - HarnessBlockError (quota/auth/network) and PARSE_FAILED propagate before
 *   anything is persisted, so a rerun recovers cleanly;
 * - reviews append: review-<kind>-v<N>.json, existing versions untouched.
 */

export const REVIEW_IDEA_SCHEMA = 'idea-review-v1';
export const REVIEW_AUDIT_SCHEMA = 'experiment-audit-v1';

export type IdeaReviewVerdict = 'ready' | 'almost' | 'not ready';

export interface IdeaReviewWeakness {
  severity: string;
  detail: string;
  minimumFix: string;
}

export type AuditCheckId =
  'gt_provenance' | 'score_normalization' | 'result_existence' | 'dead_code' | 'scope';

export type AuditStatus = 'PASS' | 'WARN' | 'FAIL';

export interface AuditCheck {
  id: AuditCheckId;
  status: AuditStatus;
  details: string;
  evidence: string;
}

export type EvalType =
  'real_gt' | 'synthetic_proxy' | 'self_supervised_proxy' | 'simulation_only' | 'human_eval';

export interface ReviewerIdentity {
  /** Model the runtime actually reported (never the configured alias). */
  model: string | null;
  sessionId: string | null;
  runtime: string;
}

export interface ReviewerRoute {
  skill: string;
  skillSha256: string;
  profile: string;
  harness: string;
}

export interface ReviewScopeRecord {
  /** Artifact refs the reviewer saw (verbatim). */
  refs: string[];
  /** Expected-but-absent artifacts (honest gaps). */
  unavailable: string[];
  /** Cited papers with no matching PaperCard (never invented). */
  unmatchedPaperRefs: string[];
}

interface ReviewEnvelope {
  reviewId: string;
  version: number;
  target: ReviewTarget;
  scope: ReviewScopeRecord;
  reviewer: { identity: ReviewerIdentity; route: ReviewerRoute; freshContext: true };
  inputs: { kind: string; ref: string; sha256: string }[];
  inputHash: ContentHash;
  /** Verbatim reviewer response (ARIS review tracing: never summarized). */
  raw: string;
  generatedAt: number;
}

export type ReviewArtifact = ReviewEnvelope &
  (
    | {
        contract: typeof REVIEW_IDEA_SCHEMA;
        kind: 'idea-review';
        score: number;
        verdict: IdeaReviewVerdict;
        weaknesses: IdeaReviewWeakness[];
        summary: string;
      }
    | {
        contract: typeof REVIEW_AUDIT_SCHEMA;
        kind: 'experiment-audit';
        checks: AuditCheck[];
        evalType: EvalType;
        overall: AuditStatus;
        summary: string;
      }
  );

const SKILL_BY_KIND: Record<ReviewKind, string> = {
  'idea-review': 'auto-review-loop',
  'experiment-audit': 'experiment-audit',
};

function schemaFor(kind: ReviewKind): string {
  return kind === 'idea-review' ? REVIEW_IDEA_SCHEMA : REVIEW_AUDIT_SCHEMA;
}

const OUTPUT_CONTRACTS: Record<ReviewKind, string> = {
  'idea-review': `
# IdeaSeek output contract (${REVIEW_IDEA_SCHEMA})

You are running inside IdeaSeek with NO tools — do not attempt file access,
tool calls or multi-round looping; answer in ONE reply.

Reply with ONE JSON object and nothing else:

{"score": <1-10>, "verdict": "ready|almost|not ready",
 "weaknesses": [{"severity": "...", "detail": "...", "minimumFix": "..."}],
 "summary": "..."}

Rules:
- score: number in [1, 10] (anchor: 6+ = the work genuinely holds up).
- verdict: exactly "ready", "almost", or "not ready".
- weaknesses: ranked most-severe first; each entry needs non-empty severity,
  detail and the MINIMUM fix (experiment, analysis or reframing).
  An empty array is allowed ONLY when verdict is "ready".
- summary: 2-5 honest sentences grounded ONLY in the artifacts above —
  never invent results, papers or numbers.
- No prose, no markdown fence, no commentary outside the JSON object.
`.trim(),
  'experiment-audit': `
# IdeaSeek output contract (${REVIEW_AUDIT_SCHEMA})

You are running inside IdeaSeek with NO tools — do not attempt file access,
tool calls or multi-round looping; answer in ONE reply.

Reply with ONE JSON object and nothing else:

{"checks": [
  {"id": "gt_provenance", "status": "PASS|WARN|FAIL", "details": "...", "evidence": "..."},
  {"id": "score_normalization", "status": "PASS|WARN|FAIL", "details": "...", "evidence": "..."},
  {"id": "result_existence", "status": "PASS|WARN|FAIL", "details": "...", "evidence": "..."},
  {"id": "dead_code", "status": "PASS|WARN|FAIL", "details": "...", "evidence": "..."},
  {"id": "scope", "status": "PASS|WARN|FAIL", "details": "...", "evidence": "..."}],
 "evalType": "real_gt|synthetic_proxy|self_supervised_proxy|simulation_only|human_eval",
 "overall": "PASS|WARN|FAIL",
 "summary": "..."}

Rules:
- checks must contain EXACTLY the five ids above, each exactly once, with a
  valid status and non-empty details; evidence must cite one of the input
  artifact refs above (or ref#field) — never invent files.
- evalType classifies the evaluation ground truth (checklist F).
- overall must equal the worst status among the checks
  (any FAIL → FAIL; else any WARN → WARN; else PASS).
- summary: an honest 2-5 sentence conclusion grounded ONLY in the artifacts.
- No prose, no markdown fence, no commentary outside the JSON object.
`.trim(),
};

export interface ReviewRequest {
  instruction: string;
  manifest: string;
  inputHash: ContentHash;
  outputSchema: string;
}

/** Assembles the harness request: ARIS skill body + IdeaSeek contract + raw artifacts. */
export function buildReviewRequest(opts: {
  kind: ReviewKind;
  skill: LoadedArisSkill;
  collected: CollectedReviewInputs;
}): ReviewRequest {
  const { kind, skill, collected } = opts;
  const target = collected.target;
  const targetLine = `idea ${target.ideaId}${
    target.cardVersion !== null ? ` (card v${target.cardVersion})` : ''
  }`;
  const inputHash = sha256Of(
    stableJson({
      contract: schemaFor(kind),
      skillSha256: skill.sha256,
      target: { ideaId: target.ideaId, cardVersion: target.cardVersion },
      inputs: collected.inputs.map(({ kind: inputKind, ref, sha256 }) => ({
        kind: inputKind,
        ref,
        sha256,
      })),
      unavailable: collected.unavailable,
      unmatchedPaperRefs: collected.unmatchedPaperRefs,
    }),
  );
  const manifest = [
    ...collected.inputs.map((input) => `${input.kind}\t${input.ref}\t${input.sha256}`),
    ...collected.unavailable.map((ref) => `unavailable\t${ref}\t-`),
    ...collected.unmatchedPaperRefs.map((ref) => `unmatched-papercard\t${ref}\t-`),
  ].join('\n');
  const instruction = [
    renderArisSkill(skill, { arguments: `${targetLine} — review kind: ${kind}` }),
    '',
    '---',
    '',
    OUTPUT_CONTRACTS[kind],
    '',
    `Review target: ${targetLine}`,
    `Review kind: ${kind}`,
    '',
    'Independence (fresh context):',
    '- This is a fresh review: NO prior review, NO executor summary, NO conversation history is provided.',
    '- Judge only from the raw artifacts below — they are transmitted verbatim and unfiltered.',
    '- You have no tools in this session; do not attempt file access or follow-up rounds.',
    '',
    'Artifacts (verbatim):',
    ...collected.inputs.flatMap((input) => [
      '',
      `### ${input.kind}: ${input.ref} (${input.sha256})`,
      input.content,
    ]),
    '',
    'Unavailable (expected but absent):',
    ...(collected.unavailable.length > 0
      ? collected.unavailable.map((ref) => `- ${ref}`)
      : ['- (none)']),
    ...(collected.unmatchedPaperRefs.length > 0
      ? [
          '',
          'Cited papers with no matching PaperCard (do not invent their content):',
          ...collected.unmatchedPaperRefs.map((ref) => `- ${ref}`),
        ]
      : []),
  ].join('\n');
  return { instruction, manifest, inputHash, outputSchema: schemaFor(kind) };
}

const AUDIT_IDS: readonly AuditCheckId[] = [
  'gt_provenance',
  'score_normalization',
  'result_existence',
  'dead_code',
  'scope',
];
const AUDIT_STATUSES: readonly AuditStatus[] = ['PASS', 'WARN', 'FAIL'];
const EVAL_TYPES: readonly EvalType[] = [
  'real_gt',
  'synthetic_proxy',
  'self_supervised_proxy',
  'simulation_only',
  'human_eval',
];

function validateIdeaReviewPayload(record: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (
    typeof record.score !== 'number' ||
    !Number.isFinite(record.score) ||
    record.score < 1 ||
    record.score > 10
  ) {
    errors.push('score must be a number in [1, 10]');
  }
  const verdict = record.verdict;
  if (!['ready', 'almost', 'not ready'].includes(String(verdict))) {
    errors.push('verdict must be ready|almost|not ready');
  }
  const weaknesses = record.weaknesses;
  if (!Array.isArray(weaknesses)) {
    errors.push('weaknesses must be an array');
  } else {
    for (const [index, entry] of weaknesses.entries()) {
      const item = entry as Partial<IdeaReviewWeakness>;
      if (typeof item?.severity !== 'string' || !item.severity.trim()) {
        errors.push(`weaknesses[${index}].severity must be a non-empty string`);
      }
      if (typeof item?.detail !== 'string' || !item.detail.trim()) {
        errors.push(`weaknesses[${index}].detail must be a non-empty string`);
      }
      if (typeof item?.minimumFix !== 'string' || !item.minimumFix.trim()) {
        errors.push(`weaknesses[${index}].minimumFix must be a non-empty string`);
      }
    }
    if (verdict !== 'ready' && weaknesses.length === 0) {
      errors.push('weaknesses must have ≥1 entry unless verdict is "ready"');
    }
  }
  if (typeof record.summary !== 'string' || !record.summary.trim()) {
    errors.push('summary must be a non-empty string');
  }
  return errors;
}

function worstAuditStatus(checks: AuditCheck[]): AuditStatus | null {
  const statuses = checks
    .filter((check) => (AUDIT_STATUSES as readonly string[]).includes(check.status))
    .map((check) => check.status);
  if (statuses.length === 0) return null;
  if (statuses.includes('FAIL')) return 'FAIL';
  if (statuses.includes('WARN')) return 'WARN';
  return 'PASS';
}

function validateExperimentAuditPayload(record: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const checks = record.checks;
  const parsed: AuditCheck[] = [];
  if (!Array.isArray(checks)) {
    errors.push('checks must be an array');
  } else {
    const seen = new Set<string>();
    for (const [index, entry] of checks.entries()) {
      const item = entry as Partial<AuditCheck>;
      const where = `checks[${index}]`;
      if (typeof item?.id !== 'string' || !(AUDIT_IDS as readonly string[]).includes(item.id)) {
        errors.push(`${where}.id must be one of ${AUDIT_IDS.join('|')}`);
        continue;
      }
      if (seen.has(item.id)) errors.push(`${where}.id "${item.id}" duplicated`);
      seen.add(item.id);
      if (!(AUDIT_STATUSES as readonly string[]).includes(String(item?.status))) {
        errors.push(`${where}.status must be PASS|WARN|FAIL`);
      }
      if (typeof item?.details !== 'string' || !item.details.trim()) {
        errors.push(`${where}.details must be a non-empty string`);
      }
      if (typeof item?.evidence !== 'string' || !item.evidence.trim()) {
        errors.push(`${where}.evidence must cite an input artifact`);
      }
      parsed.push(item as AuditCheck);
    }
    for (const id of AUDIT_IDS) {
      if (!seen.has(id)) errors.push(`checks missing id "${id}"`);
    }
  }
  if (!(EVAL_TYPES as readonly string[]).includes(String(record.evalType))) {
    errors.push(`evalType must be ${EVAL_TYPES.join('|')}`);
  }
  if (!(AUDIT_STATUSES as readonly string[]).includes(String(record.overall))) {
    errors.push('overall must be PASS|WARN|FAIL');
  }
  if (Array.isArray(checks) && checks.length === AUDIT_IDS.length) {
    const worst = worstAuditStatus(parsed);
    if (worst && record.overall !== worst) {
      errors.push(`overall must equal the worst check status (${worst})`);
    }
  }
  if (typeof record.summary !== 'string' || !record.summary.trim()) {
    errors.push('summary must be a non-empty string');
  }
  return errors;
}

export interface ParseReviewContext {
  kind: ReviewKind;
  target: ReviewTarget;
  scope: ReviewScopeRecord;
  inputs: { kind: string; ref: string; sha256: string }[];
  inputHash: ContentHash;
  skill: { name: string; sha256: string };
  identity: ReviewerIdentity;
  routeHarness: string;
  version: number;
  now: number;
}

/**
 * Parses and validates the harness output. Non-JSON or a contract violation
 * is PARSE_FAILED — nothing is written, so a rerun starts clean.
 */
export function parseReviewOutput(output: string, ctx: ParseReviewContext): ReviewArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `${ctx.kind} output is not JSON: ${output.slice(0, 160)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new IdeaseekError('PARSE_FAILED', `${ctx.kind} output must be a JSON object`);
  }
  const record = parsed as Record<string, unknown>;
  const errors =
    ctx.kind === 'idea-review'
      ? validateIdeaReviewPayload(record)
      : validateExperimentAuditPayload(record);
  if (errors.length > 0) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `${ctx.kind} failed validation: ${errors.slice(0, 4).join('; ')}`,
    );
  }
  // Defense in depth (JSON Schema authority): the semantic checks ran
  // first; the shared contract re-checks structure as a subset gate.
  assertAgainstSchema(
    ctx.kind === 'idea-review' ? 'idea-review-v1' : 'experiment-audit-v1',
    record,
  );

  const envelope: ReviewEnvelope = {
    reviewId: `rv-${ctx.kind}-${ctx.target.ideaId}-v${ctx.version}`,
    version: ctx.version,
    target: ctx.target,
    scope: ctx.scope,
    reviewer: {
      identity: ctx.identity,
      route: {
        skill: ctx.skill.name,
        skillSha256: ctx.skill.sha256,
        profile: 'reviewer',
        harness: ctx.routeHarness,
      },
      freshContext: true,
    },
    inputs: ctx.inputs,
    inputHash: ctx.inputHash,
    raw: output,
    generatedAt: ctx.now,
  };

  if (ctx.kind === 'idea-review') {
    return {
      ...envelope,
      contract: REVIEW_IDEA_SCHEMA,
      kind: 'idea-review',
      score: record.score as number,
      verdict: record.verdict as IdeaReviewVerdict,
      weaknesses: record.weaknesses as IdeaReviewWeakness[],
      summary: record.summary as string,
    };
  }
  return {
    ...envelope,
    contract: REVIEW_AUDIT_SCHEMA,
    kind: 'experiment-audit',
    checks: record.checks as AuditCheck[],
    evalType: record.evalType as EvalType,
    overall: record.overall as AuditStatus,
    summary: record.summary as string,
  };
}

export function reviewDir(root: string, ideaId: string): string {
  return join(root, 'knowledge', 'reviews', ideaId);
}

export function reviewPath(
  root: string,
  ideaId: string,
  kind: ReviewKind,
  version: number,
): string {
  return join(reviewDir(root, ideaId), `${kind}-v${version}.json`);
}

/** Reads every persisted review for an idea, oldest first (append-only history). */
export async function listReviews(root: string, ideaId: string): Promise<ReviewArtifact[]> {
  const dir = reviewDir(root, ideaId);
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: ReviewArtifact[] = [];
  for (const name of names) {
    if (!/^(idea-review|experiment-audit)-v\d+\.json$/.test(name)) continue;
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), 'utf8')) as ReviewArtifact;
      if (parsed.contract === REVIEW_IDEA_SCHEMA || parsed.contract === REVIEW_AUDIT_SCHEMA) {
        out.push(parsed);
      }
    } catch {
      continue;
    }
  }
  out.sort((a, b) => a.version - b.version || a.kind.localeCompare(b.kind));
  return out;
}

function nextVersion(reviews: ReviewArtifact[], kind: ReviewKind): number {
  const versions = reviews.filter((review) => review.kind === kind).map((review) => review.version);
  return versions.length > 0 ? Math.max(...versions) + 1 : 1;
}

export interface RunReviewOptions {
  runtime: ProjectRuntime;
  ideaId: string;
  kind: ReviewKind;
  harness: HarnessAdapter;
  /** Re-review identical inputs as a NEW append-only version. */
  force?: boolean;
  signal?: AbortSignal;
}

export interface RunReviewResult {
  artifact: ReviewArtifact;
  path: string;
  version: number;
  reused: boolean;
  eventSeq: number | null;
}

async function appendReviewEvent(
  runtime: ProjectRuntime,
  artifact: ReviewArtifact,
  path: string,
): Promise<number | null> {
  const run = await runtime.db.getLatestRun(runtime.project.id);
  if (!run) return null;
  const status = artifact.kind === 'idea-review' ? artifact.verdict : artifact.overall;
  const detail =
    artifact.kind === 'idea-review'
      ? `score ${artifact.score} ${artifact.verdict}`
      : `overall ${artifact.overall}`;
  const rel = relative(runtime.paths.root, path).split('\\').join('/');
  const event = await runtime.db.appendEvent({
    runId: run.runId,
    phase: 'REVIEW',
    objectId: `idea:${artifact.target.ideaId}`,
    role: 'reviewer',
    eventType: 'review',
    summary:
      `${artifact.kind} idea ${artifact.target.ideaId} v${artifact.version}: ${detail} — ` +
      `${artifact.reviewer.route.skill}@${artifact.reviewer.route.skillSha256.slice(0, 12)} ` +
      `via ${artifact.reviewer.identity.runtime} ` +
      `(${artifact.reviewer.identity.model ?? 'unknown model'}, fresh context) · ${rel}`,
    status,
  });
  return event.seq;
}

/**
 * Runs one fresh-context review: skill integrity first (SKILL_TAMPERED fails
 * closed before any model call), read-only input collection, idempotent reuse
 * of an identical-input review, one self-contained harness task, contract
 * validation, append-only persistence and a Decision/Event-trail RunEvent.
 */
export async function runReview(opts: RunReviewOptions): Promise<RunReviewResult> {
  const { runtime, ideaId, kind, harness, force = false, signal } = opts;
  const root = runtime.paths.root;

  // 1. Skill integrity BEFORE any model call.
  const skill = await loadArisSkill(SKILL_BY_KIND[kind]);

  // 2. Read-only input collection (IdeaCard required; gaps recorded honestly).
  const collected = await collectReviewInputs(runtime, ideaId, kind);
  if (
    kind === 'experiment-audit' &&
    !collected.inputs.some(
      (input) => input.kind === 'experiment-report' || input.kind === 'run-result',
    )
  ) {
    throw new IdeaseekError(
      'DEPENDENCY_NOT_MET',
      `idea ${ideaId} has no experiment outputs to audit (run experiments and ideaseek idea analyze ${ideaId} first)`,
    );
  }

  const request = buildReviewRequest({ kind, skill, collected });
  const scope: ReviewScopeRecord = {
    refs: collected.inputs.map((input) => input.ref),
    unavailable: collected.unavailable,
    unmatchedPaperRefs: collected.unmatchedPaperRefs,
  };
  const inputsMeta = collected.inputs.map(({ kind: inputKind, ref, sha256 }) => ({
    kind: inputKind,
    ref,
    sha256,
  }));

  // 3. Idempotent reuse: same inputs already reviewed → no second model call.
  const existing = await listReviews(root, ideaId);
  if (!force) {
    const hits = existing.filter(
      (review) => review.kind === kind && review.inputHash === request.inputHash,
    );
    const hit = hits[hits.length - 1];
    if (hit) {
      return {
        artifact: hit,
        path: reviewPath(root, ideaId, kind, hit.version),
        version: hit.version,
        reused: true,
        eventSeq: null,
      };
    }
  }
  const version = nextVersion(existing, kind);

  // 4. Fresh-context dispatch: one self-contained runTask, never carrying
  //    prior review content (reviewer independence — ARIS shared-references/
  //    reviewer-independence.md: raw artifacts, no executor summary).
  const result = await harness.runTask(
    {
      runId: `review:idea:${ideaId}`,
      taskId: `review-${kind}-${ideaId}-v${version}`,
      profile: 'reviewer',
      instruction: request.instruction,
      inputs: [{ kind: 'text', name: 'review_input_manifest', content: request.manifest }],
      outputSchema: request.outputSchema,
      budget: { timeoutMs: 120_000, maxOutputTokens: 8_192 },
      idempotencyKey: `review:${kind}:idea:${ideaId}:v${version}:${request.inputHash}`,
    },
    undefined,
    signal,
  );

  // 5. Contract validation stamps the envelope; PARSE_FAILED writes nothing.
  const artifact = parseReviewOutput(result.output, {
    kind,
    target: collected.target,
    scope,
    inputs: inputsMeta,
    inputHash: request.inputHash,
    skill: { name: skill.name, sha256: skill.sha256 },
    identity: {
      model: result.model,
      sessionId: result.sessionId ?? null,
      runtime: result.runtime.kind,
    },
    routeHarness: harness.kind,
    version,
    now: Date.now(),
  });

  // 6. Append-only persistence: a NEW versioned file; existing files are
  //    never rewritten (goal 8 — old and new reviews coexist).
  const path = reviewPath(root, ideaId, kind, version);
  await ensureDir(dirname(path));
  await writeFileAtomic(path, `${JSON.stringify(artifact, null, 2)}\n`);

  // 7. Decision/Event trail (no run yet → file-level review only).
  const eventSeq = await appendReviewEvent(runtime, artifact, path);

  return { artifact, path, version, reused: false, eventSeq };
}

export type { ReviewInput, ReviewKind, ReviewTarget };
