import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Of } from '../core/hash.js';
import { redactSecrets } from '../core/redact.js';
import { assertAgainstSchema } from '../core/schema/index.js';
import type { HarnessAdapter } from '../dsh/adapter.js';

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

export const RUN_STRATEGY_SCHEMA = 'run-strategy-v1';

export const STRATEGY_INSTRUCTION = `You are IdeaSeek's run strategy judge. A research run is being created; choose its evidence tier from the input scale and the research question.

Output ONLY one JSON object:
{"strategy": "...", "rationale": "..."}

strategy — exactly one of: starter, standard, research.
- starter: small exploratory corpus; conclusions are directional only.
- standard: mid-scale corpus; conclusions scoped to the input snapshot.
- research: large corpus under high evidence demands; the report must list uncovered ranges and evidence gaps.

The input carries "prior", the mechanical tier from file-count thresholds. Confirm it when the scale says the same; override it when the question or the counts say the heuristic misjudged the project (a narrow replication over many files is not a research-scale survey; a focused question with ten papers is not automatically starter work).
rationale — one sentence justifying the choice, at most 200 characters, no secret values.`;

export interface StrategyChoice {
  strategy: RunStrategy;
  /** How the tier was decided: explicit config, the agent, or the scale rule. */
  source: 'config' | 'agent' | 'thresholds';
  rationale?: string;
}

/** Validates one agent tier choice against the schema; null on anything unusable. */
export function parseStrategyChoice(
  output: string,
): { strategy: RunStrategy; rationale?: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  try {
    assertAgainstSchema(RUN_STRATEGY_SCHEMA, parsed);
  } catch {
    return null;
  }
  const record = parsed as { strategy: RunStrategy; rationale?: string };
  const choice: { strategy: RunStrategy; rationale?: string } = { strategy: record.strategy };
  if (typeof record.rationale === 'string' && record.rationale.trim()) {
    const rationale = redactSecrets(record.rationale).slice(0, 300).trim();
    if (rationale) choice.rationale = rationale;
  }
  return choice;
}

/**
 * Chooses the run's evidence tier (P2 判断面 agent 化): explicit
 * `research.mode` is a decision, not a judgment, and always wins without a
 * model call. In `auto`, the agent sees the counts, the question and the
 * threshold rule's answer as `prior`, and may confirm or override it; no
 * harness, a harness failure, or invalid output all fall back to
 * `resolveStrategy`, so the documented scale policy remains the floor.
 */
export async function chooseStrategy(opts: {
  mode: string;
  counts: InputCounts;
  question: string;
  harness?: HarnessAdapter | null;
  runId?: string;
}): Promise<StrategyChoice> {
  if (opts.mode === 'starter' || opts.mode === 'standard' || opts.mode === 'research') {
    return { strategy: opts.mode, source: 'config' };
  }
  const prior = resolveStrategy(opts.mode, opts.counts);
  if (!opts.harness) return { strategy: prior, source: 'thresholds' };
  const context = JSON.stringify({
    counts: opts.counts,
    question: opts.question.slice(0, 500),
    prior,
  });
  try {
    await opts.harness.initialize();
    const result = await opts.harness.runTask({
      runId: opts.runId ?? 'strategy-select',
      taskId: 'strategy-select',
      // Tool-less reasoning: this call weighs counts and a question and
      // returns JSON; it must not gain tools to inspect the corpus.
      profile: 'demo',
      instruction: STRATEGY_INSTRUCTION,
      inputs: [{ kind: 'text', name: 'project-scale', content: context }],
      outputSchema: RUN_STRATEGY_SCHEMA,
      budget: { timeoutMs: 30_000, maxOutputTokens: 300 },
      idempotencyKey: `strategy:${sha256Of(context)}`,
    });
    const choice = parseStrategyChoice(result.output);
    if (choice) {
      return {
        strategy: choice.strategy,
        source: 'agent',
        ...(choice.rationale ? { rationale: choice.rationale } : {}),
      };
    }
  } catch {
    // Harness unavailable, blocked or timed out: the scale rule stands.
  }
  return { strategy: prior, source: 'thresholds' };
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
