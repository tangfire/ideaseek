import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hybridSearch, EVIDENCE_DISCLAIMER } from '../src/retrieval/search.js';
import { createDemoRun, makeProjectDir, openRuntime, CLI_BIN } from './helpers.js';

/**
 * FTS-only retrieval contract (embedding layer removed by product
 * decision — Claude-Code-style agentic grep/read covers semantic lookup;
 * the fastembed/ONNX supply chain cost more than it returned).
 */

describe('hybridSearch (FTS-only)', () => {
  it('returns FTS hits with the honest note and via=fts', async () => {
    const dir = await makeProjectDir();
    const runtime = await openRuntime(dir, { recover: false });
    try {
      await createDemoRun(runtime);
      const result = await hybridSearch(runtime, { query: 'anything', limit: 5 });
      expect(result.mode).toBe('fts');
      expect(result.fusion.vectorHits).toBe(0);
      expect(result.hits.every((hit) => hit.via === 'fts')).toBe(true);
      expect(result.note).toContain('FTS5/BM25 only');
      expect(result.note).toContain('embedding layer was removed');
    } finally {
      await runtime.close();
    }
  });

  it('exposes the evidence disclaimer (search is recall-only)', () => {
    expect(EVIDENCE_DISCLAIMER).toContain('source snippet');
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
  it('reports FTS mode, fusion counts, the evidence disclaimer and no embedding stats', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-retrieval-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    const { makeFixturePdf } = await import('../src/knowledge/pdf.js');
    try {
      await makeFixturePdf(join(dir, 'papers', 'alpha.pdf'), 'Alpha retrieval probe');
    } catch {
      return; // pdf toolchain unavailable in this environment
    }
    expect((await runCli(dir, ['scan'])).code).toBe(0);
    expect((await runCli(dir, ['ingest', '--json'])).code).toBe(0);

    const search = await runCli(dir, ['search', 'retrieval', '--json']);
    expect(search.code).toBe(0);
    const payload = JSON.parse(search.stdout) as {
      retrieval: {
        mode: string;
        fusion: { ftsHits: number; vectorHits: number };
        disclaimer: string;
        note?: string | null;
      };
      hits: { via?: string }[];
    };
    expect(payload.retrieval.mode).toBe('fts');
    expect(payload.retrieval.disclaimer).toContain('source snippet');
    expect(payload.retrieval.fusion.vectorHits).toBe(0);
    expect(payload.retrieval.note).toBeTruthy();
    expect(payload.hits.every((hit) => hit.via === 'fts')).toBe(true);
    // The removed embedding layer leaves no stats in the payload.
    expect(JSON.stringify(payload)).not.toContain('embeddings');

    const text = await runCli(dir, ['search', 'retrieval']);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('retrieval');
    expect(text.stdout).not.toContain('[vec]');
  }, 180_000);
});
