import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMeasuredCorpus } from '../src/commands/data.js';
import { makeProjectDir, openRuntime } from './helpers.js';

/**
 * A slice binds to ONE corpus. With several datasets profiled the measured
 * structure, the sample count and the snapshot id must all come from the same
 * corpus (the largest image profile) — validating a rule against one
 * dataset's columns while claiming another dataset's snapshot would poison
 * every downstream result. Live case: sample-data.csv first in the card beat
 * PACS by card-row SUM and claimed the slices.
 */

const PACS_IMAGE = {
  schemaVersion: 'image-profile-v1',
  generatedBy: 'test',
  source: {
    path: '/mnt/workspace/proj/datasets/pacs.parquet',
    format: 'parquet',
    bytes: 191395900,
    sha256: 'sha256:4fc041ee92eec6043fe6e2859e8bdd138e5f958bc621afd153879812cbe65ff5',
    columns: ['image', 'domain', 'label'],
  },
  samples: 9991,
  grouping: {
    column: 'domain',
    values: [
      { name: 'sketch', count: 3929 },
      { name: 'cartoon', count: 2344 },
      { name: 'art_painting', count: 2048 },
      { name: 'photo', count: 1670 },
    ],
  },
  classes: {
    column: 'label',
    values: [
      { name: 'dog', count: 1500 },
      { name: 'person', count: 1600 },
    ],
    distinct: 7,
  },
  imageBytesColumn: null,
  resolution: {},
  splitRules: [],
  warnings: [],
};

const IMAGENETA_IMAGE = {
  ...PACS_IMAGE,
  source: {
    path: '/mnt/workspace/proj/datasets/train-00000-of-00002.parquet',
    format: 'parquet' as const,
    bytes: 396527844,
    sha256: 'sha256:c56c1d4ab135772760137849d44c9e1dec43028658c77a71fa9cce7c4ed0f711',
    columns: ['image', 'label'],
  },
  samples: 3750,
  grouping: { column: null, values: [] },
  classes: {
    column: 'label',
    values: Array.from({ length: 56 }, (_, index) => ({ name: String(index), count: 60 })),
    distinct: 56,
  },
};

async function writeProfiles(
  name: string,
  card: unknown,
  images: unknown[] | null = null,
): Promise<Awaited<ReturnType<typeof openRuntime>>> {
  const dir = await makeProjectDir(name);
  const knowledge = join(dir, 'knowledge');
  await mkdir(knowledge, { recursive: true });
  await writeFile(join(knowledge, 'dataset-card.json'), JSON.stringify(card), 'utf8');
  if (images) {
    await writeFile(
      join(knowledge, 'image-profiles.json'),
      JSON.stringify({ profiles: images }),
      'utf8',
    );
  }
  return openRuntime(dir, { recover: false });
}

describe('loadMeasuredCorpus (one corpus per slice)', () => {
  it('binds structure, samples and snapshot to the largest image corpus', async () => {
    const rt = await writeProfiles(
      'measured-largest-image',
      {
        profiles: [
          {
            source: { path: 'comparisons/x/upstream/sample-data.csv' },
            rows: 660,
            columns: [{ name: 'label' }, { name: 'w' }, { name: 'mean_r' }],
            datasetSnapshotId: 'data-0b196de58b65',
          },
          {
            source: { path: 'datasets/pacs.parquet' },
            rows: 9991,
            columns: [{ name: 'label' }, { name: 'domain' }],
            datasetSnapshotId: 'data-4fc041ee92ee',
          },
          {
            source: { path: 'datasets/train-00000-of-00002.parquet' },
            rows: 3750,
            columns: [{ name: 'label' }],
            datasetSnapshotId: 'data-c56c1d4ab135',
          },
        ],
      },
      [IMAGENETA_IMAGE, PACS_IMAGE],
    );
    try {
      const corpus = await loadMeasuredCorpus(rt);
      expect(corpus).not.toBeNull();
      // snapshot + samples come from PACS (largest image corpus), not from
      // the first card profile (sample-data) and not from a row SUM.
      expect(corpus!.snapshotId).toBe('data-4fc041ee92ee');
      expect(corpus!.samples).toBe(9991);
      // structure comes from PACS only: no foreign columns, no foreign labels.
      expect(corpus!.columns.sort()).toEqual(['domain', 'image', 'label']);
      expect(Object.keys(corpus!.groups).sort()).toEqual(['domain', 'label']);
      expect(Object.keys(corpus!.groups.label!)).toEqual(['dog', 'person']);
      expect(corpus!.groups.domain).toEqual({
        art_painting: 2048,
        cartoon: 2344,
        photo: 1670,
        sketch: 3929,
      });
    } finally {
      await rt.close();
    }
  });

  it('falls back to the largest card profile when no image corpus is profiled', async () => {
    const rt = await writeProfiles('measured-card-only', {
      profiles: [
        {
          source: { path: 'datasets/small.csv' },
          rows: 10,
          columns: [{ name: 'a' }],
          datasetSnapshotId: 'data-aaaa00000000',
        },
        {
          source: { path: 'datasets/big.csv' },
          rows: 4000,
          columns: [{ name: 'age' }, { name: 'churn' }],
          datasetSnapshotId: 'data-bbbb00000000',
        },
      ],
    });
    try {
      const corpus = await loadMeasuredCorpus(rt);
      expect(corpus).toEqual({
        columns: ['age', 'churn'],
        groups: {},
        samples: 4000,
        snapshotId: 'data-bbbb00000000',
      });
    } finally {
      await rt.close();
    }
  });

  it('returns null when nothing was measured (no snapshot to bind)', async () => {
    const rt = await writeProfiles('measured-empty', { profiles: [] }, []);
    try {
      expect(await loadMeasuredCorpus(rt)).toBeNull();
    } finally {
      await rt.close();
    }
  });
});
