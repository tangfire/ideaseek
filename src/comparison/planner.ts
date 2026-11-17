import { sha256Of } from '../core/hash.js';
import { assertAgainstSchema } from '../core/schema/index.js';
import { stableJson } from '../experiment/spec.js';

/**
 * Comparison Planner agent stage (docs/FULL_RESEARCH_MODE.md 全量 comparison
 * 清单): gathers the planning CONTEXT — research questions, recent
 * literature (persisted corpus always; live academic index only when
 * research.external_search is on), target venue/subfield, benchmark
 * evidence from the registry — and validates the agent's proposal
 * against it. The agent may only CLASSIFY candidates with rationales
 * citing sources that exist in the context: invented citations, unknown
 * method ids and empty rationales are rejected (fail loud, deterministic
 * fallback stays available). Applying classifications to the registry
 * remains the existing `comparison matrix --confirm` user step.
 */

export const PLANNER_PROMPT_VERSION = 'comparison-planner-v1';
export const MATRIX_PROPOSAL_SCHEMA = 'comparison-matrix-proposal-v1';

export type MatrixClassification = 'required' | 'reference-only' | 'excluded' | 'blocked';

export interface PlannerLiterature {
  sourceId: string;
  title: string;
  year: number | null;
  kind: 'paper-card' | 'parsed-paper' | 'academic-index';
}

export interface PlannerCandidate {
  methodId: string;
  currentClassification: MatrixClassification;
  origin: 'registered' | 'paper-card';
  /** Short deterministic rationale already on the draft (agent may refine). */
  currentRationale: string;
}

export interface PlannerContext {
  generator: typeof PLANNER_PROMPT_VERSION;
  questions: string[];
  venue: string | null;
  subfield: string | null;
  candidates: PlannerCandidate[];
  /** Every id the proposal is allowed to cite. */
  literature: PlannerLiterature[];
  researchMap: { landscape: string; citations: { source: string; title: string }[] } | null;
  benchmarkEvidence: { methodId: string; status: string; required: boolean }[];
  /** Live index results (empty unless external_search — network in prod). */
  indexNote: string;
}

export interface MatrixProposalEntry {
  methodId: string;
  classification: MatrixClassification;
  rationale: string;
  sources: string[];
  /** Recency/venue reasoning in one line (planning context, not a promise). */
  relevanceNote?: string;
}

export interface MatrixProposal {
  contract: typeof MATRIX_PROPOSAL_SCHEMA;
  entries: MatrixProposalEntry[];
  notes?: string[];
}

export function plannerContextHash(context: PlannerContext): string {
  return sha256Of(stableJson(context));
}

function classifyOf(candidate: PlannerCandidate): MatrixClassification {
  return candidate.currentClassification;
}

/**
 * Builds the bounded planning context from persisted state (+ optional
 * live index when external_search is enabled; index failure degrades to
 * a note, never blocks the planner).
 */
