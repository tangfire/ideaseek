import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { sha256Of, type ContentHash } from '../core/hash.js';
import type { ProjectRuntime } from '../workflow/runtime.js';

/**
 * Review input collection (Phase 4.5 fresh-context reviewer / experiment
 * audit, docs/ARIS_INTEGRATION_PLAN §交叉评审原则): gathers the IdeaSeek
 * artifacts a review judges — PaperCard (DB authority + readable exports,
 * matched against the idea's cited paperRefs), IdeaCard, ExperimentReport
 * (experiments/analysis.json, docs/ARIS_POSITIONING.md), RunResult mirrors
 * and the handoff package gate record — each with a content hash.
 *
 * Strictly read-only: nothing under ideas/, protocol, metrics or handoff is
 * ever written here (reviewer independence: goal 6 — the reviewer may not
 * change Idea/protocol/metric/handoff state).
 */

export type ReviewKind = 'idea-review' | 'experiment-audit';

export type ReviewInputKind =
  'ideacard' | 'papercard' | 'experiment-report' | 'run-result' | 'handoff';

export interface ReviewInput {
  kind: ReviewInputKind;
  /** Project-relative posix path (or papercard:<artifactId> for DB-only cards). */
  ref: string;
  sha256: ContentHash;
  /** Verbatim artifact bytes — transmitted to the reviewer unfiltered. */
  content: string;
}

export interface ReviewTarget {
  kind: 'idea';
  ideaId: string;
  cardVersion: number | null;
}

export interface CollectedReviewInputs {
  target: ReviewTarget;
  inputs: ReviewInput[];
  /** Expected-but-absent artifacts (honest scope gaps, surfaced to the reviewer). */
  unavailable: string[];
  /** Cited paperRefs with no matching PaperCard (never invented by the reviewer). */
  unmatchedPaperRefs: string[];
}

/** Which artifact kinds each review scope judges. */
const INPUT_KINDS_BY_REVIEW: Record<ReviewKind, readonly ReviewInputKind[]> = {
  'idea-review': ['ideacard', 'papercard', 'experiment-report', 'run-result', 'handoff'],
  'experiment-audit': ['ideacard', 'experiment-report', 'run-result', 'handoff'],
};

