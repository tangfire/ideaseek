import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { sha256Of, sha256OfFile, type ContentHash } from '../core/hash.js';
import { ensureDir, writeFileAtomic } from '../core/atomic.js';
import { stableJson } from '../experiment/spec.js';
import { loadIdeaCard, loadWorkspaceMeta, listWorkspaces } from './workspace.js';

/**
 * IdeationRound (docs/IDEATION_ROUNDS.md): each round freezes an immutable
 * snapshot of inputs/knowledge/protocol/comparisons plus the inherited
 * context (previous ideas, verdicts, user feedback, novelty constraints).
 * Repeated ideation with unchanged inputs reuses everything and must say
 * honestly when there is not enough new information — never pad candidates.
 */

export type RoundStatus = 'open' | 'closed';

export interface RoundIdeaRef {
  ideaId: string;
  status: string;
  /** Canonical fingerprint for near-duplicate detection in later rounds. */
  fingerprint: string;
  feedbackLabels: string[];
}

export interface RoundSnapshots {
  /** Content hash of knowledge/input-manifest.json (null when absent). */
  inputManifestHash: ContentHash | null;
  paperCardCount: number;
  /**
   * Citable paper ids (parsed-paper sources, e.g. `papers/2111.10487.pdf`).
   *
   * The generation prompt told the model to "cite the paper id from the round
   * context" while the context carried only a count — so every card cited an
   * invented `round-context:…` label that `idea claim-audit` can never
   * resolve ("ingest it first" for a ref that is not a paper). Optional only
   * so rounds stored before this field still load; consumers read `?? []`.
   */
  paperIds?: string[];
  /** Content hash of knowledge/research-map.md (null when absent). */
  researchMapHash: ContentHash | null;
  protocolId: string | null;
  protocolHash: string | null;
  /** Metric identifiers of the locked protocol (empty when none is locked). */
  protocolMetrics: string[];
  comparisonSet: { methodId: string; status: string; commit: string | null }[];
  datasetRootHashes: string[];
}

export interface IdeationRound {
  roundId: string;
  createdAt: number;
  question: string | null;
  ideaLimit: number;
  modelRoute: string;
  parentRoundId: string | null;
  snapshots: RoundSnapshots;
  /** Idea refs inherited from previous rounds (immutable history). */
  inherited: RoundIdeaRef[];
  /** Mechanisms/components already tried — new candidates must differ. */
  noveltyConstraints: string[];
  /** Fingerprints of all ideas known at round creation (dedup baseline). */
  knownFingerprints: string[];
  instructions: string[];
  status: RoundStatus;
  stopReason: string | null;
  updatedAt: number;
}

export const FEEDBACK_LABELS = [
  'useful',
  'invalid',
  'prior-work',
  'experiment-invalid',
  'protocol-error',
  'data-error',
  'baseline-unfair',
] as const;

export type FeedbackLabel = (typeof FEEDBACK_LABELS)[number];

export interface FeedbackEntry {
  at: number;
  label: FeedbackLabel;
  reason: string | null;
  source: 'user';
}

export function roundsDir(projectRoot: string): string {
  return join(projectRoot, 'knowledge', 'ideation-rounds');
}

export function roundPath(projectRoot: string, roundId: string): string {
  return join(roundsDir(projectRoot), `${roundId}.json`);
}

