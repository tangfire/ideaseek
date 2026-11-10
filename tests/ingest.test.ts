import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { partitionPdfs } from '../src/commands/ingest.js';
import type { InputManifest } from '../src/knowledge/scan.js';
import { CLI_BIN } from './helpers.js';

function file(relPath: string, sha256: string | null, ext: string): InputManifest['files'][number] {
  return {
    path: `/proj/${relPath}`,
    relPath,
    bytes: 10,
    mtimeMs: 1,
    ext,
    sha256,
    hashStatus: sha256 ? 'ok' : 'skipped-too-large',
    role: 'paper',
    confidence: 0.9,
    basis: ['extension:.pdf'],
    discoveredAt: 1,
  };
}

function manifest(files: InputManifest['files']): InputManifest {
  return {
    manifestVersion: 1,
    parserVersion: 'ideaseek-scan-1',
    generatedAt: 1,
    roots: ['papers'],
    files,
    groups: [],
    duplicateSets: [],
  };
}

describe('partitionPdfs (incremental ingest decision)', () => {
  it('splits scanned PDFs by already-parsed content hashes', () => {
    const a = `sha256:${'a'.repeat(64)}`;
    const b = `sha256:${'b'.repeat(64)}`;
    const result = partitionPdfs(
      manifest([
        file('papers/a.pdf', a, '.pdf'),
        file('papers/b.pdf', b, '.pdf'),
        file('papers/notes.txt', `sha256:${'c'.repeat(64)}`, '.txt'),
        file('papers/too-big.pdf', null, '.pdf'),
      ]),
      new Set([a]),
    );
    expect(result.alreadyParsed).toBe(1);
    expect(result.pending.map((pdf) => pdf.relPath)).toEqual(['papers/b.pdf']);
    expect(result.pending[0]!.sha256).toBe(b);
  });

  it('is stable-sorted and treats everything pending on a cold start', () => {
    const result = partitionPdfs(
      manifest([
        file('papers/z.pdf', `sha256:${'z'.repeat(64)}`, '.pdf'),
        file('papers/m.pdf', `sha256:${'m'.repeat(64)}`, '.pdf'),
      ]),
      new Set(),
    );
    expect(result.pending.map((pdf) => pdf.relPath)).toEqual(['papers/m.pdf', 'papers/z.pdf']);
    expect(result.alreadyParsed).toBe(0);
  });
});

function runCli(
  cwd: string,
  args: string[],
  timeoutMs = 60_000,
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

describe('ideaseek ingest', () => {
  it('parses new PDFs once, indexes them, and is a no-op afterwards', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-ingest-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);

    const { makeFixturePdf } = await import('../src/knowledge/pdf.js');
    try {
      await makeFixturePdf(join(dir, 'papers', 'alpha.pdf'), 'Alpha');
      await makeFixturePdf(join(dir, 'papers', 'beta.pdf'), 'Beta');
    } catch {
      return; // python/pypdf unavailable
    }
    await mkdir(join(dir, 'papers'), { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'papers', 'readme.txt'), 'not a pdf');

    expect((await runCli(dir, ['scan'])).code).toBe(0);

    const first = await runCli(dir, ['ingest', '--json']);
    expect(first.code).toBe(0);
    const firstPayload = JSON.parse(first.stdout) as {
      pending: number;
      alreadyParsed: number;
      enqueued: number;
      status: string;
      indexed: number;
    };
    expect(firstPayload.pending).toBe(2);
    expect(firstPayload.alreadyParsed).toBe(0);
    expect(firstPayload.enqueued).toBe(2);
    expect(firstPayload.status).toBe('COMPLETED');
    expect(firstPayload.indexed).toBe(2);

    // Both papers are searchable at page level.
    const search = await runCli(dir, ['search', 'Page', '--json']);
    const hits = (JSON.parse(search.stdout) as { hits: { source: string }[] }).hits;
    expect(new Set(hits.map((hit) => hit.source))).toEqual(
      new Set(['papers/alpha.pdf', 'papers/beta.pdf']),
    );

    // Second ingest: content hashes already parsed → nothing to do, no run.
    const second = await runCli(dir, ['ingest', '--json']);
    expect(second.code).toBe(0);
    const secondPayload = JSON.parse(second.stdout) as {
      pending: number;
      alreadyParsed: number;
      runId: string | null;
      action?: string;
    };
    expect(secondPayload.pending).toBe(0);
    expect(secondPayload.alreadyParsed).toBe(2);
    expect(secondPayload.runId).toBeNull();
    expect(secondPayload.action).toBe('nothing-to-do');

    const text = await runCli(dir, ['ingest']);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('nothing to do');
    expect(text.stdout).toContain('ideaseek search');
  }, 120_000);

  it('auto-scans when there is no manifest yet (empty project = no-op)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-ingest-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    const empty = await runCli(dir, ['ingest', '--json']);
    expect(empty.code).toBe(0);
    const payload = JSON.parse(empty.stdout) as { pending: number; action?: string };
    expect(payload.pending).toBe(0);
    expect(payload.action).toBe('nothing-to-do');
  }, 30_000);

  it('refuses outside a project', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-ingest-'));
    const outside = await runCli(dir, ['ingest', '--json']);
    expect(outside.code).toBe(2);
    expect(outside.stderr).toContain('NOT_INITIALIZED');
  }, 30_000);
});
