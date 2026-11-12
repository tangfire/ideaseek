import readline, { clearScreenDown, cursorTo, moveCursor } from 'node:readline';
import { renderBanner } from './banner.js';
import { paint, type PaintOptions } from './format.js';
import { interactiveRenderer } from './shell/engine.js';
import { InteractiveSession, paintHeader } from './shell/session.js';
import {
  SLASH_COMMANDS,
  slashCompleter,
  resolveSlash,
  openMenu,
  closeMenu,
  moveSelection,
  selectedCommand,
  renderMenu,
  truncateForWidth,
  type MenuState,
} from './slash-menu.js';

/**
 * Interactive REPL (docs/TERMINAL_UX.md). Presentation only: banner,
 * readline, the slash menu and prompt-safe output. Every command, the
 * approval flow, the event stream and session markers go through the
 * shared InteractiveSession (ADR-006) — the exact same use-cases the Ink
 * renderer and the non-interactive CLI run. A background `attach --json`
 * child replays persisted RunEvents then follows live ones; quitting
 * never cancels the run.
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

export interface InteractiveOptions {
  plain?: boolean;
}

export async function startInteractive(opts: InteractiveOptions = {}): Promise<number> {
  const plain = opts.plain === true;
  const isTTY = process.stdin.isTTY === true && process.stdout.isTTY === true;
  // Renderer routing (ADR-010): a real interactive TTY runs the Ink TUI —
  // the sole interactive renderer. plain/json/non-TTY stay line-based, and
  // IDEASEEK_FORCE_TTY=1 keeps the classic readline path over pipes for the
  // legacy keypress tests; IDEASEEK_FORCE_INK=1 drives the Ink shell over
  // pipes for the cross-process driver.
  const renderer = interactiveRenderer({
    isTTY,
    plain,
    forceTty: process.env.IDEASEEK_FORCE_TTY === '1',
    forceInk: process.env.IDEASEEK_FORCE_INK === '1',
  });
  if (renderer === 'ink') {
    const { startInkInteractive } = await import('./shell/app.js');
    return startInkInteractive({ plain });
  }

  const paintOpts: PaintOptions = { plain };
  const tty = isTTY || process.env.IDEASEEK_FORCE_TTY === '1';

  const banner = renderBanner({ plain });
  process.stdout.write(`${paint(banner, 'brand', paintOpts)}\n`);

  // Late-bound sink: the shared session may print before readline exists
  // (startup) and must print through the prompt-aware println afterwards.
  let printlnFn: (text: string) => void = (text) => process.stdout.write(`${text}\n`);
  const session = new InteractiveSession({
    plain,
    sink: {
      println: (text) => printlnFn(text),
      onHeader: (header) => printlnFn(paintHeader(header, plain)),
    },
  });

  // Startup data (header, previous session's fate, approval block) comes
  // from the shared session — same source as the Ink renderer.
  const startup = await session.begin();
  const tone = startup.header.tone;
  for (const line of startup.header.lines) {
    process.stdout.write(`${paint(line, tone, paintOpts)}\n`);
  }
  process.stdout.write(`${paint(startup.hint, 'dim', paintOpts)}\n`);
  if (startup.lastSession) {
    process.stdout.write(`${paint(startup.lastSession, 'dim', paintOpts)}\n`);
  }
  for (const line of startup.pending) {
    process.stdout.write(`${line}\n`);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: paint('ideaseek › ', 'brand', paintOpts),
    completer: slashCompleter,
    terminal: tty,
  });

  let promptShown = false;
  let rlClosed = false;
  let quitting = false;
  let menu: MenuState = closeMenu();
  let menuLines: string[] = [];
  let menuColumns = process.stdout.columns ?? 80;

  const showPrompt = (): void => {
    // EOF may close readline while queued lines are still draining —
    // prompting a closed interface throws ERR_USE_AFTER_CLOSE.
    if (rlClosed || quitting) return;
    rl.prompt();
    promptShown = true;
  };

  /** Removes the prompt-adjacent menu block (ANSI only). */
  const eraseMenu = (): void => {
    if (menuLines.length === 0 || !tty || plain) {
      menuLines = [];
      return;
    }
    // Keep the readline input row as the anchor. Move one row down, clear the
    // menu region, then return to the input row. readline's helpers work more
    // reliably across Windows Terminal/ConPTY than hand-written save/restore
    // cursor escapes.
    moveCursor(process.stdout, 0, 1);
    clearScreenDown(process.stdout);
    moveCursor(process.stdout, 0, -1);
    menuLines = [];
  };

  /** Draws the current menu under the prompt (width-aware for resize). */
  const drawMenu = (): void => {
    if (!menu.open || !tty) return;
    const rows = renderMenu(menu, { columns: menuColumns, keyHints: !plain });
    if (rows.length === 0) return;
    eraseMenu();
    // Draw below the current readline input row, then return to the prompt.
    // The input line is never printed a second time.
    process.stdout.write(`\n${rows.join('\n')}\n`);
    moveCursor(process.stdout, 0, -(rows.length + 1));
    cursorTo(process.stdout, Math.max(0, (rl.cursor ?? rl.line.length) + 11));
    menuLines = rows;
  };

  /** Redraws the prompt and menu as one terminal frame to avoid flicker. */
  const redrawMenuFrame = (): void => {
    drawMenu();
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
    // Shutdown race: /quit closes readline while the event stream may still
    // be flushing — prompting a closed interface would throw and take the
    // whole process down with exit 1. Plain write, no prompt.
    if (quitting) {
      process.stdout.write(`${text}\n`);
      return;
    }
    const hadMenu = menuLines.length > 0;
    eraseMenu();
    if (!promptShown) {
      process.stdout.write(`${text}\n`);
      if (hadMenu) drawMenu();
      return;
    }
    if (tty && !plain && !rlClosed) {
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
  // The shared session now prints through the prompt-aware implementation.
  printlnFn = println;

  // Shared session owns approvals, dispatch and the event stream.
  session.startStream();

  return new Promise<number>((resolve) => {
    const finish = async (code: number): Promise<void> => {
      if (quitting) return;
      quitting = true;
      // Awaited: stops the event-stream child and writes the clean session
      // end marker — a fire-and-forget write would race the exit.
      await session.end();
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
        menu = moveSelection(menu, key.name === 'up' ? -1 : 1);
        const selected = selectedCommand(menu);
        if (selected) {
          clearInputLine();
          rl.write(selected.name);
        }
        redrawMenuFrame();
        return;
      }

      // Live refresh while the user is still typing a slash word.
      const slashWord = line.startsWith('/') && !line.includes(' ');
      if (slashWord && line.length <= 24) {
        menu = openMenu(line);
        redrawMenuFrame();
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
        redrawMenuFrame();
      }
    };
    process.stdout.on('resize', onResize);

    // Lines are processed strictly in order: a piped stdin chunk can emit
    // several 'line' events back-to-back, and /quit must never overtake an
    // in-flight command's output.
    let queue: Promise<void> = Promise.resolve();
    const processLine = async (raw: string): Promise<void> => {
      if (quitting) return;
      try {
        // One shared dispatch for every renderer (ADR-006): empty lines,
        // bare `/` (menu), bare numbers (approval pick), natural language
        // and slash commands all live in InteractiveSession.submit.
        const outcome = await session.submit(raw);
        if (outcome === 'menu') {
          // Bare `/` (Enter) shows the menu again — never an error.
          menu = openMenu('/');
          if (tty) {
            drawMenu();
          } else {
            for (const row of renderMenu(menu, { columns: menuColumns })) println(row);
          }
          return;
        }
        if (outcome === 'quit') {
          println(
            paint('bye — background runs keep going (reconnect with ideaseek)', 'dim', paintOpts),
          );
          await finish(0);
          return;
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
      // Mark closed FIRST so prompt attempts from still-draining lines
      // become no-ops; a queue rejection must never go unhandled.
      rlClosed = true;
      void queue.then(() => finish(0)).catch(() => finish(0));
    });

    showPrompt();
  });
}
