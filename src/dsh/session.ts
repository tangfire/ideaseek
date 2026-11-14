import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';

/**
 * Agent mode → REAL DSH coding session (docs/ARCHITECTURE research-cli
 * headless/SDK, rule: no fixed greetings, no ask-supervisor stand-in).
 *
 * One turn boots the pinned DSH runtime via `@deepseek-ai/dsh-sdk-client`
 * (DeepSeekHarness), enables server approval requests, installs the
 * `approval/request` handler BEFORE the handshake, and runs the prompt on
 * a named/resumable session with the project as its working directory.
 * The runtime owns tool execution (project read/write, restricted shell,
 * test tools) and persists session history for `resumeSession`.
 *
 * Approval policy (never auto-approve):
 * - interactive TTY: ask the operator (y → allowed-once, n → rejected);
 * - non-TTY or --deny-tools: rejected (safe default — dismissal is never
 *   approval, one-shot grants never persist).
 * The key value never appears in IdeaSeek output, events or files.
 */

export type ApprovalPolicy = 'interactive' | 'deny';

export interface ApprovalDecision {
  outcome: 'allowed-once' | 'rejected' | 'cancelled';
  toolName: string;
  reason: string | null;
}

export interface ApprovalPrompt {
  (detail: { toolName: string; reason: string | null; sessionId: string }): Promise<boolean>;
}

/**
 * Pure approval decision (unit-testable): interactive prompting only
 * happens on a real TTY with a prompt function; everything else denies.
 */
export async function resolveApproval(
  policy: ApprovalPolicy,
  isTTY: boolean,
  prompt: ApprovalPrompt | null,
  detail: { toolName: string; reason: string | null; sessionId: string },
): Promise<ApprovalDecision> {
  if (policy === 'deny' || !isTTY || !prompt) {
    return {
      outcome: 'rejected',
      toolName: detail.toolName,
      reason:
        policy === 'deny'
          ? 'denied by --deny-tools policy'
          : 'no interactive TTY — tool approval defaults to rejected',
    };
  }
  const allowed = await prompt(detail);
  return {
    outcome: allowed ? 'allowed-once' : 'rejected',
    toolName: detail.toolName,
    reason: allowed ? 'operator approved once' : 'operator rejected',
  };
}

export interface AgentTurnOptions {
  cwd: string;
  prompt: string;
  /** Continue this persisted session instead of minting a new one. */
  sessionId?: string;
  policy?: ApprovalPolicy;
  provider?: string;
  model?: string;
  /** Explicit harness home override (tests isolate DSH_HOME). */
  dshHome?: string;
  /** Per-request bound (ms); undefined waits (a coding turn can run long). */
  requestTimeoutMs?: number;
  promptFn?: ApprovalPrompt;
  onLog?: (message: string) => void;
  /**
   * Live step-level lines for the transcript: tool/call, tool/result and
   * the turn's token usage (docs/TERMINAL_UX 实时事件 — display-only;
   * persistence into RunEvent stays the registered gap).
   */
  onStep?: (line: string) => void;
  /**
   * Intermediate assistant message text blocks emitted between tool steps
   * so multi-step turns stream visible progress instead of staying silent.
   */
  onAssistantText?: (text: string) => void;
}

export interface AgentTurnResult {
  sessionId: string;
  finalResponse: string;
  finishReason: string | null;
  eventCount: number;
  approvals: ApprovalDecision[];
  resumed: boolean;
}

/** Redacts anything key-shaped from diagnostics before they leave this module. */
export function redactAgentText(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, '[redacted]')
    .slice(0, 2000);
}

/**
 * Formats one live DSH session event for the activity pane, or null for
 * types the transcript does not show. `callNames` pairs tool/result lines
 * back to the tool name announced by their tool/call. Exported for tests.
 */
