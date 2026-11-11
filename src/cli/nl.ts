/**
 * Deterministic natural-language intents for the REPL (PRODUCT_GAPS #1,
 * Journey E, USER_JOURNEY). No model is involved: queries are answered from
 * persisted state through the SAME CLI use-cases; anything that would change
 * priorities, budgets, comparisons or hypotheses is never executed — it is
 * recorded as a pending-approval Decision the user reviews explicitly.
 * Free text can never bypass task state, budget or permission gates.
 */

export type NlIntent =
  | { kind: 'query'; label: string; cliArgs: string[] }
  | { kind: 'pending-action'; summary: string; reason: string }
  | { kind: 'unknown'; hint: string };

const QUERY_RULES: { test: RegExp; label: string; args: () => string[] }[] = [
  { test: /^(为什么|why)\b/i, label: 'why-explanation', args: () => ['next'] },
  { test: /^(下一步|next|接下来|建议|suggest)/i, label: 'next', args: () => ['next'] },
  {
    test: /^(状态|status|进度|怎么样|how)(\s+(is|are))?\s*(it|things)?$/i,
    label: 'status',
    args: () => ['status'],
  },
  { test: /^(帮助|help|你能做什么|what can you do)/i, label: 'help', args: () => ['--help'] },
  {
    test: /对比|comparison.*(状态|gate|通过)|为什么.*(比较|基线|baseline)/i,
    label: 'comparisons',
    args: () => ['comparison', 'list'],
  },
  {
    test: /(idea|点子|想法).*(状态|列表|status|list)/i,
    label: 'ideas',
    args: () => ['idea', 'list'],
  },
  {
    test: /(实验|experiments?).*(状态|列表|结果)/i,
    label: 'experiments',
    args: () => ['experiment', 'list'],
  },
  { test: /(论文|papers?).*(进度|数量|status|list)/i, label: 'papers', args: () => ['papers'] },
  { test: /\bmodels?\b|\broutes?\b|模型/i, label: 'models', args: () => ['models'] },
];

const ACTION_RULES: { test: RegExp; reason: string }[] = [
  { test: /优先|priority|先验证|不要再给/, reason: 'priority change' },
  { test: /预算|budget|GPU\s*(小时|hours?|h)\b|限制在/, reason: 'budget change' },
  {
    test: /(排除|exclud).*(comparison|方法|基线)|comparison.*(排除|不适用)/,
    reason: 'comparison exclusion',
  },
  { test: /(换|改变|修改).*(假设|hypothesis)|新假设/, reason: 'hypothesis change' },
  { test: /(暂停|pause|停).*(idea|点子)/, reason: 'idea pause request' },
];

const ID_HINT = /([a-z0-9]+(-[a-z0-9]+)+)/i; // kebab-ish id anywhere in the query

/**
 * Classifies raw REPL input. Order: explicit slash handled by caller;
 * here we try queries first (read-only), then high-impact actions
 * (pending decision), then unknown guidance.
 */
export function interpretInput(input: string): NlIntent {
  const text = input.trim();
  if (!text) return { kind: 'unknown', hint: 'empty input — /help lists commands' };

  // High-impact action phrases become pending decisions, never executions.
  for (const rule of ACTION_RULES) {
    if (rule.test.test(text)) {
      return {
        kind: 'pending-action',
        summary: text,
        reason: rule.reason,
      };
    }
  }

  // Targeted id queries: "<id> 的状态/为什么" → dedicated views.
  const idMatch = text.match(ID_HINT);
  if (idMatch && /(状态|status|为什么|why|怎么|通过|gate|blocked)/i.test(text)) {
    const id = idMatch[1]!;
    if (/为什么|why|怎么|通过|blocked/i.test(text)) {
      // Explanations resolve through `next` (state-aware blockers) plus the
      // object's own listing so the answer cites persisted facts.
      return { kind: 'query', label: 'explain-target', cliArgs: ['next'] };
    }
    return { kind: 'query', label: 'show-target', cliArgs: ['idea', 'show', id] };
  }

  for (const rule of QUERY_RULES) {
    if (rule.test.test(text)) {
      return { kind: 'query', label: rule.label, cliArgs: rule.args() };
    }
  }

  // "why <something>" without other structure → state-aware next advice.
  if (/^(为什么|why)\b/i.test(text)) {
    return { kind: 'query', label: 'why-explanation', cliArgs: ['next'] };
  }

  return {
    kind: 'unknown',
    hint:
      'not sure how to handle that — /help lists commands; queries like ' +
      '"为什么 method-x 还没通过" or "优先验证 idea-001" work out of the box',
  };
}
