import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { computeSpecHash, type ExperimentSpec, type RunResult } from '../experiment/spec.js';
import { listRounds } from '../idea/rounds.js';
import { loadWorkspaceMeta } from '../idea/workspace.js';
import type { WorkflowDb } from './db.js';
import type { NewResearchNode, ResearchNodeKind, ResearchNodeStatus } from './types.js';

/**
 * ResearchRun node ledger (docs/LONG_RUNNING_WORKFLOWS WorkflowNode): a durable
 * graph spanning idea rounds, experiments and analysis for one run.
 *
 * Sync is a projection of immutable sources (round files, the experiment
 * registry + idea-workspace mirrors, analysis files) — it never executes
 * anything, never deletes rows, and is idempotent: a second sync with unchanged
 * sources appends no events and never downgrades a succeeded node to pending
 * (成功节点不重做). Invalidation is re-derived from sources on every sync:
 *   1. version supersession — experiment/analysis nodes bound to an ideaVersion
 *      below the workspace's currentVersion are `invalidated`;
 *   2. dependency propagation — a node whose dependsOn contains an invalidated
 *      node is invalidated too (fixpoint).
 * Branching preserves the parent's executed nodes (保留旧 idea、所有结果和失败
 * 记录); the child starts with no inherited experiment/analysis nodes and
 * cross-idea edges are never built because dependencies are scoped by
 * ideaId + ideaVersion.
 */

export interface ResearchSyncReport {
  runId: string | null;
  /** True when no run exists yet — nothing to attach nodes to. */
  skipped: boolean;
  created: string[];
  updated: string[];
  /** Nodes invalidated as of this sync (created or transitioned). */
  invalidated: string[];
  unchanged: number;
  eventsAppended: number;
}

export function emptyResearchSyncReport(runId: string | null = null): ResearchSyncReport {
  return {
    runId,
    skipped: runId === null,
    created: [],
    updated: [],
    invalidated: [],
    unchanged: 0,
    eventsAppended: 0,
  };
}

interface DesiredNode {
  nodeId: string;
  kind: ResearchNodeKind;
  objectId: string;
  status: ResearchNodeStatus;
  dependsOn: string[];
  payload: Record<string, unknown>;
  invalidationReason: string | null;
}

function ideaBinding(spec: ExperimentSpec): { ideaId: string; ideaVersion: number } | null {
  const idea = spec.idea;
  if (idea && typeof idea.ideaId === 'string' && typeof idea.version === 'number') {
    return { ideaId: idea.ideaId, ideaVersion: idea.version };
  }
  return null;
}

function experimentNodeStatus(result: RunResult | null): ResearchNodeStatus {
  if (!result) return 'pending';
  return result.status === 'succeeded' ? 'succeeded' : 'failed';
}

function experimentNode(
  spec: ExperimentSpec,
  result: RunResult | null,
  specHash: string,
): DesiredNode {
  const binding = ideaBinding(spec);
  return {
    nodeId: `experiment:${spec.specId}:v${spec.version}`,
    kind: 'experiment',
    objectId: `${spec.specId}:v${spec.version}`,
    status: experimentNodeStatus(result),
    dependsOn: [],
    payload: {
      specId: spec.specId,
      specVersion: spec.version,
      specHash,
      ideaId: binding?.ideaId ?? null,
      ideaVersion: binding?.ideaVersion ?? null,
      resultStatus: result?.status ?? null,
      failureCategory: result?.failure?.category ?? null,
    },
    invalidationReason: null,
  };
}

/** Idea-workspace mirrors keep per-version history the registry row overwrites. */
async function readMirrorExperiments(projectRoot: string): Promise<DesiredNode[]> {
  const out: DesiredNode[] = [];
  let ideaDirs: string[];
  try {
    ideaDirs = await readdir(join(projectRoot, 'ideas'));
  } catch {
    return out;
  }
  for (const name of ideaDirs) {
    const experimentsDir = join(projectRoot, 'ideas', name, 'experiments');
    let files: string[];
    try {
      files = await readdir(experimentsDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!/^idea-.*-v\d+\.json$/.test(file)) continue;
      try {
        const parsed = JSON.parse(await readFile(join(experimentsDir, file), 'utf8')) as {
          spec?: ExperimentSpec;
          result?: RunResult | null;
        };
        if (!parsed.spec) continue;
        out.push(experimentNode(parsed.spec, parsed.result ?? null, computeSpecHash(parsed.spec)));
      } catch {
        continue; // an unreadable mirror must not poison the whole sync
      }
    }
  }
  return out;
}