export function formatStepLine(
  type: string,
  data: unknown,
  callNames: Map<string, string>,
): string | null {
  if (type !== 'tool/call' && type !== 'tool/result') return null;
  const d = (data ?? {}) as {
    callId?: unknown;
    name?: unknown;
    arguments?: unknown;
    message?: { callId?: unknown; isError?: unknown };
    error?: { name?: unknown };
  };
  if (type === 'tool/call') {
    const callId = typeof d.callId === 'string' ? d.callId : '';
    const name = typeof d.name === 'string' && d.name ? d.name : 'tool';
    if (callId) callNames.set(callId, name);
    const raw = typeof d.arguments === 'string' ? d.arguments : '';
    const oneLine = raw.replace(/\s+/g, ' ').trim();
    const clipped = oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine;
    return `⚙ ${name}${clipped ? ` ${clipped}` : ''}`;
  }
  const callId = typeof d.message?.callId === 'string' ? d.message.callId : '';
  const name = (callId && callNames.get(callId)) || 'tool';
  if (callId) callNames.delete(callId);
  if (d.message?.isError !== true) return `⚙ ✓ ${name}`;
  const errName = typeof d.error?.name === 'string' && d.error.name ? d.error.name : 'failed';
  return `⚙ ✗ ${name} — ${errName}`;
}

/**
 * Extracts visible assistant text blocks from an `assistant/message` event
 * payload (never hidden `reasoning` blocks), returning null if absent.
 */
export function extractAssistantStepText(type: string, data: unknown): string | null {
  if (type !== 'assistant/message') return null;
  const content = (data as { message?: { content?: unknown } } | null)?.message?.content;
  if (!Array.isArray(content)) return null;
  const chunks: string[] = [];
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown } | null;
    if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      chunks.push(redactAgentText(b.text));
    }
  }
  return chunks.length > 0 ? chunks.join('\n') : null;
}

/** Formats subagent start/finish notifications for live step visibility. */
export function formatSubagentLine(method: string, params: unknown): string | null {
  if (method === 'subagent.started') {
    const childId = (params as { childSessionId?: unknown } | null)?.childSessionId;
    if (typeof childId === 'string' && childId) {
      return `  ↳ subagent started (${childId.slice(0, 12)})`;
    }
  }
  if (method === 'subagent.finished') {
    const p = (params as { childSessionId?: unknown; status?: unknown } | null) ?? {};
    const status = typeof p.status === 'string' ? p.status : 'done';
    const childId =
      typeof p.childSessionId === 'string' ? ` (${p.childSessionId.slice(0, 12)})` : '';
    return `  ↳ subagent ${status}${childId}`;
  }
  return null;
}

/**
 * Runs ONE real agent turn on a DSH session. Throws IdeaseekError with
 * recovery on boot/session failures; never fabricates a response.
 */
