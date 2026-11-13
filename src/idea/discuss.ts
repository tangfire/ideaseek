import { sha256Of } from '../core/hash.js';
import { IdeaseekError } from '../core/errors.js';
import { stableJson } from '../experiment/spec.js';

/**
 * Research Discussant (docs/AGENT_ROLES.md): structured pro/con arguments
 * over an EXISTING idea, citing persisted evidence — every argument must
 * either reference a context source or explicitly mark itself
 * `speculation` (必须引用证据或明确是推测). Platform-owned contract
 * (ADR-009: no matching ARIS skill). The envelope binds ideaId +
 * cardVersion so a revised idea forces a fresh discussion.
 */

export const IDEA_DISCUSS_SCHEMA = 'idea-discuss-v1';

export const DISCUSSION_POSITIONS = ['supported', 'contested', 'insufficient'] as const;

export interface DiscussionArgument {
  side: 'pro' | 'con';
  statement: string;
  evidence: { source: string; location: string }[];
  confidence: number;
}

export interface IdeaDiscussion {
  contract: typeof IDEA_DISCUSS_SCHEMA;
  ideaId: string;
  cardVersion: number;
  position: (typeof DISCUSSION_POSITIONS)[number];
  arguments: DiscussionArgument[];
  openQuestions: string[];
  recommendation: string;
}

export const IDEA_DISCUSS_OUTPUT_CONTRACT = [
  `IDEA DISCUSSION (${IDEA_DISCUSS_SCHEMA}) — return ONLY the envelope JSON, no prose, no fences.`,
  '{',
  '  "contract": "' + IDEA_DISCUSS_SCHEMA + '",',
  '  "ideaId": string,   // MUST equal the context value verbatim',
  '  "cardVersion": integer ≥ 1,  // MUST equal the context value verbatim',
  `  "position": ${DISCUSSION_POSITIONS.map((p) => `"${p}"`).join(' | ')},`,
  '  "arguments": [{"side": "pro" | "con", "statement": string, "evidence": [{"source": string, "location": string}], "confidence": number 0..1}] — at least 2 with ≥1 pro AND ≥1 con',
  '  "openQuestions": [string] — at least 1',
  '  "recommendation": string — what the user should do next with this idea',
  '}',
  'Rules:',
  '- Every evidence.source MUST be one of the context sources listed below, or the literal "speculation" (then location explains what is assumed). Never invent papers, specs or results.',
  '- Both sides must be argued even when the evidence leans one way — a one-sided discussion is invalid.',
].join('\n');

export interface DiscussContext {
  ideaId: string;
  cardVersion: number;
  /** Sources the model may cite (context ids + 'speculation'). */
  sources: string[];
  lines: string[];
}

export async function collectDiscussContext(root: string, ideaId: string): Promise<DiscussContext> {
  const { loadIdeaCard } = await import('./workspace.js');
  const card = await loadIdeaCard(root, ideaId);
  const lines: string[] = [];
  const sources = new Set<string>(['speculation', 'idea-card', 'question']);

  lines.push(`Idea: ${card.ideaId} v${card.version} [${card.status}]`);
  lines.push(`Hypothesis: ${card.hypothesis.statement}`);
  lines.push(`Target problem: ${card.hypothesis.targetProblem}`);
  lines.push(`Novelty claim: ${card.novelty.claim} (uncertainty: ${card.novelty.uncertainty})`);
  lines.push('Nearest comparisons:');
  for (const near of card.nearestComparisons) {
    lines.push(`  - ${near.methodId}: ${near.difference} (${near.evidence})`);
    sources.add(`comparison:${near.methodId}`);
  }
  lines.push('Mechanism chain:');
  for (const step of card.mechanismChain.steps) {
    lines.push(`  - [${step.kind}] ${step.text}`);
  }

  const { readNoveltyReport } = await import('./novelty.js');
  const novelty = await readNoveltyReport(root, ideaId);
  if (novelty) {
    lines.push(
      `Novelty report: verdict=${novelty.verdict} score=${novelty.score} — ${novelty.positioning.slice(0, 200)}`,
    );
    sources.add('novelty-report');
  } else {
    lines.push('Novelty report: none');
  }

  const { listReviews } = await import('../review/review.js');
  try {
    const reviews = await listReviews(root, ideaId);
    const ideaReviews = reviews.filter((review) => review.kind === 'idea-review');
    const latest = ideaReviews[ideaReviews.length - 1];
    if (latest && latest.contract === 'idea-review-v1') {
      lines.push(
        `Latest review: score=${latest.score} verdict=${latest.verdict} — ${latest.summary.slice(0, 200)}`,
      );
      sources.add('idea-review');
    } else {
      lines.push('Latest review: none');
    }
  } catch {
    lines.push('Latest review: none');
  }

  // Experiment evidence bound to this idea (specId starts with idea-<id>).
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  try {
    const experiments = await runtime.db.listExperiments();
    const bound = experiments.filter((doc) => doc.specId.startsWith(`idea-${ideaId}`));
    if (bound.length > 0) {
      lines.push('Experiment results:');
      for (const doc of bound) {
        const metrics = Array.isArray((doc.result as { metrics?: unknown } | null)?.metrics)
          ? ((doc.result as { metrics: { name?: unknown; value?: unknown }[] }).metrics ?? [])
              .filter(
                (metric) => typeof metric?.name === 'string' && typeof metric?.value === 'number',
              )
              .map((metric) => `${metric.name as string}=${metric.value as number}`)
              .join(', ')
          : '';
        lines.push(
          `  - ${doc.specId} v${doc.version} [${doc.status}]${metrics ? ` ${metrics}` : ''}`,
        );
        sources.add(`experiment:${doc.specId}`);
      }
    } else {
      lines.push('Experiment results: none');
    }
  } finally {
    await runtime.close();
  }

  return { ideaId, cardVersion: card.version, sources: [...sources].sort(), lines };
}

