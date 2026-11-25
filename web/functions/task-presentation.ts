import type { CloudTask } from './engine/cloud-engine.ts';

type Fields = { [key: string]: string | { label: string; fields: Fields } };
type Value = string | number | boolean | Value[] | { [label: string]: Value };

const INPUT: Fields = {
  paper_id: '论文编号',
  paper_text: '论文正文',
  abstract: '论文摘要',
  idea_id: '想法编号',
  comparison_name: '对比方法',
  baseline_name: '基线名称',
  experiment_name: '实验名称',
  discovery_round: '发现轮次',
  round: '轮次',
  index: '序号',
};

const OUTPUT: Fields = {
  paper_id: '论文编号',
  title: '标题',
  problem: '研究问题',
  method_summary: '方法摘要',
  claims: {
    label: '结论记录',
    fields: { text: '内容', confidence: '置信度', evidence_type: '证据类型' },
  },
  unknowns: '未解决问题',
  keywords: '关键词',
  idea_id: '想法编号',
  references_paper_ids: '记录引用的论文编号',
  context_paper_ids: '供模型参考的论文编号',
  hypothesis: '待验证假设',
  mechanism_summary: '机制摘要',
  feasibility: '可行性',
  suggested_experiments: {
    label: '建议实验',
    fields: { name: '名称', purpose: '目的', expected_outcome: '预期结果' },
  },
  calibrated: '已校准',
  strategy: '建议策略',
  feasible: '可行',
  estimated_papers: '预计论文数',
  notes: '说明',
  comparisons: {
    label: '候选对比方法',
    fields: {
      name: '名称',
      type: '来源类型',
      paper_title: '论文标题',
      relevance: '相关性',
      notes: '说明',
    },
  },
  comparison_name: '对比方法',
  baseline_name: '基线名称',
  experiment_name: '实验名称',
  datasets: {
    label: '数据计划',
    fields: { name: '名称', source: '来源说明', role: '用途', size_estimate: '规模估计' },
  },
  preprocessing: '预处理计划',
  splits: { label: '划分计划', fields: { train: '训练', validation: '验证', test: '测试' } },
  risks: '风险',
  metrics: {
    label: '指标定义',
    fields: { name: '名称', definition: '定义', higher_is_better: '越高越好' },
  },
  baselines: '基线计划',
  procedure: '实验步骤',
  screened: '已筛选数',
  advanced: '保留数',
  rejected: '淘汰数',
  note: '说明',
};

// 只投影已知字段；不把任意 payload/result、执行日志或凭据传到浏览器。
function displayValue(
  value: unknown,
  fields?: Fields,
): { value: Value; truncated: boolean } | null {
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((item) => displayValue(item, fields));
    return {
      value: items.filter((item) => item !== null).map((item) => item.value),
      truncated: value.length > 20 || items.some((item) => item?.truncated),
    };
  }
  if (fields) {
    if (value === null || typeof value !== 'object') return null;
    const entries = displayFields(value as Record<string, unknown>, fields);
    return {
      value: Object.fromEntries(entries.map((entry) => [entry.label, entry.value])),
      truncated: entries.some((entry) => entry.truncated),
    };
  }
  if (typeof value === 'string' && value.trim()) {
    return { value: value.slice(0, 2000), truncated: value.length > 2000 };
  }
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
    return { value, truncated: false };
  }
  return null;
}

function displayFields(record: Record<string, unknown> | null, fields: Fields) {
  const result: Array<{ label: string; value: Value; truncated: boolean }> = [];
  if (!record) return result;
  for (const [key, spec] of Object.entries(fields)) {
    const entry = displayValue(record[key], typeof spec === 'string' ? undefined : spec.fields);
    if (entry) result.push({ label: typeof spec === 'string' ? spec : spec.label, ...entry });
  }
  return result;
}

export function presentTask(task: CloudTask) {
  const simulated = task.result?.status === 'simulated';
  const paperVerified = ['paper_text', 'abstract'].some((key) => {
    const value = task.payload?.[key];
    return typeof value === 'string' && value.trim().length > 0;
  });
  const unverified = task.kind === 'analyze_paper' && task.status === 'succeeded' && !paperVerified;
  return {
    external_task_id: task.external_task_id,
    kind: task.kind,
    status:
      task.status === 'succeeded' && simulated
        ? 'simulated'
        : unverified
          ? 'input_unverified'
          : task.status,
    attempt: task.attempt,
    max_attempts: task.max_attempts,
    started_at: task.started_at,
    ended_at: task.ended_at,
    simulated,
    input: displayFields(task.payload, INPUT),
    output: simulated || unverified ? [] : displayFields(task.result, OUTPUT),
  };
}