export async function buildPlannerContext(root: string): Promise<PlannerContext> {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { loadConfig } = await import('../config/config.js');
  const { projectPaths } = await import('../config/paths.js');
  const config = (await loadConfig(projectPaths(root))).resolved;

  // Research questions from idea cards.
  const questions: string[] = [];
  for (const name of await readdir(join(root, 'ideas'), { withFileTypes: true }).catch(() => [])) {
    if (!name.isDirectory()) continue;
    try {
      const card = JSON.parse(
        await readFile(join(root, 'ideas', name.name, 'idea.json'), 'utf8'),
      ) as { hypothesis?: { statement?: unknown } };
      if (typeof card.hypothesis?.statement === 'string') {
        questions.push(card.hypothesis.statement);
      }
    } catch {
      continue;
    }
  }

  // Venue + subfield from the stored manuscript (planning context only).
  let venue: string | null = null;
  let subfield: string | null = null;
  try {
    const manuscript = JSON.parse(
      await readFile(join(root, 'reports', 'paper', 'manuscript.json'), 'utf8'),
    ) as { manuscript?: { venue?: unknown; subfield?: unknown } };
    if (typeof manuscript.manuscript?.venue === 'string') venue = manuscript.manuscript.venue;
    if (typeof manuscript.manuscript?.subfield === 'string') {
      subfield = manuscript.manuscript.subfield;
    }
  } catch {
    venue = null;
  }

  // Deterministic matrix candidates (same source as `comparison matrix`).
  const { buildComparisonMatrix } = await import('./matrix.js');
  // ignoreProposal: the planner reasons over the DETERMINISTIC draft so
  // its own refinements never invalidate the context hash.
  const matrix = await buildComparisonMatrix(root, { ignoreProposal: true });
  const candidates: PlannerCandidate[] = matrix.entries.map((entry) => ({
    methodId: entry.methodId,
    currentClassification: classifyOf({
      methodId: entry.methodId,
      currentClassification: entry.classification as MatrixClassification,
      origin: entry.origin,
      currentRationale: entry.rationale,
    }),
    origin: entry.origin,
    currentRationale: entry.rationale.slice(0, 300),
  }));

  // Literature: persisted corpus first (paper cards + parsed papers).
  const literature: PlannerLiterature[] = [];
  for (const name of (
    await readdir(join(root, 'knowledge', 'paper-cards')).catch(() => [])
  ).sort()) {
    if (!name.endsWith('.json')) continue;
    try {
      const payload = JSON.parse(
        await readFile(join(root, 'knowledge', 'paper-cards', name), 'utf8'),
      ) as { artifactId?: unknown; card?: { title?: unknown; paper_id?: unknown } };
      const title =
        typeof payload.card?.title === 'string'
          ? payload.card.title
          : String(payload.artifactId ?? name);
      literature.push({
        sourceId: `paper-card:${payload.artifactId ?? name.replace(/\.json$/, '')}`,
        title,
        year: null,
        kind: 'paper-card',
      });
    } catch {
      continue;
    }
  }
  // Parsed-paper artifacts (titles only — no year field in the contract).
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  try {
    const papers = await runtime.db.listArtifactsByKind('parsed-paper');
    for (const artifact of papers.slice(-40)) {
      try {
        const payload = JSON.parse(await runtime.store.readFinalText(artifact.contentHash)) as {
          source?: unknown;
          title?: unknown;
        };
        literature.push({
          sourceId: `parsed:${artifact.artifactId}`,
          title:
            typeof payload.title === 'string'
              ? payload.title
              : String(payload.source ?? artifact.artifactId),
          year: null,
          kind: 'parsed-paper',
        });
      } catch {
        continue;
      }
    }

    // Research map (landscape + citations) when present.
    let researchMap: PlannerContext['researchMap'] = null;
    try {
      const { listArtifactsByKind } = runtime.db;
      const maps = await listArtifactsByKind('research-map');
      const latest = maps[maps.length - 1];
      if (latest) {
        const payload = JSON.parse(await runtime.store.readFinalText(latest.contentHash)) as {
          landscape?: unknown;
          citations?: { source?: unknown; title?: unknown }[];
        };
        researchMap = {
          landscape: typeof payload.landscape === 'string' ? payload.landscape.slice(0, 1200) : '',
          citations: (Array.isArray(payload.citations) ? payload.citations : [])
            .filter((c) => typeof c?.source === 'string')
            .slice(0, 20)
            .map((c) => ({ source: String(c.source), title: String(c.title ?? '') })),
        };
      }
    } catch {
      researchMap = null;
    }

    // Benchmark evidence: registered comparison methods.
    const methods = await runtime.db.listComparisons({});
    const benchmarkEvidence = methods
      .map((method) => ({
        methodId: method.methodId,
        status: method.status,
        required: method.required,
      }))
      .sort((a, b) => a.methodId.localeCompare(b.methodId));

    // Live recent-literature ranking ONLY when external_search is on
    // (network; tests keep it off and use the deterministic corpus).
    let indexNote = 'external_search off — recent-literature context is the persisted corpus only';
    if (config.research.externalSearch) {
      try {
        const { createAcademicIndexClient } = await import('../knowledge/academic-index.js');
        const client = createAcademicIndexClient();
        const query = questions[0] ?? 'machine learning';
        const result = await client.search(query, { limit: 10 });
        const hits = (result.hits ?? [])
          .slice()
          .sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
          .slice(0, 10);
        for (const hit of hits) {
          literature.push({
            sourceId: `index:${hit.indexId ?? hit.url ?? hit.title}`,
            title: hit.title,
            year: hit.year ?? null,
            kind: 'academic-index',
          });
        }
        indexNote = `external_search on — ${hits.length} index hit(s), year-sorted (recency available to the planner)`;
      } catch (error) {
        indexNote = `external_search failed (${(error as Error).message.slice(0, 120)}) — corpus-only context`;
      }
    }

    return {
      generator: PLANNER_PROMPT_VERSION,
      questions: questions.slice().sort(),
      venue,
      subfield,
      candidates,
      literature,
      researchMap,
      benchmarkEvidence,
      indexNote,
    };
  } finally {
    await runtime.close();
  }
}

