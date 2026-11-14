import { findProjectRoot } from '../../config/paths.js';
import { summarizeUsage } from '../../runtime/usage.js';
import { ProjectRuntime } from '../../workflow/runtime.js';
import { visualWidth } from '../text-width.js';

/**
 * Lightweight read-only telemetry snapshot for the TUI statusline (Header /
 * Footer). Queries persisted SQLite state in-process without spawning a CLI
 * subprocess, so the statusline stays fresh without taxing CPU or startup.
 */

export interface LiveStatusSnapshot {
  project: string;
  phase: string | null;
  runStatus: string | null;
  tasksDone: number;
  tasksTotal: number;
  tasksRunning: number;
  tasksFailed: number;
  totalTokens: number;
  totalCostUsd: number | null;
  pendingDecisions: number;
}

export async function readLiveStatusSnapshot(cwd: string): Promise<LiveStatusSnapshot | null> {
  const root = await findProjectRoot(cwd).catch(() => null);
  if (!root) return null;
  let runtime: ProjectRuntime | null = null;
  try {
    runtime = await ProjectRuntime.open({ cwd: root, recover: false });
    const run = await runtime.db.getLatestRun(runtime.project.id);
    if (!run) {
      return {
        project: runtime.project.name,
        phase: null,
        runStatus: null,
        tasksDone: 0,
        tasksTotal: 0,
        tasksRunning: 0,
        tasksFailed: 0,
        totalTokens: 0,
        totalCostUsd: null,
        pendingDecisions: 0,
      };
    }
    const tasks = await runtime.db.listTasks(run.runId);
    let tasksDone = 0;
    let tasksRunning = 0;
    let tasksFailed = 0;
    for (const task of tasks) {
      if (task.status === 'succeeded') tasksDone += 1;
      else if (task.status === 'failed') tasksFailed += 1;
      else if (
        task.status === 'leased' ||
        task.status === 'running' ||
        task.status === 'committing'
      ) {
        tasksRunning += 1;
      }
    }
    const events = await runtime.db.listEvents(run.runId, { limit: 1000 });
    const pendingDecisions = events.filter(
      (e) => e.eventType === 'decision' && e.status === 'pending-approval',
    ).length;
    const usage = summarizeUsage(
      run.runId,
      events,
      runtime.config.resources.modelRates,
      runtime.config.resources.maxModelCost,
      runtime.config.resources.maxModelTokens,
    );
    return {
      project: runtime.project.name,
      phase: run.phase,
      runStatus: run.status,
      tasksDone,
      tasksTotal: tasks.length,
      tasksRunning,
      tasksFailed,
      totalTokens: usage.inputTokens + usage.outputTokens,
      totalCostUsd: usage.costUsd,
      pendingDecisions,
    };
  } catch {
    return null;
  } finally {
    await runtime?.close().catch(() => undefined);
  }
}

function renderMiniBar(done: number, total: number, width = 8): string {
  if (total <= 0) return '';
  const ratio = Math.max(0, Math.min(1, done / total));
  const filled = Math.round(ratio * width);
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
}

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tok`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k tok`;
  return `${tokens} tok`;
}

/** Formats concise telemetry chips (`PAPER_ANALYSIS 18/42 [███░░] · $0.04 · ⚠ 1 pending`). */
export function formatStatusTelemetry(snap: LiveStatusSnapshot | null, maxCols = 48): string {
  if (!snap || !snap.runStatus) return '';
  const parts: string[] = [];
  if (snap.phase && snap.tasksTotal > 0) {
    const bar = maxCols >= 36 ? ` [${renderMiniBar(snap.tasksDone, snap.tasksTotal, 6)}]` : '';
    parts.push(`${snap.phase} ${snap.tasksDone}/${snap.tasksTotal}${bar}`);
  } else if (snap.phase) {
    parts.push(snap.phase);
  }
  if (snap.totalCostUsd !== null && snap.totalCostUsd > 0) {
    parts.push(`$${snap.totalCostUsd.toFixed(2)}`);
  } else if (snap.totalTokens > 0) {
    parts.push(formatCompactTokens(snap.totalTokens));
  }
  if (snap.pendingDecisions > 0) {
    parts.push(`⚠ ${snap.pendingDecisions} pending`);
  }
  const text = parts.join(' · ');
  return visualWidth(text) <= maxCols ? text : parts.slice(0, 1).join('');
}
