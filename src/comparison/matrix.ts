import { sha256Of } from '../core/hash.js';
import { IdeaseekError } from '../core/errors.js';
import { assertAgainstSchema, validateAgainstSchema } from '../core/schema/index.js';
import { stableJson } from '../experiment/spec.js';
import type { ComparisonStatus } from './types.js';

/**
 * Comparison Planner matrix (docs/FULL_RESEARCH_MODE.md 全量 comparison
 * 清单): a reviewable, editable classification of every comparison
 * candidate as required / reference-only / excluded / blocked.
 *
 * The build is deterministic over persisted evidence — registered
 * methods, PaperCard nearestComparisons, corpus paper cards, the stored
 * manuscript venue — and records where each entry came from; live
 * literature/venue synthesis (agent + credentials) enriches later and
 * never replaces this audit trail. Confirming applies the (possibly
 * user-edited) classifications to the registry: required flags gate the
 * full run, excluded/blocked go through the normal state machine with
 * the rationale as reason — no silent skips.
 */

export const MATRIX_SCHEMA = 'comparison-matrix-v1';

export type MatrixClassification = 'required' | 'reference-only' | 'excluded' | 'blocked';

export interface MatrixEntry {
  methodId: string;
  classification: MatrixClassification;
  /** Why this method is in/out (user-editable before --confirm). */
  rationale: string;
  /** Recency/venue reasoning from the Comparison Planner agent (optional). */
  plannerNote?: string;
  sources: { source: string; detail: string }[];
  implementation: {
    identity: 'official-code' | 'paper-reimplementation' | 'user' | 'paper-card-only';
    sourceKind: string | null;
    licenseKind: string | null;
    repoUrl: string | null;
  };
  origin: 'registered' | 'paper-card';
  /** Idea cards whose nearestComparisons surfaced this method. */
  cardIds: string[];
}

export interface ComparisonMatrix {
  contract: typeof MATRIX_SCHEMA;
  inputHash: string;
  generatedAt: number;
  context: {
    /** Idea hypotheses (sorted) — the research questions being served. */
    questions: string[];
    /** Target venue from the stored manuscript, when one exists. */
    venue: string | null;
    corpusPaperCards: number;
    researchMapPresent: boolean;
  };
  entries: MatrixEntry[];
  /** Must be empty before `--confirm`. */
  blockers: string[];
  /** Latest agent proposal merged into this draft (when current). */
  agentProposal?: { contextHash: string; applied: boolean; note?: string };
  confirmed?: { at: number; mode: string; inputHash: string; applied: string[] };
}

function computeInputHash(
  plan: Omit<ComparisonMatrix, 'inputHash' | 'generatedAt' | 'confirmed'>,
): string {
  // generatedAt is wall-clock and confirmed is the researcher stamp —
  // neither may affect the hash (same rule as the full plan).
  const { generatedAt: _ts, ...stable } = plan as ComparisonMatrix;
  return sha256Of(stableJson(stable));
}

function classifyRegistered(method: {
  required: boolean;
  status: string;
  record: Record<string, unknown>;
}): { classification: MatrixClassification; rationale: string } {
  const statusReason =
    typeof method.record.statusReason === 'string' && method.record.statusReason.trim()
      ? method.record.statusReason
      : null;
  const notes = Array.isArray(method.record.notes)
    ? method.record.notes.filter((n): n is string => typeof n === 'string')
    : [];
  if (method.status === 'excluded') {
    return {
      classification: 'excluded',
      rationale: statusReason || notes.join(' · ') || 'excluded',
    };
  }
  if (method.status === 'blocked') {
    return {
      classification: 'blocked',
      rationale: statusReason || notes.join(' · ') || 'blocked',
    };
  }
  if (method.required) {
    return {
      classification: 'required',
      rationale: statusReason || 'registered as required — enters the full-run comparison gate',
    };
  }
  return {
    classification: 'reference-only',
    rationale: statusReason || 'registered as reference-only — context, not gated',
  };
}

/**
 * Builds the matrix from persisted state (read-only). Never throws for
 * "nothing to plan yet" — that becomes a blocker with recovery commands.
 */
