import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Of } from '../core/hash.js';
import { IdeaseekError } from '../core/errors.js';
import { stableJson } from '../experiment/spec.js';

/**
 * Synthesis Lead (docs/AGENT_ROLES.md): consolidates each role's inputs —
 * round candidates, idea discussions, novelty verdicts, failure
 * boundaries, the mechanism graph — into a final candidate set with
 * explicit tradeoff reasons. Two machine-enforced boundaries:
 * 1) EVERY input ref must be covered by a selection (advance|merge|drop)
 *    — the lead cannot silently delete candidates;
 * 2) when the context carries failure opinions, at least one must be
 *    retained — 不能删除竞争解释和失败意见.
 * Platform-owned contract (ADR-009: no matching ARIS skill).
 */

export const CONSOLIDATION_SCHEMA = 'synthesis-lead-v1';

export interface ConsolidationSelection {
  ref: string;
  decision: 'advance' | 'merge' | 'drop';
  rationale: string;
  evidence: { source: string; location: string }[];
}

export interface Consolidation {
  contract: typeof CONSOLIDATION_SCHEMA;
  selections: ConsolidationSelection[];
  mergedInto: { source: string; target: string; reason: string }[];
  retainedCompetingExplanations: string[];
  retainedFailureOpinions: string[];
  recommendation: string;
}

export const CONSOLIDATION_OUTPUT_CONTRACT = [
  `SYNTHESIS LEAD (${CONSOLIDATION_SCHEMA}) — return ONLY the envelope JSON, no prose, no fences.`,
  '{',
  '  "contract": "' + CONSOLIDATION_SCHEMA + '",',
  '  "selections": [{"ref": string, "decision": "advance" | "merge" | "drop", "rationale": string, "evidence": [{"source": string, "location": string}]}] — MUST cover EVERY input ref exactly once (see context list); may be empty only when there are no inputs',
  '  "mergedInto": [{"source": ref, "target": ref, "reason": string}] — may be empty; a "merge" decision must name its target here',
  '  "retainedCompetingExplanations": [string] — at least 1 (never delete competing explanations; write "none declared in inputs" when truly absent)',
  '  "retainedFailureOpinions": [string] — at least 1 when the context lists failure opinions (cite them; empty only when none exist)',
  '  "recommendation": string — the single next move for the user',
  '}',
  'Rules:',
  '- Every evidence.source MUST be one of the context sources below (or "speculation").',
  '- Dropping a candidate requires a rationale grounded in evidence — never drop silently.',
].join('\n');

export interface ConsolidationContext {
  /** All input refs that selections must cover. */
  refs: string[];
  /** Failure opinion count (drives the retention rule). */
  failureOpinions: number;
  sources: string[];
  lines: string[];
}

