/**
 * Literature-watch gate (design review #13: "no continuous literature
 * surveillance — synthesize/wiki are one-shot"). Each chain step is already
 * incremental on its own; what was missing is a single decision that says
 * whether ANY refresh work exists, so a cron/watchdog invocation can no-op
 * in milliseconds when nothing changed and open the chain when something did.
 *
 * The gate never lies in either direction:
 *  - a new/changed/removed input reopens it (input drift against the last
 *    recorded scan baseline);
 *  - work a previous run could not finish reopens it (unparsed papers;
 *    unextracted sources when a model is configured — keyless runs defer
 *    instead of looping);
 *  - outputs only a model-backed synthesize can produce count as missing
 *    only while a model is enabled, so a keyless project does not see the
 *    chain run on every tick just because research-map.md cannot exist yet.
 */

export const WATCH_CONTRACT = 'literature-watch-v1';

export type WatchReason =
  | 'forced'
  | 'first-run'
  | 'outputs-missing'
  | 'new-or-changed-inputs'
  | 'unprocessed-inputs'
  | 'no-change';

/** Outputs the deterministic refresh always produces (no model needed). */
export const DETERMINISTIC_OUTPUT_MARKERS: readonly string[] = [
  'knowledge/research-wiki/graph/edges.jsonl',
  'knowledge/research-material-assessment.json',
];

/** Outputs that only the model-backed synthesize step can produce. */
export const MODEL_OUTPUT_MARKERS: readonly string[] = ['knowledge/research-map.md'];

export const WATCH_OUTPUT_MARKERS: readonly string[] = [
  ...DETERMINISTIC_OUTPUT_MARKERS,
  ...MODEL_OUTPUT_MARKERS,
];

export interface WatchGateInput {
  force: boolean;
  /** An input manifest exists — a scan has recorded a baseline to diff. */
  hasBaseline: boolean;
  /** Markers missing that the CURRENT capabilities should already produce. */
  missing: string[];
  /** added + modified + removed inputs since the recorded baseline. */
  driftChanges: number;
  pendingIngest: number;
  pendingExtract: number;
  /** Model-backed extract/synthesize would actually run (not skipped). */
  modelEnabled: boolean;
}

export interface WatchDecision {
  changed: boolean;
  reason: WatchReason;
}

export function evaluateWatchGate(input: WatchGateInput): WatchDecision {
  if (input.force) return { changed: true, reason: 'forced' };
  if (!input.hasBaseline) return { changed: true, reason: 'first-run' };
  if (input.missing.length > 0) return { changed: true, reason: 'outputs-missing' };
  if (input.driftChanges > 0) return { changed: true, reason: 'new-or-changed-inputs' };
  if (input.pendingIngest > 0 || (input.pendingExtract > 0 && input.modelEnabled)) {
    return { changed: true, reason: 'unprocessed-inputs' };
  }
  return { changed: false, reason: 'no-change' };
}
