import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import { resolve as resolvePath } from 'node:path';
import readline from 'node:readline';
import { detectEnvironment } from '../runtime/detect.js';
import { renderSessionSummary, type SessionSummary } from '../session/mode.js';
import { renderBanner, renderHeader, type HeaderContext } from './banner.js';
import { formatEventLine, paint, type PaintOptions } from './format.js';
import { cliEntryPath, runCli, runCliJson } from './runner.js';
import { tokenizeArgs } from './tokens.js';
import {
  SLASH_COMMANDS,
  slashCompleter,
  resolveSlash,
  helpText,
  openMenu,
  closeMenu,
  moveSelection,
  selectedCommand,
  renderMenu,
  truncateForWidth,
  type MenuState,
} from './slash-menu.js';

/**
 * Interactive REPL (docs/TERMINAL_UX.md). Every slash command is a thin
 * relay over the existing non-interactive CLI — no business logic is
 * duplicated here. A background `attach --json` child replays persisted
 * RunEvents then follows live ones; quitting never cancels the run.
 */

export {
  SLASH_COMMANDS,
  slashCompleter,
  resolveSlash,
  helpText,
  openMenu,
  closeMenu,
  moveSelection,
  selectedCommand,
  renderMenu,
  menuHelpLines,
  truncateForWidth,
  type SlashCommand,
  type SlashResolution,
  type MenuState,
} from './slash-menu.js';

interface StatusPayload {
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
}

interface PapersPayload {
  indexed: number;
}

/** `ideaseek open --json` payloads the REPL acts on (project switch vs document). */
type OpenPayload =
  | { kind: 'switch-target'; name: string; root: string; summary: SessionSummary }
  | { kind: 'project'; name: string; root: string; summary: SessionSummary }
  | { kind: 'document'; path: string; bytes: number; head: string }
  | { kind: 'overview'; projects: unknown[]; documents: string[] };

