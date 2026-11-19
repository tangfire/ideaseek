import { IdeaseekError } from '../core/errors.js';
import type { ExperimentDoc } from '../workflow/db.js';

/**
 * Cross-idea experiment leaderboard (design review #13a: the platform had
 * `experiment list` and the per-method `comparison matrix`, but no way to
 * compare idea-bound results against each other).
 *
 * Facts stay facts: rows come from the experiment registry, values from the
 * recorded RunResult, direction from each spec's MetricTarget, scale from
 * the spec. The judgment is ordering — which metric ranks and how values
 * sort — and it refuses to guess when the inputs make a ranking dishonest:
 * conflicting directions abort with an error, a metric nobody records is a
 * typo worth reporting, and when no metric is common to every succeeded
 * result the board degrades to a value table instead of inventing a common
 * denominator.
 */

export type MetricDirection = 'higher' | 'lower';

export interface RecordedMetric {
  name: string;
  value: number;
  stdev?: number;
  n?: number;
  /** Direction declared by this row's spec; null when the spec omits it. */
  direction: MetricDirection | null;
}

export interface LeaderboardRow {
  ideaId: string;
  specId: string;
  version: number;
  scale: string | null;
  updatedAt: number;
  /** Numeric metrics of the recorded result, in result order. */
  recorded: RecordedMetric[];
}

export interface RankedEntry {
  rank: number;
  ideaId: string;
  specId: string;
  version: number;
  value: number;
  stdev?: number;
  n?: number;
  scale: string | null;
  updatedAt: number;
}

export interface ExcludedEntry {
  ideaId: string;
  specId: string;
  status: string;
  /** Why it is not on the board: failure detail or a metric gap. */
  reason: string;
}

export interface Leaderboard {
  /** `ranked` when a metric was resolved; `table` when nothing is comparable. */
  mode: 'ranked' | 'table';
  /** Ranking metric; null in table mode. */
  metric: string | null;
  direction: MetricDirection | null;
  /** True when no --metric was given and the first common metric was chosen. */
  autoSelected: boolean;
  /** Metrics recorded AND declared by every succeeded row (first-row order). */
  commonMetrics: string[];
  /** Every metric name any succeeded row recorded (for --metric discovery). */
  availableMetrics: string[];
  /** Distinct scales across succeeded rows — mixed scales are flagged. */
  scales: string[];
  /** All succeeded idea-bound rows, ordered by ideaId (the raw facts). */
  rows: LeaderboardRow[];
  /** Ordering over `rows`; empty in table mode. Ties keep ideaId order. */
  ranked: RankedEntry[];
  /** Everything not ranked: failures, partials, metric gaps — with reasons. */
  notRanked: ExcludedEntry[];
}

interface ResultLike {
  status?: unknown;
  metrics?: unknown;
  failure?: { summary?: unknown };
}

function directionMapOf(spec: Record<string, unknown>): Map<string, MetricDirection> {
  const map = new Map<string, MetricDirection>();
  const metrics = Array.isArray(spec.metrics) ? spec.metrics : [];
  for (const entry of metrics) {
    const metric = entry as { name?: unknown; direction?: unknown };
    if (
      typeof metric.name === 'string' &&
      (metric.direction === 'higher' || metric.direction === 'lower')
    ) {
      map.set(metric.name, metric.direction);
    }
  }
  return map;
}

function numericMetrics(
  result: ResultLike,
  directions: Map<string, MetricDirection>,
): RecordedMetric[] {
  const out: RecordedMetric[] = [];
  const metrics = Array.isArray(result.metrics) ? result.metrics : [];
  for (const entry of metrics) {
    const metric = entry as { name?: unknown; value?: unknown; stdev?: unknown; n?: unknown };
    if (typeof metric.name !== 'string') continue;
    const value = Number(metric.value);
    if (!Number.isFinite(value)) continue; // schema guarantees numbers; never emit NaN into JSON
    out.push({
      name: metric.name,
      value,
      ...(typeof metric.stdev === 'number' && Number.isFinite(metric.stdev)
        ? { stdev: metric.stdev }
        : {}),
      ...(typeof metric.n === 'number' && Number.isFinite(metric.n) ? { n: metric.n } : {}),
      direction: directions.get(metric.name) ?? null,
    });
  }
  return out;
}

