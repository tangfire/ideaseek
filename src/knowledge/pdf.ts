import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IdeaseekError, type IdeaseekErrorCode } from '../core/errors.js';

/** Stable failure codes the python worker may emit (see worker/python/README). */
const PARSER_CODES = new Set<string>([
  'PARSE_FAILED',
  'FILE_NOT_FOUND',
  'EMPTY_FILE',
  'ENCRYPTED_PDF',
  'NO_TEXT_LAYER',
  'PARSER_MISSING',
  'INTERNAL',
]);

export interface ParsedPage {
  /** 1-based page number — the evidence locator for every span. */
  page: number;
  text: string;
}

export interface ParsedPdf {
  source: string;
  pageCount: number;
  pages: ParsedPage[];
  /** e.g. "pypdf/7.0.0" — recorded for provenance and invalidation. */
  parser: string;
}

/** Repository root of the Python worker (src/knowledge or dist/knowledge → ../../worker/python). */
export function workerPythonDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'worker', 'python');
}

async function pythonBinary(): Promise<string> {
  for (const candidate of ['python3', 'python']) {
    const works = await new Promise<boolean>((resolveProbe) => {
      const child = spawn(candidate, ['--version'], { stdio: 'ignore' });
      child.on('error', () => resolveProbe(false));
      child.on('close', (code) => resolveProbe(code === 0));
    });
    if (works) return candidate;
  }
  throw new IdeaseekError(
    'ENV_UNSUPPORTED',
    'no python3/python on PATH; install Python 3.10+ for PDF parsing (ideaseek doctor)',
  );
}

export interface ParsePdfOptions {
  timeoutMs?: number;
  /** Test hook: force a specific interpreter. */
  pythonBin?: string;
}

/**
 * Spawns the Python worker (`python -m ideaseek_worker parse`) and returns
 * its strict JSON result. stdout must be exactly one JSON line; stderr may
 * contain library noise, so error parsing scans lines from the end.
 * The subprocess only receives a file path — no credentials, no DB access.
 */
export async function parsePdf(pdfPath: string, opts: ParsePdfOptions = {}): Promise<ParsedPdf> {
  const python = opts.pythonBin ?? (await pythonBinary());
  const cwd = workerPythonDir();
  const timeoutMs = opts.timeoutMs ?? 60_000;

  return new Promise<ParsedPdf>((resolvePromise, reject) => {
    const child = spawn(python, ['-m', 'ideaseek_worker', 'parse', pdfPath], {
      cwd,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new IdeaseekError('PARSE_FAILED', `pdf parse timed out after ${timeoutMs}ms`, {
          pdfPath,
        }),
      );
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new IdeaseekError('ENV_UNSUPPORTED', `cannot spawn python: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
        try {
          const parsed = JSON.parse(line ?? '') as ParsedPdf;
          if (typeof parsed.pageCount !== 'number' || !Array.isArray(parsed.pages)) {
            reject(new IdeaseekError('PARSE_FAILED', 'python worker returned malformed output'));
            return;
          }
          resolvePromise(parsed);
        } catch (error) {
          reject(
            new IdeaseekError(
              'PARSE_FAILED',
              `cannot parse python worker output: ${(error as Error).message}`,
            ),
          );
        }
        return;
      }
      // Failure: last JSON-looking stderr line carries the stable code.
      let payload: { code?: string; message?: string } | null = null;
      for (const line of stderr.trim().split(/\r?\n/).reverse()) {
        if (!line.startsWith('{')) continue;
        try {
          payload = JSON.parse(line) as { code?: string; message?: string };
          break;
        } catch {
          continue;
        }
      }
      reject(
        new IdeaseekError(
          payload?.code && PARSER_CODES.has(payload.code)
            ? (payload.code as IdeaseekErrorCode)
            : 'PARSE_FAILED',
          payload?.message ??
            `pdf parse failed (exit ${code ?? 'signal'}): ${(stderr.split(/\r?\n/).find((line) => line.trim()) ?? '').slice(0, 160)}`,
          { pdfPath, exitCode: code },
        ),
      );
    });
  });
}

/** Convenience for tests: writes a fixture PDF via the worker CLI. */
export async function makeFixturePdf(outPath: string, marker?: string): Promise<void> {
  const python = await pythonBinary();
  await new Promise<void>((resolvePromise, reject) => {
    const args = ['-m', 'ideaseek_worker', 'make-fixture', outPath];
    if (marker) args.push('--marker', marker);
    const child = spawn(python, args, {
      cwd: workerPythonDir(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`make-fixture failed: ${stderr || `exit ${code}`}`));
    });
  });
}

export interface ExtractedTable {
  page: number;
  rows: string[][];
}

export interface TablesResult {
  source: string;
  tables: ExtractedTable[];
  tableCount: number;
  parser: string;
}

/**
 * Spawns the Python worker `tables` command (pdfplumber). Same strict JSON
 * protocol and error taxonomy as parsePdf; opt-in because layout analysis
 * costs seconds per page.
 */
export async function extractTables(
  pdfPath: string,
  opts: ParsePdfOptions = {},
): Promise<TablesResult> {
  const python = opts.pythonBin ?? (await pythonBinary());
  const cwd = workerPythonDir();
  const timeoutMs = opts.timeoutMs ?? 120_000;

  return new Promise<TablesResult>((resolvePromise, reject) => {
    const child = spawn(python, ['-m', 'ideaseek_worker', 'tables', pdfPath], {
      cwd,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new IdeaseekError('PARSE_FAILED', 'table extraction timed out'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new IdeaseekError('ENV_UNSUPPORTED', `cannot spawn python: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
        try {
          resolvePromise(JSON.parse(line) as TablesResult);
        } catch (error) {
          reject(
            new IdeaseekError(
              'PARSE_FAILED',
              `cannot parse tables output: ${(error as Error).message}`,
            ),
          );
        }
        return;
      }
      let payload: { code?: string; message?: string } | null = null;
      for (const line of stderr.trim().split(/\r?\n/).reverse()) {
        if (!line.startsWith('{')) continue;
        try {
          payload = JSON.parse(line) as { code?: string; message?: string };
          break;
        } catch {
          continue;
        }
      }
      reject(
        new IdeaseekError(
          payload?.code && PARSER_CODES.has(payload.code)
            ? (payload.code as IdeaseekErrorCode)
            : 'PARSE_FAILED',
          payload?.message ?? 'table extraction failed',
        ),
      );
    });
  });
}