export async function buildComparisonMatrix(
  root: string,
  opts: { ignoreProposal?: boolean } = {},
): Promise<ComparisonMatrix> {
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  try {
    const blockers: string[] = [];

    // --- Registered methods (authoritative origin). ---
    const registered = await runtime.db.listComparisons({});
    const entries = new Map<string, MatrixEntry>();
    for (const method of registered) {
      const record = method.record as {
        paperRefs?: unknown;
        sourceKind?: unknown;
        repo?: { url?: unknown; licenseKind?: unknown };
        statusReason?: unknown;
      };
      const { classification, rationale } = classifyRegistered(method);
      const paperRefs = Array.isArray(record.paperRefs)
        ? record.paperRefs.filter((ref): ref is string => typeof ref === 'string')
        : [];
      entries.set(method.methodId, {
        methodId: method.methodId,
        classification,
        rationale,
        sources: paperRefs.map((ref) => ({ source: ref, detail: 'method paperRef' })),
        implementation: {
          identity:
            record.sourceKind === 'official-code' ||
            record.sourceKind === 'paper-reimplementation' ||
            record.sourceKind === 'user'
              ? record.sourceKind
              : 'user',
          sourceKind: typeof record.sourceKind === 'string' ? record.sourceKind : null,
          licenseKind:
            typeof record.repo?.licenseKind === 'string' ? record.repo.licenseKind : null,
          repoUrl: typeof record.repo?.url === 'string' ? record.repo.url : null,
        },
        origin: 'registered',
        cardIds: [],
      });
    }

    // --- PaperCard nearestComparisons (candidate origin). ---
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const ideasDir = join(root, 'ideas');
    const questions: string[] = [];
    for (const name of await readdir(ideasDir, { withFileTypes: true }).catch(() => [])) {
      if (!name.isDirectory()) continue;
      try {
        const card = JSON.parse(await readFile(join(ideasDir, name.name, 'idea.json'), 'utf8')) as {
          hypothesis?: { statement?: unknown };
          nearestComparisons?: unknown;
        };
        if (typeof card.hypothesis?.statement === 'string') {
          questions.push(card.hypothesis.statement);
        }
        if (!Array.isArray(card.nearestComparisons)) continue;
        for (const item of card.nearestComparisons) {
          const nearest = item as { methodId?: unknown; difference?: unknown; evidence?: unknown };
          if (typeof nearest.methodId !== 'string' || !nearest.methodId) continue;
          const detail =
            `${name.name}: ${typeof nearest.difference === 'string' ? nearest.difference : ''}` +
            (typeof nearest.evidence === 'string' && nearest.evidence
              ? ` (evidence: ${nearest.evidence})`
              : '');
          const existing = entries.get(nearest.methodId);
          if (existing) {
            existing.cardIds.push(name.name);
            existing.sources.push({ source: name.name, detail: detail || 'nearest comparison' });
            continue;
          }
          entries.set(nearest.methodId, {
            methodId: nearest.methodId,
            classification: 'reference-only',
            rationale: `nearest comparison from PaperCard — ${detail || 'no detail recorded'}`,
            sources: [{ source: name.name, detail: detail || 'nearest comparison' }],
            implementation: {
              identity: 'paper-card-only',
              sourceKind: null,
              licenseKind: null,
              repoUrl: null,
            },
            origin: 'paper-card',
            cardIds: [name.name],
          });
        }
      } catch {
        continue; // unreadable card — not a matrix blocker
      }
    }

    // --- Planning context (venue / corpus size / research map). ---
    let venue: string | null = null;
    try {
      const manuscript = JSON.parse(
        await readFile(join(root, 'reports', 'paper', 'manuscript.json'), 'utf8'),
      ) as { manuscript?: { venue?: unknown } };
      if (typeof manuscript.manuscript?.venue === 'string') {
        venue = manuscript.manuscript.venue;
      }
    } catch {
      venue = null;
    }
    const cardsDir = join(root, 'knowledge', 'paper-cards');
    const corpusPaperCards = (await readdir(cardsDir).catch(() => [])).filter((name) =>
      name.endsWith('.json'),
    ).length;
    const researchMapPresent = await readFile(join(root, 'knowledge', 'research-map.md'))
      .then(() => true)
      .catch(() => false);

    const sorted = [...entries.values()].sort((a, b) => a.methodId.localeCompare(b.methodId));
    if (sorted.length === 0) {
      blockers.push(
        'no comparison candidates — register a method (ideaseek comparison register) or create idea cards first',
      );
    }

    // Merge the latest Comparison Planner proposal (when its candidate set
    // still matches). The proposal refines rationale/classification; the
    // user's --confirm remains the only path that touches the registry.
    // `ignoreProposal` (planner context) skips this so the agent's own
    // refinements never churn the context hash it was built from.
    let agentProposal: ComparisonMatrix['agentProposal'];
    const proposalArtifacts = opts.ignoreProposal
      ? []
      : await runtime.db.listArtifactsByKind('comparison-matrix-proposal');
    const latestProposal = proposalArtifacts[proposalArtifacts.length - 1];
    if (latestProposal) {
      try {
        const proposal = JSON.parse(
          await runtime.store.readFinalText(latestProposal.contentHash),
        ) as {
          contextHash?: unknown;
          entries?: {
            methodId?: unknown;
            classification?: unknown;
            rationale?: unknown;
            sources?: unknown;
            relevanceNote?: unknown;
          }[];
        };
        const contextHash =
          typeof proposal.contextHash === 'string'
            ? proposal.contextHash
            : typeof latestProposal.meta.contextHash === 'string'
              ? latestProposal.meta.contextHash
              : '';
        const byId = new Map(sorted.map((entry) => [entry.methodId, entry]));
        const proposalEntries = Array.isArray(proposal.entries) ? proposal.entries : [];
        const unknownIds = proposalEntries
          .map((entry) => entry.methodId)
          .filter((id): id is string => typeof id === 'string' && !byId.has(id));
        // The proposal is a MODEL output, so a payload that does not even have
        // the shape its contract declares is recorded as un-applied rather than
        // half-merged. The ad-hoc field checks below skip what they cannot use
        // and still report `applied: true`, which is a false conclusion: the
        // researcher would read "planner proposal merged" about a document that
        // was mostly ignored. Nothing here aborts the matrix build — the
        // deterministic classification stands on its own, and the note says
        // exactly what the planner has to fix.
        const shape = validateAgainstSchema('comparison-matrix-proposal-v1', proposal);
        if (!shape.ok) {
          agentProposal = {
            contextHash,
            applied: false,
            note: `planner proposal violates comparison-matrix-proposal-v1 and was not merged: ${shape.errors
              .slice(0, 3)
              .join('; ')}`,
          };
        } else if (unknownIds.length > 0) {
          agentProposal = {
            contextHash,
            applied: false,
            note: `stale planner proposal ignored (candidates changed: ${unknownIds.join(', ')})`,
          };
        } else if (proposalEntries.length === 0) {
          agentProposal = { contextHash, applied: false, note: 'planner proposal has no entries' };
        } else {
          for (const item of proposalEntries) {
            const target = byId.get(String(item.methodId));
            if (!target) continue;
            if (
              ['required', 'reference-only', 'excluded', 'blocked'].includes(
                String(item.classification),
              )
            ) {
              target.classification = item.classification as MatrixClassification;
            }
            if (typeof item.rationale === 'string' && item.rationale.trim()) {
              target.rationale = item.rationale;
            }
            if (Array.isArray(item.sources)) {
              for (const source of item.sources) {
                if (typeof source === 'string' && source) {
                  target.sources.push({ source, detail: 'comparison-planner citation' });
                }
              }
            }
            if (typeof item.relevanceNote === 'string' && item.relevanceNote.trim()) {
              target.plannerNote = item.relevanceNote;
            }
          }
          agentProposal = { contextHash, applied: true };
        }
      } catch {
        agentProposal = {
          contextHash: '',
          applied: false,
          note: 'unreadable planner proposal ignored',
        };
      }
    }

    const base: Omit<ComparisonMatrix, 'inputHash'> = {
      contract: MATRIX_SCHEMA,
      generatedAt: Date.now(),
      context: {
        questions: questions.slice().sort(),
        venue,
        corpusPaperCards,
        researchMapPresent,
      },
      entries: sorted,
      blockers,
      ...(agentProposal ? { agentProposal } : {}),
    };
    const inputHash = computeInputHash(base);
    const matrix: ComparisonMatrix = { ...base, inputHash };
    // Defense in depth (JSON Schema authority): the matrix is BUILT BY CODE, not
    // answered by a model, so a payload that does not match
    // comparison-matrix-v1 is a platform bug and there is no useful reading of it.
    // The file written from this object is what `--confirm` applies and what the
    // reports cite, so it is refused here — before the CLI persists it — rather
    // than being stored and failing in a later stage.
    assertAgainstSchema(MATRIX_SCHEMA, matrix);
    return matrix;
  } finally {
    await runtime.close();
  }
}