function exclusionOf(doc: ExperimentDoc, result: ResultLike | null): string {
  if (!result) return 'no recorded result (planned)';
  const status = typeof result.status === 'string' ? result.status : doc.status;
  if (status === 'failed') {
    const summary =
      typeof result.failure?.summary === 'string' ? result.failure.summary.slice(0, 120) : '';
    return summary ? `failed — ${summary}` : 'failed';
  }
  return status; // partial | invalid
}

function readScale(spec: Record<string, unknown>): string | null {
  return typeof spec.scale === 'string' && spec.scale ? spec.scale : null;
}

/**
 * Builds the leaderboard from registry docs. `metric` is the optional
 * `--metric` value; when absent the first metric common to every succeeded
 * result is auto-selected, and when none is common the board degrades to a
 * value table. Throws INVALID_ARGUMENT for a metric no succeeded result
 * records (a typo the user can fix) and for conflicting directions.
 */
export function buildLeaderboard(docs: ExperimentDoc[], metric?: string): Leaderboard {
  const rows: LeaderboardRow[] = [];
  const notRanked: ExcludedEntry[] = [];

  for (const doc of docs) {
    const idea = doc.spec.idea as { ideaId?: unknown } | null;
    if (!idea || typeof idea.ideaId !== 'string') continue; // baseline/protocol runs are not ideas
    const base = {
      ideaId: idea.ideaId,
      specId: doc.specId,
      version: doc.version,
      scale: readScale(doc.spec),
      updatedAt: doc.updatedAt,
    };
    const result = doc.result as ResultLike | null;
    if (doc.status !== 'succeeded' || !result || result.status !== 'succeeded') {
      notRanked.push({ ...base, status: doc.status, reason: exclusionOf(doc, result) });
      continue;
    }
    rows.push({
      ...base,
      recorded: numericMetrics(result, directionMapOf(doc.spec)),
    });
  }
  rows.sort((a, b) => a.ideaId.localeCompare(b.ideaId) || a.specId.localeCompare(b.specId));

  const availableSet = new Set<string>();
  const scales = new Set<string>();
  for (const row of rows) {
    for (const m of row.recorded) availableSet.add(m.name);
    if (row.scale) scales.add(row.scale);
  }
  const availableMetrics = [...availableSet];

  const empty: Leaderboard = {
    mode: 'table',
    metric: null,
    direction: null,
    autoSelected: false,
    commonMetrics: [],
    availableMetrics,
    scales: [...scales].sort(),
    rows,
    ranked: [],
    notRanked,
  };
  if (rows.length === 0) return empty;

  // Metrics every succeeded row both records and declares a direction for.
  let common: string[] = [];
  if (rows.length > 0) {
    common = rows[0]!.recorded
      .filter((m) => m.direction !== null)
      .map((m) => m.name)
      .filter((name) =>
        rows.every((row) => row.recorded.some((m) => m.name === name && m.direction !== null)),
      );
  }

  let chosen: string | null;
  let autoSelected = false;
  if (metric !== undefined) {
    if (!rows.some((row) => row.recorded.some((m) => m.name === metric))) {
      throw new IdeaseekError(
        'INVALID_ARGUMENT',
        `metric "${metric}" is not recorded by any succeeded idea result` +
          (availableMetrics.length > 0
            ? ` (available: ${availableMetrics.join(', ')})`
            : ' (no succeeded results carry metrics)'),
      );
    }
    chosen = metric;
  } else if (common.length > 0) {
    chosen = common[0]!;
    autoSelected = true;
  } else {
    return empty; // nothing comparable — the table speaks for itself
  }

  // Direction must be consistent among the rows being ranked; mixed
  // declarations would rank some values up and others down.
  const declaredDirections = new Set(
    rows
      .map((row) => row.recorded.find((m) => m.name === chosen))
      .filter((m): m is RecordedMetric => m !== undefined && m.direction !== null)
      .map((m) => m.direction),
  );
  if (declaredDirections.size > 1) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `metric "${chosen}" is declared with conflicting directions ` +
        `(${[...declaredDirections].join(', ')}) across idea specs — cannot rank honestly`,
    );
  }

  const direction = [...declaredDirections][0] ?? null;
  const ranked: RankedEntry[] = [];
  for (const row of rows) {
    const found = row.recorded.find((m) => m.name === chosen);
    if (!found) {
      notRanked.push({
        ideaId: row.ideaId,
        specId: row.specId,
        status: 'succeeded',
        reason: `metric "${chosen}" not in recorded result`,
      });
      continue;
    }
    if (found.direction === null) {
      notRanked.push({
        ideaId: row.ideaId,
        specId: row.specId,
        status: 'succeeded',
        reason: `metric "${chosen}" not declared by spec (no direction)`,
      });
      continue;
    }
    ranked.push({
      rank: 0, // assigned after sort
      ideaId: row.ideaId,
      specId: row.specId,
      version: row.version,
      value: found.value,
      ...(found.stdev !== undefined ? { stdev: found.stdev } : {}),
      ...(found.n !== undefined ? { n: found.n } : {}),
      scale: row.scale,
      updatedAt: row.updatedAt,
    });
  }

  // Stable sort: ties keep the ideaId order rows already carry.
  ranked.sort((a, b) => (direction === 'lower' ? a.value - b.value : b.value - a.value));
  ranked.forEach((entry, index) => {
    entry.rank = index + 1;
  });

  return {
    mode: 'ranked',
    metric: chosen,
    direction,
    autoSelected,
    commonMetrics: common,
    availableMetrics,
    scales: [...scales].sort(),
    rows,
    ranked,
    notRanked,
  };
}