/**
 * Fails loud on anything the agent could use to invent evidence:
 * unknown method ids, unknown classifications, empty rationales and
 * sources outside the provided context.
 */
export function validateMatrixProposal(
  proposal: unknown,
  context: PlannerContext,
): { ok: true; proposal: MatrixProposal } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    return { ok: false, errors: ['proposal must be an object'] };
  }
  const doc = proposal as Partial<MatrixProposal>;
  if (doc.contract !== MATRIX_PROPOSAL_SCHEMA) {
    errors.push(`contract must be ${MATRIX_PROPOSAL_SCHEMA}`);
  }
  if (!Array.isArray(doc.entries) || doc.entries.length === 0) {
    errors.push('entries must be a non-empty array');
    return { ok: false, errors };
  }
  const candidateIds = new Set(context.candidates.map((c) => c.methodId));
  const sourceIds = new Set(context.literature.map((l) => l.sourceId));
  for (const [index, entry] of doc.entries.entries()) {
    if (!entry || typeof entry !== 'object') {
      errors.push(`entries[${index}] must be an object`);
      continue;
    }
    const item = entry as Partial<MatrixProposalEntry>;
    if (typeof item.methodId !== 'string' || !candidateIds.has(item.methodId)) {
      errors.push(
        `entries[${index}].methodId "${String(item.methodId)}" is not a known candidate — plan only methods from the provided context`,
      );
    }
    if (
      !['required', 'reference-only', 'excluded', 'blocked'].includes(String(item.classification))
    ) {
      errors.push(
        `entries[${index}].classification must be required|reference-only|excluded|blocked`,
      );
    }
    if (typeof item.rationale !== 'string' || !item.rationale.trim()) {
      errors.push(`entries[${index}].rationale must be a non-empty string`);
    }
    if (!Array.isArray(item.sources)) {
      errors.push(`entries[${index}].sources must be an array of provided source ids`);
    } else {
      for (const source of item.sources) {
        if (typeof source !== 'string' || !sourceIds.has(source)) {
          errors.push(
            `entries[${index}].sources cites "${String(source)}" which is NOT in the provided literature context (no invented citations)`,
          );
        }
      }
    }
    if (item.relevanceNote !== undefined && typeof item.relevanceNote !== 'string') {
      errors.push(`entries[${index}].relevanceNote must be a string when present`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  // Defense in depth (JSON Schema authority): the domain validator ran first
  // because it is the one that needs the request context (candidate ids,
  // literature ids). What it cannot see is the document's own shape — the type
  // of the top-level `notes`, an `entries` item that is not an object — and that
  // shape is what a Python worker or ARIS skill reads out of the persisted
  // `comparison-matrix-proposal` artifact, since the same JSON file is the
  // contract there. Refusing here happens before the artifact lands, and the one
  // caller (src/worker/matrix-handlers.ts) already fails the task on an invalid
  // proposal: this changes which message the operator sees, not whether the run
  // continues, and it never repairs a proposal into a classification.
  assertAgainstSchema(MATRIX_PROPOSAL_SCHEMA, doc);
  return { ok: true, proposal: doc as MatrixProposal };
}
