import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeepSeekHarness, HarnessSession } from '@deepseek-ai/dsh-sdk-client';
import { IdeaseekError } from '../core/errors.js';
import {
  DSH_SDK_VERSION,
  dshHandshakeFailureMessage,
  dshInitializeAttempts,
  dshInitializeTimeoutMs,
} from './dsh-adapter.js';

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

/**
 * The tool names that mean "run a command in the workspace".
 *
 * Not a judgement table — a capability naming map. DSH reports the shell under
 * whichever program the host actually has (`pwsh` on this Windows box, `bash`
 * on POSIX), so an operator who wants to grant "may execute my research code"
 * would otherwise have to know the runtime's OS-specific spelling before the
 * session even starts. `shell` in an allowlist means this set and nothing else:
 * it does not open file writes outside the confined workspace, which the
 * sandbox mode already bounds, and it never covers other tool names.
 */
export const SHELL_TOOL_NAMES: readonly string[] = [
  'bash',
  'sh',
  'zsh',
  'pwsh',
  'powershell',
  'cmd',
  'terminal',
];

/** Pure allowlist match, so the security-relevant rule is testable on its own. */
export function toolIsAllowListed(toolName: string, allowTools: readonly string[]): boolean {
  const name = toolName.trim().toLowerCase();
  if (!name) return false;
  return allowTools.some((entry) => {
    const allowed = entry.trim().toLowerCase();
    if (!allowed) return false;
    if (allowed === name) return true;
    return allowed === 'shell' && SHELL_TOOL_NAMES.includes(name);
  });
}

export interface ApprovalDecision {
  outcome: 'allowed-once' | 'rejected' | 'cancelled';
  toolName: string;
  reason: string | null;
}

export interface ApprovalPrompt {
  (detail: { toolName: string; reason: string | null; sessionId: string }): Promise<boolean>;
}

/**
 * The refusal text, with the two remedies named in the order a researcher can
 * actually use them: grant the capability, or skip the model session entirely
 * and let the deterministic ladder run the code.
 */
export function refusalWhenExecutionCannotBeApproved(
  allowTools: readonly string[],
  policy: ApprovalPolicy = 'interactive',
): string {
  const grant = allowTools.length > 0 ? ` (currently granted: ${allowTools.join(', ')})` : '';
  // Deny arrives two ways with two different remedies, and a message that names
  // the wrong one sends the reader hunting for a flag they never typed: the
  // first FDG run of this path printed "its tools are denied (--deny-tools)" at
  // someone who had passed no such thing, because the CLI chose deny for want of
  // a terminal to ask the question in.
  const why =
    policy === 'deny'
      ? 'this agent turn must run commands and its tool approvals are denied' +
        (allowTools.length > 0 ? '' : deniedBecauseNobodyCanBeAsked()) +
        `, so it can never reach a verdict${grant}`
      : 'this agent turn must run commands, and nothing can approve them: no approval channel is ' +
        'attached and no tool was pre-granted' +
        grant;
  return (
    `${why}. Choose one: run it where a person can answer (a TTY with the prompt wired, or the ` +
    'TUI), grant the capability explicitly (--allow-tools shell, or policy.agent_allow_tools), ' +
    'drop --deny-tools if you passed it, or let the platform execute the check ladder instead ' +
    '(ideaseek idea check <id>, which needs no model session at all).'
  );
}

/** The half of the deny explanation that depends on how deny was reached. */
function deniedBecauseNobodyCanBeAsked(): string {
  return process.stdin.isTTY === true
    ? ' (--deny-tools)'
    : ': no terminal is attached to ask anybody, so the platform defaulted to denying tools' +
        ' — this is what happens to a background, CI or piped implementation run';
}

/**
 * Whether an execution-requiring turn is unapprovable before it even starts.

 *
 * Pure, because the alternative is testing it by booting a real runtime and
 * waiting: the property is a decision over four inputs, and a test that spawns
 * DSH to learn the answer takes half a minute and fails on a machine with no
 * key. `canAsk` is the caller's verdict on whether a human is reachable (a
 * channel *and* something holding it — see `runAgentTurn`), and `deny` is the
 * sharpest case rather than an exception: a turn that must execute commands and
 * a policy that forbids tools cannot ever pass.
 */
