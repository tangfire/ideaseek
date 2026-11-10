/**
 * DatasetSlice contract (docs/DATA_CONTRACTS.md §DatasetSlice): exploration
 * slices are rebuildable derived artifacts over a read-only dataset
 * snapshot — they never modify originals, always record selection rules,
 * hashes, seed and boundary information, and are addressable by a stable
 * slice id so experiment results can cite exactly what data they ran on.
 */
export type SliceScale = 'smoke' | 'quick' | 'standard';

export interface SliceStats {
  totalRows: number;
  selectedRows: number;
  /** Per-column value counts when the source is tabular (CSV-like). */
  columns?: Record<string, number>;
}

export interface DatasetSlice {
  /** Stable id: ds-<snapshotHashPrefix>-<scale>-<ruleVersion>. */
  sliceId: string;
  datasetSnapshotId: string;
  scale: SliceScale;
  /** Selection rule description (machine + human readable). */
  rule: string;
  ruleVersion: number;
  inputHash: `sha256:${string}`;
  outputHash: `sha256:${string}`;
  stats: SliceStats;
  seed: number;
  /**
   * Boundary preservation notes: which grouping/time/subject boundary the
   * slice honors (e.g. "row-level random split, no groups present").
   */
  boundaries: string[];
  generatedBy: string;
  generatedAt: number;
  limits: string[];
  /** Distribution preservation vs the source (ok + human-readable warnings). */
  distributionCheck?: { ok: boolean; warnings: string[] };
}

/** Fraction of the dataset selected per scale (rule v1). */
export const SCALE_FRACTIONS: Record<SliceScale, number> = {
  smoke: 0.02,
  quick: 0.1,
  standard: 1.0,
};

export const SLICE_RULE_VERSION = 1;

export interface RowSelectionInput {
  scale: SliceScale;
  totalRows: number;
  seed: number;
}

export interface RowSelection {
  indices: number[];
  rule: string;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic row selection: seeded shuffle + fraction cut with a minimum
 * of 1 row (never silently empty) and `standard` selecting everything.
 * Row-level only in rule v1 — group/time boundaries are reported as limits
 * unless a domain adapter supplies a splitter (docs/DOMAIN_ADAPTERS.md).
 */
export function selectRows(input: RowSelectionInput): RowSelection {
  const fraction = SCALE_FRACTIONS[input.scale];
  const total = Math.max(0, Math.floor(input.totalRows));
  if (total === 0) return { indices: [], rule: `empty input (scale ${input.scale})` };

  const take =
    input.scale === 'standard' ? total : Math.max(1, Math.min(total, Math.round(total * fraction)));

  const order = Array.from({ length: total }, (_, index) => index);
  const random = mulberry32(input.seed);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const indices = order.slice(0, take).sort((a, b) => a - b);
  const rule =
    input.scale === 'standard'
      ? `all ${total} rows (scale=standard, rule v${SLICE_RULE_VERSION})`
      : `seeded shuffle(seed=${input.seed}) take ${indices.length}/${total} (scale=${input.scale}, ${Math.round(fraction * 100)}%, rule v${SLICE_RULE_VERSION})`;
  return { indices, rule };
}
