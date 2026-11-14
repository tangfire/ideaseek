import { sanitizeAnsiForInk, stripAnsi, truncateVisual, wrapAnsiLines } from '../text-width.js';

/**
 * Presentation helpers for the TUI activity/transcript pane:
 * - preserves safe ANSI SGR colors while stripping cursor/screen escapes;
 * - applies lightweight semantic highlighting to plain CLI/DSH lines so
 *   user turns, tool steps, persisted events, warnings and errors are
 *   instantly scannable instead of collapsing into flat white text;
 * - soft-wraps logical lines to the terminal's column width with per-line
 *   memoization so scrolling stays O(visible rows).
 */

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

// eslint-disable-next-line no-control-regex
const HAS_SGR_RE = /\x1B\[[0-9;]*m/;
const EVENT_LINE_RE = /^(\[\d{2}:\d{2}:\d{2}\])\s+(\S+)(.*)$/;

export interface WrappedRow {
  text: string;
  logicalIndex: number;
}

/**
 * Applies semantic SGR styling to an unstyled transcript line. Already-styled
 * lines (carrying SGR escapes from `paint()` or downstream tools) are kept as-is.
 */
export function styleTranscriptLine(rawLine: string, plain = false): string {
  const clean = sanitizeAnsiForInk(rawLine);
  if (plain || !clean || HAS_SGR_RE.test(clean)) return clean;

  const trimmed = clean.trimStart();
  if (clean.startsWith('❯ ')) {
    return `${BOLD}${CYAN}${clean}${RESET}`;
  }
  if (/^(?:error:|✗\s|FAIL\b|×\s)/i.test(trimmed) || /\bFAILED\b/.test(clean)) {
    return `${RED}${clean}${RESET}`;
  }
  if (/^(?:warning:|⚠|⏸\s|blocked\b)/i.test(trimmed)) {
    return `${YELLOW}${clean}${RESET}`;
  }
  if (trimmed.startsWith('⚙ ✓')) {
    return `${GREEN}${clean}${RESET}`;
  }
  if (trimmed.startsWith('⚙ ✗')) {
    return `${RED}${clean}${RESET}`;
  }
  if (trimmed.startsWith('⚙ ')) {
    return `${CYAN}${clean}${RESET}`;
  }
  if (trimmed.startsWith('→ approval allowed')) {
    return `${GREEN}${clean}${RESET}`;
  }
  if (trimmed.startsWith('→ approval rejected')) {
    return `${YELLOW}${clean}${RESET}`;
  }
  if (/^(?:next:|usage:|session →|last session:|supervisor \(| {2}· )/.test(clean)) {
    return `${DIM}${clean}${RESET}`;
  }
  const eventMatch = EVENT_LINE_RE.exec(clean);
  if (eventMatch) {
    const [, stamp, phase, rest] = eventMatch;
    const tone = /\b(failed|error)\b/i.test(rest ?? '')
      ? RED
      : /\b(blocked|waiting|stale)\b/i.test(rest ?? '')
        ? YELLOW
        : /\b(completed|succeeded|verified|validated)\b/i.test(rest ?? '')
          ? GREEN
          : '';
    return `${DIM}${stamp}${RESET} ${CYAN}${phase}${RESET}${tone ? `${tone}${rest}${RESET}` : rest}`;
  }
  return clean;
}

/**
 * Per-line wrapping cache keyed by `(styledText, width)`. Because historical
 * lines are immutable once pushed, only newly arrived lines (or width changes
 * on resize) pay the wrapping cost.
 */
export class TranscriptWrapCache {
  private cachedWidth = -1;
  private readonly lineCache = new Map<string, string[]>();

  wrapAll(lines: readonly string[], width: number, plain = false): WrappedRow[] {
    const targetWidth = Math.max(16, Math.floor(width));
    if (targetWidth !== this.cachedWidth) {
      this.lineCache.clear();
      this.cachedWidth = targetWidth;
    }

    const rows: WrappedRow[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i]!;
      const cacheKey = `${plain ? 'p' : 'c'}:${raw}`;
      let wrapped = this.lineCache.get(cacheKey);
      if (!wrapped) {
        const styled = styleTranscriptLine(raw, plain);
        wrapped = wrapAnsiLines(styled, targetWidth);
        if (this.lineCache.size > 10_000) this.lineCache.clear();
        this.lineCache.set(cacheKey, wrapped);
      }
      for (const row of wrapped) {
        rows.push({ text: row, logicalIndex: i });
      }
    }
    return rows;
  }
}

export interface ViewportSlice {
  start: number;
  end: number;
  effOffset: number;
  maxOffset: number;
  totalRows: number;
}

/** Computes the visible slice in wrapped visual-row coordinates. */
export function computeViewportSlice(
  totalRows: number,
  visibleRows: number,
  offset: number,
): ViewportSlice {
  const safeVisible = Math.max(1, visibleRows);
  const maxOffset = Math.max(0, totalRows - Math.min(safeVisible, totalRows));
  const effOffset = Math.min(Math.max(0, offset), maxOffset);
  const end = totalRows - effOffset;
  const start = Math.max(0, end - safeVisible);
  return { start, end, effOffset, maxOffset, totalRows };
}

/** Formats elapsed runtime compactly (e.g. `420ms`, `3.2s`, `1m 14s`). */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const rem = Math.round(secs % 60);
  return `${mins}m ${rem}s`;
}

/** Fits `footerText` cleanly to `maxCols` using visual column width. */
export function fitFooterHint(text: string, maxCols: number): string {
  if (maxCols <= 0) return '';
  if (stripAnsi(text).length <= maxCols) return truncateVisual(text, maxCols);
  return truncateVisual(text, maxCols);
}
