import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { renderApprovalBlock, type PendingApproval } from '../../approval/pending.js';
import { renderHeader, type HeaderContext } from '../banner.js';
import { formatEventLine, paint } from '../format.js';
import { cliEntryPath, runCli, runCliJson } from '../runner.js';
import { tokenizeArgs } from '../tokens.js';
import { resolveSlash, helpText } from '../slash-menu.js';
import { findProjectRoot } from '../../config/paths.js';
import { readLastSession, writeSessionEnd, writeSessionStart } from '../../session/context.js';
import { readSessionMode, renderSessionSummary } from '../../session/mode.js';
import {
  APPROVAL_ALLOW,
  APPROVAL_REJECT,
  parseApprovalRequest,
  type ApprovalRequest,
} from '../../dsh/approval-channel.js';

/**
 * Shared interactive session (ADR-006/ADR-010): owns command dispatch, the
 * `attach --json` event stream, approval handling and session markers.
 * Renderers (classic readline line-mode, Ink TUI) only provide presentation —
 * an output sink and a header callback — so both UIs run the exact same
 * use-cases as the non-interactive CLI.
 */

export interface HeaderInfo {
  lines: string[];
  tone: 'dim' | 'warn';
}

/** Startup data each renderer displays in its own layout. */
export interface SessionStartup {
  header: HeaderInfo;
  /** Interactive hint line (`type / for the menu …`). */
  hint: string;
  /** Previous session's fate line, or null when there is no history. */
  lastSession: string | null;
  /** Pending-approval box lines (empty when nothing waits). */
  pending: string[];
}

export interface SessionSink {
  /** One output line (already painted where applicable). */
  println(text: string): void;
  /** Header was rebuilt (startup is returned; this fires on project switch). */
  onHeader?(header: HeaderInfo): void;
}

export type SubmitOutcome = 'continue' | 'quit' | 'menu';

const HINT_LINE = 'type / for the menu · Tab completes · /quit exits (runs keep going)';

/**
 * Audit records that must NOT stream into the TUI activity pane: each
 * Research/Agent toggle appends a `change-session-mode` decision event
 * (docs/MODES.md — never silent), and a session that has been switching
 * modes replays as a wall of identical DECISION lines on startup. The
 * record itself stays queryable via `ideaseek events` and the Decision
 * log; the switch confirmation line already shows the action live.
 * Exported for unit tests.
 */
export function isSessionUiNoise(event: { type: string; summary: string }): boolean {
  return event.type === 'decision' && event.summary.startsWith('change-session-mode:');
}

/**
 * Parses the session id out of `ideaseek agent`'s human summary line
 * (`agent turn → session <id> (…`) so the TUI can resume the same DSH
 * conversation on the next message. Exported for unit tests.
 */
export function extractAgentSessionId(output: string): string | null {
  const match = output.match(/^agent turn → session (\S+)/m);
  return match ? match[1]! : null;
}

/**
 * Frames a byte stream into complete lines for prompt-safe printing:
 * output lands in the activity pane AS IT ARRIVES (Claude-Code style
 * live output) instead of all at once when the subprocess exits.
 * Exported for unit tests.
 */
export function createLineStream(onLine: (line: string) => void): {
  push(chunk: string): void;
  flush(): void;
} {
  let buffer = '';
  return {
    push(chunk: string): void {
      buffer += chunk;
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() ?? '';
      for (const line of parts) onLine(line);
    },
    flush(): void {
      if (!buffer) return;
      const line = buffer;
      buffer = '';
      onLine(line);
    },
  };
}

/**
 * Unpainted project/run context header (renderer decides styling).
 * Startup stays to two lines — project · mode · run state, plus the
 * question; everything else (stage, tasks, papers, GPU, supervisor) is a
 * `/status` query. Also drops the papers/env probes, so the TUI starts
 * with one subprocess instead of four.
 */
