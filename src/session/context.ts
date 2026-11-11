import { IdeaseekError } from '../core/errors.js';
import { writeFileAtomic } from '../core/atomic.js';

/**
 * Cross-session recovery context (Phase 4.5B, ARIS session-recovery
 * capability): when a terminal session ends (or dies) the next one gets
 * a compact summary — when the previous session ran, the latest run
 * state, the last events, pending approvals and artifact references —
 * so context is REBUILT from persisted state, never from memory
 * (ADR-002: sessions are disposable, workflow state is not).
 */

export interface LastSession {
  pid: number;
  startedAt: number;
  /** Absent = the session never recorded a clean end (crash/kill). */
  endedAt?: number;
  clean?: boolean;
}

export interface ContextEventRef {
  seq: number;
  type: string;
  summary: string;
  ts: number;
}

export interface ContextIdeaRef {
  ideaId: string;
  plan: string | null;
  novelty: string | null;
  review: string | null;
}

export interface ContextReport {
  previousSession: (LastSession & { endedCleanly: boolean | null }) | null;
  sessionMode: string;
  run: { runId: string; status: string; phase: string } | null;
  lastEvents: ContextEventRef[];
  pendingApprovals: number;
  artifacts: { kind: string; hash: string }[];
  ideas: ContextIdeaRef[];
}

function lastSessionPath(root: string): string {
  return `${root.replace(/[\\/]+$/, '')}/.research/last-session.json`;
}

export async function readLastSession(root: string): Promise<LastSession | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    const parsed = JSON.parse(await readFile(lastSessionPath(root), 'utf8')) as LastSession;
    return typeof parsed.pid === 'number' && typeof parsed.startedAt === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

/** Records session start (replaces any previous marker). */
export async function writeSessionStart(root: string): Promise<void> {
  await writeFileAtomic(
    lastSessionPath(root),
    `${JSON.stringify({ pid: process.pid, startedAt: Date.now() }, null, 2)}\n`,
  );
}

/** Records a clean session end; a crash leaves endedAt absent. */
export async function writeSessionEnd(root: string, clean: boolean): Promise<void> {
  const current = (await readLastSession(root)) ?? { pid: process.pid, startedAt: Date.now() };
  if (current.pid !== process.pid) return; // never clobber a newer session
  await writeFileAtomic(
    lastSessionPath(root),
    `${JSON.stringify({ ...current, endedAt: Date.now(), clean }, null, 2)}\n`,
  );
}

export async function collectContext(root: string): Promise<ContextReport> {
  const previous = await readLastSession(root);
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  try {
    const { readSessionMode } = await import('./mode.js');
    const sessionMode = await readSessionMode(root);
    const run = await runtime.db.getLatestRun(runtime.project.id);

    let lastEvents: ContextEventRef[] = [];
    if (run) {
      const events = await runtime.db.listEvents(run.runId, { limit: 1000 });
      lastEvents = events
        .slice(-3)
        .reverse()
        .map((event) => ({
          seq: event.seq,
          type: event.eventType,
          summary: event.summary,
          ts: event.ts,
        }));
    }

    let pendingApprovals = 0;
    try {
      const { collectPendingApprovals } = await import('../approval/pending.js');
      pendingApprovals = (await collectPendingApprovals(root)).length;
    } catch {
      pendingApprovals = 0;
    }

    const artifacts: { kind: string; hash: string }[] = [];
    if (run) {
      for (const artifact of (await runtime.db.listArtifactsByRun(run.runId)).slice(-5)) {
        artifacts.push({ kind: artifact.kind, hash: artifact.contentHash });
      }
      artifacts.reverse();
    }

    const ideas: ContextIdeaRef[] = [];
    try {
      const { listWorkspaces } = await import('../idea/workspace.js');
      const { loadStoredPlan } = await import('../experiment/plan.js');
      const { readNoveltyReport } = await import('../idea/novelty.js');
      const { readLatestReview } = await import('../idea/review.js');
      for (const workspace of await listWorkspaces(root)) {
        const plan = await loadStoredPlan(runtime, workspace.ideaId);
        const novelty = await readNoveltyReport(root, workspace.ideaId);
        const review = await readLatestReview(root, workspace.ideaId);
        ideas.push({
          ideaId: workspace.ideaId,
          plan: plan ? plan.inputHash.slice(0, 19) : null,
          novelty: novelty ? novelty.inputHash.slice(0, 19) : null,
          review: review ? `r${review.round}:${review.inputHash.slice(0, 13)}` : null,
        });
      }
    } catch {
      // no workspaces → empty references
    }

    const endedCleanly =
      previous === null ? null : previous.endedAt !== undefined ? previous.clean === true : false; // started but never ended → crash/kill

    return {
      previousSession: previous ? { ...previous, endedCleanly } : null,
      sessionMode,
      run: run ? { runId: run.runId, status: run.status, phase: run.phase } : null,
      lastEvents,
      pendingApprovals,
      artifacts,
      ideas,
    };
  } finally {
    await runtime.close();
  }
}

/** Guard for callers that need a project (CLI surface). */
export async function requireProjectRoot(): Promise<string> {
  const { findProjectRoot } = await import('../config/paths.js');
  const root = await findProjectRoot(process.cwd());
  if (!root) {
    throw new IdeaseekError('NOT_INITIALIZED', 'no IdeaSeek project here; run: ideaseek init');
  }
  return root;
}
