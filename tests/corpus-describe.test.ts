import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeProfiledCorpus } from '../src/knowledge/corpus-describe.js';

async function projectWith(profiles: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'corpus-describe-'));
  await mkdir(join(dir, 'knowledge'), { recursive: true });
  await writeFile(
    join(dir, 'knowledge', 'image-profiles.json'),
    JSON.stringify({ generatedAt: 1, profiles }),
    'utf8',
  );
  return dir;
}

const REAL_SHAPE = [
  {
    schemaVersion: 'image-profile-v1',
    source: {
      path: '/data/pacs.parquet',
      format: 'parquet',
      columns: ['image', 'domain', 'label'],
    },
    samples: 9991,
    grouping: {
      column: 'domain',
      values: [
        { name: 'sketch', count: 1000 },
        { name: 'photo', count: 1000 },
      ],
    },
    classes: { distinct: 7 },
    imageBytesColumn: 'image',
    resolution: {
      width: { min: 227, median: 227, max: 227, sampled: 24 },
      height: { min: 227, median: 227, max: 227, sampled: 24 },
    },
    warnings: ['4 rows had undecodable bytes'],
  },
];

describe('describeProfiledCorpus', () => {
  it('reads the fields the profiler actually writes', async () => {
    const text = await describeProfiledCorpus(await projectWith(REAL_SHAPE));
    // The first implementation read profile.columns, which does not exist:
    // columns live on profile.source. The generator got an empty list and
    // guessed at data the platform had already measured.
    expect(text).toContain('columns: image, domain, label');
    expect(text).toContain('samples: 9991');
    expect(text).toContain('classes: 7');
    expect(text).toContain('grouping axis: domain over [sketch|photo]');
    expect(text).toContain('image bytes column: image');
    expect(text).toContain('undecodable bytes');
  });

  it('quotes a number for image size, not a statistics object', async () => {
    expect(await describeProfiledCorpus(await projectWith(REAL_SHAPE))).toContain(
      'image size (median): 227x227',
    );
  });

  it('never renders an object as [object Object]', async () => {
    // A useless string dressed as a fact is worse than an absent one: an agent
    // cannot tell it is garbage and will build code around it. Both the
    // grouping values and the resolution axes are objects in the real shape.
    const text = (await describeProfiledCorpus(await projectWith(REAL_SHAPE))) ?? '';
    expect(text).not.toContain('[object Object]');
    const ragged = await projectWith([
      { source: { columns: ['x'] }, samples: 3, grouping: { column: 'g', values: [7, null] } },
    ]);
    expect(await describeProfiledCorpus(ragged)).toContain('over [7|null]');
  });

  it('stays null when nothing has been profiled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'corpus-none-'));
    expect(await describeProfiledCorpus(dir)).toBeNull();
    expect(await describeProfiledCorpus(await projectWith([]))).toBeNull();
    const broken = await projectWith(REAL_SHAPE);
    await writeFile(join(broken, 'knowledge', 'image-profiles.json'), '{not json', 'utf8');
    expect(await describeProfiledCorpus(broken)).toBeNull();
  });
});