export async function buildHeaderLines(): Promise<HeaderInfo> {
  const status = await runCliJson<{
    project: string;
    run: {
      runId: string;
      status: string;
      question: string;
      blockReason: string | null;
    } | null;
  }>(['status', '--json']).catch(() => null);
  if (!status?.data) {
    return {
      lines: ['not an IdeaSeek project — run: ideaseek init (or cd into one)'],
      tone: 'warn',
    };
  }
  const run = status.data.run ?? null;
  let sessionMode = 'research';
  const projectRoot = await findProjectRoot(process.cwd()).catch(() => null);
  if (projectRoot) {
    sessionMode = (await readSessionMode(projectRoot).catch(() => 'research')) ?? 'research';
  }
  const ctx: HeaderContext = {
    project: status.data.project ?? '(unknown project)',
    sessionMode: sessionMode === 'agent' ? 'AGENT' : 'RESEARCH',
    question: run?.question || null,
    runId: run?.runId ?? null,
    runStatus: run?.status ?? null,
    blockReason: run?.blockReason ?? null,
  };
  return { lines: renderHeader(ctx).split('\n'), tone: run?.blockReason ? 'warn' : 'dim' };
}

/** Classic line-mode paint for a header block. */
export function paintHeader(header: HeaderInfo, plain: boolean): string {
  return header.lines.map((line) => paint(line, header.tone, { plain })).join('\n');
}

export interface InteractiveSessionOptions {
  plain: boolean;
  sink: SessionSink;
}

/**
 * One interactive UI session: begin() collects startup data, submit()
 * processes a single input line, startStream() replays then follows persisted
 * RunEvents, stop()/end() tear down without ever cancelling a background run.
 */
export class InteractiveSession {
  private readonly plain: boolean;
  private readonly sink: SessionSink;
  private pendingItems: PendingApproval[] = [];
  private streamChild: ChildProcess | null = null;
  private sessionRoot: string | null = null;
  private stopped = false;
  /** Highest RunEvent seq rendered — re-attach resumes with `--since`. */
  private lastSeq = 0;
  /** DSH session id for agent-mode continuation (null → next turn is new). */
  private agentSessionId: string | null = null;
  /** Abort handle for the in-flight relay/agent turn (Ctrl-C interrupts). */
  private relayAbort: AbortController | null = null;
  /** Tool approval waiting for the operator (stdio channel, agent turns). */
  private approvalWaiting: ApprovalRequest | null = null;
  /** Kept-open stdin of the agent child — where answers are written. */
  private agentStdin: NodeJS.WritableStream | null = null;
  /** Secret input capture is renderer-owned: only the Ink TUI can mask. */
  private secretCapture = false;
  private secretLabel: string | null = null;
  private secretResolve: ((value: string | null) => void) | null = null;

  /** Enables masked key capture (called by the Ink renderer at startup). */
  enableSecretCapture(): void {
    this.secretCapture = true;
  }

  /** Active secret prompt for renderers (null when idle). */
  get secretPrompt(): { label: string } | null {
    return this.secretLabel ? { label: this.secretLabel } : null;
  }

  private beginSecretPrompt(label: string): Promise<string | null> {
    this.secretLabel = label;
    return new Promise((resolve) => {
      this.secretResolve = resolve;
    });
  }

  /** Resolves the pending secret prompt; false when none is waiting. */
  answerSecret(value: string | null): boolean {
    if (!this.secretResolve) return false;
    const resolve = this.secretResolve;
    this.secretResolve = null;
    this.secretLabel = null;
    resolve(value);
    return true;
  }

  /** Pending tool-approval request (renderers draw an input prompt for it). */
  get pendingApproval(): ApprovalRequest | null {
    return this.approvalWaiting;
  }

