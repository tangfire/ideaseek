/**
 * Terminal display-width, grapheme segmentation, ANSI-safe truncation and soft
 * wrapping utilities.
 *
 * JavaScript `.length` counts UTF-16 code units rather than terminal columns:
 * CJK characters and emoji take 2 columns while ANSI SGR color sequences take
 * 0. Using `.length` for box padding, truncation or wrapping causes CJK input
 * and Chinese status/approval lines to overflow and break Ink's layout.
 */

const GRAPHEME_SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });

// Matches CSI sequences (`ESC [ ... @-~`) and OSC sequences (`ESC ] ... BEL/ST`).
// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCE_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\))/g;
// eslint-disable-next-line no-control-regex
const ANSI_TOKEN_RE = /(\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)))/g;
// Matches non-SGR ANSI control sequences (cursor motion, erase, alt-screen)
// while keeping color/style SGR (`...m`) intact.
// eslint-disable-next-line no-control-regex
const NON_SGR_ANSI_RE = /\x1B(?:\[[0-?]*[ -/]*[@-ln-~]|\][^\x07\x1B]*(?:\x07|\x1B\\))/g;
// eslint-disable-next-line no-control-regex
const SGR_RE = /^\x1B\[([0-9;]*)m$/;

const ZERO_WIDTH_RE =
  /^(?:\p{Mn}|\p{Me}|\p{Cf}|[\u{FE00}-\u{FE0F}]|\u{200B}|\u{200C}|\u{200D}|\u{2060})+$/u;
const WIDE_CODEPOINT_RE =
  /[\u{1100}-\u{115F}\u{231A}-\u{231B}\u{2329}-\u{232A}\u{23E9}-\u{23EC}\u{23F0}\u{23F3}\u{25FD}-\u{25FE}\u{2614}-\u{2615}\u{2648}-\u{2653}\u{267F}\u{2693}\u{26A1}\u{26AA}-\u{26AB}\u{26BD}-\u{26BE}\u{26C4}-\u{26C5}\u{26CE}\u{26D4}\u{26EA}\u{26F2}-\u{26F3}\u{26F5}\u{26FA}\u{26FD}\u{2705}\u{270A}-\u{270B}\u{2728}\u{274C}\u{274E}\u{2753}-\u{2755}\u{2757}\u{2795}-\u{2797}\u{27B0}\u{27BF}\u{2B1B}-\u{2B1C}\u{2B50}\u{2B55}\u{2E80}-\u{303E}\u{3040}-\u{33FF}\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{A000}-\u{A4CF}\u{A960}-\u{A97F}\u{AC00}-\u{D7AF}\u{F900}-\u{FAFF}\u{FE10}-\u{FE19}\u{FE30}-\u{FE6F}\u{FF01}-\u{FF60}\u{FFE0}-\u{FFE6}\u{1F004}\u{1F0CF}\u{1F18E}\u{1F191}-\u{1F19A}\u{1F1E6}-\u{1F1FF}\u{1F201}-\u{1F251}\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;

/** Removes all CSI and OSC ANSI sequences. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_SEQUENCE_RE, '');
}

/**
 * Removes dangerous terminal-control escapes (cursor moves, screen clears, alt
 * screen toggles) while keeping safe SGR color/emphasis codes (`ESC[...m`).
 */
export function sanitizeAnsiForInk(text: string): string {
  return text.replace(NON_SGR_ANSI_RE, '').replace(/\r\n?/g, '\n');
}

/** Terminal column width of a single grapheme cluster. */
export function graphemeWidth(grapheme: string): number {
  if (!grapheme) return 0;
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x1F\x7F]+$/.test(grapheme)) return 0;
  if (ZERO_WIDTH_RE.test(grapheme)) return 0;
  if (grapheme.includes('\u{FE0F}') || grapheme.includes('\u{200D}')) return 2;
  return WIDE_CODEPOINT_RE.test(grapheme) ? 2 : 1;
}

/** Exact terminal display column width (ignoring ANSI escape sequences). */
export function visualWidth(text: string): number {
  const plain = stripAnsi(text);
  let width = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(plain)) {
    width += graphemeWidth(segment);
  }
  return width;
}

/** Pads `text` with trailing spaces to reach `targetColumns` visual columns. */
export function padVisualEnd(text: string, targetColumns: number): string {
  const gap = targetColumns - visualWidth(text);
  return gap > 0 ? `${text}${' '.repeat(gap)}` : text;
}

/**
 * Slices plain text (no ANSI) from the right/around a column window, used to
 * keep a long single-line input cursor visible in narrow terminals.
 */
