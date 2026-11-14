import { delimiter } from 'node:path';
import { loadConfig } from '../config/config.js';
import { projectPaths } from '../config/paths.js';

/**
 * Portability contract for experiment/comparison child processes.
 *
 * A training entry that hardcodes `D:/...` or `/data/...` cannot move between
 * the author's Windows box, WSL and a Linux server, and IdeaSeek promises all
 * three. Dataset locations therefore arrive through the environment, resolved
 * from the project's own `inputs.readonly_datasets`.
 */
export const RUN_ENV_KEYS = {
  projectRoot: 'IDEASEEK_PROJECT_ROOT',
  datasetRoots: 'IDEASEEK_DATASET_ROOTS',
} as const;

/** Env vars handed to every experiment/comparison entry command. */
export async function buildRunEnv(projectRoot: string): Promise<Record<string, string>> {
  const paths = projectPaths(projectRoot);
  const { resolved } = await loadConfig(paths);
  const env: Record<string, string> = { [RUN_ENV_KEYS.projectRoot]: paths.root };
  const roots = resolved.inputs.readonlyDatasets;
  if (roots.length > 0) {
    env[RUN_ENV_KEYS.datasetRoots] = roots.join(delimiter);
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