export async function runAgentTurn(opts: AgentTurnOptions): Promise<AgentTurnResult> {
  const { DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client');
  const policy = opts.policy ?? 'interactive';
  const approvals: ApprovalDecision[] = [];
  const log = opts.onLog ?? (() => undefined);

  const harness = new DeepSeekHarness({
    cwd: opts.cwd,
    approvalRequests: true,
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.dshHome ? { dshHome: opts.dshHome } : {}),
    ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
    initializeTimeoutMs: 15_000,
  });

  try {
    // Client must be started before onRequest can install (SDK contract);
    // harness.start() re-starts idempotently and performs the handshake.
    harness.client.start();
    // The interactive shell opts into the stdio approval channel
    // (IDEASEEK_AGENT_APPROVAL=stdio): promptFn answers over stdin, so
    // treat that pipe as an interactive surface. Plain script pipes
    // without the opt-in still deny (resolveApproval stays pure).
    const isTTY = process.stdin.isTTY === true || process.env.IDEASEEK_AGENT_APPROVAL === 'stdio';
    harness.client.onRequest(async (method, params) => {
      if (method !== 'approval/request') {
        throw new Error(`unexpected runtime request ${method}`);
      }
      const detail = params as {
        sessionId?: unknown;
        toolName?: unknown;
        reason?: unknown;
      };
      const decision = await resolveApproval(policy, isTTY, opts.promptFn ?? null, {
        toolName: String(detail.toolName ?? 'unknown-tool'),
        reason: typeof detail.reason === 'string' ? detail.reason : null,
        sessionId: String(detail.sessionId ?? ''),
      });
      approvals.push(decision);
      log(
        `approval ${decision.outcome}: ${decision.toolName}` +
          (decision.reason ? ` (${decision.reason})` : ''),
      );
      return { outcome: decision.outcome };
    });

    await harness.start();
    log('dsh runtime started');

    let resumed = false;
    let session;
    if (opts.sessionId) {
      try {
        session = await harness.resumeSession(opts.sessionId);
        resumed = true;
        log(`resumed session ${opts.sessionId}`);
      } catch (error) {
        // Stale registry id (pruned/expired session): fall back to a fresh
        // session loudly instead of wedging every subsequent message on a
        // dead id — the summary then honestly reports (new, …).
        log(
          `resume ${opts.sessionId} failed: ${redactAgentText((error as Error).message ?? String(error))}; starting a new session`,
        );
        session = harness.session();
      }
    } else {
      session = harness.session();
      log(`new session ${session.id}`);
    }

    // Live step-level lines: tool/call + tool/result + subagent + intermediate
    // assistant replies stream into the transcript as the model works instead
    // of the whole turn being a black box until the final reply.
    const callNames = new Map<string, string>();
    const result = await session.run(opts.prompt, {
      onNotification: (notification) => {
        const subLine = formatSubagentLine(notification.method, notification.params);
        if (subLine) {
          opts.onStep?.(subLine);
          return;
        }
        if (notification.method !== 'session.event') return;
        const event = (notification.params as { event?: { type?: unknown; data?: unknown } }).event;
        if (!event || typeof event.type !== 'string') return;
        if (event.type === 'step/start') {
          const step = (event.data as { step?: unknown } | undefined)?.step;
          if (typeof step === 'number' && step > 1) log(`step ${step}…`);
        }
        const assistantText = extractAssistantStepText(event.type, event.data);
        if (assistantText) opts.onAssistantText?.(assistantText);
        const line = formatStepLine(event.type, event.data, callNames);
        if (line) opts.onStep?.(line);
      },
    });
    if (result.finishReason === 'error') {
      throw new IdeaseekError(
        'MODEL_UNAVAILABLE',
        `agent turn failed: ${redactAgentText(result.finalResponse || 'runtime error')} — ` +
          'check provider/key (ideaseek models setup --test) and retry',
      );
    }
    // Turn total across steps — cost visibility for a research platform.
    let inputTokens = 0;
    let outputTokens = 0;
    for (const event of result.events) {
      if (event.type !== 'assistant/message') continue;
      const usage = (event.data as { usage?: { inputTokens?: number; outputTokens?: number } })
        .usage;
      inputTokens += usage?.inputTokens ?? 0;
      outputTokens += usage?.outputTokens ?? 0;
    }
    if (inputTokens > 0 || outputTokens > 0) {
      opts.onStep?.(`usage: ${inputTokens} in / ${outputTokens} out tokens`);
    }
    return {
      sessionId: result.sessionId,
      finalResponse: redactAgentText(result.finalResponse),
      finishReason: result.finishReason,
      eventCount: result.events.length,
      approvals,
      resumed,
    };
  } catch (error) {
    if (error instanceof IdeaseekError) throw error;
    throw new IdeaseekError(
      'ENV_UNSUPPORTED',
      `DSH session failed to start: ${redactAgentText((error as Error).message ?? String(error))} — ` +
        'the pinned DSH runtime must boot locally (dsh on PATH / SDK profile "sdk"); retry after: ideaseek doctor',
    );
  } finally {
    await harness.close().catch(() => undefined);
  }
}

/**
 * One recorded coding-turn group. `title` is the FIRST prompt head and stays
 * stable so a session is recognizable in a list; `lastPrompt` is the newest.
 * The transcript is never stored here — that is DSH's own session history —
 * this is the IdeaSeek-side pointer list that answers "which directory, what
 * was I doing, how many turns", which is only meaningful with cwd + scope.
 */
export interface AgentSessionEntry {
  sessionId: string;
  updatedAt: number;
  startedAt: number;
  title: string;
  lastPrompt: string;
  /** Kept from v1: the head of the most recent turn. */
  promptHead: string;
  /** Directory the turns ran in; '' when a v1 record never said. */
  cwd: string;
  scope: 'general' | 'project';
  turns: number;
  lastFinish: string | null;
}

export interface AgentSessionRegistry {
  contract: 'agent-sessions-v2';
  sessions: AgentSessionEntry[];
}

/** Bounds the list so a busy machine cannot grow it without limit. */
const MAX_RECORDED_SESSIONS = 50;

