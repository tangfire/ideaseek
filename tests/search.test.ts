import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_BIN } from './helpers.js';
import { sanitizeFtsQuery } from '../src/workflow/sqlite.js';
import { refreshPaperIndex } from '../src/knowledge/search.js';
import type { ProjectRuntime } from '../src/workflow/runtime.js';
import type { RunRecord } from '../src/workflow/types.js';
import { createDemoRun, makeProjectDir, openRuntime } from './helpers.js';

let dir: string;
let runtime: ProjectRuntime;
let run: RunRecord;

beforeEach(async () => {
  dir = await makeProjectDir();
  runtime = await openRuntime(dir, { recover: false });
  run = await createDemoRun(runtime);
});

afterEach(async () => {
  await runtime.close();
});

/** Commits a parsed-paper artifact through the real two-phase path. */
async function commitParsedPaper(input: {
  source: string;
  sourceHash: string;
  parser: string;
  pages: { page: number; text: string }[];
}): Promise<void> {
  const task = await runtime.db.claimNextTask(run.runId, 'idx-worker', { leaseMs: 60_000 });
  if (!task) throw new Error('no claimable task to hang the artifact on');
  const payload = JSON.stringify(
    {
      source: input.source,
      sourceHash: input.sourceHash,
      pageCount: input.pages.length,
      pages: input.pages,
      parser: input.parser,
    },
    null,
    2,
  );
  const staged = await runtime.store.stage('parsed-paper', payload, {
    filename: 'parsed-paper.json',
  });
  await runtime.db.beginCommit({
    taskId: task.taskId,
    workerId: 'idx-worker',
    attempt: task.attempt,
    artifacts: [
      {
        kind: 'parsed-paper',
        tempPath: staged.tempPath,
        contentHash: staged.contentHash,
        size: staged.size,
        meta: staged.meta,
      },
    ],
    result: { summary: 'indexed fixture', artifacts: [] },
  });
  await runtime.store.promote([staged]);
  await runtime.db.finalizeCommit({ taskId: task.taskId, workerId: 'idx-worker' });
}

describe('sanitizeFtsQuery', () => {
  it('quotes every term and neutralizes operator injection', () => {
    expect(sanitizeFtsQuery('transformer attention')).toBe('"transformer" "attention"');
    // Input term `foo"` becomes `"foo"""` (quote doubled, then wrapped).
    expect(sanitizeFtsQuery('foo" OR bar')).toBe('"foo""" "OR" "bar"');
    expect(sanitizeFtsQuery('  spaced   out  ')).toBe('"spaced" "out"');
    expect(sanitizeFtsQuery('   ')).toBe('');
    expect(sanitizeFtsQuery('NEAR(a,b)')).toBe('"NEAR(a,b)"');
  });
});

