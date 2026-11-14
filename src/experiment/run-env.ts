import { delimiter } from 'node:path';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../config/config.js';
import { projectPaths } from '../config/paths.js';

/**
 * Portability contract for experiment/comparison child processes.
 *
 * A training entry that hardcodes `D:/...` or `/data/...` cannot move between
 * the author's Windows box, WSL and a Linux server, and IdeaSeek promises all
 * three. Dataset locations therefore arrive through the environment, resolved
 * from the project's own `inputs.readonly_datasets`.
 *
 * Materialized corpora are included because they are the only usable form of
 * the data: the configured root holds the downloaded parquet, and the image
 * tree the platform derived from it lives elsewhere. Without this, an entry
 * that obeys the contract exactly still finds no samples and reports a present
 * corpus as missing.
 */
export const RUN_ENV_KEYS = {
  projectRoot: 'IDEASEEK_PROJECT_ROOT',
  datasetRoots: 'IDEASEEK_DATASET_ROOTS',
  dataPath: 'IDEASEEK_DATA_PATH',
} as const;

/** Output directories recorded by `data materialize`, oldest first. */
async function materializedRoots(knowledgeDir: string): Promise<string[]> {
  try {
    const ledger = JSON.parse(
      await readFile(join(knowledgeDir, 'materializations.json'), 'utf8'),
    ) as {
      records?: { outDir?: unknown }[];
    };
    return (ledger.records ?? [])
      .map((record) => (typeof record.outDir === 'string' ? record.outDir.trim() : ''))
      .filter((path) => path.length > 0);
  } catch {
    // No ledger: nothing has been materialized yet, which is a normal state.
    return [];
  }
}

/** Env vars handed to every experiment/comparison entry command. */
export async function buildRunEnv(projectRoot: string): Promise<Record<string, string>> {
  const paths = projectPaths(projectRoot);
  const { resolved } = await loadConfig(paths);
  const env: Record<string, string> = { [RUN_ENV_KEYS.projectRoot]: paths.root };
  const roots = [
    ...resolved.inputs.readonlyDatasets,
    ...(await materializedRoots(paths.knowledgeDir)),
  ];
  const unique = [...new Set(roots)];
  if (unique.length > 0) {
    env[RUN_ENV_KEYS.datasetRoots] = unique.join(delimiter);
  }
  return env;
}

/** Merges run env under explicit overrides (a method-local venv wins). */
export async function mergeRunEnv(
  projectRoot: string,
  overrides?: Record<string, string>,
): Promise<Record<string, string>> {
  return { ...(await buildRunEnv(projectRoot)), ...(overrides ?? {}) };
}
