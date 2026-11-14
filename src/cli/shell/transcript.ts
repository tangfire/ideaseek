import { renderMarkdownLines } from './markdown.js';
import { sanitizeAnsiForInk, stripAnsi, truncateVisual, wrapAnsiLines } from '../text-width.js';

/**
 * Structured transcript & presentation helpers for the Ink TUI:
 * - models entries as typed blocks (user, tool, event, approval, error,
 *   diagnostic, divider, output) instead of a flat string[] dump;
 * - pairs live `⚙ <tool> <args>` calls with `⚙ ✓ <tool>` / `⚙ ✗ <tool>`
 *   completion updates in-place with elapsed duration;
 * - hides noisy runtime diagnostics (`· dsh runtime started`, raw usage lines)
 *   behind `Ctrl+O` compact/expanded details toggle while keeping errors,
 *   approvals, tool steps and assistant replies crystal clear;
 * - renders Markdown / code fences / diffs / tables inside assistant and
 *   command output blocks, soft-wrapped with per-block caching.
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
const TOOL_CALL_RE = /^\s*⚙\s+([^\s✓✗]+)(?:\s+(.*))?$/;
const TOOL_RESULT_RE = /^\s*⚙\s+([✓✗])\s+(\S+)(?:\s+—\s+(.*))?$/;

export type TranscriptBlockKind =
  'banner' | 'user' | 'tool' | 'event' | 'approval' | 'error' | 'diagnostic' | 'divider' | 'output';

export interface TranscriptBlock {
  id: number;
  kind: TranscriptBlockKind;
  text: string;
  /** Tool-specific state when `kind === 'tool'`. */
  toolName?: string;
  toolArgs?: string;
  toolStatus?: 'running' | 'ok' | 'error';
  toolError?: string;
  startedAt?: number;
  finishedAt?: number;
  /** Version bumped whenever a block mutates (e.g. running → ok). */
  rev: number;
}

