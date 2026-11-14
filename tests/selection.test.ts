import { describe, expect, it } from 'vitest';
import type { SliceScale } from '../src/experiment/slices.js';
import {
  buildSelectionSlices,
  canonicalSelection,
  validateSelectionSpec,
  type MeasuredCorpus,
  type SelectionSpec,
} from '../src/experiment/selection.js';

/**
 * Declarative selection (docs/DATA_CONTRACTS.md): the agent names structure,
 * the platform expands it. These cases exist to prove the mechanism carries no
 * field-specific vocabulary — the same code serves "just take 10%" and a
 * four-fold leave-one-group-out design.
 */

const PACS: MeasuredCorpus = {
  columns: ['image', 'domain', 'label'],
  groups: {
    domain: { art_painting: 2048, cartoon: 2344, photo: 1670, sketch: 3929 },
    label: { '0': 1729, '1': 1654, '2': 1566, '3': 1113, '4': 1540, '5': 943, '6': 1446 },
  },
  samples: 9991,
  snapshotId: 'data-4fc041ee92ee',
};

const CSV_LIKE: MeasuredCorpus = {
  columns: ['age', 'income', 'churn'],
  groups: { churn: { '0': 3000, '1': 1000 } },
  samples: 4000,
  snapshotId: 'data-abcdef012345',
};

function spec(over: Partial<SelectionSpec> = {}): SelectionSpec {
  return {
    fold: 'photo held out',
    holdoutColumn: 'domain',
    holdoutValues: ['photo'],
    clientColumn: 'domain',
    stratifyBy: 'label',
    seed: 42,
    ...over,
  };
}

const TIERS: {
  tiers: SliceScale[];
  generatedBy: string;
  now: number;
  protocolId: string | null;
} = {
  tiers: ['smoke', 'quick', 'standard'],
  generatedBy: 'test',
  now: 1000,
  protocolId: 'proto-1',
};

describe('validateSelectionSpec (structure only, never semantics)', () => {
  it('accepts a spec whose columns and values were actually measured', () => {
    expect(validateSelectionSpec(spec(), PACS)).toEqual({ ok: true, errors: [] });
  });

  it('refuses a column the corpus does not have, and lists what does', () => {
    const result = validateSelectionSpec(spec({ holdoutColumn: 'scene' }), PACS);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('does not have');
    expect(result.errors.join(' ')).toContain('image, domain, label');
  });

  it('refuses a held-out value that was never measured', () => {
    const result = validateSelectionSpec(spec({ holdoutValues: ['xray'] }), PACS);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('not present in measured domain');
    expect(result.errors.join(' ')).toContain('art_painting');
  });

  it('allows clients to be the remaining groups of the held-out column', () => {
    // The standard group-held-out design: domain is both the client axis and
    // the held-out axis, with the held-out value excluded from the clients.
    expect(validateSelectionSpec(spec({ clientColumn: 'domain' }), PACS).ok).toBe(true);
    const slices = buildSelectionSlices(spec(), PACS, TIERS);
    expect(slices[0]!.rule).toContain('3 client(s) by domain');
    expect(slices[0]!.rule).not.toContain('evaluate on [photo], train on [photo]');
  });

  it('requires a non-empty holdout list and an integer seed', () => {
    expect(validateSelectionSpec(spec({ holdoutValues: [] }), PACS).ok).toBe(false);
    expect(validateSelectionSpec(spec({ seed: 4.5 }), PACS).ok).toBe(false);
  });
});

describe('buildSelectionSlices', () => {
  it('expands one leave-one-group-out fold into the three tiers', () => {
    const slices = buildSelectionSlices(spec(), PACS, TIERS);
    expect(slices.map((slice) => slice.scale)).toEqual(['smoke', 'quick', 'standard']);
    // Training pool excludes the held-out domain: 9991 - 1670.
    expect(slices[0]!.stats.totalRows).toBe(8321);
    expect(slices[0]!.stats.selectedRows).toBe(166); // 2%
    expect(slices[1]!.stats.selectedRows).toBe(832); // 10%
    expect(slices[2]!.stats.selectedRows).toBe(8321); // 100%
    expect(slices[0]!.seed).toBe(42);
    expect(slices[0]!.boundaries).toContain('domain');
    expect(slices[0]!.rule).toContain('leave-one-out on domain');
    expect(slices[0]!.limits.join(' ')).toContain('never enter training');
    expect(slices[0]!.datasetSnapshotId).toBe('data-4fc041ee92ee');
  });

  it('serves the plain "just make it smaller" case with no grouping at all', () => {
    const slices = buildSelectionSlices(
      {
        fold: 'sampled',
        holdoutColumn: null,
        holdoutValues: [],
        clientColumn: null,
        stratifyBy: null,
        seed: 7,
      },
      CSV_LIKE,
      TIERS,
    );
    expect(slices.map((slice) => slice.stats.selectedRows)).toEqual([80, 400, 4000]);
    expect(slices[0]!.rule).toContain('whole corpus');
    expect(slices[0]!.boundaries).toEqual(['row-level selection (no client boundary measured)']);
    // Unstratified sampling is flagged rather than silently trusted.
    expect(slices[0]!.distributionCheck?.warnings.join(' ')).toContain('class balance');
  });

  it('is deterministic: the same spec and seed reproduce identical ids and hashes', () => {
    const first = buildSelectionSlices(spec(), PACS, TIERS);
    const second = buildSelectionSlices(spec(), PACS, { ...TIERS, now: 9999 });
    expect(second.map((slice) => slice.sliceId)).toEqual(first.map((slice) => slice.sliceId));
    expect(second.map((slice) => slice.outputHash)).toEqual(first.map((slice) => slice.outputHash));
    // A different seed is a different slice, by contract.
    const reseeded = buildSelectionSlices(spec({ seed: 43 }), PACS, TIERS);
    expect(reseeded[0]!.inputHash).not.toBe(first[0]!.inputHash);
  });

  it('throws with the actionable list instead of slicing on an unmeasured column', () => {
    try {
      buildSelectionSlices(spec({ clientColumn: 'sensor' }), PACS, TIERS);
      expect.unreachable('should throw');
    } catch (error) {
      expect((error as { code: string }).code).toBe('USER_INPUT_REQUIRED');
      expect((error as Error).message).toContain('data describe');
    }
  });

  it('gives each fold a distinct slice id and well-formed hashes', () => {
    // Regression: a doubled `sha256:` prefix made every fold hash to the
    // literal "sha256", so four folds overwrote each other down to one.
    const folds = ['sketch', 'cartoon', 'art_painting', 'photo'].map((value) =>
      spec({ fold: `holdout_${value}`, holdoutValues: [value] }),
    );
    const ids = new Set<string>();
    for (const fold of folds) {
      for (const slice of buildSelectionSlices(fold, PACS, TIERS)) {
        expect(slice.sliceId).toMatch(/^ds-[0-9a-z]+-(smoke|quick|standard)-[0-9a-f]{6}$/);
        expect(slice.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(slice.outputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
        ids.add(slice.sliceId);
      }
    }
    expect(ids.size).toBe(12); // 4 folds x 3 tiers, no collisions
  });

  it('canonical form ignores fold labels and value order, so intent hashes stably', () => {
    const a = canonicalSelection(spec({ fold: 'A', holdoutValues: ['photo', 'sketch'] }));
    const b = canonicalSelection(spec({ fold: 'B', holdoutValues: ['sketch', 'photo'] }));
    expect(a).toBe(b);
  });
});
