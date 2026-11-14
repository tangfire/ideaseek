import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Text, render, useApp, useInput, useStdout } from 'ink';
import { copyToClipboard } from './clipboard.js';
import { ShellEngine, toEngineKey, type EngineResult } from './engine.js';
import { scanWorkspaceMentions, type CompletionEntry } from './mentions.js';
import {
  createPicker,
  movePicker,
  selectedPickerItem,
  type PickerItem,
  type PickerState,
} from './pickers.js';
import { InteractiveSession, type HeaderInfo, type SessionStartup } from './session.js';
import {
  formatStatusTelemetry,
  readLiveStatusSnapshot,
  type LiveStatusSnapshot,
} from './status-bar.js';
import {
  TOOL_CALL_RE,
  TOOL_RESULT_RE,
  TranscriptWrapCache,
  classifyLineKind,
  computeViewportSlice,
  findTranscriptMatches,
  formatElapsed,
  highlightSearchMatches,
  type TranscriptBlock,
} from './transcript.js';
import { formatWelcomeLines, probeWorkspaceGreeting } from './welcome.js';
import { renderBanner } from '../banner.js';
import {
  padVisualEnd,
  sanitizeAnsiForInk,
  sliceVisualTail,
  stripAnsi,
  truncateVisual,
  visualWidth,
} from '../text-width.js';
import { collectPendingApprovals } from '../../approval/pending.js';
import { findProjectRoot } from '../../config/paths.js';
import { readAgentSessions } from '../../dsh/session.js';
import { listProviders } from '../../models/setup.js';
import { listRegisteredProjects } from '../../runtime/registry.js';

/**
 * Ink interactive shell (ADR-010, docs/TERMINAL_UX.md): the sole renderer
 * for a real interactive TTY. It owns presentation only — keys go through
 * the pure ShellEngine, every command through the shared InteractiveSession
 * (same dispatch/relay/event-stream use-cases as the classic line path and
 * the non-interactive CLI). Business state never lives here.
 */

