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
    const isTTY = process.stdin.isTTY === true;
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
      session = await harness.resumeSession(opts.sessionId);
      resumed = true;
      log(`resumed session ${opts.sessionId}`);
    } else {
      session = harness.session();
      log(`new session ${session.id}`);
    }

    const result = await session.run(opts.prompt);
    if (result.finishReason === 'error') {
      throw new IdeaseekError(
        'MODEL_UNAVAILABLE',
        `agent turn failed: ${redactAgentText(result.finalResponse || 'runtime error')} — ` +
          'check provider/key (ideaseek models setup --test) and retry',
      );
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

/** Persisted session registry (ids only — no prompts, no secrets). */
export interface AgentSessionRegistry {
  contract: 'agent-sessions-v1';
  sessions: { sessionId: string; updatedAt: number; promptHead: string }[];
}

export function agentSessionsPath(root: string): string {
  return `${root}/knowledge/agent-sessions.json`.replace(/\\/g, '/');
}

export async function recordAgentSession(
  root: string,
  entry: { sessionId: string; prompt: string },
): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const { writeFileAtomic, ensureDir } = await import('../core/atomic.js');
  const { join } = await import('node:path');
  let registry: AgentSessionRegistry = { contract: 'agent-sessions-v1', sessions: [] };
  try {
    registry = JSON.parse(await readFile(agentSessionsPath(root), 'utf8')) as AgentSessionRegistry;
  } catch {
    registry = { contract: 'agent-sessions-v1', sessions: [] };
  }
  const promptHead = entry.prompt.replace(/\s+/g, ' ').slice(0, 80);
  const existing = registry.sessions.find((s) => s.sessionId === entry.sessionId);
  if (existing) {
    existing.updatedAt = Date.now();
    existing.promptHead = promptHead;
  } else {
    registry.sessions.push({
      sessionId: entry.sessionId,
      updatedAt: Date.now(),
      promptHead,
    });
  }
  registry.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  await ensureDir(join(root, 'knowledge'));
  await writeFileAtomic(agentSessionsPath(root), `${JSON.stringify(registry, null, 2)}\n`);
  return agentSessionsPath(root);
}