describe('paper index refresh + search', () => {
  it('indexes committed parsed papers and finds page-level hits', async () => {
    await commitParsedPaper({
      source: 'incoming/attention.pdf',
      sourceHash: `sha256:${'a'.repeat(64)}`,
      parser: 'pypdf/7.0.0',
      pages: [
        { page: 1, text: 'The transformer relies purely on attention mechanisms.' },
        { page: 2, text: 'Recurrence is completely dispensable.' },
      ],
    });
    await commitParsedPaper({
      source: 'incoming/convnet.pdf',
      sourceHash: `sha256:${'b'.repeat(64)}`,
      parser: 'pypdf/7.0.0',
      pages: [{ page: 1, text: 'Convolutional networks exploit spatial locality.' }],
    });

    const refresh = await refreshPaperIndex(runtime.db, runtime.store);
    expect(refresh).toEqual({ indexed: 2, skipped: 0, removed: 0 });

    const attention = await runtime.db.searchPapers('attention');
    expect(attention).toHaveLength(1);
    expect(attention[0]!.source).toBe('incoming/attention.pdf');
    expect(attention[0]!.page).toBe(1);
    expect(attention[0]!.snippet.toLowerCase()).toContain('attention');

    const locality = await runtime.db.searchPapers('locality');
    expect(locality).toHaveLength(1);
    expect(locality[0]!.source).toBe('incoming/convnet.pdf');

    // Porter stemming: "dispensing"-like queries match the stem.
    const recurrence = await runtime.db.searchPapers('recurrence');
    expect(recurrence[0]!.page).toBe(2);

    // Multi-term AND semantics.
    const both = await runtime.db.searchPapers('transformer attention');
    expect(both).toHaveLength(1);
    const none = await runtime.db.searchPapers('transformer locality');
    expect(none).toHaveLength(0);
  });

  it('is incremental: unchanged papers are skipped on refresh', async () => {
    await commitParsedPaper({
      source: 'incoming/a.pdf',
      sourceHash: `sha256:${'c'.repeat(64)}`,
      parser: 'pypdf/7.0.0',
      pages: [{ page: 1, text: 'incremental content' }],
    });
    expect(await refreshPaperIndex(runtime.db, runtime.store)).toEqual({
      indexed: 1,
      skipped: 0,
      removed: 0,
    });
    expect(await refreshPaperIndex(runtime.db, runtime.store)).toEqual({
      indexed: 0,
      skipped: 1,
      removed: 0,
    });
    // Forced rebuild reprocesses but keeps one generation.
    expect(await refreshPaperIndex(runtime.db, runtime.store, { force: true })).toEqual({
      indexed: 1,
      skipped: 0,
      removed: 0,
    });
    expect(await runtime.db.listIndexedPapers()).toHaveLength(1);
    const hits = await runtime.db.searchPapers('incremental');
    expect(hits).toHaveLength(1);
  });

  it('replaces stale generations when a source re-parses to new content', async () => {
    await commitParsedPaper({
      source: 'incoming/a.pdf',
      sourceHash: `sha256:${'d'.repeat(64)}`,
      parser: 'pypdf/7.0.0',
      pages: [{ page: 1, text: 'old generation wording' }],
    });
    await refreshPaperIndex(runtime.db, runtime.store);

    // Same source, new content hash (user replaced the PDF).
    await commitParsedPaper({
      source: 'incoming/a.pdf',
      sourceHash: `sha256:${'e'.repeat(64)}`,
      parser: 'pypdf/7.0.0',
      pages: [{ page: 1, text: 'new generation wording' }],
    });
    const refresh = await refreshPaperIndex(runtime.db, runtime.store);
    expect(refresh.indexed).toBe(1);
    // Source swap drops the old generation inside replacePaperIndex itself.
    expect(refresh.removed).toBe(0);

    expect(await runtime.db.listIndexedPapers()).toHaveLength(1);
    expect(await runtime.db.searchPapers('old')).toHaveLength(0);
    expect(await runtime.db.searchPapers('new')).toHaveLength(1);
  });

  it('lists indexed papers for status/report views', async () => {
    await commitParsedPaper({
      source: 'incoming/meta.pdf',
      sourceHash: `sha256:${'f'.repeat(64)}`,
      parser: 'pypdf/7.0.0',
      pages: [{ page: 1, text: 'meta page' }],
    });
    await refreshPaperIndex(runtime.db, runtime.store);
    const metas = await runtime.db.listIndexedPapers();
    expect(metas).toHaveLength(1);
    expect(metas[0]!.source).toBe('incoming/meta.pdf');
    expect(metas[0]!.pageCount).toBe(1);
  });
});

describe('CLI: search', () => {
  function runCli(
    cwd: string,
    args: string[],
    timeoutMs = 30_000,
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

  it('finds page hits for a parsed fixture (skips without python)', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { makeFixturePdf } = await import('../src/knowledge/pdf.js');

    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-search-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    const pdfPath = join(dir, 'incoming', 'attention.pdf');
    try {
      await makeFixturePdf(pdfPath);
    } catch {
      return; // python/pypdf unavailable
    }
    const runResult = await runCli(dir, [
      'run',
      '--question',
      'search me',
      '--paper',
      pdfPath,
      '--json',
    ]);
    expect(runResult.code).toBe(0);
    expect((JSON.parse(runResult.stdout) as { status: string }).status).toBe('COMPLETED');

    const search = await runCli(dir, ['search', 'attention', '--json']);
    expect(search.code).toBe(0);
    const payload = JSON.parse(search.stdout) as {
      refresh: { indexed: number };
      hits: { source: string; page: number; snippet: string }[];
    };
    expect(payload.refresh.indexed).toBe(1);
    expect(payload.hits.length).toBeGreaterThan(0);
    expect(payload.hits[0]!.source).toBe('incoming/attention.pdf');
    expect(payload.hits[0]!.page).toBe(1);

    const text = await runCli(dir, ['search', 'attention']);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('incoming/attention.pdf');
  }, 90_000);
});
