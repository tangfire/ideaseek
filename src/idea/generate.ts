import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { sha256Of } from '../core/hash.js';
import { writeFileAtomic } from '../core/atomic.js';
import { stableJson } from '../experiment/spec.js';
import { renderArisSkill, type LoadedArisSkill } from '../aris/skill.js';
import { validateIdeaCard, type IdeaCard } from './card.js';
import { ideaFingerprint, type IdeationRound } from './rounds.js';
import { assertAgainstSchema } from '../core/schema/index.js';

/**
 * ARIS skill-backed candidate generation (Phase 4.5 capability 1,
 * docs/ARIS_INTEGRATION_PLAN §Skill adapter): the vendored `idea-creator`
 * skill supplies the ideation methodology; this module owns the IdeaSeek
 * contract — round context, the structured `idea-candidates-v1` output
 * schema, IdeaCard validation + dedup, atomic candidate files and the
 * inputHash that makes regeneration idempotent. Execution itself always
 * goes through HarnessAdapter (no second agent loop).
 */

export const IDEA_CANDIDATES_SCHEMA = 'idea-candidates-v1';

export interface CandidatesIndex {
  contract: typeof IDEA_CANDIDATES_SCHEMA;
  roundId: string;
  inputHash: string;
  skill: { name: string; sha256: string };
  generatedAt: number;
  harnessRuntime: string;
  /** Honest empty result: the round produced no defensible new idea. */
  reason?: string;
  candidates: IdeaCard[];
  rejected: { ideaId: string | null; errors: string[] }[];
}

/** Output contract appended after the ARIS skill body (the thin wrapper). */
const OUTPUT_CONTRACT = `
# IdeaSeek output contract (${IDEA_CANDIDATES_SCHEMA})

You are running inside IdeaSeek. Reply with ONE JSON object and nothing else:

{"candidates": [<IdeaCard>, ...], "reason": "only when candidates is empty"}

Each IdeaCard must satisfy ALL of:
- "ideaId": kebab-case, unique in this output (prefix "gen-").
- "version": 1, "parentVersion": null.
- "status": "CANDIDATE" only when the mechanism chain below is fully
  supported; otherwise "DRAFT_COMPOSITION" (never lie about readiness).
- "hypothesis": {"statement", "targetProblem"}.
- "paperEvidence": ≥1 entry {paperRef, statement, evidence} — paperRef must
  be exactly one of the Paper ids listed in the round context (e.g.
  papers/2111.10487.pdf); never invent papers, and a label such as
  "round-context:…" is NOT a paper (the claim audit resolves paperRef
  against indexed papers only). Claims grounded only in the question or the
  protocol belong in the hypothesis/rationale, not here.
- "contradictions": ≥1 string.
- "novelty": {"claim", "uncertainty", "whyNotRestatement"} — uncertainty is
  mandatory; the claim must differ from every novelty constraint below.
- "mechanismChain": {"designPrincipleLink", "steps": exactly 6 objects of the
  form {"kind": "...", "text": "..."} — both fields are required on every
  step; "kind" in this order: observation → hypothesis → intervention →
  expected-change → baseline-difference → falsifier.
- "nearestComparisons": ≥1 {methodId, difference, evidence} — methodId must
  be a registered comparison id from the Comparisons line (e.g.
  feddg-prototype-alignment); a descriptive display name ("FedAvg / FedProx
  with local DG augmentation", "FedDG/shared-global-prototype alignment")
  is not an id and fails the claim audit. When the Comparisons line lists
  none, cite the closest registered id you know will be imported and say so
  in evidence — never a free-text method name.
- "componentNecessity": ≥1 {component, role: "necessary-mechanism",
  removeEffect} — ≥2 engineering-only components make the card a
  DRAFT_COMPOSITION.
- "competingExplanations", "boundaryConditions", "risks": non-empty arrays.
- "minimalExperiment": {"code", "data", "baselines", "metrics", "ablations"}.
  Metric names are machine keys, not sentences: an identifier matching
  [A-Za-z][A-Za-z0-9_]* — no spaces, no prose in parentheses. The protocol's
  identifiers are listed in the round context and must appear exactly as given:
  a card that renames the primary metric cannot be run, because the experiment
  spec is checked against the locked protocol. Say what a metric measures in
  hypothesis.expectedOutcome instead.
- "falsification": {"conditions": non-empty}.
- "budget": {"maxRounds": int ≥1, "maxGpuMinutes": int ≥1}.
- "stopConditions": non-empty; "createdAt": epoch milliseconds.

Rules:
- Respect "Idea limit": never return more cards than the limit.
- Every hypothesis statement must differ from the novelty constraints and
  must not match any known fingerprint (different statement text).
- If no defensible new idea exists, return {"candidates": [], "reason": "..."}
  — never pad, never weaken the constraints.
- No prose, no markdown fence, no commentary outside the JSON object.
`.trim();

