import { redactSecrets } from '../core/redact.js';
import type { RunEvent } from '../workflow/types.js';

/**
 * Terminal presentation helpers (docs/TERMINAL_UX.md). Colors are an
 * enhancement only: plain mode, non-TTY output and NO_COLOR never receive
 * escape sequences, and every rendered summary passes redactSecrets.
 */

export type ColorName = 'brand' | 'success' | 'warn' | 'error' | 'dim';

const CODES: Record<ColorName, string> = {
  brand: '\x1b[36m',
  success: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  dim: '\x1b[2m',
};
const RESET = '\x1b[0m';

export interface PaintOptions {
  plain?: boolean;
}

export function paint(text: string, color: ColorName, opts: PaintOptions = {}): string {
  const enabled =
    !opts.plain &&
    (process.stdout.isTTY === true || process.env.IDEASEEK_FORCE_COLOR === '1') &&
    !process.env.NO_COLOR &&
    process.env.TERM !== 'dumb';
  if (!enabled) return text;
  return `${CODES[color]}${text}${RESET}`;
}

function clockTime(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/**
 * One-line action summary for live/replayed RunEvents:
 * `[13:21:04] PAPER_ANALYSIS  PaperExtractor  paper=018  completed  18/42`
 * Summaries are redacted and length-capped; full logs live in artifacts.
 */
export function formatEventLine(event: RunEvent, opts: PaintOptions = {}): string {
  const parts: string[] = [`[${clockTime(event.ts)}]`];
  if (event.phase) parts.push(event.phase);
  if (event.role) parts.push(event.role);
  if (event.objectId) parts.push(`object=${event.objectId}`);
  if (event.status) parts.push(event.status);
  const summary = redactSecrets(event.summary).slice(0, 120);
  if (summary) parts.push(summary);
  const line = parts.join('  ');
  if (event.status === 'failed' || event.status === 'error') {
    return paint(line, 'error', opts);
  }
  if (event.status === 'succeeded' || event.status === 'completed') {
    return paint(line, 'success', opts);
  }
  if (event.status === 'blocked' || event.status === 'waiting') {
    return paint(line, 'warn', opts);
  }
  return line;
}

/** Machine-readable projection of an event (secret-free summaries). */
export function eventToJson(event: RunEvent): Record<string, unknown> {
  return {
    seq: event.seq,
    runId: event.runId,
    ts: event.ts,
    type: event.eventType,
    phase: event.phase,
    role: event.role,
    object: event.objectId,
    summary: redactSecrets(event.summary),
    status: event.status,
  };
}
