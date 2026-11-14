import type { InputDriftReport } from '../knowledge/input-drift.js';
import { redactAgentText } from './session.js';

/**
 * Shared agent turn persistence, project-brief injection, and post-turn input
 * drift check (ADR-006). Used by both `ideaseek agent` CLI and the TUI's warm
 * in-process DSH host so both surfaces guarantee identical provenance/auditing.
 */

export const GENERAL_SCOPE_NOTICE =
  '通用 coding 回合（当前目录不是 IdeaSeek 项目）：不记 RunEvent、不做原始输入漂移侦测、' +
  '不注入项目摘要；回合本身进用户级会话列表（`ideaseek agent --list` / TUI `/agent` 可回看）。';

export async function composeTurnPrompt(
  root: string,
  prompt: string,
  isNewSession: boolean,
): Promise<string> {
  if (!isNewSession) return prompt;
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  const { readSessionMode } = await import('../session/mode.js');
  let brief: string[];
  try {
    const runtime = await ProjectRuntime.open({ cwd: root, recover: false });
    try {
      const run = await runtime.db.getLatestRun(runtime.project.id);
      brief = [
        `[IdeaSeek 项目上下文｜本回合为新建 session 的一次性注入]`,
        `project: ${runtime.project.name} (${root})`,
        `research tier: ${await readSessionMode(root)}`,
        run
          ? `question: ${String(run.question ?? '').slice(0, 300)}`
          : 'question: 尚未开始 run（尚无研究问题记录）',
        `provenance anchors: papers/、datasets/、comparisons/upstream/ 的内容已被 hash 记录；改动会被侦测并使下游结论失效。要改数据请写派生版本或处理后走 scan/datasets link。`,
        `科研语义（指标/split/comparison/假设/协议）不在本回合里静默改；需要时说明并由用户在 Research 面确认。`,
      ];
    } finally {
      await runtime.close();
    }
  } catch {
    return prompt;
  }
  return `${brief.join('\n')}\n\n--- 用户指令 ---\n${prompt}`;
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
    if (run) {
      const event = await runtime.db.appendEvent({
        runId: run.runId,
        phase: 'DECISION',
        objectId: 'input-drift',
        role: 'system',
        eventType: 'input_drift',
        summary: driftEventSummary(report),
        status: 'stale',
      });
      eventSeq = event.seq;
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
    if (!run) return null;
    const event = await runtime.db.appendEvent({
      runId: run.runId,
      phase: 'DECISION',
      objectId: detail.sessionId,
      role: 'system',
      eventType: 'agent_turn',
      summary:
        `agent turn on session ${detail.sessionId} ` +
        `(${detail.resumed ? 'resumed' : 'new'}, ${detail.eventCount} event(s), ` +
        `${detail.approvalsCount} approval(s)): ` +
        redactAgentText(detail.prompt).slice(0, 160),
      status: detail.finishReason ?? 'completed',
    });
    return event.seq;
  } finally {
    await runtime.close();
  }
}
