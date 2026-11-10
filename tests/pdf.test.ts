import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { makeFixturePdf, parsePdf, workerPythonDir } from '../src/knowledge/pdf.js';
import { isIdeaseekError } from '../src/core/errors.js';

const created: string[] = [];

afterAll(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

async function fixtureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ideaseek-pdf-'));
  created.push(dir);
  return dir;
}

describe('python pdf bridge', () => {
  it('selftest proves the worker environment (skips when python/pypdf missing)', async () => {
    const { spawn } = await import('node:child_process');
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn('python', ['-m', 'ideaseek_worker', 'selftest'], {
        cwd: workerPythonDir(),
        stdio: 'ignore',
      });
      child.on('error', () => resolve(null));
      child.on('close', (exit) => resolve(exit));
    });
    if (code === null) return; // no python on PATH: environment guard, not a failure
    expect(code).toBe(0);
  }, 60_000);

  it('parses a generated fixture into 1-based pages (skips without python)', async () => {
    const dir = await fixtureDir();
    const pdfPath = join(dir, 'fixture.pdf');
    try {
      await makeFixturePdf(pdfPath);
    } catch {
      return; // python/pypdf unavailable
    }
    const parsed = await parsePdf(pdfPath);
    expect(parsed.pageCount).toBe(2);
    expect(parsed.pages.map((page) => page.page)).toEqual([1, 2]);
    expect(parsed.pages[0]!.text).toContain('Evidence Page One');
    expect(parsed.pages[1]!.text).toContain('Evidence Page Two');
    expect(parsed.parser).toMatch(/^pypdf\//);
  }, 60_000);

  it('maps missing files to FILE_NOT_FOUND with a structured error', async () => {
    const dir = await fixtureDir();
    try {
      await makeFixturePdf(join(dir, 'probe.pdf'));
    } catch {
      return; // python/pypdf unavailable
    }
    try {
      await parsePdf(join(dir, 'absent.pdf'));
      expect.unreachable('parse should fail');
    } catch (error) {
      expect(isIdeaseekError(error)).toBe(true);
      if (isIdeaseekError(error)) {
        expect(error.code).toBe('FILE_NOT_FOUND');
      }
    }
  }, 60_000);

  it('maps non-PDF content to PARSE_FAILED', async () => {
    const dir = await fixtureDir();
    const { writeFile } = await import('node:fs/promises');
    const junk = join(dir, 'junk.pdf');
    await writeFile(junk, 'definitely not a pdf');
    try {
      await parsePdf(junk);
      expect.unreachable('parse should fail');
    } catch (error) {
      if (isIdeaseekError(error) && error.code === 'ENV_UNSUPPORTED') return; // no python
      expect(isIdeaseekError(error)).toBe(true);
      if (isIdeaseekError(error)) expect(error.code).toBe('PARSE_FAILED');
    }
  }, 60_000);
});
