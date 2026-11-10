import type { DatasetSlice } from './slices.js';

/**
 * Deterministic leakage/validity checks (docs/WORKFLOW_SPEC.md §PROTOCOL_REVIEW,
 * docs/RESEARCH_INTEGRITY.md): the parts that can be verified without a
 * model — slice completeness, seed/rule provenance, train-overlap risk on
 * row-level splits, and cross-scale nesting (standard ⊇ quick ⊇ smoke when
 * generated with the same seed and rule version). Semantic checks (label
 * leakage, temporal causality) need the protocol/domain adapter and are
 * reported as pending, never silently passed.
 */
export type LeakageFindingSeverity = 'blocker' | 'warning' | 'info' | 'pending';

export interface LeakageFinding {
  check: string;
  severity: LeakageFindingSeverity;
  ok: boolean;
  detail: string;
}

export interface LeakageReport {
  ok: boolean;
  findings: LeakageFinding[];
  checkedAt: number;
}

export interface LeakageCheckInput {
  /** Slices generated for one dataset snapshot under one protocol. */
  slices: DatasetSlice[];
  /** Rule ids required by the locked protocol (empty = informational run). */
  requiredRules?: string[];
  now: number;
}

function byScale(slices: DatasetSlice[], scale: string): DatasetSlice | undefined {
  return slices.find((slice) => slice.scale === scale);
}

/**
 * Runs the deterministic check suite. `ok` is false only when a `blocker`
 * finding exists; `pending` items document what still needs model/adapter
 * verification so reports cannot claim full clearance early.
 */
export function checkLeakage(input: LeakageCheckInput): LeakageReport {
  const findings: LeakageFinding[] = [];
  const { slices, now } = input;

  if (slices.length === 0) {
    findings.push({
      check: 'slices-present',
      severity: 'blocker',
      ok: false,
      detail: 'no dataset slices to validate',
    });
    return { ok: false, findings, checkedAt: now };
  }

  const snapshotIds = new Set(slices.map((slice) => slice.datasetSnapshotId));
  findings.push({
    check: 'single-snapshot',
    severity: snapshotIds.size === 1 ? 'info' : 'blocker',
    ok: snapshotIds.size === 1,
    detail:
      snapshotIds.size === 1
        ? `all ${slices.length} slices derive from one snapshot`
        : `mixed snapshots in one protocol: ${[...snapshotIds].join(', ')}`,
  });

  const scales = new Set(slices.map((slice) => slice.scale));
  findings.push({
    check: 'scale-coverage',
    severity: scales.has('quick') ? 'info' : 'warning',
    ok: scales.has('quick'),
    detail: `scales present: ${[...scales].join(', ')}${scales.has('quick') ? '' : ' (quick missing)'}`,
  });

  // Provenance: every slice must carry input/output hashes and a rule version.
  for (const slice of slices) {
    const hasHashes =
      /^sha256:[0-9a-f]{64}$/.test(slice.inputHash) &&
      /^sha256:[0-9a-f]{64}$/.test(slice.outputHash);
    findings.push({
      check: `provenance:${slice.scale}`,
      severity: hasHashes ? 'info' : 'blocker',
      ok: hasHashes,
      detail: hasHashes
        ? `${slice.sliceId} records input/output hashes and rule v${slice.ruleVersion}`
        : `${slice.sliceId} is missing content hashes`,
    });
    if (slice.stats.selectedRows <= 0) {
      findings.push({
        check: `nonempty:${slice.scale}`,
        severity: 'blocker',
        ok: false,
        detail: `${slice.sliceId} selected 0 rows`,
      });
    }
    if (slice.stats.selectedRows > slice.stats.totalRows) {
      findings.push({
        check: `row-bounds:${slice.scale}`,
        severity: 'blocker',
        ok: false,
        detail: `${slice.sliceId} selected more rows than exist`,
      });
    }
  }

  // Same-seed nesting: with rule v1's deterministic shuffle, standard ⊇
  // quick ⊇ smoke must hold when seed and ruleVersion match.
  const seeds = new Set(slices.map((slice) => `${slice.seed}:${slice.ruleVersion}`));
  findings.push({
    check: 'uniform-seed-rule',
    severity: seeds.size === 1 ? 'info' : 'warning',
    ok: seeds.size === 1,
    detail:
      seeds.size === 1
        ? `one seed/rule generation (${[...seeds][0]})`
        : 'mixed seed or rule versions — cross-scale comparisons are not nested',
  });

  const smoke = byScale(slices, 'smoke');
  const quick = byScale(slices, 'quick');
  const standard = byScale(slices, 'standard');
  if (seeds.size === 1 && smoke && quick && standard) {
    // Row-level nesting cannot be re-derived from counts alone; compare via
    // selected-row counts as a conservative proxy plus rule text.
    const nested =
      smoke.stats.selectedRows <= quick.stats.selectedRows &&
      quick.stats.selectedRows <= standard.stats.selectedRows;
    findings.push({
      check: 'scale-nesting',
      severity: nested ? 'info' : 'warning',
      ok: nested,
      detail: nested
        ? `row counts nest: ${smoke.stats.selectedRows} ≤ ${quick.stats.selectedRows} ≤ ${standard.stats.selectedRows}`
        : `row counts do not nest: ${smoke.stats.selectedRows} vs ${quick.stats.selectedRows} vs ${standard.stats.selectedRows}`,
    });
  }

  // Row-level splits on grouped/sequential data are an inherent risk that
  // only a domain adapter can clear — always reported as pending.
  findings.push({
    check: 'group-time-boundary',
    severity: 'pending',
    ok: false,
    detail:
      'row-level rule v1 does not prove subject/group/time separation; a domain adapter must confirm boundaries before leakage-sensitive conclusions',
  });

  for (const rule of input.requiredRules ?? []) {
    findings.push({
      check: `required-rule:${rule}`,
      severity: 'pending',
      ok: false,
      detail: `protocol rule "${rule}" needs semantic verification (model/adapter), not yet executed`,
    });
  }

  const ok = findings.every((finding) => finding.severity !== 'blocker');
  return { ok, findings, checkedAt: now };
}