  /** Answers the pending tool approval; false when none is waiting. */
  respondApproval(allow: boolean): boolean {
    const request = this.approvalWaiting;
    if (!request) return false;
    this.approvalWaiting = null;
    try {
      this.agentStdin?.write(allow ? `${APPROVAL_ALLOW}\n` : `${APPROVAL_REJECT}\n`);
    } catch {
      // child already gone — its exit error surfaces the turn outcome
    }
    this.println(
      paint(
        `→ approval ${allow ? 'allowed once' : 'rejected'}: ${request.toolName}`,
        allow ? 'success' : 'warn',
        { plain: this.plain },
      ),
    );
    return true;
  }

  /**
   * Classic line-mode approval answers: while a turn waits, y/n (or any
   * other line) must NOT queue behind it — the turn is blocked on the
   * answer, so queueing would deadlock. Returns true when consumed.
   */
  consumeApprovalLine(raw: string): boolean {
    if (!this.approvalWaiting) return false;
    const answer = raw.trim().toLowerCase();
    if (answer === 'y' || answer === 'yes') return this.respondApproval(true);
    if (answer === 'n' || answer === 'no') return this.respondApproval(false);
    this.println(
      paint(
        `approval pending: ${this.approvalWaiting.toolName} — answer y (allow) or n (reject)`,
        'warn',
        { plain: this.plain },
      ),
    );
    return true;
  }

  private beginApproval(request: ApprovalRequest): void {
    this.approvalWaiting = request;
    this.println(
      paint(
        `⏸ approval required: ${request.toolName}${request.reason ? ` — ${request.reason}` : ''}`,
        'warn',
        { plain: this.plain },
      ),
    );
  }

  /**
   * Stops the command currently running through this session, if any —
   * Claude-Code style interrupt. Returns whether something was actually
   * stopped (idle Ctrl-C keeps the plain exit hint instead).
   */
  async interrupt(): Promise<boolean> {
    // A pending secret prompt blocks the same way a relay does — Ctrl-C
    // cancels it (answerSecret(null) → caller reports the cancel).
    if (this.secretResolve) {
      this.answerSecret(null);
      return true;
    }
    if (!this.relayAbort) return false;
    this.relayAbort.abort();
    this.relayAbort = null;
    return true;
  }

  constructor(opts: InteractiveSessionOptions) {
    this.plain = opts.plain;
    this.sink = opts.sink;
  }

  private println(text: string): void {
    this.sink.println(text);
  }

  /** Builds header, records the session marker, fetches pending approvals. */
  async begin(): Promise<SessionStartup> {
    const header = await buildHeaderLines();
    let lastSession: string | null = null;
    try {
      const root = await findProjectRoot(process.cwd());
      if (root) {
        this.sessionRoot = root;
        const previous = await readLastSession(root);
        if (previous) {
          const ended = previous.endedAt ? new Date(previous.endedAt).toISOString() : 'never';
          const clean = previous.endedAt !== undefined && previous.clean === true;
          lastSession = `last session: pid ${previous.pid} · ended ${ended} — ${clean ? 'clean exit' : 'interrupted/crashed'} (ideaseek context for the full summary)`;
        }
        await writeSessionStart(root);
      }
    } catch {
      this.sessionRoot = null; // no project → no session marker
    }
    const res = await runCliJson<{ items?: PendingApproval[] }>(['pending', '--json']).catch(
      () => null,
    );
    this.pendingItems = res?.data?.items ?? [];
    const pending =
      this.pendingItems.length > 0
        ? renderApprovalBlock(this.pendingItems, process.stdout.columns ?? 80)
        : [];
    return { header, hint: HINT_LINE, lastSession, pending };
  }

