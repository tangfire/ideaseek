import { describe, expect, it } from 'vitest';
import { buildPaperResults } from '../src/paper/results-export.js';

/**
 * The export is what figures, tables and the manuscript cite, so it is the last
 * place a fake ablation study can be caught.
 *
 * Observed on the real project: an idea and its five ablations exported the same
 * value for every metric. Nine identical rows read as "the mechanism holds under
 * every ablation" when the only sound conclusion is that the ablation code did
 * not change what was measured. The export therefore groups indistinguishable
 * runs by themselves rather than leaving that to a reader comparing floats.
 */

function spec(specId: string, ideaId: string | null = null): never {
  return {
    specId,
    idea: ideaId ? { ideaId } : null,
    comparisonIds: [],
    metrics: [{ name: 'acc' }],
    seeds: [42],
  } as never;
}

function result(status: string, metrics: { name: string; value: number }[]): never {
  return { status, metrics, artifactRefs: [] } as never;
}

describe('results export integrity', () => {
  it('groups runs whose every metric value is indistinguishable', () => {
    const built = buildPaperResults(
      [
        { spec: spec('idea-alpha'), result: result('succeeded', [{ name: 'acc', value: 1.5 }]) },
        { spec: spec('idea-alpha-abl-x'), result: result('succeeded', [{ name: 'acc', value: 1.5 }]) },
        { spec: spec('idea-beta'), result: result('succeeded', [{ name: 'acc', value: 2.5 }]) },
        // A failed run with the same numbers is not evidence and must not join
        // the group — it never reaches the table either.
        { spec: spec('idea-gamma'), result: result('failed', [{ name: 'acc', value: 1.5 }]) },
      ],
      1_760_000_000_000,
    );
    expect(built.identicalValueGroups).toEqual([
      { specIds: ['idea-alpha', 'idea-alpha-abl-x'], metrics: ['acc'] },
    ]);
    expect(built.rows).toHaveLength(4);
  });

  it('does not group runs that differ in any metric or in metric coverage', () => {
    const built = buildPaperResults(
      [
        {
          spec: spec('idea-a'),
          result: result('succeeded', [
            { name: 'acc', value: 1 },
            { name: 'loss', value: 0.5 },
          ]),
        },
        {
          spec: spec('idea-b'),
          result: result('succeeded', [{ name: 'acc', value: 1 }]),
        },
      ],
      1_760_000_000_000,
    );
    expect(built.identicalValueGroups).toEqual([]);
  });

  it('is stable regardless of the order the rows arrive in', () => {
    const entries = [
      { spec: spec('idea-alpha'), result: result('succeeded', [{ name: 'acc', value: 1.5 }]) },
      { spec: spec('idea-beta'), result: result('succeeded', [{ name: 'acc', value: 2.5 }]) },
      { spec: spec('idea-abl'), result: result('succeeded', [{ name: 'acc', value: 1.5 }]) },
    ];
    const forward = buildPaperResults(entries, 1_760_000_000_000);
    const backward = buildPaperResults([...entries].reverse(), 1_760_000_000_000);
    expect(forward.identicalValueGroups).toEqual(backward.identicalValueGroups);
    // The group lists spec ids in the sorted order the file itself uses, so a
    // diff of two exports does not reorder on its own.
    expect(forward.identicalValueGroups[0]?.specIds).toEqual(['idea-abl', 'idea-alpha']);
  });
});
