import { sha256Of } from '../core/hash.js';
import { IdeaseekError } from '../core/errors.js';
import { SCALE_FRACTIONS, type SliceScale, type DatasetSlice } from './slices.js';

/**
 * Declarative selection: the agent states WHAT structure to split on, the
 * platform computes the resulting partition.
 *
 * This is the generic replacement for field-specific fields. Nothing here
 * knows what a "domain", "modality", "subject" or "session" is — the agent
 * names a column that the measured corpus actually has, and the platform
 * validates that it exists. A column nobody measured is refused rather than
 * guessed, which is what keeps a hallucinated split from poisoning every
 * downstream result.
 */
export interface SelectionSpec {
  /** Agent-authored fold label. Display only; never parsed. */
  fold: string;
  /** Column (or directory level) held out as this fold's unseen evaluation set. */
  holdoutColumn: string | null;
  /** Values of holdoutColumn that form the evaluation set. */
  holdoutValues: string[];
  /** Column whose values become simulated clients; null = one client. */
  clientColumn: string | null;
  /** Column to balance the kept sample by; null = unstratified. */
  stratifyBy: string | null;
  seed: number;
}

/** Measured structure the spec is validated and expanded against. */
export interface MeasuredCorpus {
  columns: string[];
  /** Column → value counts, as measured by profiling (never assumed). */
  groups: Record<string, Record<string, number>>;
  samples: number;
  snapshotId: string;
}

export interface SelectionValidation {
  ok: boolean;
  errors: string[];
}

/**
 * Every column the spec names must exist in the measured corpus, and every
 * held-out value must be a value that was actually seen. Structure is checked;
 * meaning never is.
 */
export function validateSelectionSpec(
  spec: SelectionSpec,
  corpus: MeasuredCorpus,
): SelectionValidation {
  const errors: string[] = [];
  const named = [
    ['holdoutColumn', spec.holdoutColumn],
    ['clientColumn', spec.clientColumn],
    ['stratifyBy', spec.stratifyBy],
  ] as const;
  for (const [field, column] of named) {
    if (column === null) continue;
    if (!corpus.columns.includes(column)) {
      errors.push(
        `selection.${field} names column ${column ? JSON.stringify(column) : ''} which the ` +
          `measured corpus does not have (known: ${corpus.columns.join(', ') || 'none'})`,
      );
    }
  }
  if (spec.holdoutColumn && spec.holdoutValues.length === 0) {
    errors.push('selection.holdoutValues must be non-empty when holdoutColumn is set');
  }
  // holdoutColumn and clientColumn are legitimately the same column: in
  // group-held-out designs the clients ARE the remaining groups. What must not
  // happen is a held-out value also acting as a client, which the expansion
  // prevents by drawing clients only from the non-held-out values.
  const seen = spec.holdoutColumn ? corpus.groups[spec.holdoutColumn] : undefined;
  if (spec.holdoutColumn && seen) {
    const missing = spec.holdoutValues.filter((value) => !(value in seen));
    if (missing.length > 0) {
      errors.push(
        `selection.holdoutValues not present in measured ${spec.holdoutColumn}: ` +
          `${missing.join(', ')} (measured: ${Object.keys(seen).join(', ')})`,
      );
    }
  }
  if (!Number.isInteger(spec.seed)) {
    errors.push('selection.seed must be an integer (slices must be reproducible)');
  }
  return { ok: errors.length === 0, errors };
}

/** Canonical form so the same intent hashes identically across runs. */
export function canonicalSelection(spec: SelectionSpec): string {
  return JSON.stringify({
    holdoutColumn: spec.holdoutColumn,
    holdoutValues: [...spec.holdoutValues].sort(),
    clientColumn: spec.clientColumn,
    stratifyBy: spec.stratifyBy,
    seed: spec.seed,
  });
}

function groupValues(corpus: MeasuredCorpus, column: string | null): string[] {
  if (!column) return ['(single client)'];
  const counts = corpus.groups[column];
  if (!counts) return [];
  return Object.keys(counts).sort();
}

/**
 * Expands one spec into DatasetSlice records for the requested tiers.
 *
 * The slice is a rebuildable derived artifact: it records the selection rule,
 * the measured counts it implies, the seed and the boundary — it does not copy
 * the corpus. A training entry re-derives the identical partition from the rule
 * plus the seed, which is what makes the result reproducible without doubling
 * the disk.
 */
