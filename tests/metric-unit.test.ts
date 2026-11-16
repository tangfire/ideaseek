import { describe, expect, it } from 'vitest';
import { metricUnit, unitViolation } from '../src/core/metric-id.js';

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
