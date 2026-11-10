/**
 * Distribution preservation checks (docs/RESEARCH_INTEGRITY.md: 不得为追求
 * 短时结果破坏类别/时间分布). Compares a selected slice against the full
 * source per column: categorical top-share drift and numeric mean shift.
 * Deterministic and label-free — it works on every column, so it does not
 * depend on a confirmed label candidate. Warnings never silently pass:
 * callers must display them alongside the slice.
 */
export interface ColumnDrift {
  column: string;
  kind: 'categorical' | 'numeric';
  sourceValue: number;
  sliceValue: number;
  drift: number;
  severity: 'ok' | 'warning' | 'blocker';
  detail: string;
}

export interface DistributionReport {
  /** True when no blocker-level drift exists (warnings may still exist). */
  ok: boolean;
  drifts: ColumnDrift[];
  checkedAt: number;
}

export interface DistributionInput {
  header: string[];
  /** Full source rows (post header). */
  sourceRows: string[][];
  /** Row indices selected into the slice (as produced by selectRows). */
  selectedIndices: number[];
  now: number;
  /** Absolute drift above this share/normalized-shift is a warning. */
  warningThreshold?: number;
  /** Above this it is a blocker (distribution destroyed). */
  blockerThreshold?: number;
}

const CATEGORICAL_MAX_DISTINCT = 20;

function columnValues(rows: string[][], columnIndex: number): string[] {
  return rows.map((row) => (row[columnIndex] ?? '').trim());
}

function topShare(values: string[]): { top: string; share: number } | null {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value === '') continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let total = 0;
  for (const count of counts.values()) total += count;
  if (total === 0) return null;
  let best = '';
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return { top: best, share: bestCount / total };
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function std(values: number[], avg: number): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Compares slice vs source distributions column by column. Empty/constant
 * columns are skipped (nothing to preserve); numeric columns use a
 * standardized mean shift, categorical columns use top-category share drift.
 */
export function checkDistributionPreservation(input: DistributionInput): DistributionReport {
  const warning = input.warningThreshold ?? 0.1;
  const blocker = input.blockerThreshold ?? 0.3;
  const drifts: ColumnDrift[] = [];
  const sliceRows = input.selectedIndices
    .map((index) => input.sourceRows[index])
    .filter((row): row is string[] => row !== undefined);

  input.header.forEach((name, columnIndex) => {
    const sourceCol = columnValues(input.sourceRows, columnIndex);
    const sliceCol = columnValues(sliceRows, columnIndex);
    const distinct = new Set(sourceCol.filter((value) => value !== ''));
    if (distinct.size === 0 || sliceCol.length === 0) return;

    if (distinct.size <= CATEGORICAL_MAX_DISTINCT) {
      const sourceTop = topShare(sourceCol);
      const sliceTop = topShare(sliceCol);
      if (!sourceTop || !sliceTop) return;
      const drift = Math.abs(sourceTop.share - sliceTop.share);
      const severity = drift >= blocker ? 'blocker' : drift >= warning ? 'warning' : 'ok';
      drifts.push({
        column: name,
        kind: 'categorical',
        sourceValue: sourceTop.share,
        sliceValue: sliceTop.share,
        drift,
        severity,
        detail:
          severity === 'ok'
            ? `top category "${sourceTop.top}" share ${sourceTop.share.toFixed(2)} → ${sliceTop.share.toFixed(2)}`
            : `top category "${sourceTop.top}" share moved ${sourceTop.share.toFixed(2)} → ${sliceTop.share.toFixed(2)} (drift ${drift.toFixed(2)})`,
      });
      return;
    }

    const sourceNums = sourceCol.map(Number).filter((value) => Number.isFinite(value));
    const sliceNums = sliceCol.map(Number).filter((value) => Number.isFinite(value));
    if (sourceNums.length < sourceCol.length || sourceNums.length < 2) return;
    const sourceMean = mean(sourceNums)!;
    const sourceStd = std(sourceNums, sourceMean);
    const sliceMean = mean(sliceNums);
    if (sliceMean === null) return;
    if (sourceStd === 0) {
      const drift = Math.abs(sliceMean - sourceMean) > 0 ? 1 : 0;
      drifts.push({
        column: name,
        kind: 'numeric',
        sourceValue: sourceMean,
        sliceValue: sliceMean,
        drift,
        severity: drift > 0 ? 'warning' : 'ok',
        detail: `constant source mean ${sourceMean} vs slice mean ${sliceMean}`,
      });
      return;
    }
    const shift = Math.abs(sliceMean - sourceMean) / sourceStd;
    const severity = shift >= blocker ? 'blocker' : shift >= warning ? 'warning' : 'ok';
    drifts.push({
      column: name,
      kind: 'numeric',
      sourceValue: sourceMean,
      sliceValue: sliceMean,
      drift: shift,
      severity,
      detail:
        severity === 'ok'
          ? `mean shift ${shift.toFixed(2)}σ`
          : `mean moved ${sourceMean.toFixed(2)} → ${sliceMean.toFixed(2)} (${shift.toFixed(2)}σ)`,
    });
  });

  const ok = drifts.every((drift) => drift.severity !== 'blocker');
  return { ok, drifts, checkedAt: input.now };
}
