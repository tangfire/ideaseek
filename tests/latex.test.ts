import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LATEX_PARSER_VERSION, parseLatex } from '../src/knowledge/latex.js';
import { paperLatex } from '../src/worker/paper-handlers.js';
import { CLI_BIN, createDemoRun, makeProjectDir, openRuntime } from './helpers.js';
import type { TaskContext } from '../src/worker/types.js';

const SAMPLE = String.raw`
% a leading comment that must vanish
\documentclass{article}
\title{On Widgets \& Gadgets}
\begin{document}
\section{Introduction}
Widgets are central to this study. We define a widget as a tuple $(w, s)$.
\subsection{Prior work}
Prior work \cite{alpha,beta} ignored gadgets entirely.
\section{Experiments}
Accuracy reached 91.2\% on the gadget benchmark.
\end{document}
`;

describe('parseLatex', () => {
  it('strips comments and control sequences but keeps readable content', () => {
    const doc = parseLatex(SAMPLE);
    expect(doc.parser).toBe(LATEX_PARSER_VERSION);
    expect(doc.title).toBe('On Widgets & Gadgets');
    expect(doc.text).not.toContain('documentclass');
    expect(doc.text).not.toContain('a leading comment');
    expect(doc.text).toContain('Widgets are central');
    expect(doc.text).toContain('91.2%');
    expect(doc.text).toContain('Prior work');
    expect(doc.text).not.toContain('\\cite');
  });

  it('splits sections with headings', () => {
    const doc = parseLatex(SAMPLE);
    expect(doc.sections.map((section) => section.heading)).toEqual([
      'Introduction',
      'Prior work',
      'Experiments',
    ]);
    expect(doc.sections[0]!.body).toContain('Widgets are central');
    expect(doc.sections.length).toBeGreaterThan(0);
  });

  it('handles documents without sections or title', () => {
    const doc = parseLatex('Just some plain text with \\macro{kept} braces.');
    expect(doc.title).toBeNull();
    expect(doc.text).toContain('kept');
    expect(doc.text).toContain('braces');
    expect(doc.sections).toHaveLength(0);
  });
});

describe('paper.latex handler', () => {
  it('commits a parsed-paper artifact with a single evidence page', async () => {
    const dir = await makeProjectDir();
    const runtime = await openRuntime(dir, { recover: false });
    try {
      await mkdir(join(dir, 'incoming'), { recursive: true });
      await writeFile(join(dir, 'incoming', 'notes.tex'), SAMPLE);
      const run = await createDemoRun(runtime, 'latex test');
      const task = await runtime.db.claimNextTask(run.runId, 'w1', { leaseMs: 60_000 });
      const ctx: TaskContext = {
        task: task!,
        run,
        payload: { texPath: 'incoming/notes.tex', nonBlocking: true },
        signal: new AbortController().signal,
        runtime,
        log: () => undefined,
      };
      const output = await paperLatex(ctx);
      expect(output.summary).toContain('parsed latex');
      expect(output.artifacts[0]!.kind).toBe('parsed-paper');

      const staged = await runtime.store.stage(
        'parsed-paper',
        output.artifacts[0]!.data,
        output.artifacts[0]!.meta ?? {},
      );
      await runtime.db.beginCommit({
        taskId: task!.taskId,
        workerId: 'w1',
        attempt: task!.attempt,
        artifacts: [
          {
            kind: 'parsed-paper',
            tempPath: staged.tempPath,
            contentHash: staged.contentHash,
            size: staged.size,
            meta: staged.meta,
          },
        ],
        result: { summary: output.summary, artifacts: [] },
      });
      await runtime.store.promote([staged]);
      await runtime.db.finalizeCommit({ taskId: task!.taskId, workerId: 'w1' });

      const rows = await runtime.db.listArtifacts(task!.taskId);
      const payload = JSON.parse(await runtime.store.readFinalText(rows[0]!.contentHash)) as {
        pageCount: number;
        pages: { page: number; text: string }[];
        parser: string;
        sourceHash: string;
      };
      expect(payload.pageCount).toBe(1);
      expect(payload.pages[0]!.text).toContain('Widgets are central');
      expect(payload.parser).toBe(LATEX_PARSER_VERSION);
      expect(payload.sourceHash).toMatch(/^sha256:/);
    } finally {
      await runtime.close();
    }
  }, 60_000);

  it('rejects non-tex and missing paths permanently', async () => {
    const dir = await makeProjectDir();
    const runtime = await openRuntime(dir, { recover: false });
    try {
      const run = await createDemoRun(runtime, 'latex bad');
      const task = await runtime.db.claimNextTask(run.runId, 'w1', { leaseMs: 60_000 });
      const ctx: TaskContext = {
        task: task!,
        run,
        payload: { texPath: 'incoming/../evil.tex' },
        signal: new AbortController().signal,
        runtime,
        log: () => undefined,
      };
      await expect(paperLatex(ctx)).rejects.toMatchObject({ code: 'USER_INPUT_REQUIRED' });
    } finally {
      await runtime.close();
    }
  }, 30_000);
});

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

describe('CLI: ingest .tex sources', () => {
  it('parses LaTeX sources into the shared pipeline and indexes them for search', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-latex-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    await mkdir(join(dir, 'incoming'), { recursive: true });
    await writeFile(join(dir, 'incoming', 'gadgets.tex'), SAMPLE);

    expect((await runCli(dir, ['scan'])).code).toBe(0);
    const ingest = await runCli(dir, ['ingest', '--json'], 120_000);
    expect(ingest.code).toBe(0);
    const payload = JSON.parse(ingest.stdout) as {
      latexEnqueued: number;
      status: string;
      indexed: number;
    };
    expect(payload.latexEnqueued).toBe(1);
    expect(payload.status).toBe('COMPLETED');
    expect(payload.indexed).toBeGreaterThanOrEqual(1);

    // The LaTeX content is searchable through the shared FTS index.
    const search = await runCli(dir, ['search', 'gadget benchmark', '--json']);
    const hits = (JSON.parse(search.stdout) as { hits: { source: string }[] }).hits;
    expect(hits.some((hit) => hit.source.includes('gadgets.tex'))).toBe(true);

    // Incremental: rerun is a no-op.
    const rerun = await runCli(dir, ['ingest', '--json'], 120_000);
    expect(rerun.code).toBe(0);
    expect((JSON.parse(rerun.stdout) as { action?: string }).action).toBe('nothing-to-do');
  }, 240_000);
});

describe('parser currency per source kind', () => {
  it('judges a .tex artifact by the latex version, not the pdf revision', async () => {
    const { parserIsCurrent } = await import('../src/commands/ingest.js');
    const { LATEX_PARSER_VERSION } = await import('../src/knowledge/latex.js');
    // Every artifact this command wrote used to be tested against '+rev2',
    // which is a pdf extractor stamp. That made .tex results permanently
    // stale, so `ingest` re-parsed them and opened a new run each time.
    expect(parserIsCurrent(LATEX_PARSER_VERSION)).toBe(true);
    expect(parserIsCurrent('latex-v0')).toBe(false);
    expect(parserIsCurrent('pypdf+rev2')).toBe(true);
    expect(parserIsCurrent('pypdf+rev1')).toBe(false);
    expect(parserIsCurrent(undefined)).toBe(false);
  });
});
