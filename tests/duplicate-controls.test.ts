import { describe, expect, it } from 'vitest';
import { duplicateControlFindings, analyzeIdea } from '../src/idea/analysis.js';
import type { AnalysisInput } from '../src/idea/analysis.js';
import type { ExperimentSpec, RunResult } from '../src/experiment/spec.js';
import type { IdeaCard } from '../src/idea/card.js';

/**
 * #30 (second half): one computation reported under two method ids.
 *
 * FDG's entry recorded `fedavg` and `dp_noise_matched_no_shrinkage` as
 * 16.896707907604327 — the same float64, to the last digit. Two genuinely
 * different federated aggregations agreeing that precisely is not a result; it
 * is the same number printed twice, and a delta computed against it means
 * "beats itself". #23 caught this signature across records; nothing looked for
 * it inside a single run.
 */

const PRIMARY = 'target_unseen_domain_top1_accuracy';

describe('duplicateControlFindings', () => {
  it('flags two controls carrying the identical value', () => {
    const findings = duplicateControlFindings(
      [
        { methodId: 'fedavg', value: 16.896707907604327, fromSpecId: 'idea-x@v3' },
        {
          methodId: 'dp_noise_matched_no_shrinkage',
          value: 16.896707907604327,
          fromSpecId: 'idea-x@v3',
        },
        { methodId: 'rethinkfl', value: 17.216418964772203, fromSpecId: 'idea-x@v3' },
      ],
      30.0,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('fedavg and dp_noise_matched_no_shrinkage');
    expect(findings[0]).toContain('16.896707907604327');
    expect(findings[0]).toContain('idea-x@v3');
  });

  it("flags a control that is the subject's own number", () => {
    // The #23 signature in its single-run form: the baseline equals what the
    // idea itself measured.
    const findings = duplicateControlFindings(
      [{ methodId: 'rethinkfl', value: 0.2209625991904911 }],
      0.2209625991904911,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('#23');
  });

  it('stays silent on close-but-distinct values, and on missing ones', () => {
    // Exact float equality only. A tolerance would flag every pair of similar
    // accuracies, train researchers to ignore the warning, and the point of
    // this check is the one pattern coincidence cannot produce.
    expect(
      duplicateControlFindings(
        [
          { methodId: 'a', value: 0.8123456789 },
          { methodId: 'b', value: 0.81234567890001 },
        ],
        null,
      ),
    ).toEqual([]);
    expect(
      duplicateControlFindings(
        [
          { methodId: 'a', value: null },
          { methodId: 'b', value: null },
        ],
        null,
      ),
    ).toEqual([]);
    // One control cannot duplicate anything, whatever its value.
    expect(duplicateControlFindings([{ methodId: 'a', value: 1 }], 1)).toHaveLength(1);
    expect(duplicateControlFindings([], null)).toEqual([]);
  });
});

describe('a supported verdict may not rest on duplicated controls', () => {
  const card = {
    ideaId: 'dup-probe',
    version: 1,
    hypothesis: { statement: 's', targetProblem: 't' },
    nearestComparisons: [{ methodId: 'fedavg', difference: 'd', evidence: 'e' }],
    minimalExperiment: { metrics: [PRIMARY], baselines: ['fedavg'], ablations: [] },
    mechanismChain: { steps: [] },
    componentNecessity: [],
    falsification: { conditions: ['the gain disappears without the probe'] },
  } as unknown as IdeaCard;

  const spec = {
    specId: 'idea-dup-probe',
    version: 1,
    idea: { ideaId: 'dup-probe', version: 1 },
    environment: { python: 'v24', notes: ['scale:smoke'] },
    metrics: [{ name: PRIMARY, direction: 'higher' }],
    seeds: [42],
    dataSnapshotId: 'inputs:fdg',
  } as unknown as ExperimentSpec;

  const result = {
    specId: 'idea-dup-probe',
    status: 'succeeded',
    logRefs: [],
    artifactRefs: [],
    metrics: [{ name: PRIMARY, value: 30.0 }],
    resourcesUsed: {},
    failure: null,
    startedAt: 1,
    finishedAt: 2,
  } as unknown as RunResult;

  function input(overrides: Partial<AnalysisInput> = {}): AnalysisInput {
    return {
      ideaId: 'dup-probe',
      ideaVersion: 1,
      codeHash: 'sha256:aa',
      card,
      main: { spec, result },
      ablations: [],
      baselines: [
        { methodId: 'fedavg', value: 18, scale: 'smoke', source: 'in-run' },
        { methodId: 'dp_matched', value: 18, scale: 'smoke', source: 'in-run' },
      ],
      ideaByScale: { smoke: 30 },
      suspiciousControls: [
        'fedavg and dp_matched recorded the identical value 18 (to the last bit of the float)',
      ],
      // Coverage must be satisfied, or the ladder returns inconclusive for the
      // wrong reason and never exercises the downgrade under test. The first
      // version of this fixture had one seed and one scale, so it "passed" the
      // suspicious-control check only in appearance.
      scalesRun: ['smoke', 'quick', 'standard'],
      datasetsRun: ['inputs:fdg'],
      seedsCount: 3,
      failures: [],
      resources: [],
      ...overrides,
    } as unknown as AnalysisInput;
  }

  it('downgrades the win to inconclusive and keeps the numbers', () => {
    const verdict = analyzeIdea(input());
    // The idea beats both controls on arithmetic. It still cannot be reported
    // as support, because the comparison is doubled evidence rather than two
    // measurements — and the platform is not entitled to decide on its own
    // whether the two methods were expected to converge.
    expect(verdict.verdict).toBe('inconclusive');
    expect(verdict.primaryDelta).not.toBeNull();
    expect(verdict.reasons.join(' ')).toContain('suspicious identical control values');
    expect(verdict.reasons.join(' ')).toContain('not reportable as support');
    expect(verdict.nextSteps.join(' ')).toContain('each control is a genuinely different');
    // Discarding the values would have hidden the very thing to inspect.
    expect(verdict.baselineComparison.map((entry) => entry.baselineValue)).toEqual([18, 18]);
  });

  it('leaves an honest losing verdict alone', () => {
    // The finding is reported, but a `rejected` conclusion is not manufactured
    // or softened by it: the idea simply did not beat a real baseline.
    const verdict = analyzeIdea(
      input({
        suspiciousControls: [],
        baselines: [{ methodId: 'fedavg', value: 40, scale: 'smoke', source: 'repro' }],
      }),
    );
    expect(verdict.verdict).toBe('rejected');
    expect(verdict.reasons.join(' ')).not.toContain('suspicious identical control values');
  });
});