/** Canonical idea fingerprint: stable over key order, sensitive to content. */
export function ideaFingerprint(card: {
  hypothesis?: { statement?: unknown };
  mechanismChain?: { steps?: { kind?: unknown; text?: unknown }[] };
  nearestComparisons?: { methodId?: unknown }[];
}): string {
  return sha256Of(
    stableJson({
      statement: String(card.hypothesis?.statement ?? '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim(),
      kinds: (card.mechanismChain?.steps ?? []).map((step) => String(step.kind ?? '')),
      comparisons: (card.nearestComparisons ?? []).map((c) => String(c.methodId ?? '')).sort(),
    }),
  );
}

async function fileHashOrNull(path: string): Promise<ContentHash | null> {
  try {
    return await sha256OfFile(path);
  } catch {
    return null;
  }
}

/** Freezes the current project state into a round snapshot (read-only). */
export async function computeSnapshots(projectRoot: string): Promise<RoundSnapshots> {
  const knowledge = join(projectRoot, 'knowledge');
  const inputManifestHash = await fileHashOrNull(join(knowledge, 'input-manifest.json'));
  const researchMapHash = await fileHashOrNull(join(knowledge, 'research-map.md'));

  let paperCardCount = 0;
  try {
    const { readdir } = await import('node:fs/promises');
    paperCardCount = (await readdir(join(knowledge, 'paper-cards'))).filter((name) =>
      name.endsWith('.json'),
    ).length;
  } catch {
    paperCardCount = 0;
  }

  let protocolId: string | null = null;
  let protocolHash: string | null = null;
  let protocolMetrics: string[] = [];
  try {
    const { ProjectRuntime } = await import('../workflow/runtime.js');
    const runtime = await ProjectRuntime.open({ cwd: projectRoot, recover: false });
    try {
      const artifacts = await runtime.db.listArtifactsByKind('protocol-proposal');
      const chosen = artifacts[artifacts.length - 1];
      if (chosen) {
        const proposal = JSON.parse(await runtime.store.readFinalText(chosen.contentHash)) as {
          protocolId?: unknown;
        };
        if (typeof proposal.protocolId === 'string') {
          protocolId = proposal.protocolId;
          const lock = await runtime.db.getProtocolLock(protocolId);
          protocolHash = lock?.protocolHash ?? null;
        }
        // The metric vocabulary the project is already committed to. An idea
        // card that invents its own metric spelling cannot be run: the primary
        // metric guard refused a real `idea experiment` because the ideation
        // round wrote "unseen-domain top-1 accuracy" where the locked protocol
        // says target_unseen_domain_top1_accuracy. Two model calls, no shared
        // vocabulary, and the mismatch surfaced as a user action item. Prose is
        // stripped because the identifier is what a spec must declare; the
        // definition stays readable in the protocol itself.
        const { metricIdentifier } = await import('../core/metric-id.js');
        const { protocolMetricNames, readLockedProtocol } =
          await import('../experiment/protocol-source.js');
        protocolMetrics = protocolMetricNames(await readLockedProtocol(runtime)).map(
          metricIdentifier,
        );
      }
      const methods = await runtime.db.listComparisons({});
      const comparisonSet = methods.map((method) => ({
        methodId: method.methodId,
        status: method.status,
        commit: ((method.record.repo ?? {}) as { commit?: string }).commit ?? null,
      }));
      // The citable corpus, from the artifacts claim-audit resolves against
      // (parsed-paper.source). paperCardCount comes from the same live source:
      // knowledge/paper-cards/ is legacy storage that no longer exists, and a
      // snapshot claiming "0 cards" while seven cards are indexed told the
      // generation model there was nothing to cite.
      let paperIds: string[] = [];
      try {
        const paperArtifacts = await runtime.db.listArtifactsByKind('parsed-paper');
        const ids = new Set<string>();
        for (const artifact of paperArtifacts) {
          try {
            const payload = JSON.parse(
              await runtime.store.readFinalText(artifact.contentHash),
            ) as { source?: unknown };
            if (typeof payload.source === 'string' && payload.source.trim()) {
              ids.add(payload.source.trim());
            }
          } catch {
            continue; // unreadable artifact → its ref stays out of the list
          }
        }
        paperIds = [...ids].sort();
        const cards = await runtime.db.listArtifactsByKind('papercard');
        if (cards.length > 0) paperCardCount = cards.length;
      } catch {
        // keep the directory-derived count
      }
      const datasets = JSON.parse(
        await (
          await import('node:fs/promises')
        ).readFile(join(knowledge, 'dataset-manifest.json'), 'utf8'),
      ) as { datasets?: { profile?: { rootHash?: string } }[] };
      const datasetRootHashes = (datasets.datasets ?? [])
        .map((d) => d.profile?.rootHash)
        .filter((hash): hash is string => typeof hash === 'string');
      return {
        inputManifestHash,
        paperCardCount,
        paperIds,
        researchMapHash,
        protocolId,
        protocolHash,
        protocolMetrics,
        comparisonSet,
        datasetRootHashes,
      };
    } finally {
      await runtime.close();
    }
  } catch {
    // No runtime yet (or unreadable manifests) — snapshot what we have.
    return {
      inputManifestHash,
      paperCardCount,
      paperIds: [],
      researchMapHash,
      protocolId,
      protocolHash,
      protocolMetrics,
      comparisonSet: [],
      datasetRootHashes: [],
    };
  }
}

export async function listRounds(projectRoot: string): Promise<IdeationRound[]> {
  const { readdir } = await import('node:fs/promises');
  let names: string[];
  try {
    names = (await readdir(roundsDir(projectRoot))).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const rounds: IdeationRound[] = [];
  for (const name of names) {
    try {
      rounds.push(JSON.parse(await readFile(join(roundsDir(projectRoot), name))) as IdeationRound);
    } catch {
      continue;
    }
  }
  rounds.sort((a, b) => a.createdAt - b.createdAt);
  return rounds;
}

async function readFile(path: string): Promise<string> {
  const { readFile: read } = await import('node:fs/promises');
  return read(path, 'utf8');
}

export async function loadRound(projectRoot: string, roundId: string): Promise<IdeationRound> {
  try {
    return JSON.parse(await readFile(roundPath(projectRoot, roundId))) as IdeationRound;
  } catch {
    throw new IdeaseekError(
      'TASK_NOT_FOUND',
      `ideation round ${roundId} not found (ideaseek ideate --round new)`,
    );
  }
}

/** Existing idea refs with their feedback labels (append-only reads). */
export async function currentIdeaRefs(projectRoot: string): Promise<RoundIdeaRef[]> {
  const workspaces = await listWorkspaces(projectRoot);
  const refs: RoundIdeaRef[] = [];
  for (const workspace of workspaces) {
    const card = await loadIdeaCard(projectRoot, workspace.ideaId);
    refs.push({
      ideaId: workspace.ideaId,
      status: workspace.status,
      fingerprint: ideaFingerprint(card),
      feedbackLabels: (await loadFeedback(projectRoot, workspace.ideaId)).map((f) => f.label),
    });
  }
  return refs.sort((a, b) => a.ideaId.localeCompare(b.ideaId));
}

/** Novelty constraints: components/mechanisms already claimed by old ideas. */
export async function noveltyConstraints(projectRoot: string): Promise<string[]> {
  const workspaces = await listWorkspaces(projectRoot);
  const claims = new Set<string>();
  for (const workspace of workspaces) {
    const card = await loadIdeaCard(projectRoot, workspace.ideaId);
    for (const component of card.componentNecessity) {
      claims.add(
        `${workspace.ideaId}:${component.role}:${component.component.toLowerCase().trim()}`,
      );
    }
    claims.add(`${workspace.ideaId}:hypothesis:${card.hypothesis.statement.toLowerCase().trim()}`);
  }
  return [...claims].sort();
}

export interface CreateRoundInput {
  question: string | null;
  ideaLimit: number;
  modelRoute: string;
  instructions?: string[];
}

export interface CreateRoundResult {
  round: IdeationRound;
  /** False when inputs/knowledge/feedback are unchanged since the last round. */
  hasNewInformation: boolean;
  /** Why there is no new information (spec: honest "not enough" answer). */
  newInformationNote: string | null;
}

/**
 * Creates the next round (immutable). Duplicates the previous round's
 * inherited context and computes whether ANYTHING changed since then —
 * unchanged inputs + no new feedback ⇒ hasNewInformation=false, which the
 * CLI reports instead of pretending fresh candidates exist.
 */
export async function createRound(
  projectRoot: string,
  input: CreateRoundInput,
): Promise<CreateRoundResult> {
  const existing = await listRounds(projectRoot);
  const parent = existing.length > 0 ? existing[existing.length - 1]! : null;
  const roundNumber = existing.length + 1;
  const roundId = `r${roundNumber}`;

  const snapshots = await computeSnapshots(projectRoot);
  // Even r1 inherits ideas created before rounds existed — nothing is lost.
  const inherited = await currentIdeaRefs(projectRoot);
  const constraints = await noveltyConstraints(projectRoot);
  const knownFingerprints = inherited.map((ref) => ref.fingerprint);

  // Change detection vs the previous round's frozen snapshot.
  let hasNewInformation = parent === null;
  let newInformationNote: string | null = null;
  if (parent) {
    const changes: string[] = [];
    if (parent.snapshots.inputManifestHash !== snapshots.inputManifestHash) {
      changes.push('inputs changed');
    }
    if (parent.snapshots.researchMapHash !== snapshots.researchMapHash) {
      changes.push('research map changed');
    }
    if (parent.snapshots.paperCardCount !== snapshots.paperCardCount) {
      changes.push(`paper cards: ${parent.snapshots.paperCardCount} → ${snapshots.paperCardCount}`);
    }
    if (parent.snapshots.protocolHash !== snapshots.protocolHash) {
      changes.push('protocol changed');
    }
    if (stableJson(parent.snapshots.comparisonSet) !== stableJson(snapshots.comparisonSet)) {
      changes.push('comparison set changed');
    }
    const previousFeedback = parent.inherited.reduce((n, ref) => n + ref.feedbackLabels.length, 0);
    const currentFeedback = inherited.reduce((n, ref) => n + ref.feedbackLabels.length, 0);
    if (currentFeedback > previousFeedback) {
      changes.push(`new user feedback (${previousFeedback} → ${currentFeedback})`);
    }
    hasNewInformation = changes.length > 0;
    newInformationNote = hasNewInformation
      ? changes.join('; ')
      : 'no new evidence: papers/data/protocol/comparisons/feedback are unchanged since the last round';
  }

  const round: IdeationRound = {
    roundId,
    createdAt: Date.now(),
    question: input.question,
    ideaLimit: input.ideaLimit,
    modelRoute: input.modelRoute,
    parentRoundId: parent?.roundId ?? null,
    snapshots,
    inherited,
    noveltyConstraints: constraints,
    knownFingerprints,
    instructions: input.instructions ?? [],
    status: 'open',
    stopReason: hasNewInformation ? null : 'no-new-information',
    updatedAt: Date.now(),
  };

  await ensureDir(roundsDir(projectRoot));
  const path = roundPath(projectRoot, roundId);
  const { access } = await import('node:fs/promises');
  try {
    await access(path);
    throw new IdeaseekError(
      'ALREADY_INITIALIZED',
      `ideation round ${roundId} already exists (rounds are immutable)`,
    );
  } catch (error) {
    if (error instanceof IdeaseekError) throw error;
    // does not exist → write
  }
  await writeFileAtomic(path, `${JSON.stringify(round, null, 2)}\n`);
  return { round, hasNewInformation, newInformationNote };
}

/** Appends a user feedback entry (append-only; never rewrites history). */
export async function appendFeedback(
  projectRoot: string,
  ideaId: string,
  label: FeedbackLabel,
  reason: string | null,
): Promise<{ entry: FeedbackEntry; total: number }> {
  await loadWorkspaceMeta(projectRoot, ideaId); // fails fast for unknown ideas
  const path = join(ideaDirSafe(projectRoot, ideaId), 'feedback.json');
  const existing = await loadFeedback(projectRoot, ideaId);
  const entry: FeedbackEntry = { at: Date.now(), label, reason, source: 'user' };
  const next = [...existing, entry];
  await ensureDir(join(projectRoot, 'ideas', ideaId));
  await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  return { entry, total: next.length };
}

export async function loadFeedback(projectRoot: string, ideaId: string): Promise<FeedbackEntry[]> {
  try {
    return JSON.parse(
      await readFile(join(ideaDirSafe(projectRoot, ideaId), 'feedback.json')),
    ) as FeedbackEntry[];
  } catch {
    return [];
  }
}

function ideaDirSafe(projectRoot: string, ideaId: string): string {
  return join(projectRoot, 'ideas', ideaId);
}