export function executionTurnIsUnapprovable(opts: {
  needsExecution?: boolean;
  policy: ApprovalPolicy;
  allowTools: readonly string[];
  canAsk: boolean;
}): boolean {
  if (opts.needsExecution !== true) return false;
  // A denied turn is the sharpest case, not an exception to it. The evidence
  // was a real `idea implement` on FDG with stdin redirected: no terminal meant
  // policy 'deny', this gate let the turn through because it excluded 'deny',
  // and four agent rounds later the log still read `approval rejected: pwsh
  // (denied by --deny-tools policy)`. A task that must execute commands and a
  // policy that forbids tools can never pass, so saying so costs no tokens.
  if (opts.policy === 'deny') return true;
  if (toolIsAllowListed('pwsh', opts.allowTools)) return false;
  return !opts.canAsk;
}

/**
 * Pure approval decision (unit-testable).
 *
 * Precedence is the whole design, and it is deliberately rigid:
 * 1. `deny` (an operator said no tools for this turn) refuses, allowlist or not;
 * 2. otherwise a tool the operator pre-granted is allowed once, with the grant
 *    named in the reason, because an automatic approval that cannot be traced
 *    back to a human decision is not an audit trail;
 * 3. otherwise an interactive prompt, when there is somebody to ask;
 * 4. otherwise refuse — dismissal is never approval.
 */