  /**
   * Processes one submitted input line. `'menu'` asks the renderer to show
   * the slash menu (classic draws it; the Ink palette is already open).
   */
  async submit(raw: string): Promise<SubmitOutcome> {
    const input = raw.trim();
    if (!input) return 'continue';
    if (input === '/') return 'menu';
    try {
      let outcome: SubmitOutcome = 'continue';
      if (/^\d+$/.test(input) && this.pendingItems.length > 0) {
        await this.approvePending(Number(input));
      } else if (!input.startsWith('/')) {
        // Plain text routes by session mode (docs/MODES.md): agent mode is
        // a REAL DSH coding session — the same `ideaseek agent` turn the
        // CLI runs, resumed across messages; research mode classifies
        // through `ideaseek ask`. Never prints "unknown input".
        const root = await findProjectRoot(process.cwd()).catch(() => null);
        const mode = root
          ? await readSessionMode(root).catch(() => 'research' as const)
          : 'research';
        if (mode === 'agent') await this.runAgentTurn(input);
        else await this.relay(['ask', ...tokenizeArgs(input)]);
      } else {
        outcome = await this.dispatch(input);
      }
      // The stream child exits when there is no run yet or the run reached
      // a terminal state; this command may have just created a run —
      // re-attach (idempotent; `--since` resumes after the last event the
      // pane already showed, so replays never duplicate).
      if (outcome === 'continue' && !this.stopped && !this.streamChild) this.startStream();
      return outcome;
    } catch (error) {
      this.println(paint(`error: ${(error as Error).message}`, 'error', { plain: this.plain }));
      return 'continue';
    }
  }

  /** Shift+Tab cycles Research/Agent through the same audited CLI use-case. */
  async cycleMode(): Promise<void> {
    const root = await findProjectRoot(process.cwd());
    if (!root) {
      this.println('not an IdeaSeek project — run: ideaseek init (or cd into one)');
      return;
    }
    const { readSessionMode } = await import('../../session/mode.js');
    const current = await readSessionMode(root);
    await this.relay(['mode', current === 'research' ? 'agent' : 'research']);
    await this.refreshHeader();
  }

  private async refreshHeader(): Promise<void> {
    const header = await buildHeaderLines();
    if (this.sink.onHeader) this.sink.onHeader(header);
    else this.println(paintHeader(header, this.plain));
  }

  /**
   * Agent-mode plain text → one real DSH coding-session turn (the same
   * `ideaseek agent` use-case the CLI runs), resumed across messages so
   * the TUI behaves like a normal agent conversation. Progress logs on
   * stderr render dim; `error:` lines keep the error tone. A coding turn
   * can legitimately run for minutes — bounded by a generous timeout.
   */
  /**
   * Newest agent session recorded for this project (registry writes
   * newest-first) — lets a fresh TUI continue the last conversation.
   */
  private async newestAgentSessionId(): Promise<string | null> {
    try {
      const root = await findProjectRoot(process.cwd());
      if (!root) return null;
      const { agentSessionsPath } = await import('../../dsh/session.js');
      const { readFile } = await import('node:fs/promises');
      const raw = JSON.parse(await readFile(agentSessionsPath(root), 'utf8')) as {
        sessions?: { sessionId?: unknown }[];
      };
      const newest = raw.sessions?.[0]?.sessionId;
      return typeof newest === 'string' && newest ? newest : null;
    } catch {
      return null; // no registry yet — first turn starts fresh
    }
  }

