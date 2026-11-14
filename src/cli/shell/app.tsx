import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, render, useApp, useInput, useStdout } from 'ink';
import { copyToClipboard } from './clipboard.js';
import { ShellEngine, toEngineKey, type EngineResult } from './engine.js';
import { InteractiveSession, type HeaderInfo, type SessionStartup } from './session.js';
import {
  TOOL_CALL_RE,
  TOOL_RESULT_RE,
  TranscriptWrapCache,
  classifyLineKind,
  computeViewportSlice,
  formatElapsed,
  type TranscriptBlock,
} from './transcript.js';
import { renderBanner } from '../banner.js';
import { SLASH_COMMANDS } from '../slash-menu.js';
import {
  padVisualEnd,
  sanitizeAnsiForInk,
  sliceVisualTail,
  stripAnsi,
  truncateVisual,
  visualWidth,
} from '../text-width.js';

/**
 * Ink interactive shell (ADR-010, docs/TERMINAL_UX.md): the sole renderer
 * for a real interactive TTY. It owns presentation only — keys go through
 * the pure ShellEngine, every command through the shared InteractiveSession
 * (same dispatch/relay/event-stream use-cases as the classic line path and
 * the non-interactive CLI). Business state never lives here.
 */

const FOOTER_HINTS = 'Shift+Tab mode · / menu · Ctrl+O details · ? shortcuts';
/** Lines the wheel scrolls per notch (terminals already repeat events). */
const WHEEL_SCROLL_LINES = 6;
const INTERRUPT_HINT = 'Ctrl-C: use /quit to exit (background runs keep going)';
const QUIT_LINE = 'bye — background runs keep going (reconnect with ideaseek)';
const STARTING_LINE = 'starting…';
/**
 * History buffer for the activity pane (logical lines and blocks kept in
 * memory). Visual wrapping is cached per block so rendering stays O(visible).
 */
const MAX_ACTIVITY = 5000;
const MAX_BLOCKS = 2000;
const MAX_MERGED_OUTPUT_LINES = 240;
const PROMPT_TEXT = 'ideaseek › ';
/** Coalescing window for rapid activity bursts (~60fps) to avoid frame storms. */
const BUS_BATCH_MS = 16;
/** Braille spinner cycled on the input line while a command runs. */
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const SHORTCUT_ROWS: readonly { keys: string; desc: string }[] = [
  { keys: 'Shift+Tab', desc: 'Cycle Research / Analysis tier' },
  { keys: '/ · Tab', desc: 'Open slash palette & complete prefix' },
  { keys: '↑ / ↓', desc: 'Select palette command or recall history' },
  { keys: 'Ctrl+O', desc: 'Toggle compact / expanded tool & runtime trace' },
  { keys: 'Ctrl+Y', desc: 'Copy latest response to clipboard' },
  { keys: 'Ctrl+L', desc: 'Insert fresh divider & jump to bottom' },
  { keys: 'PgUp / Wheel', desc: 'Scroll history · Ctrl-C stop · Ctrl-D /quit' },
];

/**
 * Activity/header store the session writes into before (and while) React is
 * mounted: `begin()` runs CLI relays that can finish before the first frame,
 * so early lines buffer here and flush to the view on subscribe.
 */
export class ActivityBus {
  version = 0;
  lines: string[] = [];
  blocks: TranscriptBlock[] = [];
  header: HeaderInfo | null = null;
  startup: SessionStartup | null = null;
  private nextBlockId = 1;
  private readonly listeners = new Set<() => void>();
  private batchTimer: ReturnType<typeof setTimeout> | null = null;

  private notifyNow(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    for (const listener of this.listeners) listener();
  }