export async function resolveApproval(
  policy: ApprovalPolicy,
  isTTY: boolean,
  prompt: ApprovalPrompt | null,
  detail: { toolName: string; reason: string | null; sessionId: string },
  allowTools: readonly string[] = [],
): Promise<ApprovalDecision> {
  if (policy === 'deny') {
    return {
      outcome: 'rejected',
      toolName: detail.toolName,
      reason: 'denied by --deny-tools policy',
    };
  }
  if (toolIsAllowListed(detail.toolName, allowTools)) {
    return {
      outcome: 'allowed-once',
      toolName: detail.toolName,
      reason:
        `auto-approved by the operator's allowlist (--allow-tools / policy.agentAllowTools); ` +
        'the session is confined to its workspace root',
    };
  }
  if (!isTTY || !prompt) {
    return {
      outcome: 'rejected',
      toolName: detail.toolName,
      reason:
        'no interactive TTY — tool approval defaults to rejected. Run it where a person can ' +
        'answer, or pre-grant the capability: --allow-tools ' +
        (SHELL_TOOL_NAMES.includes(detail.toolName.toLowerCase()) ? 'shell' : detail.toolName),
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
  /** Optional dynamic prompt composer invoked once resume outcome is known. */
  resolvePrompt?: (resumed: boolean, sessionId: string) => Promise<string> | string;
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
  /**
   * Tools the operator pre-granted for this turn (capability names, not a
   * model's). Empty by default: nothing is auto-approved that no human
   * enumerated.
   */
  allowTools?: string[];
  /**
   * True when the task cannot be completed without executing commands (writing
   * and running research code). Checked before the runtime is spawned, because
   * the alternative is a session that spends its whole budget discovering the
   * limitation itself: an FDG implementation turn wrote four rounds of code,
   * every shell call was refused for want of a TTY, and the agent's final
   * message was "No shell command could execute in this session" — a correct
   * diagnosis the platform could have stated before charging for it.
   */
  needsExecution?: boolean;
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
  usage: { inputTokens: number; outputTokens: number };
  model: string | null;
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

async function executeTurnOnSession(
  session: HarnessSession,
  resumed: boolean,
  approvals: ApprovalDecision[],
  opts: AgentTurnOptions,
): Promise<AgentTurnResult> {
  const log = opts.onLog ?? (() => undefined);
  const callNames = new Map<string, string>();
  const promptText = opts.resolvePrompt
    ? await opts.resolvePrompt(resumed, session.id)
    : opts.prompt;
  const result = await session.run(promptText, {
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
  let inputTokens = 0;
  let outputTokens = 0;
  let model: string | null = opts.model ?? null;
  for (const event of result.events) {
    if (event.type !== 'assistant/message') continue;
    const data = event.data as {
      model?: unknown;
      usage?: { inputTokens?: number; outputTokens?: number };
    };
    if (typeof data.model === 'string' && data.model.trim()) model = data.model;
    const usage = data.usage;
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
    usage: { inputTokens, outputTokens },
    model,
  };
}

/**
 * Capability wiring for a tool-enabled coding session.
 *
 * Two things happen here that never happened before, and the absence of the
 * second is why the first was invisible: coding turns constructed their own
 * `DeepSeekHarness` with no `patches` and no `env`, so the IdeaSeek capability
 * patch — the only place our guard is mounted — applied to analysis calls and
 * never to the flagship implementation path.
 *
 * `env` replaces the child's whole environment in this SDK, so it is built from
 * a copy of `process.env`: dropping that would hide the credential variable DSH
 * reads and turn a security improvement into an outage.
 *
 * The fence denies reads of the platform's own source tree, not a project's
 * research inputs: `src`/`dist` under the IdeaSeek install, rather than its
 * root, because an `npm link`-style dev install would otherwise fence a
 * researcher's own project directory. Papers, datasets and comparison upstreams
 * are outside the session cwd on purpose and stay readable — the read roots the
 * guard uses default to "nothing declared", so the only rule in force is the one
 * this function states.
 */
export async function codingSessionBoot(opts: { cwd: string; dshHome?: string }): Promise<{
  patches: string[];
  env: NodeJS.ProcessEnv;
  dshHome: string;
  patchPath: string;
  denyRoots: string[];
  fenceWarning: string | null;
}> {
  const home = opts.dshHome ?? join(homedir(), '.dsh');
  // The platform's own tree, derived from where this module was loaded from
  // rather than from a path somebody remembered. The two layouts differ in more
  // than cosmetics: a development checkout puts this file at
  // `<repo>/dist/dsh/session.js` (source two levels up), while the installed
  // CLI lives under the global npm directory, where the same arithmetic lands
  // nowhere. The first version filtered those misses silently, and a real FDG
  // run then went looking through `D:\Node\node_global\node_modules` with
  // nothing in the way — a fence that reports success while protecting nothing
  // is worse than none, because it makes the reader stop checking. So the
  // misses come back as a warning the caller prints.
  const moduleRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const denyRoots = [join(moduleRoot, 'src'), join(moduleRoot, 'dist'), moduleRoot].filter((path) =>
    existsSync(path),
  );
  const projectRoot = projectRootFor(opts.cwd);
  // Data handed to the session is a declared input, wherever it physically
  // lives: researchers keep corpora outside the project tree all the time, and
  // a fence that denied IDEASEEK_DATA_PATH would refuse the one thing the task
  // exists to do. So the declared roots join the allow list rather than being
  // assumed to sit under it.
  const declaredData = [
    ...(process.env.IDEASEEK_DATA_PATH ? [process.env.IDEASEEK_DATA_PATH] : []),
    ...(process.env.IDEASEEK_DATASET_ROOTS ?? '').split(delimiter),
  ].filter((path) => path.trim().length > 0 && isAbsolute(path) && existsSync(path));
  const allowRoots = [projectRoot, tmpdir(), ...declaredData].filter((path) => existsSync(path));
  const fenceWarning =
    denyRoots.length === 0
      ? `read fence inactive: no platform tree located from ${moduleRoot}, so a coding session ` +
        'can read the platform source — report this (ideaseek doctor) before trusting session ' +
        'isolation'
      : null;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    IDEASEEK_CAPABILITY_ROLE: 'coding',
    IDEASEEK_WORKSPACE_ROOT: opts.cwd,
    IDEASEEK_READ_DENY_ROOTS: denyRoots.join(delimiter),
    // Declaring the project (plus the scratch directory a session legitimately
    // needs) is what turns the fence into a scope instead of a list of things to
    // avoid: research inputs live outside the session cwd on purpose, so a rule
    // that only names denials would either miss them or fence the wrong thing.
    IDEASEEK_READ_ROOTS: allowRoots.join(delimiter),
  };
  const { writeCapabilityPatch } = await import('./capability.js');
  const patch = await writeCapabilityPatch({ dshHome: home, role: 'coding' });
  return {
    patches: [patch.patchPath],
    env,
    dshHome: home,
    patchPath: patch.patchPath,
    denyRoots,
    fenceWarning,
  };
}

/**
 * The directory holding `ideas/`, falling back to the session cwd.
 *
 * Walks up because a coding session's cwd is `ideas/<id>` while the inputs it
 * must keep reading (papers/, datasets/, comparisons/upstream/, reports/) sit
 * at the project root.
 */
export function projectRootFor(cwd: string): string {
  let current = resolve(cwd);
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(current, 'ideas'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(cwd);
}
export async function runAgentTurn(opts: AgentTurnOptions): Promise<AgentTurnResult> {
  const { DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client');
  const policy = opts.policy ?? 'interactive';
  const approvals: ApprovalDecision[] = [];
  const log = opts.onLog ?? (() => undefined);
  const allowTools = opts.allowTools ?? [];
  // Being able to ask is a channel *and* somebody holding it: a TTY with no
  // prompt function attached asks nobody. Treating the TTY alone as the surface
  // is how a real `idea implement` run spent four rounds writing code that no
  // tool would execute for it, and then reported the agent's own diagnosis.
  const hasChannel =
    process.stdin.isTTY === true || process.env.IDEASEEK_AGENT_APPROVAL === 'stdio';
  const interactiveSurface = hasChannel && opts.promptFn != null;
  // The approval handler, hoisted so the boot path can install it on whichever
  // client ends up owning the runtime.
  const handleApprovalRequest = async (method: string, params: unknown) => {
    if (method !== 'approval/request') {
      throw new Error(`unexpected runtime request ${method}`);
    }
    const detail = params as {
      sessionId?: unknown;
      toolName?: unknown;
      reason?: unknown;
    };
    const decision = await resolveApproval(
      policy,
      interactiveSurface,
      opts.promptFn ?? null,
      {
        toolName: String(detail.toolName ?? 'unknown-tool'),
        reason: typeof detail.reason === 'string' ? detail.reason : null,
        sessionId: String(detail.sessionId ?? ''),
      },
      allowTools,
    );
    approvals.push(decision);
    log(
      `approval ${decision.outcome}: ${decision.toolName}` +
        (decision.reason ? ` (${decision.reason})` : ''),
    );
    return { outcome: decision.outcome };
  };
  if (
    executionTurnIsUnapprovable({
      needsExecution: opts.needsExecution,
      policy,
      allowTools,
      canAsk: interactiveSurface,
    })
  ) {
    throw new IdeaseekError(
      'USER_INPUT_REQUIRED',
      refusalWhenExecutionCannotBeApproved(allowTools, policy),
    );
  }

  const boot =
    opts.needsExecution === true
      ? await codingSessionBoot({
          cwd: opts.cwd,
          ...(opts.dshHome ? { dshHome: opts.dshHome } : {}),
        })
      : null;
  if (boot?.fenceWarning) log(boot.fenceWarning);
  const harnessOptions = {
    cwd: opts.cwd,
    approvalRequests: true,
    ...(boot ? { patches: boot.patches, dshHome: boot.dshHome } : {}),
    // Passed even when no coding contract is mounted: `env` REPLACES the
    // child's environment in this SDK, so it is built from a copy of
    // process.env — dropping the credential variable would have turned a
    // correctness fix into an outage.
    env: {
      // The coding contract first, then the defaults: the guard, `project_read`
      // and the read fence all read their scope from these variables, and a
      // mount that supplies patches without its own env silently un-configures
      // them — which is how every file tool in a real FDG implementation
      // session started failing while the patch itself loaded fine.
      ...process.env,
      ...(boot ? boot.env : {}),
      // A turn cut off by the output cap must not count as success. The `sdk`
      // profile layers dsh-sdk-app, whose patch enables maxTokensAsSuccess
      // unless this variable is defined, and this path never set it — so
      // truncated subagent work was being reported as ok, including the
      // "subagent ok" line this module prints. Checked rather than assumed.
    },
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.dshHome && !boot ? { dshHome: opts.dshHome } : {}),
    ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
    // The bound the rest of the platform already honours (env-overridable, and
    // 30s by default) instead of a second, tighter literal living here: this is
    // the path the implementation and figure sessions boot on, and it was the
    // one still failing with `initialize timed out after 15000ms` on a loaded
    // machine after the adapter default was raised.
    initializeTimeoutMs: dshInitializeTimeoutMs(),
  };

  // Boot with the same bounded retry the adapter uses — and, like the adapter,
  // with a fresh object per attempt rather than calling `start()` again on the
  // one that failed. DSH documents `HarnessClient.close()` as permanent
  // (client.ts:220), and `DeepSeekHarness.start` only installs a replacement
  // client when its own cleanup succeeded (api.ts:92, after the early return at
  // :85-91). Reusing the object therefore degrades the retry loop to zero
  // retries exactly in the case that motivates retrying: a runtime that died
  // messily. The first version of this retried in name only.
  const attempts = dshInitializeAttempts();
  let bootError: Error | null = null;
  let harness: DeepSeekHarness | null = null;
  let booted = false;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const candidate = new DeepSeekHarness(harnessOptions as never);
    try {
      await candidate.start();
      harness = candidate;
      booted = true;
      break;
    } catch (error) {
      bootError = error instanceof Error ? error : new Error(String(error));
      log(
        `dsh handshake attempt ${attempt}/${attempts} failed: ${redactAgentText(bootError.message)}`,
      );
      await candidate.close().catch(() => undefined);
      if (attempt < attempts) {
        await new Promise<void>((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
  }
  if (!booted || !harness) {
    throw new IdeaseekError(
      'MODEL_UNAVAILABLE',
      dshHandshakeFailureMessage({
        sdkVersion: DSH_SDK_VERSION,
        timeoutMs: dshInitializeTimeoutMs(),
        attempts,
        lastError: bootError?.message ?? '(unknown)',
      }) +
        ' — then check the runtime with: ideaseek doctor, and the credential with: ' +
        'ideaseek models setup --test',
    );
  }
  harness.client.onRequest(handleApprovalRequest);
  log('dsh runtime started');

  try {
    let resumed = false;
    let session: HarnessSession;
    if (opts.sessionId) {
      try {
        session = await harness.resumeSession(opts.sessionId);
        resumed = true;
        log(`resumed session ${opts.sessionId}`);
      } catch (error) {
        log(
          `resume ${opts.sessionId} failed: ${redactAgentText((error as Error).message ?? String(error))}; starting a new session`,
        );
        session = harness.session();
      }
    } else {
      session = harness.session();
      log(`new session ${session.id}`);
    }

    return await executeTurnOnSession(session, resumed, approvals, opts);
  } catch (error) {
    if (error instanceof IdeaseekError) throw error;
    throw new IdeaseekError(
      'ENV_UNSUPPORTED',
      `DSH agent turn failed: ${redactAgentText((error as Error).message ?? String(error))} — ` +
        'if this says the runtime did not start, the pinned DSH runtime must boot locally ' +
        '(dsh on PATH / SDK profile "sdk"); if the session died mid-turn it was ended with the ' +
        'process. Check either way with: ideaseek doctor, and the credential with: ' +
        'ideaseek models setup --test',
    );
  } finally {
    await harness.close().catch(() => undefined);
  }
}

/**
 * Reusable warm DSH runtime host for the interactive TUI: keeps the
 * DeepSeekHarness child and active HarnessSession alive across turns so
 * follow-up messages respond without re-spawning Node or re-running the
 * JSON-RPC handshake. Aborting (`Ctrl-C`) or switching projects cleanly
 * disposes and resets the runtime.
 */
export class WarmAgentHost {
  private harness: DeepSeekHarness | null = null;
  private sig = '';
  private activeSession: HarnessSession | null = null;
  private aborted = false;
  private turnSink: {
    policy: ApprovalPolicy;
    interactive: boolean;
    promptFn: ApprovalPrompt | null;
    allowTools: string[];
    approvals: ApprovalDecision[];
    log: (message: string) => void;
  } | null = null;

  async runTurn(
    opts: AgentTurnOptions & { interactiveSurface?: boolean },
  ): Promise<AgentTurnResult> {
    const { DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client');
    const policy = opts.policy ?? 'interactive';
    const approvals: ApprovalDecision[] = [];
    const log = opts.onLog ?? (() => undefined);
    const allowTools = opts.allowTools ?? [];
    const hasChannel =
      opts.interactiveSurface === true ||
      process.stdin.isTTY === true ||
      process.env.IDEASEEK_AGENT_APPROVAL === 'stdio';
    const interactiveSurface = hasChannel && opts.promptFn != null;
    // Same pre-flight refusal as runAgentTurn: a warm host that cannot approve
    // a shell must say so before the turn, not after four rounds of it.
    if (
      executionTurnIsUnapprovable({
        needsExecution: opts.needsExecution,
        policy,
        allowTools,
        canAsk: interactiveSurface,
      })
    ) {
      throw new IdeaseekError(
        'USER_INPUT_REQUIRED',
        refusalWhenExecutionCannotBeApproved(allowTools, policy),
      );
    }
    const nextSig = JSON.stringify({
      cwd: opts.cwd,
      provider: opts.provider ?? '',
      model: opts.model ?? '',
      dshHome: opts.dshHome ?? '',
      timeout: opts.requestTimeoutMs ?? null,
      // A different grant is a different runtime contract, so the warm client
      // must not be reused across turns that allow different tools. The same
      // holds for the capability mount: a runtime booted without the coding
      // patch has no read fence, and reusing it for a turn that must have one
      // would make the security property depend on which turn came first.
      allowTools: [...allowTools].sort().join(','),
      capabilityMount: opts.needsExecution === true ? 'coding' : 'none',
    });

    if (this.harness && this.sig !== nextSig) {
      await this.close();
    }

    this.aborted = false;
    this.turnSink = {
      policy,
      interactive: interactiveSurface,
      promptFn: opts.promptFn ?? null,
      allowTools,
      approvals,
      log,
    };

    try {
      if (!this.harness) {
        const boot =
          opts.needsExecution === true
            ? await codingSessionBoot({
                cwd: opts.cwd,
                ...(opts.dshHome ? { dshHome: opts.dshHome } : {}),
              })
            : null;
        if (boot?.fenceWarning) log(boot.fenceWarning);
        const harness = new DeepSeekHarness({
          cwd: opts.cwd,
          approvalRequests: true,
          ...(boot ? { patches: boot.patches, env: boot.env, dshHome: boot.dshHome } : {}),
          ...(opts.provider ? { provider: opts.provider } : {}),
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.dshHome && !boot ? { dshHome: opts.dshHome } : {}),
          ...(opts.requestTimeoutMs !== undefined
            ? { requestTimeoutMs: opts.requestTimeoutMs }
            : {}),
          initializeTimeoutMs: dshInitializeTimeoutMs(),
        });
        harness.client.start();
        harness.client.onRequest(async (method, params) => {
          if (method !== 'approval/request') {
            throw new Error(`unexpected runtime request ${method}`);
          }
          const sink = this.turnSink;
          if (!sink) return { outcome: 'rejected' as const };
          const detail = params as {
            sessionId?: unknown;
            toolName?: unknown;
            reason?: unknown;
          };
          const decision = await resolveApproval(
            sink.policy,
            sink.interactive,
            sink.promptFn,
            {
              toolName: String(detail.toolName ?? 'unknown-tool'),
              reason: typeof detail.reason === 'string' ? detail.reason : null,
              sessionId: String(detail.sessionId ?? ''),
            },
            sink.allowTools,
          );
          sink.approvals.push(decision);
          sink.log(
            `approval ${decision.outcome}: ${decision.toolName}` +
              (decision.reason ? ` (${decision.reason})` : ''),
          );
          return { outcome: decision.outcome };
        });
        await harness.start();
        this.harness = harness;
        this.sig = nextSig;
        log('dsh runtime started (warm session)');
      }

      let resumed = false;
      let session = this.activeSession;
      if (opts.sessionId && session?.id === opts.sessionId) {
        resumed = true;
      } else if (opts.sessionId) {
        try {
          session = await this.harness.resumeSession(opts.sessionId);
          resumed = true;
          log(`resumed session ${opts.sessionId}`);
        } catch (error) {
          log(
            `resume ${opts.sessionId} failed: ${redactAgentText((error as Error).message ?? String(error))}; starting a new session`,
          );
          session = this.harness.session();
        }
      } else if (!session) {
        session = this.harness.session();
        log(`new session ${session.id}`);
      }
      this.activeSession = session;

      return await executeTurnOnSession(session, resumed, approvals, opts);
    } catch (error) {
      if (this.aborted) {
        const abortErr = new Error('agent turn aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      if (error instanceof IdeaseekError) throw error;
      // Transport/runtime failure: drop the cached harness so the next turn recovers.
      await this.close();
      throw new IdeaseekError(
        'ENV_UNSUPPORTED',
        `DSH session failed to start: ${redactAgentText((error as Error).message ?? String(error))} — ` +
          'the pinned DSH runtime must boot locally (dsh on PATH / SDK profile "sdk"); retry after: ideaseek doctor',
      );
    } finally {
      this.turnSink = null;
    }
  }

  /** Reaps the underlying DSH runtime immediately (used on Ctrl-C interrupt). */
  async abort(): Promise<void> {
    this.aborted = true;
    await this.close();
  }

  async close(): Promise<void> {
    const harness = this.harness;
    this.harness = null;
    this.activeSession = null;
    this.sig = '';
    if (harness) await harness.close().catch(() => undefined);
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