export function buildDiscussRequest(context: DiscussContext): {
  instruction: string;
  inputHash: string;
  idempotencyKey: string;
} {
  const inputHash = sha256Of(stableJson({ contract: IDEA_DISCUSS_SCHEMA, context }));
  const instruction = [
    'You are the Research Discussant (docs/AGENT_ROLES.md).',
    'Argue BOTH sides of the given idea with structured pro/con statements.',
    'Every claim cites a context source or is explicitly marked speculation.',
    '',
    '---',
    '',
    IDEA_DISCUSS_OUTPUT_CONTRACT,
    '',
    'Context (persisted, hashable sources only):',
    `Allowed evidence sources: ${context.sources.join(', ')}`,
    context.lines.join('\n'),
  ].join('\n');
  return { instruction, inputHash, idempotencyKey: `idea-discuss:${inputHash}` };
}

/** Parses + validates; binds envelope to the expected idea/version/sources. */
export function parseDiscussionOutput(output: string, context: DiscussContext): IdeaDiscussion {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `idea discussion output is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new IdeaseekError('PARSE_FAILED', 'idea discussion output must be an object');
  }
  const record = parsed as Record<string, unknown>;
  if (record.contract !== IDEA_DISCUSS_SCHEMA) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `idea discussion contract must be ${IDEA_DISCUSS_SCHEMA}, got ${String(record.contract)}`,
    );
  }
  if (record.ideaId !== context.ideaId || record.cardVersion !== context.cardVersion) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `discussion must echo ideaId ${context.ideaId} v${context.cardVersion} verbatim (a revised idea forces a fresh discussion)`,
    );
  }

  const errors: string[] = [];
  const nonEmpty = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0;

  if (!DISCUSSION_POSITIONS.includes(record.position as never)) {
    errors.push(`position must be ${DISCUSSION_POSITIONS.join(' | ')}`);
  }
  const args = record.arguments;
  if (!Array.isArray(args) || args.length < 2) {
    errors.push('arguments must have at least 2 entries');
  } else {
    const sides = new Set<string>();
    const allowed = new Set(context.sources);
    args.forEach((raw, index) => {
      const item = raw as Partial<DiscussionArgument> | null;
      const where = `arguments[${index}]`;
      if (!item || (item.side !== 'pro' && item.side !== 'con')) {
        errors.push(`${where}.side must be pro | con`);
        return;
      }
      sides.add(item.side);
      if (!nonEmpty(item.statement)) errors.push(`${where}.statement must be non-empty`);
      if (
        typeof item.confidence !== 'number' ||
        !Number.isFinite(item.confidence) ||
        item.confidence < 0 ||
        item.confidence > 1
      ) {
        errors.push(`${where}.confidence must be within [0, 1]`);
      }
      if (!Array.isArray(item.evidence) || item.evidence.length === 0) {
        errors.push(`${where}.evidence must cite a source (or "speculation")`);
      } else {
        item.evidence.forEach((ev, e) => {
          if (!ev || typeof ev !== 'object') {
            errors.push(`${where}.evidence[${e}] must be an object`);
            return;
          }
          if (!nonEmpty(ev.source) || !nonEmpty(ev.location)) {
            errors.push(`${where}.evidence[${e}] needs non-empty source and location`);
          } else if (!allowed.has(ev.source)) {
            errors.push(
              `${where}.evidence[${e}].source "${ev.source}" is not among the context sources (never invent evidence)`,
            );
          }
        });
      }
    });
    if (!sides.has('pro')) errors.push('arguments must include at least one pro side');
    if (!sides.has('con')) errors.push('arguments must include at least one con side');
  }
  if (!Array.isArray(record.openQuestions) || record.openQuestions.length === 0) {
    errors.push('openQuestions must be a non-empty array');
  } else if (record.openQuestions.some((q) => !nonEmpty(q))) {
    errors.push('openQuestions entries must be non-empty strings');
  }
  if (!nonEmpty(record.recommendation)) errors.push('recommendation must be non-empty');

  if (errors.length > 0) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `idea discussion violates contract: ${errors.slice(0, 5).join('; ')}`,
      { errors },
    );
  }
  return parsed as IdeaDiscussion;
}