export function sliceVisualTail(text: string, maxColumns: number): string {
  if (maxColumns <= 0) return '';
  if (visualWidth(text) <= maxColumns) return text;
  const graphemes = Array.from(GRAPHEME_SEGMENTER.segment(text), (s) => s.segment);
  let width = 0;
  let start = graphemes.length;
  for (let i = graphemes.length - 1; i >= 0; i -= 1) {
    const w = graphemeWidth(graphemes[i]!);
    if (width + w > maxColumns) break;
    width += w;
    start = i;
  }
  return graphemes.slice(start).join('');
}

/**
 * Truncates `text` to `maxColumns` display columns, preserving ANSI SGR codes
 * and closing active styling before appending `ellipsis`.
 */
export function truncateVisual(text: string, maxColumns: number, ellipsis = '…'): string {
  if (!Number.isFinite(maxColumns) || maxColumns <= 0) return text;
  if (visualWidth(text) <= maxColumns) return text;
  const ellWidth = visualWidth(ellipsis);
  if (maxColumns <= ellWidth) {
    return maxColumns === 1 ? '…' : ellipsis.slice(0, maxColumns);
  }
  const budget = maxColumns - ellWidth;
  let width = 0;
  let out = '';
  let hasActiveSgr = false;

  for (const part of text.split(ANSI_TOKEN_RE)) {
    if (!part) continue;
    if (part.startsWith('\x1B')) {
      const sgr = SGR_RE.exec(part);
      if (sgr) {
        out += part;
        hasActiveSgr = sgr[1] !== '' && sgr[1] !== '0';
      }
      continue;
    }
    for (const { segment } of GRAPHEME_SEGMENTER.segment(part)) {
      const w = graphemeWidth(segment);
      if (width + w > budget) {
        return `${out}${hasActiveSgr ? '\x1b[0m' : ''}${ellipsis}`;
      }
      out += segment;
      width += w;
    }
  }
  return `${out}${hasActiveSgr ? '\x1b[0m' : ''}${ellipsis}`;
}

/**
 * Wraps `text` (preserving SGR colors across wrapped lines) into display lines
 * no wider than `maxColumns`. Words break at spaces when possible; long URLs,
 * paths and CJK runs wrap cleanly at grapheme boundaries so nothing is clipped.
 */
export function wrapAnsiLines(text: string, maxColumns: number): string[] {
  const limit = Math.max(8, Math.floor(maxColumns));
  const logicalLines = text.split('\n');
  const wrapped: string[] = [];

  for (const logical of logicalLines) {
    if (logical === '') {
      wrapped.push('');
      continue;
    }
    let activeSgr: string[] = [];
    let current = '';
    let currentWidth = 0;
    let lastSpaceOutLen = -1;
    let lastSpacePlain = false;

    const pushLine = (content: string) => {
      const reset = activeSgr.length > 0 ? '\x1b[0m' : '';
      wrapped.push(`${content}${reset}`);
    };
    const prefixActive = () => (activeSgr.length > 0 ? activeSgr.join('') : '');

    for (const part of logical.split(ANSI_TOKEN_RE)) {
      if (!part) continue;
      if (part.startsWith('\x1B')) {
        const sgr = SGR_RE.exec(part);
        if (!sgr) continue;
        current += part;
        const code = sgr[1] ?? '';
        if (code === '' || code === '0') activeSgr = [];
        else activeSgr.push(part);
        continue;
      }

      for (const { segment } of GRAPHEME_SEGMENTER.segment(part)) {
        const w = graphemeWidth(segment);
        if (currentWidth + w > limit && currentWidth > 0) {
          if (lastSpaceOutLen >= 0 && lastSpacePlain) {
            const head = current.slice(0, lastSpaceOutLen).replace(/\s+$/, '');
            const tail = current.slice(lastSpaceOutLen).replace(/^\s+/, '');
            pushLine(head);
            current = `${prefixActive()}${tail}`;
            currentWidth = visualWidth(tail);
            lastSpaceOutLen = -1;
            lastSpacePlain = false;
            if (currentWidth + w <= limit) {
              if (segment === ' ') {
                lastSpaceOutLen = current.length;
                lastSpacePlain = true;
              }
              current += segment;
              currentWidth += w;
              continue;
            }
          }
          pushLine(current);
          current = prefixActive();
          currentWidth = 0;
          lastSpaceOutLen = -1;
          lastSpacePlain = false;
          if (segment === ' ') continue;
        }
        if (segment === ' ') {
          lastSpaceOutLen = current.length;
          lastSpacePlain = true;
        }
        current += segment;
        currentWidth += w;
      }
    }

    wrapped.push(current);
  }

  return wrapped;
}
