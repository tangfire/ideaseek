import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir, writeFileAtomic } from '../core/atomic.js';
import { sha256Of } from '../core/hash.js';
import type { InputDriftReport } from '../knowledge/input-drift.js';
import { assertCostWithinBudget, computeCostUsd, summarizeUsage } from '../runtime/usage.js';
import { redactAgentText } from './session.js';

/**
 * Shared agent turn persistence, project-brief/delta injection, budget
 * enforcement/recording, and post-turn input drift check (ADR-006). Used by
 * both `ideaseek agent` CLI and the TUI's warm in-process DSH host so Coding
 * turns share the project's cost ceiling, provenance audit, and state view.
 */

export const GENERAL_SCOPE_NOTICE =
  '通用 coding 回合（当前目录不是 IdeaSeek 项目）：不记 RunEvent、不做原始输入漂移侦测、' +
  '不注入项目摘要；回合本身进用户级会话列表（`ideaseek agent --list` / TUI `/agent` 可回看）。';

const TERMINAL_RUN_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELED']);

interface AgentContextStateMap {
  sessions: Record<string, string>;
}

function contextStatePath(root: string): string {
  return join(root, '.research', 'agent-context-state.json');
}

function projectAuditLedgerPath(root: string): string {
  return join(root, '.research', 'project-agent-audit.jsonl');
}