const FOOTER_HINTS = 'Shift+Tab mode · / menu · @ files · Ctrl+F find · ? help';
/** Lines the wheel scrolls per notch (terminals already repeat events). */
const WHEEL_SCROLL_LINES = 6;
const INTERRUPT_HINT = 'Ctrl-C: use /quit to exit (background runs keep going)';
const QUIT_LINE = 'bye — background runs keep going (reconnect with ideaseek)';
const STARTING_LINE = 'starting…';
const MAX_ACTIVITY = 5000;
const MAX_BLOCKS = 2000;
const MAX_MERGED_OUTPUT_LINES = 240;
const MAX_COMPOSER_LINES = 5;
const PROMPT_TEXT = 'ideaseek › ';
const CONTINUATION_PROMPT = '         · ';
const BUS_BATCH_MS = 16;
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const SHORTCUT_ROWS: readonly { keys: string; desc: string }[] = [
  { keys: 'Shift+Tab', desc: 'Cycle Research / Analysis / Coding focus' },
  { keys: '/ · @ · Tab', desc: 'Commands, @-mentions & sub-argument completion' },
  { keys: 'Shift+Enter', desc: 'Insert newline (Ctrl+J also inserts newline)' },
  { keys: 'Ctrl+F', desc: 'Find in transcript (Enter/↓ next · ↑ prev)' },
  { keys: 'Ctrl+R', desc: 'Reverse incremental search in command history' },
  { keys: 'Ctrl+O', desc: 'Toggle compact / expanded tool & runtime trace' },
  { keys: 'Ctrl+Y', desc: 'Copy latest response to clipboard' },
  { keys: 'Ctrl+L', desc: 'Insert fresh divider & jump to bottom' },
  { keys: 'Alt+M', desc: 'Toggle mouse wheel vs terminal drag-select copy' },
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
 * Fits single-line text around the cursor into `availCols` visual columns so
 * long English or CJK inputs keep the cursor visible and never wrap.
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

interface ComposerRow {
  prefix: string;
  before: string;
  hasCursor: boolean;
  after: string;
}

function buildComposerRows(line: string, cursor: number, cols: number): ComposerRow[] {
  const allLines = line.split('\n');
  const beforeCursor = line.slice(0, cursor);
  const activeIdx = beforeCursor.split('\n').length - 1;
  const colInActive = beforeCursor.length - (beforeCursor.lastIndexOf('\n') + 1);

  let startIdx = 0;
  if (allLines.length > MAX_COMPOSER_LINES) {
    startIdx = Math.max(
      0,
      Math.min(allLines.length - MAX_COMPOSER_LINES, activeIdx - MAX_COMPOSER_LINES + 1),
    );
  }
  const slice = allLines.slice(startIdx, startIdx + MAX_COMPOSER_LINES);
  const availCols = cols - visualWidth(PROMPT_TEXT) - 2;

  return slice.map((text, idx) => {
    const logicalIdx = startIdx + idx;
    const prefix = logicalIdx === 0 ? PROMPT_TEXT : CONTINUATION_PROMPT;
    const isCurrent = logicalIdx === activeIdx;
    if (!isCurrent) {
      return {
        prefix,
        before: truncateVisual(text, availCols),
        hasCursor: false,
        after: '',
      };
    }
    const win = fitComposerWindow(text, colInActive, availCols);
    return {
      prefix,
      before: win.before,
      hasCursor: true,
      after: win.after,
    };
  });
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
  const [mouseEnabled, setMouseEnabled] = useState(true);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [transcriptSearch, setTranscriptSearch] = useState<{
    query: string;
    matchCursor: number;
  } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveStatusSnapshot | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastStatusRefreshRef = useRef(0);
  const [secretBuf, setSecretBuf] = useState('');
  useSyncExternalStore(bus.subscribe, () => bus.version);
  const stateRef = useRef({ offset: 0, chromeRows: 6, visible: 20 });
  const inputGenRef = useRef(0);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const prevRowCountRef = useRef(0);
  const [size, setSize] = useState(() => ({
    rows: Number(process.env.IDEASEEK_TTY_ROWS ?? '') || stdout.rows || 24,
    columns: Number(process.env.IDEASEEK_TTY_COLS ?? '') || stdout.columns || 80,
  }));

  const refreshMentionsAndProjects = () => {
    void scanWorkspaceMentions(process.cwd())
      .then((entries) => engine.setMentions(entries))
      .catch(() => undefined);
    void listRegisteredProjects()
      .then((projects) => {
        const targets: CompletionEntry[] = projects.map((p) => ({
          kind: 'arg',
          value: p.name,
          label: p.name,
          description: p.root,
        }));
        engine.setOpenTargets(targets);
      })
      .catch(() => undefined);
  };

  const refreshLiveStatus = (force = false) => {
    const now = Date.now();
    if (!force && now - lastStatusRefreshRef.current < 2000) return;
    lastStatusRefreshRef.current = now;
    void readLiveStatusSnapshot(process.cwd())
      .then((snapShot) => {
        setLiveStatus(snapShot);
      })
      .catch(() => undefined);
  };

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

  const searchMatches = useMemo(
    () => (transcriptSearch ? findTranscriptMatches(wrappedRows, transcriptSearch.query) : []),
    [transcriptSearch, wrappedRows],
  );
  const activeSearchRow =
    transcriptSearch && searchMatches.length > 0
      ? searchMatches[
          ((transcriptSearch.matchCursor % searchMatches.length) + searchMatches.length) %
            searchMatches.length
        ]
      : undefined;

  useEffect(() => {
    const delta = wrappedRows.length - prevRowCountRef.current;
    prevRowCountRef.current = wrappedRows.length;
    if (delta > 0 && offset > 0) setOffset((prev) => prev + delta);
  }, [wrappedRows.length, offset]);

  useEffect(() => {
    if (activeSearchRow === undefined) return;
    const half = Math.floor(stateRef.current.visible / 2);
    const targetOffset = Math.max(0, wrappedRows.length - activeSearchRow - half);
    setOffset(targetOffset);
  }, [activeSearchRow, wrappedRows.length]);

  useEffect(() => {
    if (bus.startup) refreshLiveStatus(false);
  }, [bus.version, bus.startup]);

  // Startup (header, session marker, pending approvals) + live event stream.
  useEffect(() => {
    let cancelled = false;
    void session
      .begin()
      .then((startup) => {
        if (cancelled) return;
        bus.setStartup(startup);
        session.startStream();
        refreshLiveStatus(true);
        refreshMentionsAndProjects();
      })
      .catch((error: unknown) => {
        if (!cancelled) bus.push(`startup: ${(error as Error).message}`);
      });
    return () => {
      cancelled = true;
      session.stopStream();
    };
  }, [session, bus]);

  const maybeOpenContextualPicker = async (
    submittedLine: string,
    genAtDispatch: number,
  ): Promise<void> => {
    const stillIdle = () => inputGenRef.current === genAtDispatch;
    const trimmed = submittedLine.trim();
    if (trimmed === '/models setup') {
      const rows_ = await listProviders().catch(() => []);
      if (!stillIdle() || rows_.length === 0) return;
      const items: PickerItem[] = rows_.map((p) => ({
        id: p.id,
        label: p.id,
        detail: `${p.baseUrl ?? '(--base-url required)'} · ${p.configured ? 'configured' : 'not configured'}`,
        command: `/models setup ${p.id}`,
      }));
      setPicker(
        createPicker(
          'provider',
          'Select Provider',
          items,
          '↑/↓ select · Enter configure · type /... or Esc to dismiss',
        ),
      );
      return;
    }
    if (trimmed === '/pending') {
      const root = await findProjectRoot(process.cwd()).catch(() => null);
      if (!root) return;
      const pending = await collectPendingApprovals(root).catch(() => []);
      if (!stillIdle() || pending.length === 0) return;
      const items: PickerItem[] = pending.map((item, idx) => ({
        id: item.id,
        label: `[${idx + 1}] ${item.kind}`,
        detail: item.summary,
        command: `/approve ${idx + 1}`,
      }));
      setPicker(
        createPicker(
          'pending',
          'Pending Approvals',
          items,
          '↑/↓ select · Enter approve · type /... or Esc to dismiss',
        ),
      );
      return;
    }
    if (trimmed === '/agent') {
      const root = await findProjectRoot(process.cwd()).catch(() => null);
      const { sessions } = await readAgentSessions(root).catch(() => ({ sessions: [] }));
      if (!stillIdle() || sessions.length === 0) return;
      const items: PickerItem[] = sessions.slice(0, 10).map((s) => ({
        id: s.sessionId,
        label: s.title || s.sessionId.slice(0, 14),
        detail: `${s.turns} turn(s) · ${s.scope}${s.lastFinish ? ` · ${s.lastFinish}` : ''}`,
        prefill: '/agent ',
      }));
      setPicker(
        createPicker(
          'session',
          'Agent Sessions (newest first)',
          items,
          '↑/↓ inspect · Enter starts /agent prompt · Esc close',
        ),
      );
      return;
    }
    if (trimmed === '/open') {
      const projects = await listRegisteredProjects().catch(() => []);
      if (!stillIdle() || projects.length === 0) return;
      const items: PickerItem[] = projects.map((p) => ({
        id: p.name,
        label: p.name,
        detail: p.root,
        command: `/open "${p.root}" --confirm`,
      }));
      setPicker(
        createPicker(
          'project',
          'Registered Projects',
          items,
          '↑/↓ select · Enter switch project · Esc close',
        ),
      );
    }
  };

  const dispatchCommand = (line: string): void => {
    if (line === '/') return;
    const genAtDispatch = inputGenRef.current;
    bus.push(`❯ ${line}`);
    setOffset(0);
    setBusy(true);
    queueRef.current = queueRef.current
      .then(async () => {
        const outcome = await session.submit(line);
        if (outcome === 'quit') {
          bus.push(QUIT_LINE);
          setTimeout(() => exit(0), 60);
          return;
        }
        await maybeOpenContextualPicker(line, genAtDispatch);
      })
      .catch((error: unknown) => {
        bus.push(`error: ${(error as Error).message}`);
      })
      .finally(() => {
        setBusy(false);
        refreshLiveStatus(true);
        refreshMentionsAndProjects();
      });
  };

  useInput((input, key) => {
    inputGenRef.current += 1;
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
    if (transcriptSearch) {
      if (key.escape || (key.ctrl && input === 'c') || input === '\x03') {
        setTranscriptSearch(null);
        return;
      }
      if (key.return || key.downArrow || (key.ctrl && input === 'f') || input === '\x06') {
        if (searchMatches.length > 0) {
          setTranscriptSearch((prev) =>
            prev ? { ...prev, matchCursor: (prev.matchCursor + 1) % searchMatches.length } : null,
          );
        }
        return;
      }
      if (key.upArrow) {
        if (searchMatches.length > 0) {
          setTranscriptSearch((prev) =>
            prev
              ? {
                  ...prev,
                  matchCursor: (prev.matchCursor - 1 + searchMatches.length) % searchMatches.length,
                }
              : null,
          );
        }
        return;
      }
      if (key.backspace || input === '\x7f' || input === '\b') {
        setTranscriptSearch((prev) =>
          prev ? { query: prev.query.slice(0, -1), matchCursor: 0 } : null,
        );
        return;
      }
      if (input && !key.ctrl && !key.meta && input !== '\t' && input !== '\r') {
        setTranscriptSearch((prev) =>
          prev ? { query: prev.query + input, matchCursor: 0 } : null,
        );
      }
      return;
    }

    if (picker) {
      if (key.upArrow) {
        setPicker((prev) => (prev ? movePicker(prev, -1) : null));
        return;
      }
      if (key.downArrow) {
        setPicker((prev) => (prev ? movePicker(prev, 1) : null));
        return;
      }
      if (key.escape) {
        setPicker(null);
        return;
      }
      if (key.return) {
        const chosen = selectedPickerItem(picker);
        setPicker(null);
        if (chosen?.command) {
          dispatchCommand(chosen.command);
        } else if (chosen?.prefill) {
          setSnap(engine.setLine(chosen.prefill));
          showToast(`selected ${chosen.id.slice(0, 12)}`);
        }
        return;
      }
      // Typing any other key automatically dismisses the picker and falls
      // through to the composer so the user is never trapped in an overlay.
      setPicker(null);
    }

    if (shortcutsOpen && (key.escape || input === '?')) {
      setShortcutsOpen(false);
      return;
    }

    const result = engine.handle(toEngineKey(input, key));
    if (result.searchTranscript) {
      setShortcutsOpen(false);
      setTranscriptSearch({ query: '', matchCursor: 0 });
      return;
    }
    if (result.toggleMouse) {
      const next = !mouseEnabled;
      setMouseEnabled(next);
      try {
        stdout.write(next ? '\x1b[?1000;1006h' : '\x1b[?1006l\x1b[?1000l');
      } catch {
        // ignore closed stream
      }
      showToast(next ? 'mouse: wheel scroll' : 'mouse: text selection');
      return;
    }
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
        .finally(() => {
          setBusy(false);
          refreshLiveStatus(true);
        });
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
      dispatchCommand(result.submit);
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

  const hairline = '─'.repeat(cols);
  const activeApproval = session.pendingApproval;
  const approvalReasonLines = activeApproval?.reason
    ? [`  ${truncateVisual(activeApproval.reason, Math.max(20, cols - 4))}`]
    : [];
  const touchesAnchor = Boolean(
    activeApproval?.reason &&
    /(?:papers|datasets|comparisons\/upstream)[/\\]/i.test(activeApproval.reason),
  );
  const approvalCardRows = activeApproval
    ? 4 + approvalReasonLines.length + (touchesAnchor ? 1 : 0)
    : 0;

  const composerInnerRows =
    session.secretPrompt || activeApproval || transcriptSearch
      ? 1
      : snap.historySearch
        ? 1
        : Math.max(1, Math.min(MAX_COMPOSER_LINES, snap.line.split('\n').length));
  const composerRows = activeApproval ? approvalCardRows : 2 + composerInnerRows;
  const footerRows = 1;
  const maxOverlayRows = Math.max(3, rows - headerRows - composerRows - footerRows - 2);
  const showPicker = !activeApproval && picker !== null && picker.items.length > 0;
  const shownPickerItems = showPicker ? picker.items.slice(0, Math.max(2, maxOverlayRows - 2)) : [];
  const showShortcutsPanel =
    !activeApproval && !showPicker && shortcutsOpen && maxOverlayRows >= SHORTCUT_ROWS.length + 1;
  const shownPalette =
    !activeApproval && !showPicker && !showShortcutsPanel && snap.paletteOpen
      ? snap.paletteOptions.slice(0, maxOverlayRows)
      : [];
  const paletteTruncated =
    !activeApproval &&
    !showPicker &&
    !showShortcutsPanel &&
    snap.paletteOpen &&
    snap.paletteOptions.length > shownPalette.length;
  const overlayRows = showPicker
    ? 2 + shownPickerItems.length
    : showShortcutsPanel
      ? 1 + SHORTCUT_ROWS.length
      : shownPalette.length > 0
        ? 1 + shownPalette.length + (paletteTruncated ? 1 : 0)
        : 0;

  stateRef.current.chromeRows = headerRows + overlayRows + composerRows + footerRows;
  const visible = Math.max(1, rows - stateRef.current.chromeRows);
  stateRef.current.visible = visible;
  const probeViewport = computeViewportSlice(wrappedRows.length, visible, offset);
  const contentRows = probeViewport.effOffset > 0 ? Math.max(1, visible - 1) : visible;
  const viewport = computeViewportSlice(wrappedRows.length, contentRows, offset);
  const pane = wrappedRows.slice(viewport.start, Math.max(viewport.start, viewport.end));

  const composerRenderRows = buildComposerRows(snap.line, snap.cursor, cols);
  const secretLabel = ` 🔐 ${session.secretPrompt?.label ?? ''}: `;
  const secretBullets = '•'.repeat(
    Math.min(secretBuf.length, Math.max(0, cols - visualWidth(secretLabel) - 2)),
  );

  const elapsed = busy && busyStartedAt ? ` ${formatElapsed(Date.now() - busyStartedAt)}` : '';
  const detailBadge = expandedDetails ? 'expanded · ' : '';
  const toastPart = toast ? `${toast} · ` : '';
  const telemetry = formatStatusTelemetry(liveStatus, Math.max(16, Math.floor(cols * 0.42)));
  const telemetrySuffix = telemetry ? ` · ${telemetry}` : '';
  const statusSegment = busy
    ? ` ${SPINNER[spin % SPINNER.length]} ${activeApproval ? 'waiting for approval…' : `running…${elapsed}`} · `
    : ` ${toastPart}${detailBadge}`;
  const badgeText = ` ${modeLabel.toUpperCase()} `;
  const footerTail = truncateVisual(
    `${statusSegment}${FOOTER_HINTS}${telemetrySuffix}`,
    Math.max(0, cols - visualWidth(badgeText)),
  );

  const paletteTitle =
    snap.paletteMode === 'mention'
      ? `─── @ Workspace Mention (Tab / ↑↓ pick) ${hairline}`
      : snap.paletteMode === 'arg'
        ? `─── Arguments (Tab / ↑↓ pick) ${hairline}`
        : hairline;

  const searchSummary = transcriptSearch
    ? searchMatches.length > 0
      ? `${(((transcriptSearch.matchCursor % searchMatches.length) + searchMatches.length) % searchMatches.length) + 1}/${searchMatches.length}`
      : transcriptSearch.query
        ? '0/0'
        : ''
    : '';

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
        {pane.map((row, index) => {
          const absIndex = viewport.start + index;
          const display =
            transcriptSearch && transcriptSearch.query
              ? highlightSearchMatches(
                  row.text,
                  transcriptSearch.query,
                  absIndex === activeSearchRow,
                  plain,
                )
              : row.text;
          return <Text key={`p-${absIndex}`}>{display}</Text>;
        })}
        {viewport.effOffset > 0 ? (
          <Text dimColor>
            {truncateVisual(
              `— scrolled up ${viewport.effOffset}/${viewport.totalRows} lines · ↓ / wheel down to follow —`,
              paneCols,
            )}
          </Text>
        ) : null}
      </Box>
      {showPicker && picker ? (
        <Box flexDirection="column" flexShrink={0}>
          <Text color="cyan" bold>
            {truncateVisual(`─── ${picker.title} ${hairline}`, cols)}
          </Text>
          {shownPickerItems.map((item, idx) => {
            const selected = idx === picker.selected;
            const left = padVisualEnd(
              selected ? ` › ${item.label}` : `   ${item.label}`,
              Math.min(28, Math.floor(cols * 0.4)),
            );
            const desc = truncateVisual(item.detail, Math.max(8, cols - visualWidth(left) - 1));
            return (
              <Box key={`pk-${item.id}`} flexDirection="row">
                <Text color={selected ? 'cyan' : undefined} bold={selected}>
                  {left}
                </Text>
                <Text color={selected ? 'white' : undefined} dimColor={!selected}>
                  {desc}
                </Text>
              </Box>
            );
          })}
          <Text dimColor>{truncateVisual(`   ${picker.hint}`, cols)}</Text>
        </Box>
      ) : showShortcutsPanel ? (
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
          <Text dimColor>{truncateVisual(paletteTitle, cols)}</Text>
          {shownPalette.map((opt, index) => {
            const selected = index === snap.paletteIndex;
            const colWidth =
              snap.paletteMode === 'command' ? 18 : Math.min(30, Math.floor(cols * 0.42));
            const left = padVisualEnd(selected ? ` › ${opt.label}` : `   ${opt.label}`, colWidth);
            const rightBudget = Math.max(8, cols - visualWidth(left) - 1);
            const desc = truncateVisual(opt.description, rightBudget);
            return (
              <Box key={`c-${opt.kind}-${opt.label}`} flexDirection="row">
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
                `   … ${snap.paletteOptions.length - shownPalette.length} more (↑/↓ to scroll)`,
                cols,
              )}
            </Text>
          ) : null}
        </Box>
      ) : null}
      {activeApproval ? (
        <Box flexDirection="column" flexShrink={0}>
          <Text color="yellow" bold>
            {truncateVisual(
              `┌─ ⏸ Tool Approval · allow ${activeApproval.toolName}? ${hairline}`,
              cols,
            )}
          </Text>
          {approvalReasonLines.map((reasonLine, idx) => (
            <Text key={`apr-${idx}`}>{reasonLine}</Text>
          ))}
          {touchesAnchor ? (
            <Text color="red" bold>
              {'  ⚠ touches provenance anchor path (papers/datasets/comparisons/upstream)'}
            </Text>
          ) : null}
          <Text backgroundColor="#3d3413" color="yellow" bold>
            {padVisualEnd(
              truncateVisual(
                `  allow ${activeApproval.toolName}? y allow once · n/Enter reject`,
                cols,
              ),
              cols,
            )}
          </Text>
          <Text color="yellow">{truncateVisual(`└${hairline}`, cols)}</Text>
        </Box>
      ) : (
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
          ) : transcriptSearch ? (
            <Text>
              <Text color="cyan" bold>
                {'Find: '}
              </Text>
              <Text>{transcriptSearch.query}</Text>
              <Text color="cyan">{cursorOn ? '▏' : ' '}</Text>
              <Text dimColor>
                {truncateVisual(
                  `  ${searchSummary ? `${searchSummary} · ` : ''}Enter/↓ next · ↑ prev · Esc close`,
                  Math.max(0, cols - 8 - visualWidth(transcriptSearch.query)),
                )}
              </Text>
            </Text>
          ) : snap.historySearch ? (
            <Text>
              <Text color="cyan" bold>
                {'(reverse-i-search) '}
              </Text>
              <Text>{`${snap.historySearch.query}: `}</Text>
              <Text color={snap.historySearch.match ? 'white' : 'red'}>
                {truncateVisual(
                  snap.historySearch.match ?? 'no matching command',
                  Math.max(8, cols - 24 - visualWidth(snap.historySearch.query)),
                )}
              </Text>
            </Text>
          ) : (
            composerRenderRows.map((row, idx) => (
              <Text key={`cmp-${idx}`}>
                <Text color="cyan" bold={idx === 0} dimColor={idx > 0}>
                  {row.prefix}
                </Text>
                {row.before}
                {row.hasCursor ? (
                  <Text color="cyan">
                    {busy ? SPINNER[spin % SPINNER.length] : cursorOn ? '▏' : ' '}
                  </Text>
                ) : null}
                {row.after}
              </Text>
            ))
          )}
          <Text dimColor>{hairline}</Text>
        </Box>
      )}
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
          <Text color={activeApproval ? 'yellow' : undefined} dimColor={!activeApproval}>
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
  const greeting = await probeWorkspaceGreeting(process.cwd()).catch(() => null);
  if (greeting) {
    for (const line of formatWelcomeLines(greeting, plain)) {
      bus.push(line);
    }
  }

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