function posixRel(root: string, abs: string): string {
  return relative(root, abs).split('\\').join('/');
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

function cardPaperId(card: unknown): string {
  if (card && typeof card === 'object' && 'paper_id' in card) {
    const id = (card as { paper_id?: unknown }).paper_id;
    if (typeof id === 'string' && id.trim()) return id;
  }
  return '';
}

interface PapercardCandidate {
  paperId: string;
  ref: string;
  content: string;
}

export async function collectReviewInputs(
  runtime: ProjectRuntime,
  ideaId: string,
  kind: ReviewKind,
): Promise<CollectedReviewInputs> {
  const root = runtime.paths.root;
  const wanted = new Set(INPUT_KINDS_BY_REVIEW[kind]);
  const inputs: ReviewInput[] = [];
  const unavailable: string[] = [];
  const unmatchedPaperRefs: string[] = [];

  // 1) IdeaCard — required; the review target's authoritative record.
  const cardPath = join(root, 'ideas', ideaId, 'idea.json');
  const cardText = await readIfExists(cardPath);
  if (cardText === null) {
    throw new IdeaseekError(
      'TASK_NOT_FOUND',
      `idea workspace ${ideaId} not found at ${cardPath} (run: ideaseek idea create ${ideaId} --from-card <file>)`,
    );
  }
  let cardVersion: number | null = null;
  let paperRefs: string[] = [];
  try {
    const card = JSON.parse(cardText) as {
      version?: unknown;
      paperEvidence?: { paperRef?: unknown }[];
    };
    if (typeof card.version === 'number') cardVersion = card.version;
    paperRefs = (Array.isArray(card.paperEvidence) ? card.paperEvidence : [])
      .map((entry) => (typeof entry?.paperRef === 'string' ? entry.paperRef : ''))
      .filter((ref) => ref.length > 0);
  } catch {
    // Unparsable card still travels verbatim; version/refs stay unknown.
  }
  if (wanted.has('ideacard')) {
    inputs.push({
      kind: 'ideacard',
      ref: posixRel(root, cardPath),
      sha256: sha256Of(cardText),
      content: cardText,
    });
  }

  const target: ReviewTarget = { kind: 'idea', ideaId, cardVersion };

  // 2) PaperCards cited by the idea — readable exports first, DB artifacts
  //    (authority) overwrite, dedup by paper_id.
  if (wanted.has('papercard')) {
    const byPaperId = new Map<string, PapercardCandidate>();
    const exportDir = join(root, 'knowledge', 'paper-cards');
    for (const name of (await listNames(exportDir)).sort()) {
      if (!name.endsWith('.json')) continue;
      const path = join(exportDir, name);
      const content = await readIfExists(path);
      if (content === null) continue;
      try {
        const wrapper = JSON.parse(content) as { card?: unknown };
        if (!wrapper.card) continue;
        const paperId = cardPaperId(wrapper.card);
        if (paperId && !byPaperId.has(paperId)) {
          byPaperId.set(paperId, { paperId, ref: posixRel(root, path), content });
        }
      } catch {
        continue;
      }
    }
    for (const artifact of await runtime.db.listArtifactsByKind('papercard')) {
      try {
        const content = await runtime.store.readFinalText(artifact.contentHash);
        const wrapper = JSON.parse(content) as {
          card?: unknown;
          source?: { sourcePath?: unknown };
        };
        if (!wrapper.card) continue;
        const paperId = cardPaperId(wrapper.card);
        if (!paperId) continue;
        const sourcePath =
          typeof wrapper.source?.sourcePath === 'string' ? wrapper.source.sourcePath : '';
        byPaperId.set(paperId, {
          paperId,
          ref: sourcePath || `papercard:${artifact.artifactId}`,
          content,
        });
      } catch {
        continue;
      }
    }
    const seenHashes = new Set<string>();
    for (const ref of paperRefs) {
      const hit = byPaperId.get(ref);
      if (!hit) {
        unmatchedPaperRefs.push(ref);
        continue;
      }
      const sha = sha256Of(hit.content);
      if (seenHashes.has(sha)) continue;
      seenHashes.add(sha);
      inputs.push({ kind: 'papercard', ref: hit.ref, sha256: sha, content: hit.content });
    }
  }

  // 3) ExperimentReport — the Result Analyst's structured report
  //    (docs/ARIS_POSITIONING.md "PaperCard/IdeaCard/ExperimentReport").
  const reportPath = join(root, 'ideas', ideaId, 'experiments', 'analysis.json');
  const reportText = await readIfExists(reportPath);
  if (wanted.has('experiment-report')) {
    if (reportText !== null) {
      inputs.push({
        kind: 'experiment-report',
        ref: posixRel(root, reportPath),
        sha256: sha256Of(reportText),
        content: reportText,
      });
    } else {
      unavailable.push(posixRel(root, reportPath));
    }
  }

  // 4) RunResult mirrors: <specId>-v<N>.json written by the experiment
  //    bridge; analysis-/progress- files are reports, not run results.
  const experimentsDir = join(root, 'ideas', ideaId, 'experiments');
  if (wanted.has('run-result')) {
    let found = false;
    for (const name of (await listNames(experimentsDir)).sort()) {
      if (!/-v\d+\.json$/.test(name)) continue;
      if (name.startsWith('analysis') || name.startsWith('progress')) continue;
      const path = join(experimentsDir, name);
      const content = await readIfExists(path);
      if (content === null) continue;
      found = true;
      inputs.push({
        kind: 'run-result',
        ref: posixRel(root, path),
        sha256: sha256Of(content),
        content,
      });
    }
    // Full-run results live in the unified registry (comparison specs have
    // idea=null and never write workspace mirrors) — the reviewer must see
    // them or it judges an idea without its full-scale evidence.
    const reports = await runtime.db.listArtifactsByKind('full-run-report');
    for (const artifact of reports) {
      if ((artifact.meta as { ideaId?: unknown } | null)?.ideaId !== ideaId) continue;
      try {
        const reportText = await runtime.store.readFinalText(artifact.contentHash);
        inputs.push({
          kind: 'run-result',
          ref: `artifact:full-run-report/${artifact.artifactId}`,
          sha256: artifact.contentHash.startsWith('sha256:')
            ? artifact.contentHash
            : sha256Of(reportText),
          content: reportText,
        });
        found = true;
        const parsed = JSON.parse(reportText) as { items?: { specId?: unknown }[] };
        for (const item of parsed.items ?? []) {
          if (typeof item.specId !== 'string') continue;
          const doc = await runtime.db.getExperiment(item.specId);
          if (!doc) continue;
          const content = JSON.stringify({ spec: doc.spec, result: doc.result }, null, 2);
          inputs.push({
            kind: 'run-result',
            ref: `registry:${item.specId}`,
            sha256: sha256Of(content),
            content,
          });
        }
      } catch {
        // unreadable report → stays an honest gap below
      }
    }
    if (!found) unavailable.push(`ideas/${ideaId}/experiments/*-v*.json (no run results)`);
  }

  // 5) Handoff package gate record.
  const handoffPath = join(root, 'ideas', ideaId, 'handoff', 'handoff.json');
  const handoffText = await readIfExists(handoffPath);
  if (wanted.has('handoff')) {
    if (handoffText !== null) {
      inputs.push({
        kind: 'handoff',
        ref: posixRel(root, handoffPath),
        sha256: sha256Of(handoffText),
        content: handoffText,
      });
    } else {
      unavailable.push(posixRel(root, handoffPath));
    }
  }

  return { target, inputs, unavailable, unmatchedPaperRefs };
}
