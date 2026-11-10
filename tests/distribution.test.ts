import { describe, expect, it } from 'vitest';
import { checkDistributionPreservation } from '../src/experiment/distribution.js';

const HEADER = ['id', 'label', 'score'];
// 20 rows: labels balanced 10/10, scores around 50.
const SOURCE = Array.from({ length: 20 }, (_, i) => [
  String(i + 1),
  i % 2 === 0 ? '0' : '1',
  String(50 + (i % 5)),
]);

describe('checkDistributionPreservation', () => {
  it('passes when the slice mirrors the source', () => {
    const report = checkDistributionPreservation({
      header: HEADER,
      sourceRows: SOURCE,
      selectedIndices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], // 5/5 labels
      now: 1,
    });
    expect(report.ok).toBe(true);
    const label = report.drifts.find((drift) => drift.column === 'label')!;
    expect(label.kind).toBe('categorical');
    expect(label.drift).toBeCloseTo(0, 5);
    expect(label.severity).toBe('ok');
  });

  it('flags categorical imbalance as warning or blocker', () => {
    // Slice of only label=0 rows → top share moves 0.5 → 1.0 (drift 0.5).
    const report = checkDistributionPreservation({
      header: HEADER,
      sourceRows: SOURCE,
      selectedIndices: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18],
      now: 2,
    });
    const label = report.drifts.find((drift) => drift.column === 'label')!;
    expect(label.drift).toBeCloseTo(0.5, 5);
    expect(label.severity).toBe('blocker');
    expect(report.ok).toBe(false);
    expect(label.detail).toContain('drift');
  });

  it('flags numeric mean shift in sigma units', () => {
    // High-cardinality numeric column (more than 20 distinct values).
    const rows = Array.from({ length: 40 }, (_, i) => [String(100 + i)]);
    const report = checkDistributionPreservation({
      header: ['score'],
      sourceRows: rows,
      selectedIndices: rows.map((_, i) => i).filter((i) => i < 5), // low values only
      now: 3,
    });
    const score = report.drifts[0]!;
    expect(score.kind).toBe('numeric');
    expect(score.drift).toBeGreaterThan(0);
    expect(['ok', 'warning', 'blocker']).toContain(score.severity);
    expect(score.severity).not.toBe('ok'); // slice is all-low: shift is large
  });

  it('skips empty and all-empty columns without findings', () => {
    const report = checkDistributionPreservation({
      header: ['empty', 'id'],
      sourceRows: SOURCE.map(() => ['', 'x']),
      selectedIndices: [0, 1],
      now: 4,
    });
    const empty = report.drifts.find((drift) => drift.column === 'empty');
    expect(empty).toBeUndefined();
    expect(report.ok).toBe(true);
  });

  it('handles an empty selection gracefully', () => {
    const report = checkDistributionPreservation({
      header: HEADER,
      sourceRows: SOURCE,
      selectedIndices: [],
      now: 5,
    });
    expect(report.ok).toBe(true);
    expect(report.drifts).toHaveLength(0); // nothing to compare
  });
});
