import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { findProjectRoot } from '../../config/paths.js';

/**
 * Lightweight, read-only workspace summary rendered under the startup wordmark
 * so a new user immediately sees what materials and credentials are ready
 * without spawning extra CLI probes.
 */

export interface WorkspaceGreetingStats {
  isProject: boolean;
  papers: number;
  datasets: number;
  comparisons: number;
  ideas: number;
  hasKeyEnv: boolean;
}

async function countVisibleEntries(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => !e.name.startsWith('.') && !e.name.startsWith('_')).length;
  } catch {
    return 0;
  }
}

async function hasDotEnvKey(root: string): Promise<boolean> {
  try {
    await access(join(root, '.env'));
    return true;
  } catch {
    return false;
  }
}

export async function probeWorkspaceGreeting(cwd: string): Promise<WorkspaceGreetingStats> {
  const root = await findProjectRoot(cwd).catch(() => null);
  const keyInProcess = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
  if (!root) {
    return {
      isProject: false,
      papers: 0,
      datasets: 0,
      comparisons: 0,
      ideas: 0,
      hasKeyEnv: keyInProcess || (await hasDotEnvKey(cwd)),
    };
  }
  const [papers, datasets, comparisons, ideas, dotEnv] = await Promise.all([
    countVisibleEntries(join(root, 'papers')),
    countVisibleEntries(join(root, 'datasets')),
    countVisibleEntries(join(root, 'comparisons')),
    countVisibleEntries(join(root, 'ideas')),
    hasDotEnvKey(root),
  ]);
  return {
    isProject: true,
    papers,
    datasets,
    comparisons,
    ideas,
    hasKeyEnv: keyInProcess || dotEnv,
  };
}

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';

export function formatWelcomeLines(stats: WorkspaceGreetingStats, plain = false): string[] {
  const dim = (s: string) => (plain ? s : `${DIM}${s}${RESET}`);
  const cyan = (s: string) => (plain ? s : `${CYAN}${s}${RESET}`);
  const keyStatus = stats.hasKeyEnv
    ? plain
      ? 'model key: ready'
      : `${GREEN}model key: ready${RESET}`
    : plain
      ? 'model key: not set (/models setup)'
      : `${YELLOW}model key: not set${RESET} ${dim('(/models setup)')}`;

  if (!stats.isProject) {
    return [
      dim(`workspace: no project here · ${keyStatus}`),
      dim(
        `quick start: ${cyan('/init')} create project · ${cyan('/open')} switch project · ${cyan('/agent <task>')} coding turn · ${cyan('?')} shortcuts`,
      ),
    ];
  }
  const counts = `papers ${stats.papers} · datasets ${stats.datasets} · comparisons ${stats.comparisons} · ideas ${stats.ideas}`;
  return [
    dim(`workspace: ${counts} · `) + keyStatus,
    dim(
      `tips: ${cyan('/next')} advice · ${cyan('/')} commands · ${cyan('@')} mention files · ${cyan('?')} shortcuts`,
    ),
  ];
}
