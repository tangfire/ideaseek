import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IdeaseekError, type IdeaseekErrorCode } from '../core/errors.js';

/** Stable failure codes the python dataset profiler may emit. */
const DATASET_CODES = new Set<string>([
  'FILE_NOT_FOUND',
  'DATASET_LAYOUT',
  'PARSE_FAILED',
  'PARSER_MISSING',
  'INTERNAL',
]);

export interface FederatedClientProfile {
  id: string;
  file: string;
  samples: number;
  xShape: number[];
  xDtype: string;
  yShape: number[];
  yDtype: string;
  labelCounts: Record<string, number>;
}

export interface DatasetSplitProfile {
  dir: string;
  clients: FederatedClientProfile[];
  clientCount: number;
  totalSamples: number;
  sampleStats: { min: number; max: number; mean: number; std: number };
  labelDistribution: Record<string, number>;
}

export interface FederatedDatasetProfile {
  parser: string;
  root: string;
  splits: { train?: DatasetSplitProfile; test?: DatasetSplitProfile };
  clientCount: number;
  nonIid: {
    tvDistanceMean: number;
    tvDistanceMax: number;
    samplesCv: number;
    classesPerClientMean: number;
    interpretation: string;
  };
  files: { rel: string; bytes: number; sha256: string }[];
  fileCount: number;
  rootHash: string;
  readOnly: {
    rootWritableByProcess: boolean;
    sampleWritableByProcess: boolean;
    policy: string;
  };
}

function workerPythonDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'worker', 'python');
}

/**
 * Spawns `python -m ideaseek_worker dataset <root>` — a strictly read-only
 * profiler for external federated datasets (npz client archives). Same JSON
 * protocol as the PDF bridges; never writes to the dataset tree.
 */
export async function profileFederatedDataset(
  datasetRoot: string,
  opts: { timeoutMs?: number; pythonBin?: string } = {},
): Promise<FederatedDatasetProfile> {
  const python =
    opts.pythonBin ??
    (process.platform === 'win32'
      ? join(workerPythonDir(), '.venv', 'Scripts', 'python.exe')
      : join(workerPythonDir(), '.venv', 'bin', 'python'));
  const fallback = ['python3', 'python'];
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const cwd = workerPythonDir();

  const attempt = (interpreter: string): Promise<FederatedDatasetProfile> =>
    new Promise((resolvePromise, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(interpreter, ['-m', 'ideaseek_worker', 'dataset', datasetRoot], {
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
        reject(new IdeaseekError('PARSE_FAILED', 'dataset profiling timed out'));
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
          const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
          try {
            resolvePromise(JSON.parse(line) as FederatedDatasetProfile);
          } catch (error) {
            reject(
              new IdeaseekError(
                'PARSE_FAILED',
                `cannot parse dataset profile: ${(error as Error).message}`,
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
            payload?.code && DATASET_CODES.has(payload.code)
              ? (payload.code as IdeaseekErrorCode)
              : 'PARSE_FAILED',
            payload?.message ?? `dataset profiling failed (exit ${code ?? 'signal'})`,
          ),
        );
      });
    });

  if (!opts.pythonBin) {
    try {
      return await attempt(python);
    } catch (error) {
      if (!(error instanceof IdeaseekError) || error.code !== 'ENV_UNSUPPORTED') throw error;
      let last = error;
      for (const candidate of fallback) {
        try {
          return await attempt(candidate);
        } catch (fallbackError) {
          last = fallbackError as typeof error;
        }
      }
      throw last;
    }
  }
  return attempt(python);
}
