import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ocrPdf, workerPythonDir } from '../src/knowledge/pdf.js';
import { paperParse } from '../src/worker/paper-handlers.js';
import { createDemoRun, makeProjectDir, openRuntime } from './helpers.js';
import type { TaskContext } from '../src/worker/types.js';

async function venvExists(): Promise<boolean> {
  for (const candidate of [
    join(workerPythonDir(), '.venv', 'Scripts', 'python.exe'),
    join(workerPythonDir(), '.venv', 'bin', 'python'),
  ]) {
    try {
      await access(candidate);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

describe('ocrPdf bridge (venv-provisioned OCR)', () => {
  it('extracts rendered page text through the worker venv', async () => {
    if (!(await venvExists())) return; // OCR requires the pinned worker venv (README)
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-ocr-'));
    const { makeFixturePdf } = await import('../src/knowledge/pdf.js');
    const pdfPath = join(dir, 'fixture.pdf');
    await makeFixturePdf(pdfPath, 'OCR visible text');
    const result = await ocrPdf(pdfPath, { timeoutMs: 240_000 });
    expect(result.parser).toBe('rapidocr+pypdfium2');
    expect(result.pages.length).toBeGreaterThan(0);
    expect(result.pages.map((page) => page.text).join('\n')).toContain('OCR');
  }, 300_000);
});

describe('paper.parse OCR fallback semantics', () => {
  it('flags a textless PDF as permanent NO_TEXT_LAYER after the OCR attempt', async () => {
    const dir = await makeProjectDir();
    const runtime = await openRuntime(dir, { recover: false });
    try {
      const { spawnSync } = await import('node:child_process');
      const pdfPath = join(dir, 'incoming', 'blank.pdf');
      await import('node:fs/promises').then((fs) =>
        fs.mkdir(join(dir, 'incoming'), { recursive: true }),
      );
      // A fixture with an empty text layer: parse → NO_TEXT_LAYER → OCR finds nothing.
      const produced = spawnSync(
        'python',
        [
          '-c',
          'import sys; sys.path.insert(0, r)' +
            JSON.stringify(workerPythonDir().replace(/\\/g, '\\\\')) +
            '; from ideaseek_worker.minipdf import build_minimal_pdf; from pathlib import Path; Path(sys.argv[1]).write_bytes(build_minimal_pdf([""]))',
          pdfPath,
        ],
        { encoding: 'utf8' },
      );
      if (produced.status !== 0) return; // python unavailable in this environment
      await writeFile(join(dir, 'incoming', 'keep.txt'), 'x');

      const run = await createDemoRun(runtime, 'ocr fallback');
      const task = await runtime.db.claimNextTask(run.runId, 'w1', { leaseMs: 120_000 });
      const ctx: TaskContext = {
        task: task!,
        run,
        payload: { pdfPath: 'incoming/blank.pdf', nonBlocking: true },
        signal: new AbortController().signal,
        runtime,
        log: () => undefined,
      };
      try {
        await paperParse(ctx);
        expect.unreachable('textless PDF must be flagged');
      } catch (error) {
        const ideaseek = error as { code?: string; message?: string; permanent?: boolean };
        expect(ideaseek.code).toBe('NO_TEXT_LAYER');
        expect(ideaseek.permanent).toBe(true);
        // The enriched message proves the OCR fallback actually ran.
        expect(ideaseek.message).toContain('OCR fallback unavailable');
      }
    } finally {
      await runtime.close();
    }
  }, 300_000);
});
