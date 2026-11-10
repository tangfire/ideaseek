import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export type RunStrategy = 'starter' | 'standard' | 'research';

export interface InputCounts {
  papers: number;
  datasets: number;
  comparisons: number;
}

const SKIP_DIRS = new Set(['.research', 'node_modules', '.git', '__pycache__', '.venv', 'venv']);

async function countFilesRecursive(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      total += await countFilesRecursive(join(dir, entry.name));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      total += 1;
    }
  }
  return total;
}

async function countFirstLevel(
  dir: string,
  opts: { dirsOnly: boolean; skip?: string[] },
): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (opts.skip?.includes(entry.name)) continue;
    if (opts.dirsOnly && !entry.isDirectory()) continue;
    total += 1;
  }
  return total;
}

/**
 * Cheap input scale probe for strategy selection: paper files are counted
 * recursively, datasets/comparisons by their first-level units (a dataset or
 * method is a directory, not every file inside it). No hashing, no writes.
 */
export async function countInputs(
  projectRoot: string,
  dirs: { papers: string; datasets: string; comparisons: string },
): Promise<InputCounts> {
  const [papers, datasets, comparisons] = await Promise.all([
    countFilesRecursive(join(projectRoot, dirs.papers)),
    countFirstLevel(join(projectRoot, dirs.datasets), { dirsOnly: false }),
    countFirstLevel(join(projectRoot, dirs.comparisons), { dirsOnly: true, skip: ['_candidates'] }),
  ]);
  return { papers, datasets, comparisons };
}

/**
 * Chooses the run strategy (docs/WORKFLOW_SPEC.md): an explicit
 * `research.mode` always wins; `auto` adapts to input scale. The strategy
 * changes default budgets/wording only — never evidence, audit or safety
 * requirements.
 */
export function resolveStrategy(mode: string, counts: InputCounts): RunStrategy {
  if (mode === 'starter' || mode === 'standard' || mode === 'research') return mode;
  if (counts.papers < 10 && counts.datasets <= 1 && counts.comparisons === 0) return 'starter';
  if (counts.papers < 50) return 'standard';
  return 'research';
}

export interface StrategyWording {
  label: string;
  /** How results must be phrased in reports for this strategy. */
  disclaimer: string;
}

/**
 * Report phrasing per strategy (docs/WORKFLOW_SPEC.md §门槛): starter
 * conclusions are directional only; research demands coverage statements.
 */
export const STRATEGY_WORDING: Record<RunStrategy, StrategyWording> = {
  starter: {
    label: 'starter（少量论文/单数据集探索）',
    disclaimer:
      '本 run 采用 starter 策略：证据等级较低，结论仅用于方向筛选，不构成对已有方法的优越性主张；扩大结论前请补充论文与对比材料并以 standard/research 策略重跑。',
  },
  standard: {
    label: 'standard（中等规模常规研究）',
    disclaimer:
      '本 run 采用 standard 策略：覆盖中等规模语料；结论适用于当前输入快照，外推到未覆盖数据前需要额外验证。',
  },
  research: {
    label: 'research（大规模高证据要求）',
    disclaimer:
      '本 run 采用 research 策略：按高覆盖与证据要求执行；报告必须列出未覆盖范围与证据缺口，不得把通过项表述为全领域结论。',
  },
};

export function strategyWording(strategy: string): StrategyWording {
  return STRATEGY_WORDING[strategy as RunStrategy] ?? STRATEGY_WORDING.standard;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