  private async runAgentTurn(message: string): Promise<void> {
    const args = ['agent', message];
    if (this.agentSessionId) {
      args.push('--resume', this.agentSessionId);
    } else {
      // Continue the project's last agent conversation across TUI
      // restarts (Claude-Code style continuity); the child falls back to
      // a fresh session when the id no longer exists DSH-side.
      const prior = await this.newestAgentSessionId();
      if (prior) {
        this.agentSessionId = prior;
        args.push('--resume', prior);
      }
    }
    // Default provider/model routes for TUI turns. IDEASEEK_AGENT_MODEL
    // doubles as the test hook for a cheap model-free failure (a bogus
    // model name refuses in ~4s BEFORE any model call — never spend
    // credentials implicitly in tests).
    const provider = process.env.IDEASEEK_AGENT_PROVIDER;
    if (provider) args.push('--provider', provider);
    const model = process.env.IDEASEEK_AGENT_MODEL;
    if (model) args.push('--model', model);
    // Stream: DSH progress logs land live; magic approval-request lines
    // open the operator prompt instead of printing (docs/TERMINAL_UX
    // 审批界面 — y/n answers flow back over the kept-open stdin).
    const out = createLineStream((line) => {
      const request = parseApprovalRequest(line);
      if (request) {
        this.beginApproval(request);
        return;
      }
      this.println(line);
    });
    const err = createLineStream((line) => {
      if (!line.trim()) return;
      const tone = /^error:/.test(line.trim()) ? ('error' as const) : ('dim' as const);
      this.println(paint(line, tone, { plain: this.plain }));
    });
    const abort = new AbortController();
    this.relayAbort = abort;
    try {
      const result = await runCli(args, {
        timeoutMs: 300_000,
        signal: abort.signal,
        extraEnv: { IDEASEEK_AGENT_APPROVAL: 'stdio' },
        keepStdinOpen: true,
        onStdin: (stdin) => {
          this.agentStdin = stdin;
        },
        onStdout: (chunk) => out.push(chunk),
        onStderr: (chunk) => err.push(chunk),
      });
      const sessionId = extractAgentSessionId(result.stdout);
      if (sessionId) this.agentSessionId = sessionId;
      if (result.code !== 0 && !result.stdout && !result.stderr) {
        this.println(
          paint(`agent turn failed (exit ${result.code})`, 'error', { plain: this.plain }),
        );
      }
    } finally {
      out.flush();
      err.flush();
      this.approvalWaiting = null;
      try {
        this.agentStdin?.end();
      } catch {
        // dead pipe — nothing to close
      }
      this.agentStdin = null;
      if (this.relayAbort === abort) this.relayAbort = null;
    }
  }

