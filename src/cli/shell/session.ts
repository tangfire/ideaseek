import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import { resolve } from 'node:path';
import { renderApprovalBlock, type PendingApproval } from '../../approval/pending.js';
import { detectEnvironment } from '../../runtime/detect.js';
import { renderHeader, type HeaderContext } from '../banner.js';
import { formatEventLine, paint } from '../format.js';
import { cliEntryPath, runCli, runCliJson } from '../runner.js';
import { tokenizeArgs } from '../tokens.js';
import { resolveSlash, helpText } from '../slash-menu.js';
import { findProjectRoot } from '../../config/paths.js';
import { readLastSession, writeSessionEnd, writeSessionStart } from '../../session/context.js';
import { readSessionMode, renderSessionSummary } from '../../session/mode.js';

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

/** Unpainted project/run context header (renderer decides styling). */
export async function buildHeaderLines(): Promise<HeaderInfo> {
  const [status, papers, env] = await Promise.all([
    runCliJson<{
      project: string;
      run: {
        runId: string;
        status: string;
        phase: string;
        question: string;
        blockReason: string | null;
        strategy?: string;
      } | null;
      tasks: Record<string, number>;
      total: number;
      liveWorkers: number;
      daemon?: { pid: number; state: string; logPath: string } | null;
    }>(['status', '--json']).catch(() => null),
    runCliJson<{ indexed: number }>(['papers', '--json']).catch(() => null),
    detectEnvironment(process.cwd()).catch(() => null),
  ]);
  if (!status?.data) {
    return {
      lines: ['not an IdeaSeek project — run: ideaseek init (or cd into one)'],
      tone: 'warn',
    };
  }
  const run = status.data.run ?? null;
  const counts = status.data.tasks ?? {};
  const ctx: HeaderContext = {
    project: status.data.project ?? '(unknown project)',
    question: run?.question || null,
    mode: run?.strategy ?? null,
    runId: run?.runId ?? null,
    runStatus: run?.status ?? null,
    stage: run?.phase ?? null,
    blockReason: run?.blockReason ?? null,
    agents: status.data.liveWorkers ?? 0,
    tasks: {
      done: counts.succeeded ?? 0,
      total: status.data.total ?? 0,
      queued: counts.queued ?? 0,
      running: (counts.leased ?? 0) + (counts.running ?? 0) + (counts.committing ?? 0),
      failed: counts.failed ?? 0,
    },
    papersIndexed: papers?.data?.indexed ?? null,
    gpu: env?.gpu.nvidiaSmi.available
      ? `${env.gpu.devices.length} device(s)${env.gpu.cudaVersion ? `, CUDA ${env.gpu.cudaVersion}` : ''}`
      : null,
    cpuCores: os.cpus().length,
    memoryGiB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    supervisor: status.data.daemon
      ? `pid ${status.data.daemon.pid} ${status.data.daemon.state}`
      : null,
  };
  const lines = renderHeader(ctx).split('\n');
  const projectRoot = await findProjectRoot(process.cwd()).catch(() => null);
  if (projectRoot) {
    const sessionMode = await readSessionMode(projectRoot).catch(() => null);
    if (sessionMode)
      lines.splice(1, 0, `Session : ${sessionMode === 'agent' ? 'Agent' : 'Research'}`);
  }
  return { lines, tone: 'dim' };
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
      if (/^\d+$/.test(input) && this.pendingItems.length > 0) {
        await this.approvePending(Number(input));
        return 'continue';
      }
      if (!input.startsWith('/')) {
        // Plain text → `ideaseek ask`: queries answer from state, high-impact
        // requests become pending Decisions, everything else goes to the
        // supervisor. Never prints "unknown input".
        await this.relay(['ask', ...tokenizeArgs(input)]);
        return 'continue';
      }
      return await this.dispatch(input);
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

  /** Relays a CLI command; its stdout/stderr becomes session output. */
  private async relay(args: string[]): Promise<void> {
    const result = await runCli(args, { timeoutMs: 60_000 });
    if (result.stdout) {
      const text = result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout;
      for (const line of text.split(/\r?\n/)) this.println(line);
    }
    if (result.stderr) {
      const text = result.stderr.endsWith('\n') ? result.stderr.slice(0, -1) : result.stderr;
      for (const line of text.split(/\r?\n/)) {
        this.println(paint(line, 'error', { plain: this.plain }));
      }
    }
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
      case '/models':
        await this.relay(['models', ...restArgs]);
        return 'continue';
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
   * Replays persisted RunEvents from seq 0 then follows live ones (DB
   * polling). Quitting kills only this child — never the background run.
   */
  startStream(): void {
    if (this.streamChild) return;
    const child = spawn(process.execPath, [cliEntryPath(), 'attach', '--json'], {
      cwd: process.cwd(),
      env: { ...process.env, IDEASEEK_CLI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.streamChild = child;
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
            seq: number;
            runId: string;
            ts: number;
            type: string;
            phase?: string;
            role?: string;
            object: string | null;
            summary: string;
            status: string | null;
          };
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
      if (text) this.println(paint(`event stream: ${text}`, 'warn', { plain: this.plain }));
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
      if (!this.stopped) {
        this.println(
          paint(
            `(event stream ended${code === 0 || code === null ? '' : ` exit ${code}`})`,
            'dim',
            { plain: this.plain },
          ),
        );
      }
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