async function buildHeader(plain: boolean): Promise<string> {
  const paintOpts: PaintOptions = { plain };
  const [status, papers, env] = await Promise.all([
    runCliJson<StatusPayload>(['status', '--json']).catch(() => null),
    runCliJson<PapersPayload>(['papers', '--json']).catch(() => null),
    detectEnvironment(process.cwd()).catch(() => null),
  ]);
  if (!status?.data) {
    return paint(
      'not an IdeaSeek project — run: ideaseek init (or cd into one)',
      'warn',
      paintOpts,
    );
  }
  const run = status.data.run ?? null;
  const counts = status.data?.tasks ?? {};
  const ctx: HeaderContext = {
    project: status.data?.project ?? '(unknown project)',
    question: run?.question || null,
    mode: run?.strategy ?? null,
    runId: run?.runId ?? null,
    runStatus: run?.status ?? null,
    stage: run?.phase ?? null,
    blockReason: run?.blockReason ?? null,
    agents: status.data?.liveWorkers ?? 0,
    tasks: {
      done: counts.succeeded ?? 0,
      total: status.data?.total ?? 0,
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
  return paint(renderHeader(ctx), 'dim', paintOpts);
}

export interface InteractiveOptions {
  plain?: boolean;
}

interface AttachEventJson {
  seq: number;
  runId: string;
  ts: number;
  type: string;
  phase?: string;
  role?: string;
  object: string | null;
  summary: string;
  status: string | null;
}

export async function startInteractive(opts: InteractiveOptions = {}): Promise<number> {
  const plain = opts.plain === true;
  const paintOpts: PaintOptions = { plain };
  // IDEASEEK_FORCE_TTY=1 forces terminal key handling (menus, arrows, Tab)
  // for piped test runs; production uses the real TTY detection.
  const tty =
    (process.stdin.isTTY === true && process.stdout.isTTY === true) ||
    process.env.IDEASEEK_FORCE_TTY === '1';

  const banner = renderBanner({ plain });
  process.stdout.write(`${paint(banner, 'brand', paintOpts)}\n`);
  const header = await buildHeader(plain);
  process.stdout.write(`${header}\n`);
  process.stdout.write(
    `${paint('type / for the menu · Tab completes · /quit exits (runs keep going)', 'dim', paintOpts)}\n`,
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: paint('ideaseek › ', 'brand', paintOpts),
    completer: slashCompleter,
    terminal: tty,
  });

  let promptShown = false;
  let quitting = false;
  let streamChild: ChildProcess | null = null;
  let menu: MenuState = closeMenu();
  let menuLines: string[] = [];
  let menuColumns = process.stdout.columns ?? 80;

  const showPrompt = (): void => {
    rl.prompt();
    promptShown = true;
  };

  /** Removes previously drawn menu rows below the prompt (ANSI only). */
  const eraseMenu = (): void => {
    if (menuLines.length === 0 || !tty || plain) {
      menuLines = [];
      return;
    }
    process.stdout.write(`\x1b[${menuLines.length}A\r\x1b[J`);
    menuLines = [];
  };

  /** Draws the current menu under the prompt (width-aware for resize). */
  const drawMenu = (): void => {
    if (!menu.open || !tty) return;
    const rows = renderMenu(menu, { columns: menuColumns, keyHints: !plain });
    if (rows.length === 0) return;
    process.stdout.write(`${rows.join('\n')}\n`);
    menuLines = rows;
  };

  /**
   * Clears the current input buffer and repaints the prompt. Direct
   * line/cursor assignment — readline's ctrl-u binding is unreliable for
   * piped/forced-TTY streams (Esc must truly dismiss the line).
   */
  const clearInputLine = (): void => {
    const editable = rl as unknown as { line: string; cursor: number };
    editable.line = '';
    editable.cursor = 0;
    if (tty) {
      process.stdout.write('\r\x1b[K');
      rl.prompt(true);
    }
  };

  /**
   * Writes a line above the prompt without losing the typed buffer or
   * cursor (event floods preserve in-progress input — TERMINAL_UX).
   */
  const println = (text: string): void => {
    const hadMenu = menuLines.length > 0;
    eraseMenu();
    if (!promptShown) {
      process.stdout.write(`${text}\n`);
      if (hadMenu) drawMenu();
      return;
    }
    if (tty && !plain) {
      process.stdout.write('\r\x1b[K');
      process.stdout.write(`${text}\n`);
      rl.prompt(true);
      if (rl.line) {
        process.stdout.write(rl.line);
        const back = rl.line.length - (rl.cursor ?? rl.line.length);
        if (back > 0) process.stdout.write(`\x1b[${back}D`);
      }
      if (hadMenu) drawMenu();
      return;
    }
    // Piped / plain: orphan the old prompt line, keep output line-oriented.
    promptShown = false;
    process.stdout.write(`\n${text}\n`);
    if (hadMenu && menu.open) {
      const rows = renderMenu(menu, { columns: menuColumns, keyHints: false });
      process.stdout.write(`${rows.join('\n')}\n`);
      menuLines = rows;
      showPrompt();
    }
  };

  const relay = async (args: string[]): Promise<void> => {
    const result = await runCli(args, { timeoutMs: 60_000 });
    if (result.stdout) {
      const text = result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout;
      for (const line of text.split(/\r?\n/)) println(line);
    }
    if (result.stderr) {
      const text = result.stderr.endsWith('\n') ? result.stderr.slice(0, -1) : result.stderr;
      for (const line of text.split(/\r?\n/)) println(paint(line, 'error', paintOpts));
    }
  };

  const stopStream = (): void => {
    if (streamChild) {
      streamChild.kill();
      streamChild = null;
    }
  };

  const startStream = (): void => {
    const child = spawn(process.execPath, [cliEntryPath(), 'attach', '--json'], {
      cwd: process.cwd(),
      env: { ...process.env, IDEASEEK_CLI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    streamChild = child;
    let buf = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      buf += String(chunk);
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as AttachEventJson;
          println(
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
              paintOpts,
            ),
          );
        } catch {
          // non-JSON chatter from the child — surface verbatim
          println(line);
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk).trim();
      if (text) println(paint(`event stream: ${text}`, 'warn', paintOpts));
    });
    child.on('close', (code) => {
      streamChild = null;
      if (!quitting) {
        println(
          paint(
            `(event stream ended${code === 0 || code === null ? '' : ` exit ${code}`})`,
            'dim',
            paintOpts,
          ),
        );
      }
    });
  };

  const dispatch = async (input: string): Promise<'continue' | 'quit'> => {
    // Arguments never take part in command matching: `/reject some reason`
    // resolves on `/reject` alone.
    const spaceAt = input.search(/\s/);
    const head = spaceAt === -1 ? input : input.slice(0, spaceAt);
    const rest = spaceAt === -1 ? '' : input.slice(spaceAt).trim();
    const resolution = resolveSlash(head);
    if (resolution.kind === 'unknown') {
      println(`unknown command: ${head} — try /help (or a prefix like /sta)`);
      return 'continue';
    }
    if (resolution.kind === 'ambiguous') {
      println(`ambiguous prefix: ${head} → ${resolution.candidates.join(', ')}`);
      return 'continue';
    }
    const name = resolution.name;
    const restArgs = tokenizeArgs(rest);

    switch (name) {
      case '/help':
        println(helpText());
        return 'continue';
      case '/ideas':
        // Real idea state from the workspace registry (no placeholder).
        await relay(['idea', 'list']);
        return 'continue';
      case '/quit':
        return 'quit';
      case '/logs': {
        if (!rest) {
          println('usage: /logs <task-id>');
          return 'continue';
        }
        await relay(['logs', ...tokenizeArgs(rest)]);
        return 'continue';
      }
      case '/reject': {
        if (!rest) {
          println('usage: /reject <reason>');
          return 'continue';
        }
        await relay(['reject', rest]);
        return 'continue';
      }
      case '/approve':
        await relay(['confirm', 'protocol', '--by', 'user']);
        return 'continue';
      case '/status':
        await relay(['status']);
        return 'continue';
      case '/next':
        await relay(['next']);
        return 'continue';
      case '/papers':
        await relay(['papers']);
        return 'continue';
      case '/comparisons':
        await relay(['comparison', 'list']);
        return 'continue';
      case '/experiments':
        await relay(['experiment', 'list']);
        return 'continue';
      case '/pause':
        await relay(['pause']);
        return 'continue';
      case '/resume':
        await relay(['resume']);
        return 'continue';
      case '/continue':
        await relay(['continue']);
        return 'continue';
      case '/cancel':
        await relay(['cancel']);
        return 'continue';
      case '/report':
        await relay(['report']);
        return 'continue';
      case '/models':
        await relay(['models', ...restArgs]);
        return 'continue';
      case '/mode':
        await relay(['mode', ...restArgs]);
        return 'continue';
      case '/open': {
        if (!rest) {
          await relay(['open']);
          return 'continue';
        }
        // Project targets are two-step (TERMINAL_UX: switch only after a
        // confirmation so control commands never hit the wrong directory):
        // preview target + mode/project/permission summary, then --confirm
        // chdirs the session, restarts the event stream and reprints the
        // header for the new project.
        const res = await runCliJson<OpenPayload>(['open', ...restArgs, '--json']);
        const payload = res.data;
        if (payload?.kind === 'switch-target') {
          println(`switch target : ${payload.name}  (${payload.root})`);
          for (const line of renderSessionSummary(payload.summary)) println(line);
          println(paint(`confirm: /open ${restArgs.join(' ')} --confirm`, 'dim', paintOpts));
          return 'continue';
        }
        if (payload?.kind === 'project') {
          if (resolvePath(payload.root) !== resolvePath(process.cwd())) {
            process.chdir(payload.root);
            stopStream(); // events were bound to the previous project
            startStream();
            println(paint(`session → ${payload.root}`, 'dim', paintOpts));
            println(await buildHeader(plain));
          }
          for (const line of renderSessionSummary(payload.summary)) println(line);
          return 'continue';
        }
        if (res.code === 0) {
          // Document / overview: render through the same use-case.
          await relay(['open', ...restArgs]);
          return 'continue';
        }
        for (const line of res.stderr.split(/\r?\n/)) {
          if (line.trim()) println(paint(line, 'error', paintOpts));
        }
        return 'continue';
      }
      case '/rounds':
        await relay(['rounds', ...restArgs]);
        return 'continue';
      case '/ideate':
        await relay(['ideate', ...restArgs]);
        return 'continue';
      case '/feedback':
        await relay(['feedback', ...restArgs]);
        return 'continue';
      default:
        println(`unknown command: ${name} — try /help`);
        return 'continue';
    }
  };

  startStream();

  return new Promise<number>((resolve) => {
    const finish = (code: number): void => {
      if (quitting) return;
      quitting = true;
      stopStream();
      rl.close();
      resolve(code);
    };

    // --- slash menu: typing `/` opens it immediately; ↑/↓ select, Esc close.
    // Node ≥20: Interface#keypress does not re-emit for piped input — listen
    // on the raw input stream (PTY-equivalent coverage in tests).
    const keypressHost = process.stdin as unknown as {
      on(event: 'keypress', listener: (str: string | undefined, key?: readline.Key) => void): void;
    };
    keypressHost.on('keypress', (_str, key) => {
      if (!key || quitting || !tty) return;
      const line = rl.line;

      // Submission is owned by the 'line' handler — never fight it here.
      if (key.name === 'return' || key.name === 'enter') {
        if (menu.open || menuLines.length > 0) {
          eraseMenu();
          menu = closeMenu();
        }
        return;
      }

      if (key.name === 'escape') {
        if (menu.open || menuLines.length > 0) {
          eraseMenu();
          menu = closeMenu();
          clearInputLine();
        }
        return;
      }

      if (menu.open && (key.name === 'up' || key.name === 'down')) {
        eraseMenu();
        menu = moveSelection(menu, key.name === 'up' ? -1 : 1);
        const selected = selectedCommand(menu);
        if (selected) {
          clearInputLine();
          rl.write(selected.name);
        }
        drawMenu();
        return;
      }

      // Live refresh while the user is still typing a slash word.
      const slashWord = line.startsWith('/') && !line.includes(' ');
      if (slashWord && line.length <= 24) {
        eraseMenu();
        menu = openMenu(line);
        drawMenu();
        return;
      }
      if (menu.open && !slashWord) {
        eraseMenu();
        menu = closeMenu();
      }

      // Argument hints: "/logs " shows the usage line for the command.
      if (line.includes(' ')) {
        const headToken = line.slice(0, line.indexOf(' '));
        const res = resolveSlash(headToken);
        if (res.kind === 'exact' || res.kind === 'prefix') {
          const cmd = SLASH_COMMANDS.find((c) => c.name === res.name);
          if (cmd && cmd.usage !== cmd.name) {
            eraseMenu();
            const row = truncateForWidth(`  usage: ${cmd.usage}`, menuColumns);
            process.stdout.write(`${row}\n`);
            menuLines = [row];
          }
        }
      }
    });

    // Resize: re-measure width so menu rows stay inside the terminal.
    const onResize = (): void => {
      menuColumns = process.stdout.columns ?? menuColumns;
      if (menu.open && menuLines.length > 0) {
        eraseMenu();
        drawMenu();
      }
    };
    process.stdout.on('resize', onResize);

    // Lines are processed strictly in order: a piped stdin chunk can emit
    // several 'line' events back-to-back, and /quit must never overtake an
    // in-flight command's output.
    let queue: Promise<void> = Promise.resolve();
    const processLine = async (raw: string): Promise<void> => {
      if (quitting) return;
      const input = raw.trim();
      try {
        if (!input) {
          // empty line — nothing to do
        } else if (input === '/') {
          // Bare `/` (Enter) shows the menu again — never an error.
          menu = openMenu('/');
          if (tty) {
            drawMenu();
          } else {
            for (const row of renderMenu(menu, { columns: menuColumns })) println(row);
          }
          return;
        } else if (!input.startsWith('/')) {
          // Plain text → `ideaseek ask`: queries answer from state, high-impact
          // requests become pending Decisions, everything else goes to the
          // supervisor. The REPL never prints "unknown input".
          await relay(['ask', ...tokenizeArgs(input)]);
        } else {
          const outcome = await dispatch(input);
          if (outcome === 'quit') {
            println(
              paint('bye — background runs keep going (reconnect with ideaseek)', 'dim', paintOpts),
            );
            finish(0);
            return;
          }
        }
      } catch (error) {
        println(paint(`error: ${(error as Error).message}`, 'error', paintOpts));
      } finally {
        if (!quitting) showPrompt();
      }
    };

    rl.on('line', (raw) => {
      queue = queue.then(() => processLine(raw));
    });

    rl.on('SIGINT', () => {
      if (rl.line && rl.line.length > 0) {
        // Ctrl-C with typed input: clear the line.
        clearInputLine();
        return;
      }
      println(paint('Ctrl-C: use /quit to exit (background runs keep going)', 'warn', paintOpts));
      showPrompt();
    });

    rl.on('close', () => {
      // stdin EOF (piped tests, closed terminal) — drain queued lines first.
      void queue.then(() => finish(0));
    });

    showPrompt();
  });
}