export async function collectConsolidationContext(root: string): Promise<ConsolidationContext> {
  const sources = new Set<string>(['speculation', 'mechanism-graph']);
  const lines: string[] = [];
  const refs: string[] = [];
  let failureOpinions = 0;

  // Latest ideation round candidates (the lead must account for each).
  const roundsRoot = join(root, 'knowledge', 'ideation-rounds');
  let latestRound: string | null = null;
  try {
    const rounds = (await readdir(roundsRoot))
      .filter((name) => /^r\d+$/.test(name))
      .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    latestRound = rounds[rounds.length - 1] ?? null;
  } catch {
    latestRound = null;
  }
  if (latestRound) {
    const { readCandidatesIndex } = await import('./generate.js');
    const index = await readCandidatesIndex(root, latestRound);
    if (index && index.candidates.length > 0) {
      lines.push(`Round ${latestRound} candidates (each MUST be selected):`);
      for (const card of index.candidates) {
        lines.push(`  - ${card.ideaId}: ${card.hypothesis.statement.slice(0, 160)}`);
        refs.push(card.ideaId);
        sources.add(`round:${latestRound}`);
      }
    } else {
      lines.push(`Round ${latestRound}: no persisted candidates`);
    }
  } else {
    lines.push('Ideation rounds: none (run: ideaseek ideate --round new)');
  }

  // Existing ideas with their latest signals.
  const ideasDir = join(root, 'ideas');
  let ideaNames: string[] = [];
  try {
    ideaNames = (await readdir(ideasDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    ideaNames = [];
  }
  if (ideaNames.length > 0) {
    lines.push('Existing ideas (each MUST be selected):');
  }
  for (const ideaId of ideaNames.sort()) {
    refs.push(ideaId);
    sources.add(`idea:${ideaId}`);
    const parts: string[] = [];
    try {
      const files = (await readdir(join(ideasDir, ideaId))).filter((name) =>
        /^analysis-v\d+\.json$/.test(name),
      );
      files.sort();
      const latest = files[files.length - 1];
      if (latest) {
        const analysis = JSON.parse(await readFile(join(ideasDir, ideaId, latest), 'utf8')) as {
          verdict?: unknown;
          failureClass?: unknown;
        };
        parts.push(`analysis=${String(analysis.verdict)}/${String(analysis.failureClass)}`);
        failureOpinions += 1;
        sources.add(`idea-analysis:${ideaId}`);
      }
    } catch {
      // no analysis yet
    }
    try {
      const discussion = JSON.parse(
        await readFile(join(ideasDir, ideaId, 'discussion.json'), 'utf8'),
      ) as { discussion?: { position?: unknown; recommendation?: unknown } };
      const inner = discussion.discussion;
      if (inner) {
        parts.push(`discussion=${String(inner.position)}`);
        sources.add(`discussion:${ideaId}`);
      }
    } catch {
      // no discussion yet
    }
    try {
      const novelty = JSON.parse(
        await readFile(join(ideasDir, ideaId, 'novelty.json'), 'utf8'),
      ) as { verdict?: unknown };
      if (typeof novelty.verdict === 'string') {
        parts.push(`novelty=${novelty.verdict}`);
        sources.add(`novelty:${ideaId}`);
      }
    } catch {
      // no novelty report
    }
    lines.push(`  - ${ideaId}${parts.length > 0 ? `: ${parts.join(', ')}` : ''}`);
  }

  try {
    const graph = JSON.parse(
      await readFile(join(root, 'knowledge', 'mechanism-graph.json'), 'utf8'),
    ) as { analysis?: { contradictions?: unknown[] } };
    const count = Array.isArray(graph.analysis?.contradictions)
      ? graph.analysis.contradictions.length
      : 0;
    lines.push(`Mechanism graph: present (${count} contradiction(s))`);
  } catch {
    lines.push('Mechanism graph: none (run: ideaseek mech)');
  }

  return {
    refs: [...new Set(refs)].sort(),
    failureOpinions,
    sources: [...sources].sort(),
    lines,
  };
}

export function buildConsolidationRequest(context: ConsolidationContext): {
  instruction: string;
  inputHash: string;
  idempotencyKey: string;
} {
  const inputHash = sha256Of(stableJson({ contract: CONSOLIDATION_SCHEMA, context }));
  const instruction = [
    'You are the Synthesis Lead (docs/AGENT_ROLES.md).',
    'Produce the final candidate set with explicit tradeoff reasons. Never delete a candidate silently and never delete competing explanations or failure opinions.',
    '',
    '---',
    '',
    CONSOLIDATION_OUTPUT_CONTRACT,
    '',
    'Context (persisted, hashable sources only):',
    `Allowed evidence sources: ${context.sources.join(', ')}`,
    `Input refs requiring a selection: ${context.refs.length > 0 ? context.refs.join(', ') : '(none)'}`,
    `Failure opinions in context: ${context.failureOpinions}`,
    context.lines.join('\n'),
  ].join('\n');
  return { instruction, inputHash, idempotencyKey: `consolidation:${inputHash}` };
}

/** Parses + validates; enforces coverage, retention and source bindings. */
export function parseConsolidationOutput(
  output: string,
  context: ConsolidationContext,
): Consolidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `consolidation output is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new IdeaseekError('PARSE_FAILED', 'consolidation output must be an object');
  }
  const record = parsed as Record<string, unknown>;
  if (record.contract !== CONSOLIDATION_SCHEMA) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `consolidation contract must be ${CONSOLIDATION_SCHEMA}, got ${String(record.contract)}`,
    );
  }

  const errors: string[] = [];
  const nonEmpty = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0;
  const allowed = new Set(context.sources);

  const selections = record.selections;
  const seenRefs = new Set<string>();
  if (!Array.isArray(selections)) {
    errors.push('selections must be an array');
  } else {
    if (context.refs.length > 0 && selections.length === 0) {
      errors.push('selections must cover every input ref — nothing may be dropped silently');
    }
    selections.forEach((raw, index) => {
      const item = raw as Partial<ConsolidationSelection> | null;
      const where = `selections[${index}]`;
      if (!item || !nonEmpty(item.ref)) {
        errors.push(`${where}.ref must be non-empty`);
        return;
      }
      if (seenRefs.has(item.ref)) errors.push(`${where}.ref "${item.ref}" selected twice`);
      seenRefs.add(item.ref);
      if (!['advance', 'merge', 'drop'].includes(String(item.decision))) {
        errors.push(`${where}.decision must be advance | merge | drop`);
      }
      if (!nonEmpty(item.rationale)) errors.push(`${where}.rationale must be non-empty`);
      if (!Array.isArray(item.evidence) || item.evidence.length === 0) {
        errors.push(`${where}.evidence must cite a source (or "speculation")`);
      } else {
        item.evidence.forEach((ev, e) => {
          if (!ev || typeof ev !== 'object' || !nonEmpty(ev.source) || !nonEmpty(ev.location)) {
            errors.push(`${where}.evidence[${e}] needs non-empty source and location`);
          } else if (!allowed.has(ev.source)) {
            errors.push(
              `${where}.evidence[${e}].source "${ev.source}" is not among the context sources`,
            );
          }
        });
      }
    });
    // Completeness: every input ref must receive a decision (anti-deletion).
    for (const ref of context.refs) {
      if (!seenRefs.has(ref)) {
        errors.push(
          `input ref "${ref}" has no selection — every candidate must be advanced, merged or dropped with a reason`,
        );
      }
    }
  }

  const merged = record.mergedInto;
  if (!Array.isArray(merged)) {
    errors.push('mergedInto must be an array (may be empty)');
  } else {
    merged.forEach((raw, index) => {
      const item = raw as Partial<{ source: string; target: string; reason: string }> | null;
      if (!item || !nonEmpty(item.source) || !nonEmpty(item.target) || !nonEmpty(item.reason)) {
        errors.push(`mergedInto[${index}] needs non-empty source, target and reason`);
      }
    });
  }

  const retained = record.retainedCompetingExplanations;
  if (!Array.isArray(retained) || retained.length === 0 || retained.some((r) => !nonEmpty(r))) {
    errors.push(
      'retainedCompetingExplanations must be a non-empty array (never delete competing explanations)',
    );
  }

  const failures = record.retainedFailureOpinions;
  if (!Array.isArray(failures) || failures.some((f) => !nonEmpty(f))) {
    errors.push('retainedFailureOpinions must be an array of non-empty strings');
  } else if (context.failureOpinions > 0 && failures.length === 0) {
    errors.push(
      `context lists ${context.failureOpinions} failure opinion(s) — retainedFailureOpinions must keep at least one (never delete failure opinions)`,
    );
  }

  if (!nonEmpty(record.recommendation)) errors.push('recommendation must be non-empty');

  if (errors.length > 0) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `consolidation violates contract: ${errors.slice(0, 5).join('; ')}`,
      { errors },
    );
  }
  return parsed as Consolidation;
}