export function buildSelectionSlices(
  spec: SelectionSpec,
  corpus: MeasuredCorpus,
  opts: { tiers: SliceScale[]; generatedBy: string; now: number; protocolId: string | null },
): DatasetSlice[] {
  const validation = validateSelectionSpec(spec, corpus);
  if (!validation.ok) {
    throw new IdeaseekError(
      'USER_INPUT_REQUIRED',
      `selection spec does not match the measured corpus: ${validation.errors.join('; ')} — ` +
        're-measure with: ideaseek data describe, or correct the protocol slicing',
      { errors: validation.errors },
    );
  }
  const canonical = canonicalSelection(spec);
  const heldOut = new Set(spec.holdoutValues);
  const holdColumn = spec.holdoutColumn;
  const trainingGroups = holdColumn
    ? groupValues(corpus, holdColumn).filter((value) => !heldOut.has(value))
    : [];
  // When the client axis is the held-out column itself (the standard
  // group-held-out design) the unseen group must not also be a client, or the
  // rule would claim more clients than training actually sees.
  const clients =
    spec.clientColumn && spec.clientColumn === holdColumn
      ? trainingGroups
      : groupValues(corpus, spec.clientColumn);
  if (clients.length === 0) {
    throw new IdeaseekError(
      'USER_INPUT_REQUIRED',
      `selection.clientColumn ${JSON.stringify(spec.clientColumn)} has no measured values`,
    );
  }
  const perClientPool = holdColumn
    ? trainingGroups.reduce((sum, value) => sum + (corpus.groups[holdColumn]?.[value] ?? 0), 0)
    : corpus.samples;

  return opts.tiers.map((tier) => {
    const fraction = SCALE_FRACTIONS[tier];
    const selected = Math.min(perClientPool, Math.max(1, Math.round(perClientPool * fraction)));
    const rule =
      `${spec.holdoutColumn ? `leave-one-out on ${spec.holdoutColumn}` : 'whole corpus'}: ` +
      `evaluate on [${spec.holdoutValues.join(', ')}], train on [${trainingGroups.join(', ')}]` +
      `${spec.clientColumn ? `, ${clients.length} client(s) by ${spec.clientColumn}` : ''}` +
      `${spec.stratifyBy ? `, stratified by ${spec.stratifyBy}` : ''}, ${tier} tier ` +
      `(${fraction * 100}% of each client pool, seed ${spec.seed})`;
    // sha256Of already returns the `sha256:` prefix — wrapping it again made
    // every fold hash to the literal string "sha256" and collide on sliceId.
    const inputHash = sha256Of(
      `${canonical}|${corpus.snapshotId}|${opts.protocolId ?? 'unlocked'}|${spec.fold}`,
    );
    const outputHash = sha256Of(`${rule}|${selected}|${clients.length}`);
    return {
      sliceId: `ds-${corpus.snapshotId.replace(/^data-/, '').slice(0, 12)}-${tier}-${inputHash.slice(14, 20)}`,
      datasetSnapshotId: corpus.snapshotId,
      scale: tier,
      rule,
      ruleVersion: 2,
      inputHash,
      outputHash,
      stats: { totalRows: perClientPool, selectedRows: selected },
      seed: spec.seed,
      boundaries: spec.clientColumn
        ? [
            `${spec.clientColumn} (clients never share a sample)`,
            ...(spec.holdoutColumn ? [spec.holdoutColumn] : []),
          ]
        : ['row-level selection (no client boundary measured)'],
      generatedBy: opts.generatedBy,
      generatedAt: opts.now,
      limits: [
        `derived from a declarative selection spec; re-derive with seed ${spec.seed} to reproduce`,
        spec.holdoutColumn
          ? `held-out ${spec.holdoutColumn} values [${spec.holdoutValues.join(', ')}] must never enter training, validation or tuning`
          : 'no hold-out column: this slice does not test unseen groups',
      ],
      distributionCheck: {
        ok: true,
        warnings: spec.stratifyBy ? [] : [`unstratified ${tier} selection may skew class balance`],
      },
    };
  });
}