/**
 * Normalizes v2 and v1 records. v1 had no cwd/scope/turns: an entry inherits
 * the location it was read from as its scope (the honest guess — a project's
 * `knowledge/` file means project, the user-level file means general) and gets
 * its single recorded prompt as title, last and turns=1.
 */
function normalizeRegistry(
  raw: unknown,
  fallbackScope: 'general' | 'project',
): AgentSessionRegistry {
  const list = (raw as { sessions?: unknown })?.sessions;
  const sessions: AgentSessionEntry[] = [];
  for (const item of Array.isArray(list) ? list : []) {
    const entry = item as Record<string, unknown>;
    if (typeof entry.sessionId !== 'string' || !entry.sessionId) continue;
    const head = typeof entry.promptHead === 'string' ? entry.promptHead : '';
    const updatedAt = Number.isFinite(entry.updatedAt) ? Number(entry.updatedAt) : Date.now();
    const scope =
      entry.scope === 'general' || entry.scope === 'project' ? entry.scope : fallbackScope;
    sessions.push({
      sessionId: entry.sessionId,
      updatedAt,
      startedAt: Number.isFinite(entry.startedAt) ? Number(entry.startedAt) : updatedAt,
      title: typeof entry.title === 'string' && entry.title ? entry.title : head,
      lastPrompt:
        typeof entry.lastPrompt === 'string' && entry.lastPrompt ? entry.lastPrompt : head,
      promptHead: head,
      cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
      scope,
      turns: Number.isFinite(entry.turns) ? Number(entry.turns) : 1,
      lastFinish: typeof entry.lastFinish === 'string' ? entry.lastFinish : null,
    });
  }
  return { contract: 'agent-sessions-v2', sessions };
}

/**
 * Where resumable session ids live: inside a project under `knowledge/` next to
 * the other artifacts; outside one in the user-level state directory, so a
 * general coding turn in an unrelated repo still gets `--resume` tomorrow.
 */
export function agentSessionsPath(root: string | null): string {
  if (root) return `${root}/knowledge/agent-sessions.json`.replace(/\\/g, '/');
  const override = process.env.IDEASEEK_USER_CONFIG?.trim();
  const dir = override ? dirname(override) : join(homedir(), '.ideaseek');
  return join(dir, 'agent-sessions.json');
}

/** Reads the registry (v1 or v2); a missing or unreadable file is an empty list. */
export async function readAgentSessions(root: string | null): Promise<AgentSessionRegistry> {
  const { readFile } = await import('node:fs/promises');
  try {
    return normalizeRegistry(
      JSON.parse(await readFile(agentSessionsPath(root), 'utf8')),
      root ? 'project' : 'general',
    );
  } catch {
    return { contract: 'agent-sessions-v2', sessions: [] };
  }
}

export async function recordAgentSession(
  root: string | null,
  entry: { sessionId: string; prompt: string; cwd: string; finishReason?: string | null },
): Promise<string> {
  const { writeFileAtomic, ensureDir } = await import('../core/atomic.js');
  const file = agentSessionsPath(root);
  const registry = await readAgentSessions(root);
  const head = entry.prompt.replace(/\s+/g, ' ').slice(0, 80);
  const scope: 'general' | 'project' = root ? 'project' : 'general';
  const now = Date.now();
  const existing = registry.sessions.find((s) => s.sessionId === entry.sessionId);
  if (existing) {
    existing.updatedAt = now;
    existing.promptHead = head;
    existing.lastPrompt = head;
    existing.cwd = entry.cwd;
    existing.scope = scope;
    existing.turns += 1;
    existing.lastFinish = entry.finishReason ?? null;
  } else {
    registry.sessions.push({
      sessionId: entry.sessionId,
      updatedAt: now,
      startedAt: now,
      title: head,
      lastPrompt: head,
      promptHead: head,
      cwd: entry.cwd,
      scope,
      turns: 1,
      lastFinish: entry.finishReason ?? null,
    });
  }
  registry.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  registry.sessions = registry.sessions.slice(0, MAX_RECORDED_SESSIONS);
  await ensureDir(dirname(file));
  await writeFileAtomic(file, `${JSON.stringify(registry, null, 2)}\n`);
  return file;
}
