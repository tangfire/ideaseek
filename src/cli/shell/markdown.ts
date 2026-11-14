import {
  padVisualEnd,
  stripAnsi,
  truncateVisual,
  visualWidth,
  wrapAnsiLines,
} from '../text-width.js';

/**
 * Lightweight terminal Markdown & Diff renderer (pure, zero dependencies).
 *
 * Converts headings, bullet/numbered lists, blockquotes, fenced code blocks,
 * unified diff hunks, Markdown pipe tables and inline formatting (`code`,
 * **bold**, *italic*, [label](url)) into clean ANSI-styled display lines
 * wrapped safely to the terminal's column width.
 */

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const ITALIC = '\x1b[3m';
const UNDERLINE = '\x1b[4m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';

export interface MarkdownRenderOptions {
  width: number;
  plain?: boolean;
}

function styleInline(text: string, plain: boolean): string {
  if (plain) {
    return text
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1');
  }
  return text
    .replace(/`([^`]+)`/g, `${CYAN}$1${RESET}`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${UNDERLINE}${CYAN}$1${RESET} ${DIM}($2)${RESET}`)
    .replace(/\*\*([^*]+)\*\*/g, `${BOLD}$1${RESET}`)
    .replace(/(^|[^\w*])\*([^*]+)\*(?=[^\w*]|$)/g, `$1${ITALIC}$2${RESET}`);
}

