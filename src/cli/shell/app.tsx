import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, render, useApp, useInput, useStdout } from 'ink';
import { ShellEngine, toEngineKey, type EngineResult } from './engine.js';
import { InteractiveSession, type HeaderInfo, type SessionStartup } from './session.js';
import { renderBanner, PLAIN_MARK } from '../banner.js';

/**
 * Ink interactive shell (ADR-010, docs/TERMINAL_UX.md): the sole renderer
 * for a real interactive TTY. It owns presentation only — keys go through
 * the pure ShellEngine, every command through the shared InteractiveSession
 * (same dispatch/relay/event-stream use-cases as the classic line path and
 * the non-interactive CLI). Business state never lives here.
 */

const FOOTER =
  'Tab complete · ↑/↓ palette · Esc close · PgUp/PgDn scroll · Ctrl-C hint · Ctrl-D or /quit exits';
const INTERRUPT_HINT = 'Ctrl-C: use /quit to exit (background runs keep going)';
const QUIT_LINE = 'bye — background runs keep going (reconnect with ideaseek)';
const STARTING_LINE = 'starting…';
const MAX_ACTIVITY = 500;

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
    this.lines = [...this.lines, line].slice(-MAX_ACTIVITY);
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
  plain: boolean;
}

/** Block wordmark only when it fits; otherwise the short `[IS]` mark. */
function bannerLines(columns: number, rows: number, plain: boolean): string[] {
  if (plain) return [PLAIN_MARK];
  // Terminal height controls layout only. It must not silently disable the
  // brand mark; renderBanner already chooses the compact mark by width.
  void rows;
  const text = renderBanner({ columns });
  return text.split('\n');
}

function ShellApp({ session, bus, plain }: ShellAppProps): React.ReactElement {
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

  const banner = bannerLines(size.columns, size.rows, plain);
  const ctxLines = bus.header?.lines ?? [STARTING_LINE];
  const tone = bus.header?.tone ?? 'dim';
  const hint = bus.startup?.hint ?? null;
  const headerLines = [...banner, ...ctxLines, ...(hint ? [hint] : [])];
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
        {banner.map((line, index) => (
          <Text key={`b-${index}`} color="cyan" wrap="truncate">
            {line}
          </Text>
        ))}
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
        {hint ? (
          <Text key="hint" dimColor wrap="truncate">
            {hint}
          </Text>
        ) : null}
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
          {shownPalette.map((name, index) => (
            <Text
              key={`c-${name}`}
              color={index === snap.paletteIndex ? 'cyan' : undefined}
              wrap="truncate"
            >
              {index === snap.paletteIndex ? `> ${name}` : `  ${name}`}
            </Text>
          ))}
          {paletteTruncated ? (
            <Text
              dimColor
            >{`… ${snap.paletteItems.length - shownPalette.length} more (↑/↓ to scroll)`}</Text>
          ) : null}
        </Box>
      ) : null}
      <Box flexShrink={0}>
        <Text wrap="truncate">
          <Text color="cyan">{'ideaseek › '}</Text>
          {snap.line.slice(0, snap.cursor)}
          <Text color="cyan">{'▏'}</Text>
          {snap.line.slice(snap.cursor)}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text dimColor wrap="truncate">
          {busy ? `${FOOTER} · running…` : FOOTER}
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
    app = render(<ShellApp session={session} bus={bus} plain={plain} />, {
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
