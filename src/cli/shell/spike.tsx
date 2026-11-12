import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, useStdout } from 'ink';
import { ShellEngine, type EngineKey, type EngineResult } from './engine.js';
import { resolveSlash } from '../slash-menu.js';

/**
 * Ink spike (ADR-010): proves the framework covers the interactive shell
 * contract — alternate screen, fixed header/activity/input/footer, live
 * palette, keyboard rules, resize, Ctrl-C/D and background event refresh —
 * before Ink becomes the sole interactive renderer. Business dispatch is
 * stubbed here on purpose; the adoption step wires the SAME engine +
 * view to the existing dispatch/relay use-cases.
 */

interface InkKeyLike {
  return?: boolean;
  escape?: boolean;
  tab?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

export function toEngineKey(input: string, key: InkKeyLike): EngineKey {
  if (key.return) return { name: 'return' };
  if (key.escape) return { name: 'escape' };
  if (key.tab || input === '\t') return { name: 'tab' };
  if (key.upArrow) return { name: 'up' };
  if (key.downArrow) return { name: 'down' };
  if (key.leftArrow) return { name: 'left' };
  if (key.rightArrow) return { name: 'right' };
  if (key.pageUp) return { name: 'pageup' };
  if (key.pageDown) return { name: 'pagedown' };
  if (key.home) return { name: 'home' };
  if (key.end) return { name: 'end' };
  if (key.backspace || input === '\x7f' || input === '\b') return { name: 'backspace' };
  if (key.delete) return { name: 'delete' };
  if (key.ctrl && input === '\x03') return { name: 'c', ctrl: true };
  if (key.ctrl && input === '\x04') return { name: 'd', ctrl: true };
  if (key.ctrl && input.length === 1) return { name: input, ctrl: true };
  if (input.length > 0 && !key.meta) return { sequence: input };
  return { name: 'unknown' };
}

interface SpikeState {
  snap: EngineResult;
  activity: string[];
  offset: number; // 0 = follow tail
  header: string[];
}

const FOOTER = 'Tab complete · ↑/↓ palette · Esc close · Ctrl-C hint · Ctrl-D exit';

function SpikeApp({ initialHeader }: { initialHeader: string[] }): React.ReactElement {
  const engine = useMemo(() => new ShellEngine(), []);
  const { stdout } = useStdout();
  const { exit } = useApp();
  const [state, setState] = useState<SpikeState>({
    snap: engine.handle({ name: 'noop' }),
    activity: [],
    offset: 0,
    header: initialHeader,
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const [size, setSize] = useState(() => ({
    rows: Number(process.env.IDEASEEK_TTY_ROWS ?? '') || stdout.rows || 24,
    columns: Number(process.env.IDEASEEK_TTY_COLS ?? '') || stdout.columns || 80,
  }));

  // Alternate screen: enter on mount, restore on unmount (the only raw
  // sequences this adapter owns — layout/diffing is Ink's job).
  useEffect(() => {
    stdout.write('\x1b[?1049h\x1b[H');
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

  // Background events (checkpoint: continuous refresh while typing).
  useEffect(() => {
    const timer = setInterval(() => {
      const stamp = new Date().toISOString().slice(11, 19);
      setState((prev) => ({
        ...prev,
        activity: [
          ...prev.activity,
          `[${stamp}] background event #${prev.activity.length + 1}`,
        ].slice(-300),
      }));
    }, 700);
    return () => clearInterval(timer);
  }, []);

  useInput((input, key) => {
    const result = engine.handle(toEngineKey(input, key));
    if (result.scrollDelta !== 0) {
      const page = Math.max(1, size.rows - stateRef.current.header.length - 3);
      setState((prev) => ({
        ...prev,
        snap: result,
        offset: Math.max(0, prev.offset + result.scrollDelta * page),
      }));
      return;
    }
    if (result.interrupt) {
      setState((prev) => ({
        ...prev,
        snap: result,
        activity: [...prev.activity, 'Ctrl-C: use Ctrl-D or /quit to exit'].slice(-300),
      }));
      return;
    }
    if (result.eof) {
      exit(0); // restores the primary screen via the unmount effect
      return;
    }
    if (result.submit) {
      // Spike stub: the real shell routes this into the shared dispatch.
      if (result.submit === '/') {
        setState((prev) => ({ ...prev, snap: result }));
        return;
      }
      if (result.submit === '/quit') {
        exit(0); // same contract as the real REPL
        return;
      }
      const resolution = resolveSlash(result.submit);
      const echo =
        resolution.kind === 'unknown'
          ? `unknown command: ${result.submit} — try /help`
          : `✓ would run: ${resolution.kind === 'ambiguous' ? resolution.candidates.join(', ') : resolution.name}`;
      setState((prev) => ({
        ...prev,
        snap: result,
        activity: [...prev.activity, echo].slice(-300),
      }));
      return;
    }
    setState((prev) => ({ ...prev, snap: result }));
  });

  const { snap, activity, offset, header } = state;
  const inputAndFooterRows = 2;
  const maxPaletteRows = Math.max(3, size.rows - header.length - inputAndFooterRows - 1);
  const shownPalette = snap.paletteOpen ? snap.paletteItems.slice(0, maxPaletteRows) : [];
  const paletteTruncated = snap.paletteOpen && snap.paletteItems.length > shownPalette.length;
  const paletteRows = shownPalette.length + (paletteTruncated ? 1 : 0);
  const inputAndFooter = 2;
  const visible = Math.max(1, size.rows - header.length - paletteRows - inputAndFooter);
  const end = activity.length - offset;
  const start = Math.max(0, end - visible);
  const pane =
    offset > 0 ? activity.slice(Math.max(0, end - visible), end) : activity.slice(start, end);

  return (
    <Box flexDirection="column" width={size.columns} height={size.rows}>
      <Box flexDirection="column" height={header.length} flexShrink={0}>
        {header.map((line, index) => (
          <Text key={`h-${index}`} wrap="truncate">
            {line}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {pane.map((line, index) => (
          <Text key={`p-${index}`} wrap="truncate">
            {line}
          </Text>
        ))}
        {offset > 0 ? <Text dimColor>{`— scrolled ${offset} page(s), ↓ to follow —`}</Text> : null}
      </Box>
      {shownPalette.length > 0 ? (
        <Box flexDirection="column" flexShrink={0}>
          {shownPalette.map((name, index) => (
            <Text key={`c-${name}`} wrap="truncate">
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
          {'ideaseek › '}
          {snap.line.slice(0, snap.cursor)}
          {'▏'}
          {snap.line.slice(snap.cursor)}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text dimColor wrap="truncate">
          {FOOTER}
        </Text>
      </Box>
    </Box>
  );
}

export interface SpikeStreams {
  stdout: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
}

/** Runs the spike until Ctrl-D/exit; resolves with the exit code. */
export function startShellSpike(headerLines: string[], streams?: SpikeStreams): Promise<number> {
  const app = render(<SpikeApp initialHeader={headerLines} />, {
    patchConsole: false,
    exitOnCtrlC: false,
    ...(streams ? { stdout: streams.stdout, stdin: streams.stdin } : {}),
  });
  return app.waitUntilExit().then(() => 0);
}
