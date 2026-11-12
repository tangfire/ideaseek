import { describe, expect, it } from 'vitest';
import {
  assertAgainstSchema,
  listSchemaNames,
  validateAgainstSchema,
} from '../src/core/schema/index.js';

/**
 * dataset-profile-v1: the Python federated profiler emits this shape and
 * TypeScript validates it at the parse boundary (federated.ts) before
 * anything persists knowledge/dataset-manifest.json; the worker validates
 * the same file before emitting — one authority, both languages.
 */

function validProfile(): Record<string, unknown> {
  return {
    parser: 'ideaseek-fedpf-1',
    root: '/datasets/fedpf-mnist',
    splits: {
      train: {
        dir: 'train',
        clients: [
          {
            id: 'f_00001',
            file: 'train/f_00001.npz',
            samples: 2625,
            xShape: [2625, 1, 28, 28],
            xDtype: 'float32',
            yShape: [2625],
            yDtype: 'int64',
            labelCounts: { '0': 100, '1': 90 },
          },
        ],
        clientCount: 1,
        totalSamples: 2625,
        sampleStats: { min: 2625, max: 2625, mean: 2625.0, std: 0.0 },
        labelDistribution: { '0': 100, '1': 90 },
      },
    },
    clientCount: 1,
    nonIid: {
      tvDistanceMean: 0.7348,
      tvDistanceMax: 0.81,
      samplesCv: 0.0,
      classesPerClientMean: 2.0,
      interpretation: 'label distribution total-variation distance from the global mix',
    },
    files: [{ rel: 'train/f_00001.npz', bytes: 8192, sha256: `sha256:${'a'.repeat(64)}` }],
    fileCount: 1,
    rootHash: `sha256:${'b'.repeat(64)}`,
    readOnly: {
      rootWritableByProcess: false,
      sampleWritableByProcess: false,
      policy: 'external datasets are registered read-only',
    },
  };
}

function mutate(apply: (profile: Record<string, unknown>) => void): Record<string, unknown> {
  const profile = structuredClone(validProfile());
  apply(profile);
  return profile;
}

describe('dataset-profile-v1 schema', () => {
  it('is registered', () => {
    expect(listSchemaNames()).toContain('dataset-profile-v1');
  });

  it('accepts a complete profile (python worker shape)', () => {
    const check = validateAgainstSchema('dataset-profile-v1', validProfile());
    expect(check.errors).toEqual([]);
    expect(() => assertAgainstSchema('dataset-profile-v1', validProfile())).not.toThrow();
  });

  const rejected: { name: string; profile: unknown }[] = [
    { name: 'null', profile: null },
    { name: 'missing rootHash', profile: mutate((p) => delete p.rootHash) },
    {
      name: 'bad rootHash pattern',
      profile: mutate((p) => (p.rootHash = 'sha256:zz')),
    },
    {
      name: 'empty splits',
      profile: mutate((p) => (p.splits = {})),
    },
    {
      name: 'negative clientCount',
      profile: mutate((p) => (p.clientCount = -1)),
    },
    {
      name: 'nonIid missing interpretation',
      profile: mutate((p) => delete (p.nonIid as Record<string, unknown>).interpretation),
    },
    {
      name: 'file with bad sha',
      profile: mutate((p) => {
        (p.files as Record<string, unknown>[])[0]!.sha256 = 'md5:x';
      }),
    },
    {
      name: 'client missing labelCounts',
      profile: mutate((p) => {
        delete (
          (p.splits as Record<string, Record<string, unknown>>).train!.clients as Record<
            string,
            unknown
          >[]
        )[0]!.labelCounts;
      }),
    },
    {
      name: 'client with negative samples',
      profile: mutate((p) => {
        (
          (p.splits as Record<string, Record<string, unknown>>).train!.clients as Record<
            string,
            unknown
          >[]
        )[0]!.samples = -5;
      }),
    },
    {
      name: 'labelDistribution with non-integer count',
      profile: mutate((p) => {
        (
          (p.splits as Record<string, Record<string, unknown>>).train!.labelDistribution as Record<
            string,
            unknown
          >
        )['0'] = 1.5;
      }),
    },
    {
      name: 'readOnly missing policy',
      profile: mutate((p) => delete (p.readOnly as Record<string, unknown>).policy),
    },
    {
      name: 'sampleStats missing std',
      profile: mutate((p) => {
        delete (
          (p.splits as Record<string, Record<string, unknown>>).train!.sampleStats as Record<
            string,
            unknown
          >
        ).std;
      }),
    },
  ];
  for (const testCase of rejected) {
    it(`rejects: ${testCase.name}`, () => {
      const check = validateAgainstSchema('dataset-profile-v1', testCase.profile);
      expect(check.ok, `issues: ${check.errors.join('; ')}`).toBe(false);
      expect(check.errors.length).toBeGreaterThan(0);
      expect(() => assertAgainstSchema('dataset-profile-v1', testCase.profile)).toThrow();
    });
  }
});