async function readAnalysisNodes(projectRoot: string): Promise<DesiredNode[]> {
  const out: DesiredNode[] = [];
  let ideaDirs: string[];
  try {
    ideaDirs = await readdir(join(projectRoot, 'ideas'));
  } catch {
    return out;
  }
  for (const name of ideaDirs) {
    const experimentsDir = join(projectRoot, 'ideas', name, 'experiments');
    let files: string[];
    try {
      files = await readdir(experimentsDir);
    } catch {
      continue;
    }
    for (const file of files) {
      const match = /^analysis-v(\d+)\.json$/.exec(file);
      if (!match) continue;
      try {
        const parsed = JSON.parse(await readFile(join(experimentsDir, file), 'utf8')) as {
          ideaId?: unknown;
          ideaVersion?: unknown;
          verdict?: unknown;
          failureClass?: unknown;
        };
        const ideaId = typeof parsed.ideaId === 'string' ? parsed.ideaId : name;
        const ideaVersion =
          typeof parsed.ideaVersion === 'number' ? parsed.ideaVersion : Number(match[1]);
        if (!Number.isFinite(ideaVersion)) continue;
        out.push({
          nodeId: `analysis:${ideaId}:v${ideaVersion}`,
          kind: 'analysis',
          objectId: `${ideaId}:v${ideaVersion}`,
          status: 'succeeded',
          dependsOn: [],
          payload: {
            ideaId,
            ideaVersion,
            verdict: typeof parsed.verdict === 'string' ? parsed.verdict : 'unknown',
            failureClass: typeof parsed.failureClass === 'string' ? parsed.failureClass : 'none',
          },
          invalidationReason: null,
        });
      } catch {
        continue;
      }
    }
  }
  return out;
}

/** `superseded by idea v${current}` when the node's ideaVersion is stale. */
function supersessionReason(
  payload: Record<string, unknown>,
  currentVersions: Map<string, number | null>,
): string | null {
  const ideaId = payload.ideaId;
  const ideaVersion = payload.ideaVersion;
  if (typeof ideaId !== 'string' || typeof ideaVersion !== 'number') return null;
  const current = currentVersions.get(ideaId);
  if (current === null || current === undefined) return null;
  return ideaVersion < current ? `superseded by idea v${current}` : null;
}

/**
 * Projects durable research state into the run's node graph and applies
 * invalidation rules (see module doc). Returns a report of created / updated /
 * invalidated node ids; appends at most one `research_sync` RunEvent when the
 * graph actually changed.
 */
