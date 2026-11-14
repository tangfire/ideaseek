import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { makeFixturePdf, parsePdf, parseTimeoutMs, workerPythonDir } from '../src/knowledge/pdf.js';
import { EXPECTED_PARSER_REVISION } from '../src/commands/ingest.js';
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
  it('scales the parse budget with file size instead of failing large PDFs', async () => {
    const { writeFile } = await import('node:fs/promises');
    const dir = await fixtureDir();
    const small = join(dir, 'small.pdf');
    const big = join(dir, 'big.pdf');
    await writeFile(small, Buffer.alloc(1024));
    await writeFile(big, Buffer.alloc(30 * 1024 * 1024));
    expect(await parseTimeoutMs(small)).toBe(60_000); // floor
    expect(await parseTimeoutMs(big)).toBe(180_000); // 30 MiB × 4s + floor
    expect(await parseTimeoutMs(small, 5_000)).toBe(5_000); // explicit wins
    const huge = join(dir, 'huge.pdf');
    await writeFile(huge, Buffer.alloc(400 * 1024 * 1024));
    expect(await parseTimeoutMs(huge)).toBe(900_000); // capped, never wedged
  }, 120_000);

  it('worker parser revision matches what ingest treats as current', async () => {
    // Drift here is silent and expensive: bump the revision in one language
    // only, and either papers never re-parse or they re-parse forever.
    const { spawn } = await import('node:child_process');
    const output = await new Promise<string | null>((resolve) => {
      const child = spawn('python', ['-m', 'ideaseek_worker', 'selftest'], {
        cwd: workerPythonDir(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => (stdout += String(chunk)));
      child.on('error', () => resolve(null));
      child.on('close', (exit) => resolve(exit === 0 ? stdout : null));
    });
    if (output === null) return; // no python/pypdf: environment guard
    const parser = (JSON.parse(output.trim()) as { parser: string }).parser;
    expect(parser).toContain(EXPECTED_PARSER_REVISION);
  }, 60_000);

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