export interface WrappedRow {
  text: string;
  blockId: number;
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

/** Summarizes JSON or CLI tool arguments into a concise inline preview. */
function summarizeToolArgs(rawArgs: string, maxCols = 64): string {
  const compact = rawArgs.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  try {
    const parsed = JSON.parse(compact) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const pairs = Object.entries(parsed)
        .slice(0, 3)
        .map(([k, v]) => {
          const val = typeof v === 'string' ? v : JSON.stringify(v);
          return `${k}=${val}`;
        });
      const joined = pairs.join(' ');
      return truncateVisual(joined, maxCols);
    }
  } catch {
    // non-JSON argument summary — keep raw compact form
  }
  return truncateVisual(compact, maxCols);
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
 * Classifies an incoming line into a structured block kind. Keeps existing
 * line-based callers (`InteractiveSession.submit` / `runCli`) working while
 * letting the TUI group, style, collapse and copy intelligently.
 */
export function classifyLineKind(cleanLine: string): TranscriptBlockKind {
  const plain = stripAnsi(cleanLine);
  const trimmed = plain.trimStart();
  if (plain.startsWith('❯ ')) return 'user';
  if (TOOL_CALL_RE.test(plain) || TOOL_RESULT_RE.test(plain)) return 'tool';
  if (/^(?:⏸|→ approval )/.test(trimmed)) return 'approval';
  if (/^(?:error:|✗\s|FAIL\b|×\s)/i.test(trimmed)) return 'error';
  if (EVENT_LINE_RE.test(plain)) return 'event';
  if (/^(?: {2}· |next: ideaseek agent |agent turn → session )/.test(plain)) return 'diagnostic';
  if (/^usage:\s+\d+\s+in\s+\/\s+\d+\s+out\s+tokens/.test(trimmed)) return 'diagnostic';
  return 'output';
}

function formatToolBlockLines(
  block: TranscriptBlock,
  width: number,
  plain: boolean,
  expanded: boolean,
): string[] {
  const name = block.toolName ?? 'tool';
  const args = block.toolArgs ?? '';
  const elapsed =
    block.finishedAt !== undefined && block.startedAt !== undefined
      ? ` (${formatElapsed(block.finishedAt - block.startedAt)})`
      : '';

  if (block.toolStatus === 'running') {
    const line = `  ⚙ ${name}${args ? ` ${args}` : ''}`;
    return wrapAnsiLines(plain ? line : `${CYAN}${line}${RESET}`, width);
  }
  if (block.toolStatus === 'ok') {
    const preview = expanded ? args : summarizeToolArgs(args, Math.max(20, width - 24));
    const head = `  ⚙ ✓ ${name}`;
    const tail = `${preview ? `  ${preview}` : ''}${elapsed}`;
    const line = plain ? `${head}${tail}` : `${GREEN}${head}${RESET}${DIM}${tail}${RESET}`;
    return wrapAnsiLines(line, width);
  }
  const errTail = block.toolError ? ` — ${block.toolError}` : '';
  const preview = expanded && args ? `  ${args}` : '';
  const line = `  ⚙ ✗ ${name}${errTail}${preview}${elapsed}`;
  return wrapAnsiLines(plain ? line : `${RED}${line}${RESET}`, width);
}

function looksLikeMarkdown(text: string): boolean {
  return /(?:^#{1,4}\s|^```|^[-*+]\s|^\d+\.\s|^>\s|\*\*[^*]+\*\*|`[^`]+`|\|[^|]+\|)/m.test(text);
}

/**
 * Per-block rendering and wrapping cache keyed by `(blockId, rev, width, plain, expanded)`.
 * Historical blocks remain immutable once finalized, keeping re-renders O(visible).
 */
export class TranscriptWrapCache {
  private cachedSignature = '';
  private readonly blockCache = new Map<string, string[]>();

  renderBlocks(
    blocks: readonly TranscriptBlock[],
    width: number,
    opts: { plain?: boolean; expanded?: boolean } = {},
  ): WrappedRow[] {
    const targetWidth = Math.max(16, Math.floor(width));
    const plain = opts.plain === true;
    const expanded = opts.expanded === true;
    const sig = `${targetWidth}:${plain ? 'p' : 'c'}:${expanded ? 'e' : 'm'}`;
    if (sig !== this.cachedSignature) {
      this.blockCache.clear();
      this.cachedSignature = sig;
    }

    const rows: WrappedRow[] = [];
    for (let i = 0; i < blocks.length; i += 1) {
      const block = blocks[i]!;
      // Compact mode hides verbose internal runtime scaffolding lines while
      // preserving all tool cards, approvals, errors, events and responses.
      if (!expanded && block.kind === 'diagnostic') continue;

      const cacheKey = `${block.id}:${block.rev}`;
      let rendered = this.blockCache.get(cacheKey);
      if (!rendered) {
        rendered = this.renderSingleBlock(block, targetWidth, plain, expanded);
        if (this.blockCache.size > 10_000) this.blockCache.clear();
        this.blockCache.set(cacheKey, rendered);
      }

      // Add subtle visual breathing room before a user prompt (when not at top).
      if (block.kind === 'user' && rows.length > 0 && rows[rows.length - 1]?.text !== '') {
        rows.push({ text: '', blockId: block.id });
      }
      for (const line of rendered) {
        rows.push({ text: line, blockId: block.id });
      }
    }
    return rows;
  }

  private renderSingleBlock(
    block: TranscriptBlock,
    width: number,
    plain: boolean,
    expanded: boolean,
  ): string[] {
    switch (block.kind) {
      case 'banner': {
        // Keep the ASCII wordmark unsplit on single line when it fits, else wrap.
        return wrapAnsiLines(plain ? block.text : `${CYAN}${block.text}${RESET}`, width);
      }
      case 'divider': {
        const label = block.text ? ` ${block.text} ` : '';
        const side = Math.max(2, Math.floor((width - stripAnsi(label).length) / 2));
        const rule = `${'─'.repeat(side)}${label}${'─'.repeat(side)}`;
        const fit = truncateVisual(rule, width);
        return [plain ? fit : `${DIM}${fit}${RESET}`];
      }
      case 'tool': {
        return formatToolBlockLines(block, width, plain, expanded);
      }
      case 'user': {
        return wrapAnsiLines(styleTranscriptLine(block.text, plain), width);
      }
      case 'output': {
        const clean = sanitizeAnsiForInk(block.text);
        if (!HAS_SGR_RE.test(clean) && looksLikeMarkdown(clean)) {
          return renderMarkdownLines(clean, { width, plain });
        }
        return wrapAnsiLines(styleTranscriptLine(clean, plain), width);
      }
      default: {
        return wrapAnsiLines(styleTranscriptLine(block.text, plain), width);
      }
    }
  }

  /** Backward-compatible helper for string[] callers and unit tests. */
  wrapAll(lines: readonly string[], width: number, plain = false): WrappedRow[] {
    const blocks: TranscriptBlock[] = lines.map((text, idx) => ({
      id: idx + 1,
      kind: 'output',
      text,
      rev: 0,
    }));
    return this.renderBlocks(blocks, width, { plain, expanded: true });
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

/** Fits `footerText` cleanly to `maxCols` using visual column width. */
export function fitFooterHint(text: string, maxCols: number): string {
  if (maxCols <= 0) return '';
  return truncateVisual(text, maxCols);
}

/** Finds wrapped visual row indices matching `query` (case-insensitive). */
export function findTranscriptMatches(rows: readonly WrappedRow[], query: string): number[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: number[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (stripAnsi(rows[i]!.text).toLowerCase().includes(needle)) {
      matches.push(i);
    }
  }
  return matches;
}

/**
 * Highlights case-insensitive occurrences of `query` in `line` without
 * splitting ANSI escape sequences.
 */
export function highlightSearchMatches(
  line: string,
  query: string,
  isActiveRow: boolean,
  plain = false,
): string {
  const needle = query.trim();
  if (!needle || plain) return line;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped, 'gi');
  const hlOpen = isActiveRow ? '\x1b[43m\x1b[30m' : '\x1b[4m\x1b[33m';
  const hlClose = isActiveRow ? '\x1b[49m\x1b[39m' : '\x1b[24m\x1b[39m';
  // Split around ANSI escape tokens so regex never touches CSI parameters.
  // eslint-disable-next-line no-control-regex
  const parts = line.split(/(\x1B\[[0-?]*[ -/]*[@-~])/g);
  return parts
    .map((part) =>
      part.startsWith('\x1B') ? part : part.replace(re, (m) => `${hlOpen}${m}${hlClose}`),
    )
    .join('');
}

export { TOOL_CALL_RE, TOOL_RESULT_RE };