  private scheduleNotify(): void {
    if (this.listeners.size === 0 || this.batchTimer) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      for (const listener of this.listeners) listener();
    }, BUS_BATCH_MS);
  }

  private appendBlock(block: Omit<TranscriptBlock, 'id' | 'rev'>): void {
    const entry: TranscriptBlock = {
      ...block,
      id: this.nextBlockId++,
      rev: 0,
    };
    this.blocks = [...this.blocks, entry].slice(-MAX_BLOCKS);
  }

  private pushStructuredLine(clean: string): void {
    const plain = stripAnsi(clean);
    const kind = classifyLineKind(clean);

    if (kind === 'tool') {
      const callMatch = TOOL_CALL_RE.exec(plain);
      if (
        callMatch &&
        !plain.trimStart().startsWith('⚙ ✓') &&
        !plain.trimStart().startsWith('⚙ ✗')
      ) {
        this.appendBlock({
          kind: 'tool',
          text: clean,
          toolName: callMatch[1]!,
          toolArgs: callMatch[2] ?? '',
          toolStatus: 'running',
          startedAt: Date.now(),
        });
        return;
      }
      const resMatch = TOOL_RESULT_RE.exec(plain);
      if (resMatch) {
        const [, symbol, name, errMsg] = resMatch;
        for (let i = this.blocks.length - 1; i >= 0; i -= 1) {
          const prev = this.blocks[i]!;
          if (prev.kind === 'tool' && prev.toolName === name && prev.toolStatus === 'running') {
            prev.toolStatus = symbol === '✓' ? 'ok' : 'error';
            prev.toolError = errMsg;
            prev.finishedAt = Date.now();
            prev.text = clean;
            prev.rev += 1;
            return;
          }
          // Stop searching once we cross back past a user turn boundary.
          if (prev.kind === 'user') break;
        }
        this.appendBlock({
          kind: 'tool',
          text: clean,
          toolName: name!,
          toolArgs: '',
          toolStatus: symbol === '✓' ? 'ok' : 'error',
          toolError: errMsg,
          finishedAt: Date.now(),
        });
        return;
      }
    }

    // Coalesce consecutive ordinary output lines into one Markdown-capable block
    // so multi-line fenced code, lists and pipe tables render cohesively.
    const last = this.blocks[this.blocks.length - 1];
    if (
      kind === 'output' &&
      last?.kind === 'output' &&
      last.text.split('\n').length < MAX_MERGED_OUTPUT_LINES
    ) {
      last.text = `${last.text}\n${clean}`;
      last.rev += 1;
      return;
    }

    this.appendBlock({ kind, text: clean });
  }

  pushBanner(text: string): void {
    const safe = sanitizeAnsiForInk(text);
    const split = safe.split('\n');
    this.lines = [...this.lines, ...split].slice(-MAX_ACTIVITY);
    for (const line of split) {
      this.appendBlock({ kind: 'banner', text: line });
    }
    this.version += 1;
    this.scheduleNotify();
  }

  pushDivider(label = ''): void {
    this.appendBlock({ kind: 'divider', text: label });
    this.version += 1;
    this.notifyNow();
  }

  push(line: string): void {
    // Preserve safe ANSI SGR color sequences while stripping cursor/screen
    // control codes so downstream CLI colors survive without corrupting Ink.
    const safe = sanitizeAnsiForInk(line);
    const split = safe.split('\n');
    this.lines = [...this.lines, ...split].slice(-MAX_ACTIVITY);
    for (const entry of split) {
      this.pushStructuredLine(entry);
    }
    this.version += 1;
    this.scheduleNotify();
  }

  /** Returns the latest substantive output text (for Ctrl+Y clipboard copy). */
  getLastCopyableText(): string | null {
    for (let i = this.blocks.length - 1; i >= 0; i -= 1) {
      const block = this.blocks[i]!;
      if (block.kind === 'output' || block.kind === 'error') {
        const plain = stripAnsi(block.text).trim();
        if (plain) return plain;
      }
    }
    return null;
  }

  setHeader(header: HeaderInfo): void {
    this.header = header;
    this.version += 1;
    this.notifyNow();
  }

  setStartup(startup: SessionStartup): void {
    this.startup = startup;
    this.header = startup.header;
    if (startup.lastSession) this.push(startup.lastSession);
    for (const line of startup.pending) this.push(line);
    this.version += 1;
    this.notifyNow();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.batchTimer) {
        clearTimeout(this.batchTimer);
        this.batchTimer = null;
      }
    };
  };
}

/**
 * Fits single-line composer text around the cursor into `availCols` visual
 * columns so long English or CJK inputs keep the cursor visible and never wrap.
 */
