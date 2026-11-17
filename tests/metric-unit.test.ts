import { describe, expect, it } from 'vitest';
import {
  declaredMetric,
  declaredUnitFor,
  metricUnit,
  unitViolation,
} from '../src/core/metric-id.js';

describe('declared metric units', () => {
  it('reads the unit the protocol definition states', () => {
    expect(
      metricUnit('target_unseen_domain_top1_accuracy (held-out domain value, all samples, %)'),
    ).toBe('percent');
    expect(
      metricUnit('communication_cost_per_round (bytes exchanged per round, number of rounds)'),
    ).toBe('count');
    expect(metricUnit('unseen_domain_top1_accuracy (fraction of held-out samples, 0-1)')).toBe(
      'fraction',
    );
    expect(metricUnit('delta_over_FedAvg (average accuracy gain in percentage points)')).toBe(
      'percent',
    );
    // No declaration is no opinion: it must never be inferred from magnitude.
    expect(metricUnit('principal-angle mismatch of per-client separating bases')).toBeNull();
  });

  it('flags only the contradictions that are actually visible', () => {
    expect(unitViolation('percent', 18.75)).toBeNull();
    expect(unitViolation('percent', 0.16858931604511102)).toMatch(
      /declared percent but the recorded value/,
    );
    expect(unitViolation('fraction', 0.1686)).toBeNull();
    expect(unitViolation('fraction', 18.75)).toMatch(/exceeds it/);
    expect(unitViolation(null, 1_000_000)).toBeNull();
    expect(unitViolation('count', 0)).toBeNull();
    expect(unitViolation('percent', 0)).toBeNull();
    expect(unitViolation('ratio', Number.NaN)).toMatch(/not finite/);
  });
});

describe('declaredUnitFor — a declared unit is not the same kind of fact as a parsed one', () => {
  it('prefers the protocol field, falls back to prose, and says which it used', () => {
    const declared = [
      declaredMetric('accuracy (all samples)', 'higher', 'percent'),
      declaredMetric('number_of_prototypes (avg # transmitted/round)', 'lower'),
    ];
    // Declared as a field: the guard is enforcing a contract.
    expect(declaredUnitFor('accuracy', declared, 'accuracy (all samples, %)')).toEqual({
      unit: 'percent',
      source: 'declared',
    });
    // Only the prose carries it: the guard is reading a sentence, and the
    // refusal has to admit that, because the fix differs (declare vs re-lock).
    expect(declaredUnitFor('top1_accuracy', [], 'top1_accuracy (held-out, %)')).toEqual({
      unit: 'percent',
      source: 'parsed-from-definition',
    });
    // Identifier match works across the prose gap (#15), so a spec that stores
    // the bare name still finds the declared unit.
    expect(
      declaredUnitFor(
        'target_unseen_domain_top1_accuracy',
        [declaredMetric('target_unseen_domain_top1_accuracy (held-out, %)', 'higher', 'percent')],
        'target_unseen_domain_top1_accuracy',
      ),
    ).toEqual({ unit: 'percent', source: 'declared' });
    // Nothing declares or implies a unit: `none`, and no guard may fire on it.
    expect(declaredUnitFor('loss', [], 'loss')).toEqual({ unit: null, source: 'none' });
    // A metric parsed as "lower" with no unit stays unenforced rather than
    // inventing one from the magnitude of the value.
    const prototypes = declared[1]!;
    expect(declaredUnitFor('number_of_prototypes', declared, prototypes.name)).toEqual({
      unit: null,
      source: 'none',
    });
  });

  it('derived identity and unit land on the protocol record the ladder reads', async () => {
    const accuracy = declaredMetric(
      'target_unseen_domain_top1_accuracy (held-out domain value, all samples, %)',
    );
    const errorMetric = declaredMetric('mean_absolute_error (lower is better, degrees)');
    expect(accuracy.identifier).toBe('target_unseen_domain_top1_accuracy');
    expect(accuracy.unit).toBe('percent');
    expect(accuracy.unitDeclared).toBe(false);
    expect(errorMetric.unit).toBeNull();
  });
});
