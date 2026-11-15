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
/**
 * Usage events store their payload as JSON in the summary field, which made
 * the transcript print raw objects at the user: `[01:21:12] USAGE deepseek-…`
 * followed by `{"in":3193,"out":2242,"cost":null,...}`. The numbers are worth
 * showing; the wire format is not. Rendered here rather than at each writer so
 * `events`, `status` and the TUI all get the same line, and so older stored
 * records — which are append-only — display correctly too.
 */
function renderUsageSummary(summary: string): string | null {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(summary) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof payload.in !== 'number' && typeof payload.out !== 'number') return null;
  const parts = [`${payload.in ?? 0} in / ${payload.out ?? 0} out tokens`];
  if (typeof payload.cost === 'number') parts.push(`cost ${payload.cost}`);
  // Phrased to survive the 120-character event line cap: the first version
  // read "cost not computed (no rates configured)" and was cut mid-word.
  else parts.push('cost unset (no rates)');
  if (typeof payload.taskId === 'string') parts.push(`task ${payload.taskId}`);
  return `usage: ${parts.join(' · ')}`;
}

export function formatEventLine(event: RunEvent, opts: PaintOptions = {}): string {
  const parts: string[] = [`[${clockTime(event.ts)}]`];
  if (event.phase) parts.push(event.phase);
  if (event.role) parts.push(event.role);
  if (event.objectId) parts.push(`object=${event.objectId}`);
  if (event.status) parts.push(event.status);
  const raw = redactSecrets(event.summary);
  const readable =
    event.eventType === 'model_usage'
      ? (renderUsageSummary(raw) ?? raw.slice(0, 120))
      : raw.slice(0, 120);
  if (readable) parts.push(readable);
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
