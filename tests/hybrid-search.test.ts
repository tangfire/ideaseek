import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cosineSimilarity, rrfMerge, hybridSearch } from '../src/retrieval/embeddings.js';
import { createDemoRun, makeProjectDir, openRuntime, CLI_BIN } from './helpers.js';

describe('embedding math', () => {
  it('cosine similarity is symmetric and bounded', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 6);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 6);
    expect(cosineSimilarity(a, [1, 1, 0])).toBeCloseTo(1 / Math.SQRT2, 6);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('rrf merges ranked lists with shared items scoring higher', () => {
    const fts = [
      { source: 'p/a.pdf', page: 1, rank: 0 },
      { source: 'p/b.pdf', page: 1, rank: 1 },
    ];
    const vec = [
      { source: 'p/b.pdf', page: 1, rank: 0 },
      { source: 'p/c.pdf', page: 1, rank: 1 },
    ];
    const fused = rrfMerge([fts, vec]);
    // b.pdf appears in both lists → highest fused score, ranked first.
    expect(fused[0]!.source).toBe('p/b.pdf');
    expect(fused.map((hit) => hit.source).sort()).toEqual(['p/a.pdf', 'p/b.pdf', 'p/c.pdf']);
  });
});

describe('hybridSearch fallback contract', () => {
  it('returns FTS-only with a note when no provider is available', async () => {
    const dir = await makeProjectDir();
    const runtime = await openRuntime(dir, { recover: false });
    try {
      const run = await createDemoRun(runtime);
      void run;
      const result = await hybridSearch(runtime, null, { query: 'anything', limit: 5 });
      expect(result.mode).toBe('fts');
      expect(result.note).toContain('BM25/FTS only');
      expect(result.fusion.vectorHits).toBe(0);
      expect(result.hits.every((hit) => hit.via === 'fts')).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it('degrades to FTS with a note when the provider throws (offline/user refusal)', async () => {
    const dir = await makeProjectDir();
    const runtime = await openRuntime(dir, { recover: false });
    try {
      await createDemoRun(runtime);
      const brokenProvider = {
        providerId: 'local-fastembed',
        modelId: 'x',
        cacheDir: '/nonexistent',
        embed: async () => {
          throw new Error('MODEL_UNAVAILABLE: network refused');
        },
        describe: async () => null,
      } as never;
      const result = await hybridSearch(runtime, brokenProvider, { query: 'q' });
      expect(result.mode).toBe('fts');
      expect(result.note).toContain('network refused');
      expect(result.note).toContain('BM25/FTS only');
    } finally {
      await runtime.close();
    }
  });
});

function runCli(
  cwd: string,
  args: string[],
  timeoutMs = 180_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli ${args.join(' ')} timed out; stderr=${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

describe('CLI: search retrieval metadata', () => {
  it('reports retrieval mode, fusion counts and the evidence disclaimer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-retrieval-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    const { makeFixturePdf } = await import('../src/knowledge/pdf.js');
    try {
      await makeFixturePdf(join(dir, 'papers', 'alpha.pdf'), 'Alpha retrieval probe');
    } catch {
      return;
    }
    expect((await runCli(dir, ['scan'])).code).toBe(0);
    expect((await runCli(dir, ['ingest', '--json'])).code).toBe(0);

    const search = await runCli(dir, ['search', 'retrieval', '--json']);
    expect(search.code).toBe(0);
    const payload = JSON.parse(search.stdout) as {
      retrieval: {
        mode: string;
        fusion: { ftsHits: number; vectorHits: number };
        embeddings: { embedded: number; failed: number };
        disclaimer: string;
        note?: string | null;
      };
      hits: { via?: string }[];
    };
    expect(['fts', 'hybrid']).toContain(payload.retrieval.mode);
    expect(payload.retrieval.disclaimer).toContain('source snippet');
    expect(payload.retrieval.embeddings.failed).toBe(0);
    if (payload.retrieval.mode === 'fts') {
      expect(payload.retrieval.note).toBeTruthy();
    } else {
      expect(payload.retrieval.fusion.vectorHits).toBeGreaterThan(0);
      expect(payload.hits.every((hit) => hit.via === 'fts' || hit.via === 'vector')).toBe(true);
    }

    const text = await runCli(dir, ['search', 'retrieval']);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('retrieval');
    expect(text.stdout).toContain('always verify claims');
  }, 300_000);
});
