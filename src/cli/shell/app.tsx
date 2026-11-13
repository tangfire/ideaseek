import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, render, useApp, useInput, useStdout } from 'ink';
import { ShellEngine, toEngineKey, type EngineResult } from './engine.js';
import { InteractiveSession, type HeaderInfo, type SessionStartup } from './session.js';
import { renderBanner } from '../banner.js';
import { SLASH_COMMANDS } from '../slash-menu.js';

/**
 * Ink interactive shell (ADR-010, docs/TERMINAL_UX.md): the sole renderer
 * for a real interactive TTY. It owns presentation only — keys go through
 * the pure ShellEngine, every command through the shared InteractiveSession
 * (same dispatch/relay/event-stream use-cases as the classic line path and
 * the non-interactive CLI). Business state never lives here.
 */

const FOOTER =
  'Shift+Tab mode · Tab complete · ↑/↓ palette · Esc close · PgUp/PgDn scroll · Ctrl-D or /quit exits';
const INTERRUPT_HINT = 'Ctrl-C: use /quit to exit (background runs keep going)';
const QUIT_LINE = 'bye — background runs keep going (reconnect with ideaseek)';
const STARTING_LINE = 'starting…';
const MAX_ACTIVITY = 500;
const PROMPT_TEXT = 'ideaseek › ';
/** Input-bar background: one shade above the terminal black. */
const INPUT_BG = '#171b22';
/** Braille spinner cycled on the input line while a command runs. */
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Activity/header store the session writes into before (and while) React is
 * mounted: `begin()` runs CLI relays that can finish before the first frame,
 * so early lines buffer here and flush to the view on subscribe.
 */
export class ActivityBus {
  version = 0;
  lines: string[] = [];
  header: HeaderInfo | null = null;
  startup: SessionStartup | null = null;
  private readonly listeners = new Set<() => void>();

  private emit(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  push(line: string): void {
    // CLI relays may return several lines in one stdout chunk and may carry
    // ANSI styling from downstream commands. Ink owns the terminal screen,
    // so keep each logical line separate and strip embedded control codes
    // before rendering; raw ANSI inside <Text> can corrupt later frames.
    // The control character is the point: this pattern matches ANSI CSI sequences.
    // eslint-disable-next-line no-control-regex
    const safe = line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n?/g, '\n');
    this.lines = [...this.lines, ...safe.split('\n')].slice(-MAX_ACTIVITY);
    this.emit();
  }

  setHeader(header: HeaderInfo): void {
    this.header = header;
    this.emit();
  }