export interface GenerationRequest {
  instruction: string;
  roundContext: string;
  inputHash: string;
  idempotencyKey: string;
}

/** Assembles the harness request: ARIS skill body + IdeaSeek contract. */
export function buildGenerationRequest(
  round: IdeationRound,
  skill: LoadedArisSkill,
): GenerationRequest {
  const roundContext = buildRoundContext(round);
  const inputHash = sha256Of(
    stableJson({
      contract: IDEA_CANDIDATES_SCHEMA,
      // A contract-text edit must invalidate idempotent reuse: the cached
      // output was produced by a different prompt.
      contractTextSha256: sha256Of(OUTPUT_CONTRACT),
      skillSha256: skill.sha256,
      round: {
        roundId: round.roundId,
        question: round.question,
        ideaLimit: round.ideaLimit,
        snapshots: round.snapshots,
        noveltyConstraints: round.noveltyConstraints,
        knownFingerprints: round.knownFingerprints,
        inherited: round.inherited,
        instructions: round.instructions,
      },
    }),
  );
  const instruction = [
    renderArisSkill(skill, { arguments: roundContext }),
    '',
    '---',
    '',
    OUTPUT_CONTRACT,
    '',
    'Round context:',
    roundContext,
  ].join('\n');
  return {
    instruction,
    roundContext,
    inputHash,
    idempotencyKey: `idea-generate:${inputHash}`,
  };
}

function buildRoundContext(round: IdeationRound): string {
  const lines = [
    `Research question: ${round.question ?? '(none)'}`,
    `Idea limit: ${round.ideaLimit}`,
    `Paper cards in evidence snapshot: ${round.snapshots.paperCardCount}`,
    `Paper ids (a card's paperRef MUST be exactly one of these): ${
      (round.snapshots.paperIds ?? []).length > 0
        ? (round.snapshots.paperIds ?? []).join(', ')
        : 'none indexed yet — this round cannot cite a paper in paperEvidence'
    }`,
    `Input manifest: ${round.snapshots.inputManifestHash ?? 'absent'}`,
    `Research map: ${round.snapshots.researchMapHash ?? 'absent'}`,
    `Protocol: ${round.snapshots.protocolId ?? 'absent'}${round.snapshots.protocolHash ? ` (${round.snapshots.protocolHash})` : ''}`,
    `Protocol metric identifiers (a card's minimalExperiment.metrics MUST declare these, verbatim, plus any extra metric it needs): ${
      round.snapshots.protocolMetrics.length > 0
        ? round.snapshots.protocolMetrics.join(', ')
        : 'none locked yet'
    }`,
    `Comparisons: ${
      round.snapshots.comparisonSet.length > 0
        ? round.snapshots.comparisonSet
            .map((entry) => `${entry.methodId}:${entry.status}`)
            .join(', ')
        : 'none'
    }`,
    `Dataset snapshots: ${
      round.snapshots.datasetRootHashes.length > 0
        ? round.snapshots.datasetRootHashes.join(', ')
        : 'none'
    }`,
    `User instructions: ${round.instructions.length > 0 ? round.instructions.join(' | ') : 'none'}`,
    'Novelty constraints (new ideas MUST differ from each):',
    ...(round.noveltyConstraints.length > 0
      ? round.noveltyConstraints.map((entry) => `  - ${entry}`)
      : ['  (none)']),
    'Known idea fingerprints (statements must differ):',
    ...(round.knownFingerprints.length > 0
      ? round.knownFingerprints.map((entry) => `  - ${entry}`)
      : ['  (none)']),
    'Inherited ideas:',
    ...(round.inherited.length > 0
      ? round.inherited.map((entry) => `  - ${entry.ideaId} [${entry.status}] ${entry.fingerprint}`)
      : ['  (none)']),
  ];
  return lines.join('\n');
}

