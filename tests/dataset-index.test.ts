import { describe, expect, it } from 'vitest';
import {
  createDatasetIndexClient,
  pickFile,
  type DatasetIndexFetch,
} from '../src/knowledge/dataset-index.js';

/**
 * Dataset hub lookup (the source that gives `datasets acquire` something to
 * fetch). Transport is injected — no test here touches the network.
 */

function json(body: unknown, ok = true, status = 200) {
  return async () => ({ ok, status, text: async () => JSON.stringify(body) });
}

describe('pickFile', () => {
  it('prefers the largest archive over a bigger-looking loose file list order', () => {
    const picked = pickFile([
      { path: 'README.md', size: 1200, type: 'file' },
      { path: 'data-00-of-02.parquet', size: 900_000, type: 'file' },
      { path: 'PACS.zip', size: 500_000, type: 'file' },
      { path: 'data-01-of-02.parquet', size: 1_200_000, type: 'file' },
    ]);
    expect(picked.path).toBe('data-01-of-02.parquet');
    expect(picked.bytes).toBe(2_601_200);
  });

  it('takes the largest file when there is no archive, and reports no bytes when none listed', () => {
    expect(
      pickFile([
        { path: 'a.txt', size: 5 },
        { path: 'b.bin', size: 50 },
      ]).path,
    ).toBe('b.bin');
    const empty = pickFile([]);
    expect(empty.path).toBeNull();
    expect(empty.bytes).toBeNull();
  });

  it('never resolves to repository metadata, even when it is the only sized entry', () => {
    // The first live run picked README.md for PACS; documentation is not data.
    expect(
      pickFile([
        { path: 'README.md', size: 5000 },
        { path: '.gitattributes', size: 300 },
      ]).path,
    ).toBeNull();
    const mixed = pickFile([
      { path: 'README.md', size: 9_000_000 },
      { path: 'data/train-00000-of-00001.parquet', size: 40 },
    ]);
    expect(mixed.path).toBe('data/train-00000-of-00001.parquet');
  });

  it('ignores directory entries', () => {
    expect(pickFile([{ path: 'data', type: 'directory' }]).path).toBeNull();
  });
});

describe('createDatasetIndexClient', () => {
  const searchBody = [
    {
      id: 'flwrlabs/pacs',
      tags: ['license:mit', 'modality:image'],
      downloads: 4210,
    },
    { id: 'someone/other', tags: [] },
  ];
  const treeBody = [
    { path: 'PACS.zip', size: 176_000_000, type: 'file' },
    { path: 'README.md', size: 1700, type: 'file' },
  ];

  function transport(): { calls: string[]; fetchImpl: DatasetIndexFetch } {
    const calls: string[] = [];
    const fetchImpl: DatasetIndexFetch = async (url) => {
      calls.push(url);
      if (url.endsWith('limit=5')) return (await json(searchBody))();
      if (url.includes('/tree/main')) return (await json(treeBody))();
      return (await json({}, false, 404))();
    };
    return { calls, fetchImpl };
  }

  it('resolves a fetchable file, license tag and size, and records the serving endpoint', async () => {
    const { calls, fetchImpl } = transport();
    const client = createDatasetIndexClient({
      fetchImpl,
      endpoint: 'https://huggingface.co',
      mirror: 'https://hf-mirror.com',
    });
    const result = await client.search('pacs', { limit: 5 });
    expect(result.error).toBeNull();
    expect(result.endpoint).toBe('https://huggingface.co');
    // one search + one tree per candidate
    expect(calls.length).toBe(3);
    const hit = result.hits[0]!;
    expect(hit.id).toBe('flwrlabs/pacs');
    expect(hit.fileUrl).toBe('https://huggingface.co/datasets/flwrlabs/pacs/resolve/main/PACS.zip');
    expect(hit.licenseTag).toBe('mit');
    expect(hit.downloads).toBe(4210);
    expect(hit.bytes).toBe(176_001_700);
  });

  it('falls back to the mirror when the primary is unreachable, and says which served', async () => {
    const fetchImpl: DatasetIndexFetch = async (url) => {
      if (url.startsWith('https://huggingface.co')) throw new Error('fetch failed');
      if (url.endsWith('limit=5')) return (await json(searchBody))();
      return (await json(treeBody))();
    };
    const client = createDatasetIndexClient({
      fetchImpl,
      endpoint: 'https://huggingface.co',
      mirror: 'https://hf-mirror.com',
    });
    const result = await client.search('pacs', { limit: 5 });
    expect(result.endpoint).toBe('https://hf-mirror.com');
    expect(result.hits[0]!.fileUrl).toContain('hf-mirror.com/datasets/flwrlabs/pacs/resolve/main/');
  });

  it('names both hosts when neither answers', async () => {
    const fetchImpl: DatasetIndexFetch = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const client = createDatasetIndexClient({
      fetchImpl,
      endpoint: 'https://huggingface.co',
      mirror: 'https://hf-mirror.com',
    });
    const result = await client.search('pacs', { limit: 5 });
    expect(result.hits).toEqual([]);
    expect(result.endpoint).toBeNull();
    expect(result.error).toContain('https://huggingface.co');
    expect(result.error).toContain('https://hf-mirror.com');
  });

  it('leaves fileUrl null when a repo lists no fetchable file', async () => {
    const fetchImpl: DatasetIndexFetch = async (url) => {
      if (url.endsWith('limit=5')) return (await json([{ id: 'x/y', tags: [] }]))();
      return (await json([{ path: 'docs', type: 'directory' }]))();
    };
    const client = createDatasetIndexClient({ fetchImpl, endpoint: 'https://huggingface.co' });
    const result = await client.search('y', { limit: 5 });
    expect(result.hits[0]!.fileUrl).toBeNull();
  });
});
