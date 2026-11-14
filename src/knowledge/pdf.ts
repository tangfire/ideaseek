import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IdeaseekError, type IdeaseekErrorCode } from '../core/errors.js';
import { killTreeSafe } from '../core/proc.js';

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

let cachedPython: string | null | undefined;

/**
 * Interpreter preference: the isolated worker venv (pinned wheels incl.
 * stable onnxruntime for OCR) first, then system python3/python.
 */
export async function pythonBinary(): Promise<string> {
  if (cachedPython) return cachedPython;
  const venvCandidate =
    process.platform === 'win32'
      ? join(workerPythonDir(), '.venv', 'Scripts', 'python.exe')
      : join(workerPythonDir(), '.venv', 'bin', 'python');
  for (const candidate of [venvCandidate, 'python3', 'python']) {
    if (!candidate) continue;
    const probe = await probePython(candidate);
    if (probe) {
      cachedPython = probe;
      return probe;
    }
  }
  throw new IdeaseekError('ENV_UNSUPPORTED', 'no python interpreter found for the worker');
}

async function probePython(candidate: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(candidate, ['--version'], { stdio: 'ignore' });
    } catch {
      resolve(null);
      return;
    }
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? candidate : null));
  });
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
/**
 * Parse budget scaled to file size. A fixed 60s is a silent correctness bug:
 * large camera-ready PDFs (tens of MB for a dozen pages, dense vector
 * graphics) then never parse, so the paper stays at whatever the first
 * attempt produced and the extractor can never improve it.
 */
export async function parseTimeoutMs(pdfPath: string, explicit?: number): Promise<number> {
  if (explicit !== undefined && Number.isFinite(explicit)) return explicit;
  const { stat } = await import('node:fs/promises');
  const bytes = await stat(pdfPath)
    .then((info) => info.size)
    .catch(() => 0);
  const megabytes = bytes / (1024 * 1024);
  // ~6s per megabyte, floor 60s, capped at 15 minutes so a pathological
  // input fails with a reported timeout instead of wedging the worker.
  return Math.min(900_000, Math.max(60_000, Math.round(megabytes * 6_000)));
}

export async function parsePdf(pdfPath: string, opts: ParsePdfOptions = {}): Promise<ParsedPdf> {
  const python = opts.pythonBin ?? (await pythonBinary());
  const cwd = workerPythonDir();
  const timeoutMs = await parseTimeoutMs(pdfPath, opts.timeoutMs);

  return new Promise<ParsedPdf>((resolvePromise, reject) => {
    const child = spawn(python, ['-m', 'ideaseek_worker', 'parse', pdfPath], {
      cwd,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      killTreeSafe(child.pid);
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
      killTreeSafe(child.pid);
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

export interface OcrResult {
  source: string;
  pageCount: number;
  pages: ParsedPage[];
  parser: string;
  /** Pages beyond the OCR cap that were not processed. */
  ocrPagesTruncated: number;
}

/**
 * Image-based OCR fallback (rapidocr + pypdfium2 in the worker venv) for
 * scanned PDFs that parsePdf reports as NO_TEXT_LAYER. Same strict JSON
 * protocol; OCR is capped (20 pages) and PARSER_MISSING means the venv was
 * not provisioned — the caller flags the paper instead of crashing.
 */
export async function ocrPdf(pdfPath: string, opts: ParsePdfOptions = {}): Promise<OcrResult> {
  const python = opts.pythonBin ?? (await pythonBinary());
  const cwd = workerPythonDir();
  const timeoutMs = opts.timeoutMs ?? 300_000;

  return new Promise<OcrResult>((resolvePromise, reject) => {
    const child = spawn(python, ['-m', 'ideaseek_worker', 'ocr', pdfPath], {
      cwd,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      killTreeSafe(child.pid);
      reject(new IdeaseekError('PARSE_FAILED', 'OCR timed out'));
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
          resolvePromise(JSON.parse(line) as OcrResult);
        } catch (error) {
          reject(
            new IdeaseekError(
              'PARSE_FAILED',
              `cannot parse OCR output: ${(error as Error).message}`,
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
          payload?.message ?? 'OCR failed',
        ),
      );
    });
  });
}