export interface ParsedCandidates {
  cards: IdeaCard[];
  rejected: { ideaId: string | null; errors: string[] }[];
  reason: string | null;
}

/**
 * Parses and validates the harness output. Non-JSON or wrong shape is a
 * PARSE_FAILED error (nothing is written); invalid or duplicate cards are
 * collected in `rejected` so a partially good batch still lands.
 */
export function parseCandidatesOutput(output: string, round: IdeationRound): ParsedCandidates {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `idea generator returned non-JSON output: ${output.slice(0, 160)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new IdeaseekError('PARSE_FAILED', 'idea generator output must be a JSON object');
  }
  const record = parsed as { candidates?: unknown; reason?: unknown };
  if (!Array.isArray(record.candidates)) {
    throw new IdeaseekError('PARSE_FAILED', 'idea generator output is missing a candidates array');
  }
  // Envelope contract (subset defense — the semantic loop runs below and
  // still collects per-card rejections for partial batches).
  assertAgainstSchema('idea-candidates-v1', record);
  const reason = typeof record.reason === 'string' ? record.reason : null;

  const cards: IdeaCard[] = [];
  const rejected: ParsedCandidates['rejected'] = [];
  const seenFingerprints = new Set(round.knownFingerprints);
  const seenIds = new Set<string>();

  for (const raw of record.candidates) {
    const validation = validateIdeaCard(raw);
    const ideaId =
      raw && typeof raw === 'object' && typeof (raw as { ideaId?: unknown }).ideaId === 'string'
        ? (raw as { ideaId: string }).ideaId
        : null;
    const errors = [...validation.errors];
    if (validation.ok) {
      // Defense in depth: structurally-valid cards must also satisfy the
      // shared contract before they can land.
      assertAgainstSchema('idea-card-v1', raw);
    }
    if (validation.ok && ideaId) {
      if (seenIds.has(ideaId)) errors.push(`duplicate ideaId in output: ${ideaId}`);
      const fingerprint = ideaFingerprint(raw as IdeaCard);
      if (seenFingerprints.has(fingerprint)) {
        errors.push(`collides with a known idea fingerprint: ${fingerprint}`);
      }
      seenFingerprints.add(fingerprint);
      seenIds.add(ideaId);
    }
    if (errors.length > 0) rejected.push({ ideaId, errors });
    else cards.push(raw as IdeaCard);
  }

  if (cards.length === 0 && !reason && record.candidates.length > 0) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `every candidate was rejected and no reason was given: ${rejected
        .flatMap((entry) => entry.errors)
        .slice(0, 3)
        .join('; ')}`,
    );
  }
  return { cards, rejected, reason };
}

export function candidatesIndexPath(root: string, roundId: string): string {
  return join(root, 'knowledge', 'ideation-rounds', roundId, 'candidates.json');
}

export function candidateCardPath(root: string, roundId: string, ideaId: string): string {
  return join(root, 'knowledge', 'ideation-rounds', roundId, 'candidates', `${ideaId}.json`);
}

/** Reads the persisted index; a corrupt file counts as absent (regenerate). */
export async function readCandidatesIndex(
  root: string,
  roundId: string,
): Promise<CandidatesIndex | null> {
  try {
    const raw = await readFile(candidatesIndexPath(root, roundId), 'utf8');
    const parsed = JSON.parse(raw) as CandidatesIndex;
    if (parsed.contract !== IDEA_CANDIDATES_SCHEMA || parsed.roundId !== roundId) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Atomically writes the index plus one file per card (for --from-card). */
export async function writeCandidates(
  root: string,
  roundId: string,
  index: CandidatesIndex,
): Promise<string[]> {
  const written: string[] = [];
  const indexPath = candidatesIndexPath(root, roundId);
  await writeFileAtomic(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  written.push(indexPath);
  for (const card of index.candidates) {
    const path = candidateCardPath(root, roundId, card.ideaId);
    await writeFileAtomic(path, `${JSON.stringify(card, null, 2)}\n`);
    written.push(path);
  }
  return written;
}
