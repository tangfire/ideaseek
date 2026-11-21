import { describe, expect, it } from 'vitest';
import { prepareExitCode } from '../src/commands/prepare.js';

/**
 * `ideaseek prepare` exit contract: blocking gaps dominate (2), a failed
 * pipeline step with no open gap still fails the command (1) so
 * `prepare && run` cannot proceed on a broken pipeline, clean is 0.
 * Before this contract a failed extract/synthesize step exited 0 whenever
 * the assessment happened to have no blocking gaps — fail-open.
 */
describe('prepare exit code', () => {
  it('returns 0 only when there are no blocking gaps and no failed steps', () => {
    expect(prepareExitCode(0, 0)).toBe(0);
  });

  it('returns 2 when blocking gaps remain (dominates over failed steps)', () => {
    expect(prepareExitCode(1, 0)).toBe(2);
    expect(prepareExitCode(3, 2)).toBe(2);
  });

  it('returns 1 when a step failed even though no gap is blocking', () => {
    expect(prepareExitCode(0, 1)).toBe(1);
    expect(prepareExitCode(0, 3)).toBe(1);
  });
});