  setStartup(startup: SessionStartup): void {
    this.startup = startup;
    this.header = startup.header;
    // Recovery line + approval block land in the activity pane (they are
    // event-shaped), the hint stays pinned under the header.
    if (startup.lastSession) this.push(startup.lastSession);
    for (const line of startup.pending) this.push(line);
    this.emit();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

interface ShellAppProps {
  session: InteractiveSession;
  bus: ActivityBus;
}

function ShellApp({ session, bus }: ShellAppProps): React.ReactElement {
  const engine = useMemo(() => new ShellEngine(), []);
  const { stdout } = useStdout();
  const { exit } = useApp();
  const [snap, setSnap] = useState<EngineResult>(() => engine.handle({ name: 'noop' }));
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  // Re-renders whenever the bus changes (early session lines flush here).
  useSyncExternalStore(bus.subscribe, () => bus.version);
  const stateRef = useRef({ offset: 0, headerLines: 0 });
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const [size, setSize] = useState(() => ({
    rows: Number(process.env.IDEASEEK_TTY_ROWS ?? '') || stdout.rows || 24,
    columns: Number(process.env.IDEASEEK_TTY_COLS ?? '') || stdout.columns || 80,
  }));
  // Input-line liveness: idle = blinking cursor block, busy = spinner in
  // the same cell so "working" is visible exactly where the user looks.
  const [cursorOn, setCursorOn] = useState(true);
  const [spin, setSpin] = useState(0);
  useEffect(() => {
    if (busy) {
      const id = setInterval(() => setSpin((value) => value + 1), 90);
      return () => clearInterval(id);
    }
    const id = setInterval(() => setCursorOn((value) => !value), 530);
    return () => clearInterval(id);
  }, [busy]);

  // Alternate screen restore on unmount (enter happens synchronously in
  // startInkInteractive BEFORE the first frame — these are the only raw
  // sequences this adapter owns; layout/diffing is Ink's job).
  useEffect(() => {
    return () => {
      try {
        stdout.write('\x1b[?1049l');
      } catch {
        // stream already closed
      }
    };
  }, [stdout]);

  useEffect(() => {
    const onResize = (): void => {
      setSize({
        rows: Number(process.env.IDEASEEK_TTY_ROWS ?? '') || stdout.rows || 24,
        columns: Number(process.env.IDEASEEK_TTY_COLS ?? '') || stdout.columns || 80,
      });
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  // Startup (header, session marker, pending approvals) + live event stream.
  // stopStream on unmount only kills THIS child — background runs keep going.
  useEffect(() => {
    let cancelled = false;
    void session
      .begin()
      .then((startup) => {
        // Serialize startup BEFORE the event stream opens: both paths
        // open the project DB, and overlapping connections can hit
        // "database is locked" under load (attach recovery writes while
        // status is still reading).
        if (cancelled) return;
        bus.setStartup(startup);
        session.startStream();
      })
      .catch((error: unknown) => {
        if (!cancelled) bus.push(`startup: ${(error as Error).message}`);
      });
    return () => {
      cancelled = true;
      session.stopStream();
    };
  }, [session, bus]);

  useInput((input, key) => {
    const result = engine.handle(toEngineKey(input, key));
    if (result.cycleMode) {
      setSnap(result);
      setBusy(true);
      queueRef.current = queueRef.current
        .then(() => session.cycleMode())
        .catch((error: unknown) => {
          bus.push(`error: ${(error as Error).message}`);
        })
        .finally(() => setBusy(false));
      return;
    }
    if (result.scrollDelta !== 0) {
      const page = Math.max(1, size.rows - stateRef.current.headerLines - 3);
      setOffset((prev) => Math.max(0, prev + result.scrollDelta * page));
      return;
    }
    if (result.interrupt) {
      setSnap(result);
      bus.push(INTERRUPT_HINT);
      return;
    }
    if (result.eof) {
      exit(0); // restores the primary screen via the unmount effect
      return;
    }
    if (result.submit) {
      setSnap(result);
      const line = result.submit;
      // Bare "/" — the engine already keeps the palette open; nothing to run.
      if (line === '/') return;
      // Strictly ordered dispatch: a piped burst must not overtake an
      // in-flight command's output (same queue discipline as classic).
      setBusy(true);
      queueRef.current = queueRef.current
        .then(async () => {
          const outcome = await session.submit(line);
          if (outcome === 'quit') {
            bus.push(QUIT_LINE);
            // Give ink one frame to paint the farewell before unmounting —
            // exit() in the same batch would drop the final render.
            setTimeout(() => exit(0), 60);
          }
        })
        .catch((error: unknown) => {
          bus.push(`error: ${(error as Error).message}`);
        })
        .finally(() => {
          setBusy(false);
        });
      return;
    }
    setSnap(result);
  });

  // Pinned header = the compact context only (project · mode · run ·
  // question). The block wordmark is a greeting in the activity pane and
  // scrolls away with the first events (docs/TERMINAL_UX 启动信息).
  const ctxLines = bus.header?.lines ?? [STARTING_LINE];
  const modeLabel = ctxLines[0]?.includes('AGENT') ? 'Agent' : 'Research';
  const tone = bus.header?.tone ?? 'dim';
  const headerLines = ctxLines;
  stateRef.current.headerLines = headerLines.length;

  const inputAndFooterRows = 2;
  const maxPaletteRows = Math.max(3, size.rows - headerLines.length - inputAndFooterRows - 1);
  const shownPalette = snap.paletteOpen ? snap.paletteItems.slice(0, maxPaletteRows) : [];
  const paletteTruncated = snap.paletteOpen && snap.paletteItems.length > shownPalette.length;
  const paletteRows = shownPalette.length + (paletteTruncated ? 1 : 0);
  const visible = Math.max(1, size.rows - headerLines.length - paletteRows - inputAndFooterRows);
  const all = bus.lines;
  const end = all.length - offset;
  const start = Math.max(0, end - visible);
  const pane = all.slice(start, Math.max(start, end));

  return (
    <Box flexDirection="column" width={size.columns} height={size.rows}>
      <Box flexDirection="column" height={headerLines.length} flexShrink={0}>
        {ctxLines.map((line, index) => (
          <Text
            key={`c-${index}`}
            color={tone === 'warn' ? 'yellow' : undefined}
            dimColor={tone !== 'warn'}
            wrap="truncate"
          >
            {line}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {pane.map((line, index) => (
          <Text key={`p-${start + index}`} wrap="truncate">
            {line}
          </Text>
        ))}
        {offset > 0 ? <Text dimColor>{`— scrolled ${offset} page(s), ↓ to follow —`}</Text> : null}
      </Box>
      {shownPalette.length > 0 ? (
        <Box flexDirection="column" flexShrink={0}>
          {shownPalette.map((name, index) => {
            const description =
              SLASH_COMMANDS.find((command) => command.name === name)?.description ?? '';
            return (
              <Box key={`c-${name}`} flexDirection="row">
                <Box width={22} flexShrink={0}>
                  <Text
                    color={index === snap.paletteIndex ? 'cyan' : undefined}
                    bold={index === snap.paletteIndex}
                    wrap="truncate"
                  >
                    {index === snap.paletteIndex ? `› ${name}` : `  ${name}`}
                  </Text>
                </Box>
                <Box flexGrow={1}>
                  <Text dimColor wrap="truncate">
                    {description}
                  </Text>
                </Box>
              </Box>
            );
          })}
          {paletteTruncated ? (
            <Text
              dimColor
            >{`… ${snap.paletteItems.length - shownPalette.length} more (↑/↓ to scroll)`}</Text>
          ) : null}
        </Box>
      ) : null}
      <Box flexShrink={0}>
        {/* Styled composer: full-width tinted bar, bold brand prompt, and a
            live cursor cell (blink when idle, spinner while busy) — the
            input line reads as an input, not as another content row. */}
        <Text wrap="truncate" backgroundColor={INPUT_BG}>
          <Text color="cyan" bold>
            {PROMPT_TEXT}
          </Text>
          {snap.line.slice(0, snap.cursor)}
          <Text color="cyan">{busy ? SPINNER[spin % SPINNER.length] : cursorOn ? '▏' : ' '}</Text>
          {snap.line.slice(snap.cursor)}
          {/* Pad with Braille blanks (U+2800): Ink trimEnds trailing
              ASCII spaces on every line, but U+2800 is not whitespace —
              it keeps its cell (and the bar's background) to the right
              edge while rendering as an empty glyph. */}
          {'⠀'.repeat(Math.max(0, size.columns - (PROMPT_TEXT.length + snap.line.length + 1)))}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text wrap="truncate">
          <Text color="black" backgroundColor={modeLabel === 'Agent' ? 'magenta' : 'cyan'} bold>
            {` ${modeLabel.toUpperCase()} `}
          </Text>
          <Text dimColor>{` ${busy ? `${FOOTER} · running…` : FOOTER}`}</Text>
        </Text>
      </Box>
    </Box>
  );
}

export interface InkInteractiveOptions {
  plain?: boolean;
  /** Test hook: fake TTY streams (same surface as the spike driver). */
  streams?: { stdout: NodeJS.WriteStream; stdin: NodeJS.ReadStream };
}

/**
 * Runs the Ink shell until Ctrl-D / `/quit`; resolves with the exit code.
 * Never cancels a background run — teardown only kills the event-stream
 * child and writes the clean session-end marker.
 */
export async function startInkInteractive(opts: InkInteractiveOptions = {}): Promise<number> {
  const plain = opts.plain === true;
  // FORCE_INK over piped stdio (tests/driver): shim the raw-mode surface so
  // ink's real input parser runs without allocating a PTY.
  if (!opts.streams && process.env.IDEASEEK_FORCE_INK === '1') {
    const stdin = process.stdin as unknown as {
      isTTY?: boolean;
      setRawMode?: (mode: boolean) => void;
      ref?: () => void;
      unref?: () => void;
    };
    stdin.isTTY = true;
    stdin.setRawMode = () => {};
    stdin.ref = () => {};
    stdin.unref = () => {};
  }

  const bus = new ActivityBus();
  // Greeting first: the block wordmark (or short mark) lands at the top of
  // the activity pane before begin() resolves, so the first frame already
  // shows the brand — and it scrolls away as events arrive instead of
  // pinning six rows of header forever.
  const greetingColumns =
    Number(process.env.IDEASEEK_TTY_COLS ?? '') || process.stdout.columns || 80;
  for (const line of renderBanner({ columns: greetingColumns, plain }).split('\n')) {
    bus.push(line);
  }
  const session = new InteractiveSession({
    plain,
    sink: {
      println: (text) => bus.push(text),
      onHeader: (header) => bus.setHeader(header),
    },
  });

  // Enter the alternate screen BEFORE the first frame so no startup output
  // ever lands on the primary screen (restore lives in ShellApp unmount).
  const out = opts.streams?.stdout ?? process.stdout;
  out.write('\x1b[?1049h\x1b[H');

  let app: ReturnType<typeof render>;
  try {
    app = render(<ShellApp session={session} bus={bus} />, {
      patchConsole: false,
      exitOnCtrlC: false,
      ...(opts.streams ? { stdout: opts.streams.stdout, stdin: opts.streams.stdin } : {}),
    });
  } catch (error) {
    try {
      out.write('\x1b[?1049l');
    } catch {
      // stream already closed
    }
    await session.end();
    throw error;
  }
  await app.waitUntilExit();
  // Awaited: the process may exit right after — a fire-and-forget write
  // would race the exit and lose the clean-end marker.
  await session.end();
  return 0;
}
