import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { IdeaseekError, type IdeaseekErrorCode } from '../core/errors.js';
import { assertAgainstSchema } from '../core/schema/index.js';
import { workerPythonDir } from './federated.js';

/**
 * Turns an acquired corpus into the on-disk layout experiments read. The
 * worker does the writing; this module is the product-facing door and the
 * contract gate, so a materialization that cannot be traced back to its
 * source never reaches an experiment.
 */
export interface MaterializationReport {
  schemaVersion: 'materialization-report-v1';
  generatedBy: string;
  status: 'ok';
  source: string;
  sourceHash: string;
  outDir: string;
  manifest: string;
  manifestHash: string;
  scale: 'smoke' | 'quick' | 'standard';
  seed: number;
  columns: { image: string; group: string; label: string };
  totalSourceRows: number;
  materializedSamples: number;
  perDomain: Record<string, number>;
  domains: number;
  bytes: number;
  readOnlySourcePreserved: true;
  already?: boolean;
}

const WORKER_CODES = new Set<string>([
  'FILE_NOT_FOUND',
  'DATASET_LAYOUT',
  'PARSE_FAILED',
  'PARSER_MISSING',
  'SCHEMA_VIOLATION',
  'ENV_UNSUPPORTED',
]);

/**
 * Interpreter fallback happens only for an unusable interpreter. A real
 * failure surfaces instead of being retried three times, which would hide the
 * cause behind whichever attempt happened to be last.
 */
export async function materializeCorpus(
  parquetPath: string,
  outDir: string,
  opts: { scale?: MaterializationReport['scale']; seed?: number; timeoutMs?: number } = {},
): Promise<MaterializationReport> {
  const cwd = workerPythonDir();
  const args = [
    '-m',
    'ideaseek_worker',
    'materialize',
    resolve(parquetPath),
    resolve(outDir),
    '--scale',
    opts.scale ?? 'standard',
    '--seed',
    String(opts.seed ?? 42),
  ];
  const venvPython =
    process.platform === 'win32'
      ? join(cwd, '.venv', 'Scripts', 'python.exe')
      : join(cwd, '.venv', 'bin', 'python');
  const interpreters = [venvPython, 'python3', 'python'];
  const timeoutMs = opts.timeoutMs ?? 900_000;

  let stdout = '';
  let lastError: unknown = null;
  for (const interpreter of interpreters) {
    try {
      stdout = await runWorker(interpreter, args, cwd, timeoutMs);
      break;
    } catch (error) {
      lastError = error;
      if (!(error instanceof IdeaseekError) || error.code !== 'ENV_UNSUPPORTED') throw error;
    }
  }
  if (!stdout) {
    throw (
      lastError ??
      new IdeaseekError('ENV_UNSUPPORTED', 'no usable python interpreter for materialization')
    );
  }

  let report: MaterializationReport;
  try {
    report = JSON.parse(
      stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '',
    ) as MaterializationReport;
  } catch (error) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `cannot parse materialization report: ${(error as Error).message}`,
    );
  }
  assertAgainstSchema('materialization-report-v1', report);
  return report;
}

/**
 * Compiles a Python file through the worker. Used to reject a blueprint whose
 * implementation cannot even parse: catching it at authoring keeps a broken
 * artifact out of the worktree, instead of discovering it one reproduce run later.
 */
export async function checkPythonSyntax(
  filePath: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; line?: number; message?: string }> {
  const cwd = workerPythonDir();
  const args = ['-m', 'ideaseek_worker', 'check-syntax', resolve(filePath)];
  const venvPython =
    process.platform === 'win32'
      ? join(cwd, '.venv', 'Scripts', 'python.exe')
      : join(cwd, '.venv', 'bin', 'python');
  let stdout = '';
  let lastError: unknown = null;
  for (const interpreter of [venvPython, 'python3', 'python']) {
    try {
      stdout = await runWorker(interpreter, args, cwd, opts.timeoutMs ?? 30_000);
      break;
    } catch (error) {
      lastError = error;
      if (!(error instanceof IdeaseekError) || error.code !== 'ENV_UNSUPPORTED') throw error;
    }
  }
  if (!stdout) {
    throw lastError ?? new IdeaseekError('ENV_UNSUPPORTED', 'no usable python for syntax check');
  }
  const parsed = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '{}') as {
    ok?: boolean;
    line?: number;
    message?: string;
  };
  return { ok: parsed.ok === true, line: parsed.line, message: parsed.message };
}

function runWorker(
  interpreter: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(interpreter, args, {
        cwd,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(
        new IdeaseekError('ENV_UNSUPPORTED', `cannot spawn python: ${(error as Error).message}`),
      );
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new IdeaseekError('PARSE_FAILED', 'materialization timed out'));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr?.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', () => {
      clearTimeout(timer);
      reject(new IdeaseekError('ENV_UNSUPPORTED', `interpreter not runnable: ${interpreter}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise(stdout);
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
          payload?.code && WORKER_CODES.has(payload.code)
            ? (payload.code as IdeaseekErrorCode)
            : 'PARSE_FAILED',
          payload?.message ?? `materialization failed (exit ${code ?? 'signal'})`,
        ),
      );
    });
  });
}