  /**
   * Relays a CLI command; its stdout/stderr streams into the session
   * output line by line as the subprocess produces them — a long
   * `extract`/`report` shows progress live instead of appearing all at
   * once when it exits.
   */
  private async relay(args: string[], opts: { stdinPayload?: string } = {}): Promise<void> {
    const out = createLineStream((line) => this.println(line));
    const err = createLineStream((line) =>
      this.println(paint(line, 'error', { plain: this.plain })),
    );
    const abort = new AbortController();
    this.relayAbort = abort;
    try {
      // Test seam: stretch the abortable window so the Ctrl-C interrupt
      // e2e does not race a fast command (env-gated, default off).
      const delay = Number(process.env.IDEASEEK_RELAY_DELAY_MS ?? '0');
      if (Number.isFinite(delay) && delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      await runCli(args, {
        timeoutMs: 60_000,
        signal: abort.signal,
        // stdinPayload (e.g. a masked API key) is written and closed at
        // spawn so the child's read-until-EOF completes immediately.
        ...(opts.stdinPayload !== undefined
          ? {
              keepStdinOpen: true,
              onStdin: (stdin: NodeJS.WritableStream) => {
                stdin.write(opts.stdinPayload!);
                stdin.end();
              },
            }
          : {}),
        onStdout: (chunk) => out.push(chunk),
        onStderr: (chunk) => err.push(chunk),
      });
    } finally {
      out.flush();
      err.flush();
      if (this.relayAbort === abort) this.relayAbort = null;
    }
  }

  /**
   * `/models setup` inside the TUI: the renderer captures the key
   * masked (never echoed, never argv, never in the transcript) and the
   * child reads it from stdin via --api-key-stdin. The connection test
   * runs by default so a bad key fails closed before anything is wired.
   */
  private async runModelsSetup(flags: string[]): Promise<void> {
    if (!this.secretCapture) {
      // Classic line mode cannot mask a secret (readline echoes it) —
      // point at the real terminal instead of leaking the key.
      this.println(
        'hidden key capture needs the TUI — run `ideaseek models setup` in a terminal (or pipe via --api-key-stdin)',
      );
      return;
    }
    const key = await this.beginSecretPrompt('API key (input hidden)');
    if (key === null) {
      this.println(paint('setup cancelled — nothing written', 'warn', { plain: this.plain }));
      return;
    }
    if (!key.trim()) {
      this.println(paint('empty API key — nothing written', 'warn', { plain: this.plain }));
      return;
    }
    await this.relay(['models', 'setup', '--api-key-stdin', '--test', ...flags], {
      stdinPayload: `${key}\n`,
    });
  }

  private async fetchPending(): Promise<PendingApproval[]> {
    const res = await runCliJson<{ items?: PendingApproval[] }>(['pending', '--json']).catch(
      () => null,
    );
    return res?.data?.items ?? [];
  }

  private showApprovalBlock(items: PendingApproval[]): void {
    this.pendingItems = items;
    for (const line of renderApprovalBlock(items, process.stdout.columns ?? 80)) {
      this.println(line);
    }
  }

  /**
   * `/approve [n]` and bare-number selection from the confirmation block:
   * relays the item's EXISTING CLI command; decision items are review-only
   * and never execute an unreviewed request.
   */
  private async approvePending(choice?: number): Promise<void> {
    const items = await this.fetchPending();
    this.pendingItems = items;
    if (items.length === 0) {
      this.println('nothing waiting for approval — /pending lists what needs a decision');
      return;
    }
    let index: number;
    if (choice !== undefined) {
      if (!Number.isInteger(choice) || choice < 1 || choice > items.length) {
        this.println(`no item ${String(choice)} — /pending lists ${items.length} waiting`);
        return;
      }
      index = choice - 1;
    } else if (items.length === 1) {
      index = 0;
    } else {
      this.showApprovalBlock(items);
      this.println(
        paint('pick one: /approve <n> (or type the number)', 'dim', { plain: this.plain }),
      );
      return;
    }
    const item = items[index]!;
    if (!item.approve) {
      this.println(`[${item.kind}] ${item.summary}`);
      this.println(
        paint(
          'review-only: nothing changes on approve — apply the recorded request with the equivalent command + --confirm, or /reject <reason>',
          'warn',
          { plain: this.plain },
        ),
      );
      return;
    }
    await this.relay(item.approve.cliArgs);
  }

  /** Slash-command dispatch — every case relays the equivalent CLI command. */
  private async dispatch(input: string): Promise<SubmitOutcome> {
    const spaceAt = input.search(/\s/);
    const head = spaceAt === -1 ? input : input.slice(0, spaceAt);
    const rest = spaceAt === -1 ? '' : input.slice(spaceAt).trim();
    const resolution = resolveSlash(head);
    if (resolution.kind === 'unknown') {
      this.println(`unknown command: ${head} — try /help (or a prefix like /sta)`);
      return 'continue';
    }
    if (resolution.kind === 'ambiguous') {
      this.println(`ambiguous prefix: ${head} → ${resolution.candidates.join(', ')}`);
      return 'continue';
    }
    const name = resolution.name;
    const restArgs = tokenizeArgs(rest);

    switch (name) {
      case '/help':
        this.println(helpText());
        return 'continue';
      case '/ideas':
        await this.relay(['idea', 'list']);
        return 'continue';
      case '/quit':
        return 'quit';
      case '/logs': {
        if (!rest) {
          this.println('usage: /logs <task-id>');
          return 'continue';
        }
        await this.relay(['logs', ...tokenizeArgs(rest)]);
        return 'continue';
      }
      case '/reject': {
        if (!rest) {
          this.println('usage: /reject <reason>');
          return 'continue';
        }
        await this.relay(['reject', rest]);
        return 'continue';
      }
      case '/pending': {
        const items = await this.fetchPending();
        if (items.length === 0) {
          this.pendingItems = [];
          this.println('nothing waiting for approval');
        } else {
          this.showApprovalBlock(items);
        }
        return 'continue';
      }
      case '/approve': {
        if (rest && !/^\d+$/.test(rest)) {
          this.println('usage: /approve [n] — /pending lists the items');
          return 'continue';
        }
        await this.approvePending(rest ? Number(rest) : undefined);
        return 'continue';
      }
      case '/status':
        await this.relay(['status']);
        return 'continue';
      case '/next':
        await this.relay(['next']);
        return 'continue';
      case '/papers':
        await this.relay(['papers']);
        return 'continue';
      case '/comparisons':
        await this.relay(['comparison', 'list']);
        return 'continue';
      case '/experiments':
        await this.relay(['experiment', 'list']);
        return 'continue';
      case '/pause':
        await this.relay(['pause']);
        return 'continue';
      case '/resume':
        await this.relay(['resume']);
        return 'continue';
      case '/continue':
        await this.relay(['continue']);
        return 'continue';
      case '/cancel':
        await this.relay(['cancel']);
        return 'continue';
      case '/report':
        await this.relay(['report']);
        return 'continue';
      case '/models': {
        // `/models setup` needs masked key capture — never a plain relay
        // (the child would see an empty stdin and there is no masking).
        if (restArgs[0] === 'setup') {
          await this.runModelsSetup(restArgs.slice(1));
          return 'continue';
        }
        await this.relay(['models', ...restArgs]);
        return 'continue';
      }
      case '/mode':
        await this.relay(['mode', ...restArgs]);
        await this.refreshHeader();
        return 'continue';
      case '/open': {
        if (!rest) {
          await this.relay(['open']);
          return 'continue';
        }
        // Project targets are two-step (TERMINAL_UX: switch only after a
        // confirmation so control commands never hit the wrong directory):
        // preview target + mode/project/permission summary, then --confirm
        // chdirs the session, restarts the event stream and reprints the
        // header for the new project.
        const res = await runCliJson<
          | { kind: 'switch-target'; name: string; root: string; summary: unknown }
          | { kind: 'project'; name: string; root: string; summary: unknown }
          | { kind: 'document'; path: string; bytes: number; head: string }
          | { kind: 'overview'; projects: unknown[]; documents: string[] }
        >(['open', ...restArgs, '--json']);
        const payload = res.data;
        if (payload?.kind === 'switch-target') {
          this.println(`switch target : ${payload.name}  (${payload.root})`);
          for (const line of renderSessionSummary(
            payload.summary as Parameters<typeof renderSessionSummary>[0],
          )) {
            this.println(line);
          }
          this.println(
            paint(`confirm: /open ${restArgs.join(' ')} --confirm`, 'dim', { plain: this.plain }),
          );
          return 'continue';
        }
        if (payload?.kind === 'project') {
          if (resolve(payload.root) !== resolve(process.cwd())) {
            process.chdir(payload.root);
            this.stopStream(); // events were bound to the previous project
            this.lastSeq = 0; // …and so was the event sequence
            this.startStream();
            this.println(paint(`session → ${payload.root}`, 'dim', { plain: this.plain }));
            const header = await buildHeaderLines();
            if (this.sink.onHeader) this.sink.onHeader(header);
            else this.println(paintHeader(header, this.plain));
          }
          for (const line of renderSessionSummary(
            payload.summary as Parameters<typeof renderSessionSummary>[0],
          )) {
            this.println(line);
          }
          return 'continue';
        }
        if (res.code === 0) {
          // Document / overview: render through the same use-case.
          await this.relay(['open', ...restArgs]);
          return 'continue';
        }
        for (const line of res.stderr.split(/\r?\n/)) {
          if (line.trim()) this.println(paint(line, 'error', { plain: this.plain }));
        }
        return 'continue';
      }
      case '/rounds':
        await this.relay(['rounds', ...restArgs]);
        return 'continue';
      case '/ideate':
        await this.relay(['ideate', ...restArgs]);
        return 'continue';
      case '/feedback':
        await this.relay(['feedback', ...restArgs]);
        return 'continue';
      default:
        this.println(`unknown command: ${name} — try /help`);
        return 'continue';
    }
  }

  /**
   * Replays persisted RunEvents (from `--since` on re-attach, else seq 0)
   * then follows live ones (DB polling). Expected exits stay silent: no
   * run yet (RUN_NOT_FOUND) and terminal-run stops are normal lifecycle,
   * not something to shout at the user on every startup. Quitting kills
   * only this child — never the background run.
   */
  startStream(): void {
    if (this.streamChild || this.stopped) return;
    const args = ['attach', '--json'];
    if (this.lastSeq > 0) args.push('--since', String(this.lastSeq));
    const child = spawn(process.execPath, [cliEntryPath(), ...args], {
      cwd: process.cwd(),
      env: { ...process.env, IDEASEEK_CLI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.streamChild = child;
    // Set once the child's exit is explained (no run / surfaced error) so
    // the close handler does not append a redundant "ended" line.
    let exitExplained = false;
    let buf = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      buf += String(chunk);
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as {
            seq?: number;
            runId: string;
            ts?: number;
            type?: string;
            phase?: string;
            role?: string;
            object: string | null;
            summary: string;
            status: string | null;
          };
          // attach's lifecycle summary (stopReason/status/…) is JSON but
          // not an event — rendering it produced `[NaN:NaN:NaN]` garbage.
          if (
            typeof event.seq !== 'number' ||
            typeof event.ts !== 'number' ||
            typeof event.type !== 'string'
          ) {
            continue;
          }
          if (event.seq > this.lastSeq) this.lastSeq = event.seq;
          // Audit-only session UI decisions stay in the DB (/events) but
          // never stream: every Shift+Tab writes one, and replaying them
          // floods the startup pane with a wall of identical lines while
          // the switch confirmation already showed the action live.
          if (isSessionUiNoise({ type: event.type, summary: event.summary })) continue;
          this.println(
            formatEventLine(
              {
                seq: event.seq,
                runId: event.runId,
                ts: event.ts,
                phase: event.phase ?? '',
                objectId: event.object,
                role: event.role ?? null,
                eventType: event.type,
                summary: event.summary,
                status: event.status,
                artifactRefs: [],
              },
              { plain: this.plain },
            ),
          );
        } catch {
          // non-JSON chatter from the child — surface verbatim
          this.println(line);
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk).trim();
      if (!text) return;
      // A fresh project has no run yet — attach exits with RUN_NOT_FOUND.
      // That is the expected steady state, not a warning to paint red.
      if (text.includes('RUN_NOT_FOUND')) {
        exitExplained = true;
        return;
      }
      exitExplained = true;
      this.println(paint(`event stream: ${text}`, 'warn', { plain: this.plain }));
    });
    // Spawn can fail under process pressure (EAGAIN); an unhandled 'error'
    // event would take the whole UI down — degrade to a warning instead.
    child.on('error', (error) => {
      this.streamChild = null;
      if (!this.stopped) {
        this.println(paint(`event stream: ${error.message}`, 'warn', { plain: this.plain }));
      }
    });
    child.on('close', (code) => {
      this.streamChild = null;
      if (this.stopped || exitExplained) return;
      // Natural stop (run terminal) or our own kill — silent. Anything
      // else is an abnormal exit worth one dim line.
      if (code === 0 || code === null) return;
      this.println(paint(`(event stream ended exit ${code})`, 'dim', { plain: this.plain }));
    });
  }

  stopStream(): void {
    if (this.streamChild) {
      this.streamChild.kill();
      this.streamChild = null;
    }
  }

  /** Stops the stream and writes the clean session-end marker (idempotent). */
  async end(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stopStream();
    if (this.sessionRoot) {
      // Awaited: the process may exit right after — a fire-and-forget write
      // would race the exit and lose the clean-end marker.
      try {
        await writeSessionEnd(this.sessionRoot, true);
      } catch {
        // marker is best-effort; a crash still reads as a crash
      }
    }
  }
}