export async function syncResearchRun(
  db: WorkflowDb,
  runId: string,
  projectRoot: string,
): Promise<ResearchSyncReport> {
  const report = emptyResearchSyncReport(runId);
  const existingList = await db.listResearchNodes(runId);
  const existingById = new Map(existingList.map((node) => [node.nodeId, node]));

  // --- collect sources -----------------------------------------------------
  const desired = new Map<string, DesiredNode>();

  const rounds = await listRounds(projectRoot);
  const roundIds = new Set(rounds.map((round) => round.roundId));
  for (const round of rounds) {
    const nodeId = `idea-round:${round.roundId}`;
    desired.set(nodeId, {
      nodeId,
      kind: 'idea-round',
      objectId: round.roundId,
      status: 'succeeded',
      dependsOn:
        round.parentRoundId && roundIds.has(round.parentRoundId)
          ? [`idea-round:${round.parentRoundId}`]
          : [],
      payload: {
        roundId: round.roundId,
        parentRoundId: round.parentRoundId ?? null,
        stopReason: round.stopReason ?? null,
      },
      invalidationReason: null,
    });
  }

  // Mirrors first, registry last: the registry row wins for the same version.
  for (const node of await readMirrorExperiments(projectRoot)) {
    desired.set(node.nodeId, node);
  }
  for (const doc of await db.listExperiments()) {
    const node = experimentNode(
      doc.spec as unknown as ExperimentSpec,
      (doc.result as unknown as RunResult | null) ?? null,
      doc.specHash,
    );
    desired.set(node.nodeId, node);
  }

  const analysisNodes = await readAnalysisNodes(projectRoot);
  for (const node of analysisNodes) {
    desired.set(node.nodeId, node);
  }

  // Lineage: analysis → experiments of the same ideaId + ideaVersion. Matched
  // against desired AND existing experiment nodes so historical edges survive a
  // registry overwrite (the old version row is gone but its node remains).
  type AnyNode = { kind: ResearchNodeKind; payload: Record<string, unknown>; nodeId: string };
  for (const node of analysisNodes) {
    const ideaId = node.payload.ideaId;
    const ideaVersion = node.payload.ideaVersion;
    const matches = (candidate: AnyNode) =>
      candidate.kind === 'experiment' &&
      candidate.payload.ideaId === ideaId &&
      candidate.payload.ideaVersion === ideaVersion;
    node.dependsOn = [
      ...[...desired.values()].filter(matches),
      ...[...existingById.values()].filter(matches),
    ]
      .map((candidate) => candidate.nodeId)
      .filter((id, index, all) => all.indexOf(id) === index);
  }

  // --- rule 1: version supersession (desired + orphans) --------------------
  const currentVersions = new Map<string, number | null>();
  const currentVersionOf = async (ideaId: string): Promise<number | null> => {
    if (!currentVersions.has(ideaId)) {
      try {
        const meta = await loadWorkspaceMeta(projectRoot, ideaId);
        currentVersions.set(ideaId, meta.currentVersion);
      } catch {
        currentVersions.set(ideaId, null); // workspace gone — leave the node alone
      }
    }
    return currentVersions.get(ideaId) ?? null;
  };
  for (const ideaId of collectIdeaIds(desired.values())) {
    await currentVersionOf(ideaId);
  }
  for (const node of desired.values()) {
    const reason = supersessionReason(node.payload, currentVersions);
    if (reason) {
      node.status = 'invalidated';
      node.invalidationReason = reason;
    }
  }

  // Orphans: a source row can disappear (the registry keeps only the latest
  // spec version) while its node stays — the version rule must still apply.
  const orphanWrites: NewResearchNode[] = [];
  for (const current of existingById.values()) {
    if (desired.has(current.nodeId) || current.status === 'invalidated') continue;
    const reason = supersessionReason(current.payload, currentVersions);
    if (!reason) continue;
    orphanWrites.push({
      runId,
      nodeId: current.nodeId,
      kind: current.kind,
      objectId: current.objectId,
      status: 'invalidated',
      dependsOn: current.dependsOn,
      payload: current.payload,
      invalidationReason: reason,
    });
  }

  // --- rule 2: dependency propagation over the union ------------------------
  const statusOf = (nodeId: string): ResearchNodeStatus | undefined =>
    desired.get(nodeId)?.status ??
    (orphanWrites.find((write) => write.nodeId === nodeId)?.status as
      ResearchNodeStatus | undefined) ??
    existingById.get(nodeId)?.status;
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of desired.values()) {
      if (node.status === 'invalidated') continue;
      const badDep = node.dependsOn.find((dep) => statusOf(dep) === 'invalidated');
      if (badDep) {
        node.status = 'invalidated';
        node.invalidationReason = `dependency ${badDep} invalidated`;
        changed = true;
      }
    }
  }

  // --- single write pass ----------------------------------------------------
  const markCreated = (nodeId: string, status: ResearchNodeStatus): void => {
    report.created.push(nodeId);
    if (status === 'invalidated') report.invalidated.push(nodeId);
  };
  const markUpdated = (
    nodeId: string,
    status: ResearchNodeStatus,
    wasInvalidated: boolean,
  ): void => {
    if (!report.updated.includes(nodeId)) report.updated.push(nodeId);
    if (status === 'invalidated' && !wasInvalidated && !report.invalidated.includes(nodeId)) {
      report.invalidated.push(nodeId);
    }
  };

  for (const write of orphanWrites) {
    const { created, changed: nodeChanged } = await db.upsertResearchNode(write);
    if (created) markCreated(write.nodeId, write.status);
    else if (nodeChanged) markUpdated(write.nodeId, write.status, false);
  }

  for (const node of desired.values()) {
    const before = existingById.get(node.nodeId);
    // 成功节点不重做: a succeeded node is never downgraded to pending.
    const status =
      before?.status === 'succeeded' && node.status === 'pending' ? 'succeeded' : node.status;
    const input: NewResearchNode = {
      runId,
      nodeId: node.nodeId,
      kind: node.kind,
      objectId: node.objectId,
      status,
      dependsOn: node.dependsOn,
      payload: node.payload,
      invalidationReason: status === 'invalidated' ? node.invalidationReason : null,
    };
    const { created, changed: nodeChanged } = await db.upsertResearchNode(input);
    if (created) {
      markCreated(node.nodeId, status);
    } else if (nodeChanged) {
      markUpdated(node.nodeId, status, before?.status === 'invalidated');
    } else {
      report.unchanged += 1;
    }
  }

  // --- one audit event per sync that changed the graph ----------------------
  if (report.created.length > 0 || report.updated.length > 0) {
    const invalidatedPart =
      report.invalidated.length > 0
        ? `; invalidated: ${report.invalidated.slice(0, 3).join(', ')}${
            report.invalidated.length > 3 ? ', …' : ''
          }`
        : '';
    await db.appendEvent({
      runId,
      phase: 'RESEARCH',
      objectId: null,
      role: 'system',
      eventType: 'research_sync',
      summary:
        `research nodes: +${report.created.length} created, ` +
        `${report.updated.length} updated${invalidatedPart}`,
      status: report.invalidated.length > 0 ? 'invalidated' : 'synced',
    });
    report.eventsAppended = 1;
  }
  return report;
}

function collectIdeaIds(nodes: Iterable<DesiredNode>): Set<string> {
  const ideaIds = new Set<string>();
  for (const node of nodes) {
    const ideaId = node.payload.ideaId;
    if (typeof ideaId === 'string') ideaIds.add(ideaId);
  }
  return ideaIds;
}