/** Human rendering (house style: aligned, two-space indented, honest notes). */
export function formatLeaderboard(board: Leaderboard): string {
  const lines: string[] = [];
  if (board.rows.length === 0) {
    lines.push('no idea-bound experiment results recorded yet');
    lines.push('next: ideaseek idea run-ready   (or: ideaseek experiment plan <idea>)');
    return `${lines.join('\n')}\n`;
  }

  if (board.mode === 'ranked' && board.metric) {
    const commonNote = board.autoSelected ? ', first common metric' : '';
    if (board.ranked.length === 0) {
      lines.push(`leaderboard by ${board.metric}${commonNote}:`);
      lines.push('  no result can be ranked by this metric:');
      for (const entry of board.notRanked) {
        if (entry.status === 'succeeded') lines.push(`  ${entry.ideaId}: ${entry.reason}`);
      }
    } else {
      const arrow = board.direction === 'lower' ? 'lower is better' : 'higher is better';
      lines.push(`leaderboard by ${board.metric} (${arrow})${commonNote}:`);
      for (const entry of board.ranked) {
        const value =
          entry.value.toFixed(4) +
          (entry.stdev !== undefined ? ` ±${entry.stdev.toFixed(4)}` : '') +
          (entry.n !== undefined ? ` n=${entry.n}` : '');
        const scale = entry.scale ? ` ${entry.scale}` : '';
        lines.push(
          `  ${String(entry.rank).padStart(2)}. ${entry.ideaId.padEnd(24)} ${value.padStart(18)}  v${entry.version}${scale}`,
        );
      }
      if (board.scales.length > 1) {
        lines.push(
          `  note: mixed scales (${board.scales.join(', ')}) — values are not directly comparable`,
        );
      }
    }
  } else {
    lines.push(
      `no metric is common to all ${board.rows.length} succeeded result(s) — recorded values:`,
    );
    for (const row of board.rows) {
      const scale = row.scale ? ` ${row.scale}` : '';
      const values = row.recorded.map((m) => `${m.name}=${m.value.toFixed(4)}`).join(' ');
      lines.push(`  ${row.ideaId.padEnd(24)} v${row.version}${scale}  ${values || '(no metrics)'}`);
    }
    if (board.availableMetrics.length > 0) {
      lines.push(
        `available metrics: ${board.availableMetrics.join(', ')} — rank with: ideaseek experiment leaderboard --metric <name>`,
      );
    }
  }

  if (board.notRanked.length > 0) {
    lines.push('not ranked:');
    for (const entry of board.notRanked) {
      lines.push(`  ${entry.ideaId} (${entry.status}): ${entry.reason}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