function styleDiffLine(line: string, plain: boolean): string {
  if (plain) return line;
  if (line.startsWith('+++') || line.startsWith('---')) return `${BOLD}${line}${RESET}`;
  if (line.startsWith('@@')) return `${CYAN}${line}${RESET}`;
  if (line.startsWith('+')) return `${GREEN}${line}${RESET}`;
  if (line.startsWith('-')) return `${RED}${line}${RESET}`;
  return line;
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  return /^\|?(\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?$/.test(trimmed);
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function renderTableBlock(rows: string[][], width: number, plain: boolean): string[] {
  if (rows.length === 0) return [];
  const colCount = Math.max(...rows.map((r) => r.length));
  if (colCount === 0) return [];

  const styledRows = rows.map((row) =>
    Array.from({ length: colCount }, (_, i) => styleInline(row[i] ?? '', plain)),
  );
  const rawWidths = Array.from({ length: colCount }, (_, col) =>
    Math.max(3, ...styledRows.map((row) => visualWidth(row[col] ?? ''))),
  );

  // Fit total table width (`colCount * 3 + 1` borders + padding) inside `width`.
  const borderOverhead = colCount * 3 + 1;
  const maxInner = Math.max(colCount * 3, width - borderOverhead);
  const totalDesired = rawWidths.reduce((sum, w) => sum + w, 0);
  const colWidths =
    totalDesired <= maxInner
      ? rawWidths
      : rawWidths.map((w) => Math.max(3, Math.floor((w / totalDesired) * maxInner)));

  const sep = (left: string, mid: string, right: string) =>
    `${left}${colWidths.map((w) => '─'.repeat(w + 2)).join(mid)}${right}`;
  const formatRow = (row: string[], header: boolean) => {
    const cells = row.map((cell, i) => {
      const target = colWidths[i] ?? 3;
      const fit = padVisualEnd(truncateVisual(cell, target), target);
      return header && !plain ? `${BOLD}${fit}${RESET}` : fit;
    });
    const bar = plain ? '|' : `${DIM}│${RESET}`;
    return `${bar} ${cells.join(` ${bar} `)} ${bar}`;
  };

  const out: string[] = [];
  out.push(plain ? sep('+', '+', '+') : `${DIM}${sep('┌', '┬', '┐')}${RESET}`);
  out.push(formatRow(styledRows[0]!, true));
  if (styledRows.length > 1) {
    out.push(plain ? sep('+', '+', '+') : `${DIM}${sep('├', '┼', '┤')}${RESET}`);
    for (let i = 1; i < styledRows.length; i += 1) {
      out.push(formatRow(styledRows[i]!, false));
    }
  }
  out.push(plain ? sep('+', '+', '+') : `${DIM}${sep('└', '┴', '┘')}${RESET}`);
  return out;
}

/**
 * Renders a Markdown document or assistant reply into display lines wrapped to
 * `opts.width` columns. Guarantees every output line fits within `opts.width`.
 */
export function renderMarkdownLines(text: string, opts: MarkdownRenderOptions): string[] {
  const width = Math.max(20, Math.floor(opts.width));
  const plain = opts.plain === true;
  const sourceLines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];

  let inFence = false;
  let fenceLang = '';
  let i = 0;

  while (i < sourceLines.length) {
    const raw = sourceLines[i]!;
    const trimmed = raw.trim();

    // Fenced code blocks: ```lang ... ```
    const fenceMatch = /^```(\S*)\s*$/.exec(trimmed);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceLang = fenceMatch[1] ?? '';
        const label = fenceLang ? ` ${fenceLang} ` : '';
        const ruleLen = Math.max(2, width - 2 - visualWidth(label));
        const header = `┌─${label}${'─'.repeat(ruleLen)}`;
        out.push(plain ? header : `${DIM}${header}${RESET}`);
      } else {
        inFence = false;
        fenceLang = '';
        const footer = `└${'─'.repeat(Math.max(2, width - 1))}`;
        out.push(plain ? footer : `${DIM}${footer}${RESET}`);
      }
      i += 1;
      continue;
    }

    if (inFence) {
      const codeWidth = Math.max(8, width - 2);
      const isDiff = fenceLang === 'diff' || fenceLang === 'patch';
      const wrapped = wrapAnsiLines(raw, codeWidth);
      const rail = plain ? '| ' : `${DIM}│${RESET} `;
      for (const line of wrapped) {
        const styled = isDiff ? styleDiffLine(line, plain) : line;
        out.push(`${rail}${styled}`);
      }
      i += 1;
      continue;
    }

    // Markdown pipe table: header row + `|---|---|` separator + body rows.
    if (
      trimmed.includes('|') &&
      i + 1 < sourceLines.length &&
      isTableSeparator(sourceLines[i + 1]!)
    ) {
      const tableRows: string[][] = [parseTableRow(raw)];
      i += 2; // skip header + separator
      while (i < sourceLines.length && sourceLines[i]!.trim().includes('|')) {
        tableRows.push(parseTableRow(sourceLines[i]!));
        i += 1;
      }
      out.push(...renderTableBlock(tableRows, width, plain));
      continue;
    }

    // Horizontal rule (`---`, `***`, `___`)
    if (/^(?:---+|\*\*\*+|___+)$/.test(trimmed)) {
      const rule = '─'.repeat(Math.min(width, 48));
      out.push(plain ? rule : `${DIM}${rule}${RESET}`);
      i += 1;
      continue;
    }

    // Headings (`# ...` through `#### ...`)
    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const level = heading[1]!.length;
      const body = styleInline(heading[2]!.trim(), plain);
      const prefix = level === 1 ? '' : level === 2 ? '▸ ' : '  ';
      const styled = plain
        ? `${prefix}${stripAnsi(body)}`
        : level <= 2
          ? `${BOLD}${CYAN}${prefix}${body}${RESET}`
          : `${BOLD}${prefix}${body}${RESET}`;
      out.push(...wrapAnsiLines(styled, width));
      i += 1;
      continue;
    }

    // Blockquotes (`> ...`)
    const quote = /^>\s?(.*)$/.exec(raw);
    if (quote) {
      const body = styleInline(quote[1] ?? '', plain);
      const rail = plain ? '> ' : `${DIM}│${RESET} `;
      const wrapped = wrapAnsiLines(plain ? body : `${DIM}${body}${RESET}`, Math.max(8, width - 2));
      for (const line of wrapped) out.push(`${rail}${line}`);
      i += 1;
      continue;
    }

    // Bullet lists (`- `, `* `, `+ `) with hanging indentation.
    const bullet = /^(\s*)[-*+]\s+(.+)$/.exec(raw);
    if (bullet) {
      const indent = ' '.repeat(Math.min(6, bullet[1]!.length));
      const marker = plain ? `${indent}- ` : `${indent}${CYAN}•${RESET} `;
      const contIndent = ' '.repeat(visualWidth(indent) + 2);
      const body = styleInline(bullet[2]!, plain);
      const wrapped = wrapAnsiLines(body, Math.max(8, width - visualWidth(contIndent)));
      wrapped.forEach((line, idx) => {
        out.push(`${idx === 0 ? marker : contIndent}${line}`);
      });
      i += 1;
      continue;
    }

    // Ordered lists (`1. `, `2. `) with hanging indentation. Keep `N. ` free of
    // inline ANSI escapes so numbered prompts (e.g. `1. deepseek`) stay contiguous.
    const ordered = /^(\s*)(\d+)\.\s+(.+)$/.exec(raw);
    if (ordered) {
      const indent = ' '.repeat(Math.min(6, ordered[1]!.length));
      const numLabel = `${ordered[2]}. `;
      const marker = `${indent}${numLabel}`;
      const contIndent = ' '.repeat(visualWidth(indent) + numLabel.length);
      const body = styleInline(ordered[3]!, plain);
      const wrapped = wrapAnsiLines(body, Math.max(8, width - visualWidth(contIndent)));
      wrapped.forEach((line, idx) => {
        out.push(`${idx === 0 ? marker : contIndent}${line}`);
      });
      i += 1;
      continue;
    }

    // Blank line
    if (!trimmed) {
      out.push('');
      i += 1;
      continue;
    }

    // Ordinary paragraph line with inline styling + soft wrap.
    out.push(...wrapAnsiLines(styleInline(raw, plain), width));
    i += 1;
  }

  // Close unclosed fence gracefully on incomplete/streamed chunks.
  if (inFence) {
    const footer = `└${'─'.repeat(Math.max(2, width - 1))}`;
    out.push(plain ? footer : `${DIM}${footer}${RESET}`);
  }

  return out;
}