/** Pure confirm gates: freshness + blockers (unit-testable). */
export function assertMatrixApprovable(matrix: ComparisonMatrix, currentInputHash: string): void {
  if (matrix.inputHash !== currentInputHash) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      'comparison matrix is stale (project state changed since it was built) — rerun: ideaseek comparison matrix',
    );
  }
  if (matrix.blockers.length > 0) {
    throw new IdeaseekError(
      'USER_INPUT_REQUIRED',
      `comparison matrix has blockers: ${matrix.blockers.join('; ')}`,
      { blockers: matrix.blockers },
    );
  }
}

export interface MatrixApplyResult {
  applied: string[];
}

/**
 * Applies the (possibly user-edited) matrix to the registry: required
 * flags follow the classification, excluded/blocked walk the normal
 * state machine with the rationale as reason. Registered-only — paper-
 * card candidates are listed for review but never auto-registered
 * (import/clone is a separate, explicit step).
 */
export async function applyComparisonMatrix(
  root: string,
  matrix: ComparisonMatrix,
): Promise<MatrixApplyResult> {
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const { assertTransition } = await import('./types.js');
  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  try {
    // This is the boundary where the matrix stops being a review document and
    // starts changing the registry, and the object arriving here is the one on
    // disk — which the researcher edits by hand. A structurally broken matrix
    // used to fail midway through the loop (a raw TypeError on `entry.rationale`
    // when the field was deleted, or INVALID_STATE about a method id when an
    // entry lost its `classification`) after some methods had already been
    // transitioned; refusing it whole up front cannot abandon a run that works
    // today, because nothing valid that `comparison matrix` wrote is ever
    // rejected here.
    assertAgainstSchema(MATRIX_SCHEMA, matrix);
    const applied: string[] = [];
    for (const entry of matrix.entries) {
      if (entry.origin !== 'registered') continue;
      const before = await runtime.db.getComparison(entry.methodId);
      if (!before) {
        throw new IdeaseekError(
          'INVALID_STATE',
          `matrix entry ${entry.methodId} is marked registered but no longer exists — rebuild: ideaseek comparison matrix`,
        );
      }
      const desiredRequired = entry.classification === 'required';
      const desiredStatus: ComparisonStatus =
        entry.classification === 'excluded'
          ? 'excluded'
          : entry.classification === 'blocked'
            ? 'blocked'
            : (before.status as ComparisonStatus);

      // A user edit cannot pull a method out of excluded/blocked by
      // itself — the state machine owns that path (restore via
      // `comparison set-status` first, then reclassify).
      if (
        (entry.classification === 'required' || entry.classification === 'reference-only') &&
        (before.status === 'excluded' || before.status === 'blocked')
      ) {
        throw new IdeaseekError(
          'INVALID_STATE',
          `matrix entry ${entry.methodId} classifies ${entry.classification} but its status is ${before.status} — restore it first: ideaseek comparison set-status ${entry.methodId} <next-status> --reason "..."`,
        );
      }

      // Status first (state machine + reason), then the required flag.
      if (desiredStatus !== before.status) {
        if (
          (desiredStatus === 'excluded' || desiredStatus === 'blocked') &&
          !entry.rationale.trim()
        ) {
          throw new IdeaseekError(
            'USER_INPUT_REQUIRED',
            `matrix entry ${entry.methodId} classifies ${desiredStatus} but has an empty rationale (no silent skips)`,
          );
        }
        assertTransition(before.status as ComparisonStatus, desiredStatus, entry.rationale);
        await runtime.db.transitionComparison(entry.methodId, desiredStatus, entry.rationale);
        applied.push(`${entry.methodId}:status=${desiredStatus}`);
      }
      if (desiredRequired !== before.required) {
        const record = { ...before.record, required: desiredRequired };
        await runtime.db.upsertComparison({
          ...before,
          required: desiredRequired,
          record,
          updatedAt: Date.now(),
        });
        applied.push(`${entry.methodId}:required=${desiredRequired}`);
      }
    }
    return { applied };
  } finally {
    await runtime.close();
  }
}