function fitComposerWindow(
  line: string,
  cursor: number,
  availCols: number,
): { before: string; after: string } {
  const safeAvail = Math.max(6, availCols);
  const rawBefore = line.slice(0, cursor);
  const rawAfter = line.slice(cursor);
  const beforeW = visualWidth(rawBefore);
  const afterW = visualWidth(rawAfter);
  if (beforeW + afterW <= safeAvail) {
    return { before: rawBefore, after: rawAfter };
  }
  const reserveAfter = Math.min(afterW, Math.max(0, Math.floor(safeAvail / 3)));
  const beforeBudget = Math.max(3, safeAvail - reserveAfter);
  let before = rawBefore;
  if (beforeW > beforeBudget) {
    const tail = sliceVisualTail(rawBefore, Math.max(1, beforeBudget - 1));
    before = `…${tail}`;
  }
  const remainingForAfter = Math.max(0, safeAvail - visualWidth(before));
  const after = afterW > remainingForAfter ? truncateVisual(rawAfter, remainingForAfter) : rawAfter;
  return { before, after };
}

interface ShellAppProps {
  session: InteractiveSession;
  bus: ActivityBus;
  plain: boolean;
}

function ShellApp({ session, bus, plain }: ShellAppProps): React.ReactElement {
  const engine = useMemo(() => new ShellEngine(), []);
  const wrapCache = useMemo(() => new TranscriptWrapCache(), []);
  const { stdout } = useStdout();
  const { exit } = useApp();
  const [snap, setSnap] = useState<EngineResult>(() => engine.handle({ name: 'noop' }));
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [busyStartedAt, setBusyStartedAt] = useState<number | null>(null);
  const [expandedDetails, setExpandedDetails] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Masked secret entry (models setup): the buffer never leaves this
  // component except as the resolved answer — no echo, no transcript.
  const [secretBuf, setSecretBuf] = useState('');
  // Re-renders whenever the bus changes (early session lines flush here).
  useSyncExternalStore(bus.subscribe, () => bus.version);
  const stateRef = useRef({ offset: 0, chromeRows: 6 });
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const prevRowCountRef = useRef(0);
  const [size, setSize] = useState(() => ({
    rows: Number(process.env.IDEASEEK_TTY_ROWS ?? '') || stdout.rows || 24,
    columns: Number(process.env.IDEASEEK_TTY_COLS ?? '') || stdout.columns || 80,
  }));

  const showToast = (message: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, 2500);
  };

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  // Input-line liveness: idle = blinking cursor block, busy = spinner in
  // the same cell so "working" is visible exactly where the user looks.
  const [cursorOn, setCursorOn] = useState(true);
  const [spin, setSpin] = useState(0);
  useEffect(() => {
    if (busy) {
      setBusyStartedAt((prev) => prev ?? Date.now());
      const id = setInterval(() => setSpin((value) => value + 1), 90);
      return () => clearInterval(id);
    }
    setBusyStartedAt(null);
    const id = setInterval(() => setCursorOn((value) => !value), 530);
    return () => clearInterval(id);
  }, [busy]);

  // Alternate screen + mouse-tracking restore on unmount.
  useEffect(() => {
    return () => {
      try {
        stdout.write('\x1b[?1006l\x1b[?1000l\x1b[?1049l');
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

  const cols = Math.max(24, size.columns);
  const rows = Math.max(8, size.rows);
  const paneCols = Math.max(16, cols - 2);
  const wrappedRows = useMemo(
    () =>
      wrapCache.renderBlocks(bus.blocks, paneCols, {
        plain,
        expanded: expandedDetails,
      }),
    [wrapCache, bus.blocks, bus.version, paneCols, plain, expandedDetails],
  );

  // While scrolled up, anchor the viewed window in wrapped-row units so new
  // wrapped blocks never push history out from under the reader.
  useEffect(() => {
    const delta = wrappedRows.length - prevRowCountRef.current;
    prevRowCountRef.current = wrappedRows.length;
    if (delta > 0 && offset > 0) setOffset((prev) => prev + delta);
  }, [wrappedRows.length, offset]);

  // Startup (header, session marker, pending approvals) + live event stream.
  useEffect(() => {
    let cancelled = false;
    void session
      .begin()
      .then((startup) => {
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
    if (session.secretPrompt) {
      if (key.return) {
        const answer = secretBuf;
        setSecretBuf('');
        session.answerSecret(answer);
        return;
      }
      if (key.escape || (key.ctrl && input === 'c') || input === '\x03') {
        setSecretBuf('');
        session.answerSecret(null);
        return;
      }
      if (key.backspace || input === '\x7f' || input === '\b') {
        setSecretBuf((value) => value.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta && input !== '\t' && input !== '\r') {
        setSecretBuf((value) => value + input);
      }
      return;
    }
    if (session.pendingApproval) {
      if (input === 'y' || input === 'Y') session.respondApproval(true);
      else if (input === 'n' || input === 'N' || key.return || key.escape)
        session.respondApproval(false);
      return;
    }
    if (shortcutsOpen && (key.escape || input === '?')) {
      setShortcutsOpen(false);
      return;
    }

    const result = engine.handle(toEngineKey(input, key));
    if (result.toggleHelp) {
      setShortcutsOpen((prev) => !prev);
      return;
    }
    if (shortcutsOpen) setShortcutsOpen(false);

    if (result.toggleDetails) {
      setExpandedDetails((prev) => {
        const next = !prev;
        showToast(next ? 'details: expanded' : 'details: compact');
        return next;
      });
      return;
    }
    if (result.clearView) {
      bus.pushDivider('view cleared (scroll up for earlier history)');
      setOffset(0);
      return;
    }
    if (result.copyLast) {
      const payload = bus.getLastCopyableText();
      if (!payload) {
        showToast('nothing to copy yet');
      } else {
        void copyToClipboard(payload).then((res) => {
          showToast(res.ok ? '✓ copied latest reply' : `copy failed: ${res.reason}`);
        });
      }
      return;
    }
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
    if (result.wheelDelta !== 0) {
      setOffset((prev) => Math.max(0, prev + result.wheelDelta * WHEEL_SCROLL_LINES));
      return;
    }
    if (result.scrollDelta !== 0) {
      const page = Math.max(1, rows - stateRef.current.chromeRows);
      setOffset((prev) => Math.max(0, prev + result.scrollDelta * page));
      return;
    }
    if (result.interrupt) {
      setSnap(result);
      void session
        .interrupt()
        .then((aborted) =>
          bus.push(aborted ? 'interrupted — the running command was stopped' : INTERRUPT_HINT),
        )
        .catch(() => bus.push(INTERRUPT_HINT));
      return;
    }
    if (result.eof) {
      exit(0);
      return;
    }
    if (result.submit) {
      setSnap(result);
      const line = result.submit;
      if (line === '/') return;
      bus.push(`❯ ${line}`);
      setOffset(0);
      setBusy(true);
      queueRef.current = queueRef.current
        .then(async () => {
          const outcome = await session.submit(line);
          if (outcome === 'quit') {
            bus.push(QUIT_LINE);
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

  // Pinned header = compact context (project · mode · run · question).
  const ctxLines = (bus.header?.lines ?? [STARTING_LINE]).map((line) => truncateVisual(line, cols));
  const modeLabel = ctxLines[0]?.includes('CODING')
    ? 'Coding'
    : ctxLines[0]?.includes('ANALYSIS')
      ? 'Analysis'
      : ctxLines[0]?.includes('GENERAL')
        ? 'General'
        : 'Research';
  const tone = bus.header?.tone ?? 'dim';
  const headerRows = ctxLines.length;

  const composerRows = 3;
  const footerRows = 1;
  const maxOverlayRows = Math.max(3, rows - headerRows - composerRows - footerRows - 2);
  const showShortcutsPanel = shortcutsOpen && maxOverlayRows >= SHORTCUT_ROWS.length + 1;
  const shownPalette =
    !showShortcutsPanel && snap.paletteOpen ? snap.paletteItems.slice(0, maxOverlayRows) : [];
  const paletteTruncated =
    !showShortcutsPanel && snap.paletteOpen && snap.paletteItems.length > shownPalette.length;
  const overlayRows = showShortcutsPanel
    ? 1 + SHORTCUT_ROWS.length
    : shownPalette.length > 0
      ? 1 + shownPalette.length + (paletteTruncated ? 1 : 0)
      : 0;

  stateRef.current.chromeRows = headerRows + overlayRows + composerRows + footerRows;
  const visible = Math.max(1, rows - stateRef.current.chromeRows);
  const probeViewport = computeViewportSlice(wrappedRows.length, visible, offset);
  const contentRows = probeViewport.effOffset > 0 ? Math.max(1, visible - 1) : visible;
  const viewport = computeViewportSlice(wrappedRows.length, contentRows, offset);
  const pane = wrappedRows.slice(viewport.start, Math.max(viewport.start, viewport.end));

  const hairline = '─'.repeat(cols);
  const composerWindow = fitComposerWindow(
    snap.line,
    snap.cursor,
    cols - visualWidth(PROMPT_TEXT) - 2,
  );
  const secretLabel = ` 🔐 ${session.secretPrompt?.label ?? ''}: `;
  const secretBullets = '•'.repeat(
    Math.min(secretBuf.length, Math.max(0, cols - visualWidth(secretLabel) - 2)),
  );
  const approvalPromptText = session.pendingApproval
    ? truncateVisual(
        ` ⏸ allow ${session.pendingApproval.toolName}? y allow once · n/Enter reject${
          session.pendingApproval.reason ? ` — ${session.pendingApproval.reason}` : ''
        }`,
        cols,
      )
    : '';

  const elapsed = busy && busyStartedAt ? ` ${formatElapsed(Date.now() - busyStartedAt)}` : '';
  const detailBadge = expandedDetails ? 'expanded · ' : '';
  const toastPart = toast ? `${toast} · ` : '';
  const statusSegment = busy
    ? ` ${SPINNER[spin % SPINNER.length]} ${session.pendingApproval ? 'waiting for approval…' : `running…${elapsed}`} · `
    : ` ${toastPart}${detailBadge}`;
  const badgeText = ` ${modeLabel.toUpperCase()} `;
  const footerTail = truncateVisual(
    `${statusSegment}${FOOTER_HINTS}`,
    Math.max(0, cols - visualWidth(badgeText)),
  );

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Box flexDirection="column" height={headerRows} flexShrink={0}>
        {ctxLines.map((line, index) => (
          <Text
            key={`c-${index}`}
            color={tone === 'warn' ? 'yellow' : index === 0 ? 'white' : undefined}
            bold={index === 0}
            dimColor={tone !== 'warn' && index > 0}
          >
            {line}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {pane.map((row, index) => (
          <Text key={`p-${viewport.start + index}`}>{row.text}</Text>
        ))}
        {viewport.effOffset > 0 ? (
          <Text dimColor>
            {truncateVisual(
              `— scrolled up ${viewport.effOffset}/${viewport.totalRows} lines · ↓ / wheel down to follow —`,
              paneCols,
            )}
          </Text>
        ) : null}
      </Box>
      {showShortcutsPanel ? (
        <Box flexDirection="column" flexShrink={0}>
          <Text dimColor>
            {truncateVisual(`─── Shortcuts (Esc / ? to close) ${hairline}`, cols)}
          </Text>
          {SHORTCUT_ROWS.map((row) => (
            <Box key={row.keys} flexDirection="row">
              <Text color="cyan" bold>
                {padVisualEnd(`  ${row.keys}`, 16)}
              </Text>
              <Text dimColor>{truncateVisual(row.desc, Math.max(8, cols - 16))}</Text>
            </Box>
          ))}
        </Box>
      ) : shownPalette.length > 0 ? (
        <Box flexDirection="column" flexShrink={0}>
          <Text dimColor>{hairline}</Text>
          {shownPalette.map((name, index) => {
            const cmd = SLASH_COMMANDS.find((command) => command.name === name);
            const selected = index === snap.paletteIndex;
            const left = padVisualEnd(selected ? ` › ${name}` : `   ${name}`, 18);
            const rightBudget = Math.max(8, cols - visualWidth(left) - 1);
            const desc = truncateVisual(cmd?.description ?? '', rightBudget);
            return (
              <Box key={`c-${name}`} flexDirection="row">
                <Text color={selected ? 'cyan' : undefined} bold={selected}>
                  {left}
                </Text>
                <Text color={selected ? 'white' : undefined} dimColor={!selected}>
                  {desc}
                </Text>
              </Box>
            );
          })}
          {paletteTruncated ? (
            <Text dimColor>
              {truncateVisual(
                `   … ${snap.paletteItems.length - shownPalette.length} more (↑/↓ to scroll)`,
                cols,
              )}
            </Text>
          ) : null}
        </Box>
      ) : null}
      <Box flexDirection="column" flexShrink={0}>
        <Text dimColor>{hairline}</Text>
        {session.secretPrompt ? (
          <Text>
            <Text color="cyan" bold>
              {secretLabel}
            </Text>
            <Text>{secretBullets}</Text>
            <Text color="cyan">{cursorOn ? '▏' : ' '}</Text>
          </Text>
        ) : session.pendingApproval ? (
          <Text backgroundColor="#3d3413" color="yellow" bold>
            {padVisualEnd(approvalPromptText, cols)}
          </Text>
        ) : (
          <Text>
            <Text color="cyan" bold>
              {PROMPT_TEXT}
            </Text>
            {composerWindow.before}
            <Text color="cyan">{busy ? SPINNER[spin % SPINNER.length] : cursorOn ? '▏' : ' '}</Text>
            {composerWindow.after}
          </Text>
        )}
        <Text dimColor>{hairline}</Text>
      </Box>
      <Box flexShrink={0}>
        <Text>
          <Text
            color="black"
            backgroundColor={
              modeLabel === 'General' || modeLabel === 'Coding'
                ? 'magenta'
                : modeLabel === 'Analysis'
                  ? 'yellow'
                  : 'cyan'
            }
            bold
          >
            {badgeText}
          </Text>
          <Text
            color={session.pendingApproval ? 'yellow' : undefined}
            dimColor={!session.pendingApproval}
          >
            {footerTail}
          </Text>
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
 * Wraps real-TTY stdout writes in DEC Synchronized Update brackets
 * (`\x1b[?2026h ... \x1b[?2026l`) so Ink multi-line diff rewrites render
 * atomically without frame tearing in modern terminals.
 */
function installSynchronizedOutput(stream: NodeJS.WriteStream): () => void {
  const originalWrite = stream.write.bind(stream) as typeof stream.write;
  let active = true;
  stream.write = ((
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => {
    if (!active) {
      return originalWrite(chunk, encodingOrCb as BufferEncoding, cb);
    }
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (!text.includes('\n')) {
      return originalWrite(chunk, encodingOrCb as BufferEncoding, cb);
    }
    const wrapped = `\x1b[?2026h${text}\x1b[?2026l`;
    return originalWrite(wrapped, encodingOrCb as BufferEncoding, cb);
  }) as typeof stream.write;
  return () => {
    active = false;
    stream.write = originalWrite;
  };
}

/**
 * Runs the Ink shell until Ctrl-D / `/quit`; resolves with the exit code.
 * Never cancels a background run — teardown only kills the event-stream
 * child and writes the clean session-end marker.
 */
export async function startInkInteractive(opts: InkInteractiveOptions = {}): Promise<number> {
  const plain = opts.plain === true;
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
  const greetingColumns =
    Number(process.env.IDEASEEK_TTY_COLS ?? '') || process.stdout.columns || 80;
  bus.pushBanner(renderBanner({ columns: greetingColumns, plain }));

  const session = new InteractiveSession({
    plain,
    sink: {
      println: (text) => bus.push(text),
      onHeader: (header) => bus.setHeader(header),
    },
  });
  session.enableSecretCapture();

  const prevForceColor = process.env.IDEASEEK_FORCE_COLOR;
  const restoreForceColor = () => {
    if (prevForceColor === undefined) delete process.env.IDEASEEK_FORCE_COLOR;
    else process.env.IDEASEEK_FORCE_COLOR = prevForceColor;
  };
  if (!plain && !process.env.NO_COLOR && process.env.TERM !== 'dumb') {
    process.env.IDEASEEK_FORCE_COLOR = '1';
  }

  const out = opts.streams?.stdout ?? process.stdout;
  out.write('\x1b[?1049h\x1b[H');
  out.write('\x1b[?1000;1006h');
  const uninstallSync =
    !opts.streams && out.isTTY === true && process.env.TERM !== 'dumb'
      ? installSynchronizedOutput(out)
      : null;

  let app: ReturnType<typeof render>;
  try {
    app = render(<ShellApp session={session} bus={bus} plain={plain} />, {
      patchConsole: false,
      exitOnCtrlC: false,
      ...(opts.streams ? { stdout: opts.streams.stdout, stdin: opts.streams.stdin } : {}),
    });
  } catch (error) {
    uninstallSync?.();
    restoreForceColor();
    try {
      out.write('\x1b[?1006l\x1b[?1000l\x1b[?1049l');
    } catch {
      // stream already closed
    }
    await session.end();
    throw error;
  }
  try {
    await app.waitUntilExit();
  } finally {
    uninstallSync?.();
    restoreForceColor();
  }
  await session.end();
  return 0;
}