async function appendProjectAuditEntry(
  root: string,
  entry: Record<string, unknown>,
): Promise<void> {
  try {
    await ensureDir(join(root, '.research'));
    await appendFile(projectAuditLedgerPath(root), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // audit ledger must never crash a turn
  }
}

export async function readRecentProjectAgentAudits(
  root: string,
  limit = 5,
): Promise<Record<string, unknown>[]> {
  try {
    const raw = await readFile(projectAuditLedgerPath(root), 'utf8');
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const out: Record<string, unknown>[] = [];
    for (const line of lines.slice(-limit)) {
      try {
        out.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        continue;
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function readContextSignature(root: string, sessionId: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(contextStatePath(root), 'utf8')) as AgentContextStateMap;
    return typeof raw.sessions?.[sessionId] === 'string' ? raw.sessions[sessionId]! : null;
  } catch {
    return null;
  }
}

async function writeContextSignature(
  root: string,
  sessionId: string,
  signature: string,
): Promise<void> {
  let map: AgentContextStateMap = { sessions: {} };
  try {
    const raw = JSON.parse(await readFile(contextStatePath(root), 'utf8')) as AgentContextStateMap;
    if (raw && typeof raw.sessions === 'object' && raw.sessions !== null) {
      map = { sessions: { ...raw.sessions } };
    }
  } catch {
    map = { sessions: {} };
  }
  map.sessions[sessionId] = signature;
  const keys = Object.keys(map.sessions);
  if (keys.length > 40) {
    for (const k of keys.slice(0, keys.length - 40)) delete map.sessions[k];
  }
  await writeFileAtomic(contextStatePath(root), `${JSON.stringify(map, null, 2)}\n`);
}

export async function composeTurnPrompt(
  root: string,
  prompt: string,
  isNewSession: boolean,
  opts: { sessionId?: string } = {},
): Promise<string> {
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const { readSessionMode } = await import('../session/mode.js');
  const { detectInputDrift, hasInputDrift } = await import('../knowledge/input-drift.js');

  let tier: string;
  let projectName = '';
  let runSummary = '尚未开始 run（尚无研究问题记录）';
  let runId = 'none';
  let questionText = '';
  try {
    const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
    try {
      projectName = runtime.project.name;
      tier = await readSessionMode(root);
      const run = await runtime.db.getLatestRun(runtime.project.id);
      if (run) {
        runId = `${run.runId}:${run.status}:${run.phase}`;
        questionText = String(run.question ?? '').slice(0, 300);
        runSummary = questionText || '尚未开始 run（尚无研究问题记录）';
      } else if (runtime.config.research.question) {
        questionText = runtime.config.research.question.slice(0, 300);
        runSummary = questionText;
      }
    } finally {
      await runtime.close();
    }
  } catch {
    return prompt;
  }

  let driftCount = 0;
  try {
    const drift = await detectInputDrift(root);
    if (drift.hasBaseline && hasInputDrift(drift)) driftCount = drift.drifted.length;
  } catch {
    driftCount = 0;
  }

  const statePayload = `${tier}|${runId}|${questionText}|drift=${driftCount}`;
  const signature = sha256Of(statePayload);

  if (isNewSession) {
    if (opts.sessionId) {
      await writeContextSignature(root, opts.sessionId, signature).catch(() => undefined);
    }
    const brief = [
      `[IdeaSeek 项目上下文｜本回合为新建 session 的一次性注入]`,
      `project: ${projectName} (${root})`,
      `research tier: ${tier}`,
      runId === 'none' ? `question: ${runSummary}` : `question: ${runSummary} (run ${runId})`,
      ...(driftCount > 0 ? [`input drift: ${driftCount} 个锚点文件相对 scan 基线已漂移`] : []),
      `provenance anchors: papers/、datasets/、comparisons/upstream/（及 comparisons/*/upstream/）的内容已被 hash 记录；改动会被侦测并使下游结论失效。要改数据请写派生版本或处理后走 scan/datasets link。`,
      `科研语义（指标/split/comparison/假设/协议）不在本回合里静默改；需要时说明并由用户在 Research 面确认。`,
    ];
    return `${brief.join('\n')}\n\n--- 用户指令 ---\n${prompt}`;
  }

  // Resumed session: only inject a compact delta if the project state (tier,
  // active run/question, or input drift) changed since this session's last turn.
  if (opts.sessionId) {
    const prev = await readContextSignature(root, opts.sessionId);
    if (prev !== signature) {
      await writeContextSignature(root, opts.sessionId, signature).catch(() => undefined);
      if (prev !== null) {
        const delta = [
          `[IdeaSeek 状态同步] tier=${tier} · run=${runId}` +
            (driftCount > 0 ? ` · inputDrift=${driftCount} file(s)` : ''),
          ...(tier === 'analysis'
            ? ['当前科研档位为 analysis（只读准备），勿修改锁定协议或触发正式实验。']
            : []),
        ];
        return `${delta.join('\n')}\n\n--- 用户指令 ---\n${prompt}`;
      }
    }
  }
  return prompt;
}

/**
 * Enforces the project's configured model cost/token ceiling before launching
 * an in-project coding turn so Coding shares the same QUOTA_EXHAUSTED guard as
 * Research/Analysis model calls.
 */
export async function assertProjectAgentBudget(root: string): Promise<void> {
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  try {
    const run = await runtime.db.getLatestRun(runtime.project.id);
    if (!run || TERMINAL_RUN_STATES.has(run.status)) return;
    const events = await runtime.db.listEvents(run.runId, { limit: 100_000 });
    const summary = summarizeUsage(
      run.runId,
      events,
      runtime.config.resources.modelRates,
      runtime.config.resources.maxModelCost,
      runtime.config.resources.maxModelTokens,
    );
    assertCostWithinBudget(summary);
  } finally {
    await runtime.close();
  }
}

export async function recordProjectAgentUsage(
  root: string,
  detail: {
    sessionId: string;
    inputTokens: number;
    outputTokens: number;
    model: string | null;
  },
): Promise<number | null> {
  if (detail.inputTokens <= 0 && detail.outputTokens <= 0) return null;
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  try {
    const costUsd = computeCostUsd(
      runtime.config.resources.modelRates,
      detail.inputTokens,
      detail.outputTokens,
    );
    const summaryPayload = {
      in: detail.inputTokens,
      out: detail.outputTokens,
      cost: costUsd,
      model: detail.model ?? 'dsh-agent',
      taskId: `agent:${detail.sessionId}`,
    };
    const run = await runtime.db.getLatestRun(runtime.project.id);
    if (run && !TERMINAL_RUN_STATES.has(run.status)) {
      const event = await runtime.db.appendEvent({
        runId: run.runId,
        phase: 'USAGE',
        objectId: null,
        role: detail.model ?? 'dsh-agent',
        eventType: 'model_usage',
        summary: JSON.stringify(summaryPayload),
        status: null,
      });
      return event.seq;
    }
    await appendProjectAuditEntry(root, {
      ts: Date.now(),
      eventType: 'model_usage',
      sessionId: detail.sessionId,
      ...summaryPayload,
    });
    return null;
  } finally {
    await runtime.close();
  }
}

export async function checkInputDriftAfterTurn(root: string): Promise<{
  report: InputDriftReport;
  eventSeq: number | null;
}> {
  const { detectInputDrift, driftEventSummary, hasInputDrift } =
    await import('../knowledge/input-drift.js');
  const report = await detectInputDrift(root);
  if (!hasInputDrift(report)) return { report, eventSeq: null };
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  let eventSeq: number | null = null;
  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  try {
    const run = await runtime.db.getLatestRun(runtime.project.id);
    const summary = driftEventSummary(report);
    if (run && !TERMINAL_RUN_STATES.has(run.status)) {
      const event = await runtime.db.appendEvent({
        runId: run.runId,
        phase: 'DECISION',
        objectId: 'input-drift',
        role: 'system',
        eventType: 'input_drift',
        summary,
        status: 'stale',
      });
      eventSeq = event.seq;
    } else {
      await appendProjectAuditEntry(root, {
        ts: Date.now(),
        eventType: 'input_drift',
        summary,
        drifted: report.drifted.map((d) => ({ path: d.relPath, change: d.change })),
      });
    }
  } finally {
    await runtime.close();
  }
  return { report, eventSeq };
}

export function inputDriftJson(report: InputDriftReport) {
  return {
    roots: report.roots,
    hasBaseline: report.hasBaseline,
    hashMatched: report.checked,
    unchecked: report.unchecked,
    drifted: report.drifted.length,
    changes: report.drifted.slice(0, 20).map((file) => ({
      path: file.relPath,
      change: file.change,
    })),
  };
}

export async function auditProjectAgentTurn(
  root: string,
  detail: {
    sessionId: string;
    resumed: boolean;
    eventCount: number;
    approvalsCount: number;
    prompt: string;
    finishReason: string | null;
  },
): Promise<number | null> {
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
  try {
    const run = await runtime.db.getLatestRun(runtime.project.id);
    const summary =
      `agent turn on session ${detail.sessionId} ` +
      `(${detail.resumed ? 'resumed' : 'new'}, ${detail.eventCount} event(s), ` +
      `${detail.approvalsCount} approval(s)): ` +
      redactAgentText(detail.prompt).slice(0, 160);
    if (run && !TERMINAL_RUN_STATES.has(run.status)) {
      const event = await runtime.db.appendEvent({
        runId: run.runId,
        phase: 'DECISION',
        objectId: detail.sessionId,
        role: 'system',
        eventType: 'agent_turn',
        summary,
        status: detail.finishReason ?? 'completed',
      });
      return event.seq;
    }
    await appendProjectAuditEntry(root, {
      ts: Date.now(),
      eventType: 'agent_turn',
      sessionId: detail.sessionId,
      summary,
      status: detail.finishReason ?? 'completed',
    });
    return null;
  } finally {
    await runtime.close();
  }
}
