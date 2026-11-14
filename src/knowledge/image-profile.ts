import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { IdeaseekError, type IdeaseekErrorCode } from '../core/errors.js';
import { assertAgainstSchema } from '../core/schema/index.js';
import type { DatasetProfile } from '../experiment/dataset-card.js';
import { workerPythonDir } from './federated.js';

/**
 * TypeScript side of image-corpus profiling (docs/DATA_CONTRACTS.md). The
 * worker emits `image-profile-v1`; this module validates it at the boundary,
 * maps it onto the DatasetProfile the card and assessment already understand,
 * and keeps the richer structure for protocol synthesis to ground splits in.
 */

export interface ImageGroupValue {
  name: string;
  count: number;
}

export interface ImageProfile {
  schemaVersion: 'image-profile-v1';
  generatedBy: string;
  source: {
    path: string;
    format: 'parquet' | 'parquet-shards' | 'image-dir';
    bytes: number;
    sha256: string;
    columns: string[];
  };
  samples: number;
  grouping: { column: string | null; values: ImageGroupValue[] };
  classes: { column: string | null; values: ImageGroupValue[]; distinct: number };
  imageBytesColumn: string | null;
  resolution: Record<string, unknown>;
  splitRules: string[];
  warnings: string[];
}

const WORKER_CODES = new Set<string>([
  'FILE_NOT_FOUND',
  'DATASET_LAYOUT',
  'PARSE_FAILED',
  'PARSER_MISSING',
  'SCHEMA_VIOLATION',
  'ENV_UNSUPPORTED',
]);

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
      reject(new IdeaseekError('PARSE_FAILED', 'image profiling timed out'));
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
          payload?.code && WORKER_CODES.has(payload.code as IdeaseekErrorCode)
            ? (payload.code as IdeaseekErrorCode)
            : 'PARSE_FAILED',
          payload?.message ?? `image profiling failed (exit ${code ?? 'signal'})`,
        ),
      );
    });
  });
}

/** Profiles one image corpus (directory, parquet file or parquet shards). */
export async function profileImages(
  path: string,
  opts: { timeoutMs?: number; pythonBin?: string } = {},
): Promise<ImageProfile> {
  const cwd = workerPythonDir();
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const args = ['-m', 'ideaseek_worker', 'images', path];
  const venvPython =
    process.platform === 'win32'
      ? join(cwd, '.venv', 'Scripts', 'python.exe')
      : join(cwd, '.venv', 'bin', 'python');
  const interpreters = opts.pythonBin
    ? [opts.pythonBin]
    : [venvPython, 'python3', 'python'].filter(Boolean);

  let stdout = '';
  let lastError: unknown = null;
  for (const interpreter of interpreters) {
    try {
      stdout = await runWorker(interpreter, args, cwd, timeoutMs);
      break;
    } catch (error) {
      lastError = error;
      // Only an unusable interpreter justifies trying the next one; a real
      // profile failure must surface instead of being retried three times.
      if (!(error instanceof IdeaseekError) || error.code !== 'ENV_UNSUPPORTED') throw error;
    }
  }
  if (!stdout) {
    throw (
      lastError ??
      new IdeaseekError('ENV_UNSUPPORTED', 'no usable python interpreter for image profiling')
    );
  }

  const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
  let profile: ImageProfile;
  try {
    profile = JSON.parse(line) as ImageProfile;
  } catch (error) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `cannot parse image profile: ${(error as Error).message}`,
    );
  }
  // Cross-language contract gate, mirroring the federated profiler.
  assertAgainstSchema('image-profile-v1', profile);
  return profile;
}

/**
 * Maps an image profile onto the DatasetProfile the card and assessment
 * already consume, so a downloaded benchmark clears the no-dataset gap without
 * every reader learning about the new format.
 */
export function imageProfileToDatasetProfile(
  profile: ImageProfile,
  opts: { now: number; generatedBy: string },
): DatasetProfile {
  const labelColumn = profile.classes.column;
  const groupColumn = profile.grouping.column;
  const columns = [
    {
      name: labelColumn ?? 'class',
      missing: 0,
      distinct: profile.classes.distinct,
      numeric: /^\d+$/.test(profile.classes.values[0]?.name ?? ''),
      samples: profile.classes.values.slice(0, 3).map((item) => `${item.name} (${item.count})`),
    },
    ...(groupColumn
      ? [
          {
            name: groupColumn,
            missing: 0,
            distinct: profile.grouping.values.length,
            numeric: false,
            samples: profile.grouping.values.slice(0, 3).map((item) => item.name),
          },
        ]
      : []),
  ];
  return {
    datasetSnapshotId: `data-${profile.source.sha256.slice(7, 19)}`,
    source: {
      path: profile.source.path,
      bytes: profile.source.bytes,
      sha256: profile.source.sha256,
      format: profile.source.format,
    },
    rows: profile.samples,
    columns,
    quality: { missingCells: 0, duplicateRows: 0, constantColumns: [] },
    labelCandidates: labelColumn
      ? [
          {
            column: labelColumn,
            confidence: 0.9,
            basis: `image corpus class column ${labelColumn} (${profile.classes.distinct} distinct)`,
          },
        ]
      : [],
    licenseHint: null,
    generatedAt: opts.now,
    generatedBy: opts.generatedBy,
  };
}
