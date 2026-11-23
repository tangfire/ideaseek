/**
 * Class A 任务执行器：纯 LLM 推理单元。
 *
 * 每个函数对应 step-driver 里一种 task.kind，输入是任务载荷 + 上下文，
 * 输出是结构化结果（入库 + 写 outbox）。单次执行 ≤45s。
 */
import { callLlm, type LlmCallResult } from './function-llm-adapter.ts';
import type { CloudEngine, CloudRun, CloudTask } from './cloud-engine.ts';

export interface TaskExecutionContext {
  engine: CloudEngine;
  run: CloudRun;
  task: CloudTask;
}

// 粗略成本估算：DeepSeek 约 $0.14/1M input tokens, $0.28/1M output tokens
const COST_PER_1M_INPUT_TOKENS = 0.14;
const COST_PER_1M_OUTPUT_TOKENS = 0.28;

async function recordLlmCost(
  ctx: TaskExecutionContext,
  result: LlmCallResult,
  taskKind: string,
): Promise<void> {
  const inputCost = (result.usage.inputTokens / 1_000_000) * COST_PER_1M_INPUT_TOKENS;
  const outputCost = (result.usage.outputTokens / 1_000_000) * COST_PER_1M_OUTPUT_TOKENS;
  const totalUsd = inputCost + outputCost;
  const usdMicro = Math.round(totalUsd * 1_000_000);

  await ctx.engine.recordCost({
    runId: ctx.run.id,
    kind: taskKind,
    modelRoute: result.model,
    agentRole: ctx.task.agent_role ?? 'engine',
    usdMicro,
    tokensIn: result.usage.inputTokens,
    tokensOut: result.usage.outputTokens,
  });
}

// ---------------------------------------------------------------------------
// analyze_paper：一篇论文 → 一张 PaperCard
// ---------------------------------------------------------------------------

const PAPER_ANALYSIS_SCHEMA = `papercard-v1:
{
  "title": "string — paper title",
  "problem": "string — core research problem (1-2 sentences)",
  "method_summary": "string — proposed method overview",
  "claims": [{"text": "string", "confidence": "high|medium|low", "evidence_type": "string"}],
  "unknowns": ["string — unresolved questions or limitations"],
  "keywords": ["string"]
}`;

export async function executeAnalyzePaper(ctx: TaskExecutionContext): Promise<Record<string, unknown>> {
  const paperPayload = (ctx.task.payload as Record<string, unknown> | null) ?? {};
  const paperText = typeof paperPayload.paper_text === 'string'
    ? paperPayload.paper_text
    : typeof paperPayload.abstract === 'string'
      ? paperPayload.abstract
      : `Paper ID: ${paperPayload.paper_id ?? ctx.task.external_task_id}\nResearch question: ${ctx.run.question ?? 'Not specified'}`;

  const result = await callLlm({
    instruction: 'Analyze this research paper and extract its core structure: the problem it addresses, the method it proposes, the key claims it makes with confidence levels, and any unresolved questions or limitations.',
    inputs: [{ name: 'Paper content', content: paperText.slice(0, 12_000) }],
    outputSchema: PAPER_ANALYSIS_SCHEMA,
    maxTokens: 2048,
  });

  const parsed = result.parsed ?? {};
  const paperId = String(paperPayload.paper_id ?? ctx.task.external_task_id);

  await ctx.engine.upsertResearchNode({
    runId: ctx.run.id,
    nodeId: `paper-${paperId}`,
    kind: 'paper_analysis',
    status: 'succeeded',
    title: String(parsed.title ?? `Paper ${paperId}`),
    detail: {
      paper_id: paperId,
      problem: parsed.problem,
      method_summary: parsed.method_summary,
      claims: parsed.claims,
      unknowns: parsed.unknowns,
      keywords: parsed.keywords,
      claim_count: Array.isArray(parsed.claims) ? (parsed.claims as unknown[]).length : 0,
      unknown_count: Array.isArray(parsed.unknowns) ? (parsed.unknowns as unknown[]).length : 0,
    },
  });

  await ctx.engine.appendEvent({
    runId: ctx.run.id,
    type: 'paper_analyzed',
    summary: `论文 "${String(parsed.title ?? paperId).slice(0, 80)}" 分析完成：${Array.isArray(parsed.claims) ? (parsed.claims as unknown[]).length : 0} 条结论`,
    phaseTag: 'PAPER_ANALYSIS',
    objectType: 'paper',
    objectId: paperId,
  });

  await recordLlmCost(ctx, result, 'analyze_paper');

  return {
    paper_id: paperId,
    title: parsed.title,
    problem: parsed.problem,
    method_summary: parsed.method_summary,
    claims: parsed.claims ?? [],
    unknowns: parsed.unknowns ?? [],
    keywords: parsed.keywords ?? [],
    llm_usage: result.usage,
    llm_model: result.model,
  };
}

// ---------------------------------------------------------------------------
// generate_idea：已分析论文 → 一个研究 idea
// ---------------------------------------------------------------------------

const IDEA_GENERATION_SCHEMA = `idea-v1:
{
  "title": "string — concise idea title",
  "hypothesis": "string — testable hypothesis (1-3 sentences)",
  "mechanism_summary": "string — proposed mechanism or approach",
  "motivation": "string — why this idea follows from the analyzed papers",
  "feasibility": "high|medium|low",
  "novelty_claim": "string — what is new compared to existing work",
  "suggested_experiments": [{"name": "string", "purpose": "string", "expected_outcome": "string"}],
  "references_paper_ids": ["string"]
}`;

export async function executeGenerateIdea(ctx: TaskExecutionContext): Promise<Record<string, unknown>> {
  const papers = await ctx.engine.listTasks(ctx.run.id);
  const analyzedPapers = papers.filter((t) => t.kind === 'analyze_paper' && t.status === 'succeeded');

  const paperContexts: string[] = [];
  for (const p of analyzedPapers.slice(0, 5)) {
    const pResult = (p.result as Record<string, unknown> | null) ?? {};
    paperContexts.push([
      `Paper: ${pResult.title ?? p.external_task_id}`,
      `Problem: ${pResult.problem ?? 'N/A'}`,
      `Method: ${pResult.method_summary ?? 'N/A'}`,
      `Claims: ${JSON.stringify(pResult.claims ?? [])}`,
      `Unknowns: ${JSON.stringify(pResult.unknowns ?? [])}`,
    ].join('\n'));
  }

  const researchQuestion = ctx.run.question ?? 'Open research question not specified';

  const result = await callLlm({
    instruction: `Based on the analyzed papers below and the research question, generate a novel research idea. The idea should:
1. Address at least one "unknown" or gap identified in the papers
2. Be feasible to validate with computational experiments
3. Have a clear, testable hypothesis
4. Build on (not repeat) existing methods`,
    inputs: [
      { name: 'Research question', content: researchQuestion },
      { name: 'Analyzed papers', content: paperContexts.join('\n---\n') || 'No papers analyzed yet. Generate an idea based on the research question alone.' },
    ],
    outputSchema: IDEA_GENERATION_SCHEMA,
    maxTokens: 2048,
  });

  const parsed = result.parsed ?? {};
  const ideaId = `idea-${ctx.task.external_task_id}`;

  await ctx.engine.upsertResearchNode({
    runId: ctx.run.id,
    nodeId: ideaId,
    kind: 'idea',
    status: 'proposed',
    title: String(parsed.title ?? 'Generated idea'),
    detail: {
      hypothesis: parsed.hypothesis,
      mechanism_summary: parsed.mechanism_summary,
      motivation: parsed.motivation,
      feasibility: parsed.feasibility,
      novelty_claim: parsed.novelty_claim,
      suggested_experiments: parsed.suggested_experiments,
      references_paper_ids: parsed.references_paper_ids,
    },
  });

  await ctx.engine.appendEvent({
    runId: ctx.run.id,
    type: 'idea_generated',
    summary: `Idea "${String(parsed.title ?? ideaId).slice(0, 80)}" 生成`,
    phaseTag: 'IDEA_GENERATION',
    objectType: 'idea',
    objectId: ideaId,
  });

  await recordLlmCost(ctx, result, 'generate_idea');

  return {
    idea_id: ideaId,
    title: parsed.title,
    hypothesis: parsed.hypothesis,
    mechanism_summary: parsed.mechanism_summary,
    feasibility: parsed.feasibility,
    suggested_experiments: parsed.suggested_experiments ?? [],
    llm_usage: result.usage,
    llm_model: result.model,
  };
}

// ---------------------------------------------------------------------------
// calibrate：初始校准（轻量 LLM 调用，确认研究问题可行）
// ---------------------------------------------------------------------------

export async function executeCalibrate(ctx: TaskExecutionContext): Promise<Record<string, unknown>> {
  const result = await callLlm({
    instruction: 'Evaluate whether this research question is well-formed for an automated research workflow. Return a calibration assessment.',
    inputs: [{ name: 'Research question', content: ctx.run.question ?? 'Not specified' }],
    outputSchema: `calibration-v1: {"feasible": boolean, "strategy": "starter|standard|research", "estimated_papers": number, "notes": "string"}`,
    // 渠道是推理模型：太小的预算会被推理 token 耗尽，正文返回空。
    maxTokens: 2048,
  });

  const parsed = result.parsed ?? {};

  await ctx.engine.appendEvent({
    runId: ctx.run.id,
    type: 'calibrated',
    summary: `校准完成：策略=${String(parsed.strategy ?? 'standard')}，预估论文=${String(parsed.estimated_papers ?? '?')}`,
    phaseTag: 'CALIBRATING',
  });

  await recordLlmCost(ctx, result, 'calibrate');

  return {
    calibrated: true,
    strategy: parsed.strategy ?? 'standard',
    feasible: parsed.feasible ?? true,
    estimated_papers: parsed.estimated_papers ?? 3,
    notes: parsed.notes ?? '',
    llm_usage: result.usage,
  };
}

// ---------------------------------------------------------------------------
// Class B: discover_comparison — 发现对比方法
// ---------------------------------------------------------------------------

const COMPARISON_DISCOVERY_SCHEMA = `comparison-discovery-v1:
{
  "comparisons": [{
    "name": "string — method/baseline name",
    "type": "official|community|reimplementation",
    "paper_title": "string — original paper title",
    "paper_url": "string — optional",
    "relevance": "high|medium|low",
    "notes": "string — why this is a relevant comparison"
  }]
}`;

export async function executeDiscoverComparison(ctx: TaskExecutionContext): Promise<Record<string, unknown>> {
  const papers = await ctx.engine.listTasks(ctx.run.id);
  const analyzedPapers = papers.filter((t) => t.kind === 'analyze_paper' && t.status === 'succeeded');

  const paperContexts: string[] = [];
  for (const p of analyzedPapers.slice(0, 5)) {
    const pResult = (p.result as Record<string, unknown> | null) ?? {};
    paperContexts.push([
      `Paper: ${pResult.title ?? p.external_task_id}`,
      `Problem: ${pResult.problem ?? 'N/A'}`,
      `Method: ${pResult.method_summary ?? 'N/A'}`,
    ].join('\n'));
  }

  const researchQuestion = ctx.run.question ?? 'Open research question not specified';

  const result = await callLlm({
    instruction: `Based on the research question and analyzed papers, discover relevant comparison methods/baselines. 
For each comparison, identify:
1. The method name and type (official implementation, community implementation, or reimplementation)
2. The original paper title
3. Why it's relevant to compare against
4. Relevance level (high/medium/low)`,
    inputs: [
      { name: 'Research question', content: researchQuestion },
      { name: 'Analyzed papers', content: paperContexts.join('\n---\n') || 'No papers analyzed yet.' },
    ],
    outputSchema: COMPARISON_DISCOVERY_SCHEMA,
    maxTokens: 2048,
  });

  const parsed = result.parsed ?? {};
  const comparisons = Array.isArray(parsed.comparisons) ? parsed.comparisons : [];

  await ctx.engine.upsertResearchNode({
    runId: ctx.run.id,
    nodeId: `comparison-discovery-${ctx.task.external_task_id}`,
    kind: 'comparison_discovery',
    status: 'succeeded',
    title: '对比方法发现',
    detail: { comparisons },
  });

  await ctx.engine.appendEvent({
    runId: ctx.run.id,
    type: 'comparisons_discovered',
    summary: `发现 ${comparisons.length} 个对比方法`,
    phaseTag: 'COMPARISON_DISCOVERY',
    objectType: 'comparison',
    objectId: ctx.task.external_task_id,
  });

  await recordLlmCost(ctx, result, 'discover_comparison');

  return {
    comparisons,
    llm_usage: result.usage,
    llm_model: result.model,
  };
}

// ---------------------------------------------------------------------------
// Class B: reproduce_comparison — 复现对比方法（需要 QCA Session）
// ---------------------------------------------------------------------------

export async function executeReproduceComparison(ctx: TaskExecutionContext): Promise<Record<string, unknown>> {
  // Class B 重计算单元：需要 QCA Session 执行代码
  // 当前使用模拟实现，真实集成需要 ensure_backend(qoder) 授权
  
  const taskPayload = (ctx.task.payload as Record<string, unknown> | null) ?? {};
  const comparisonName = String(taskPayload.comparison_name ?? ctx.task.external_task_id);

  // 模拟复现结果
  const reproductionResult = {
    comparison_name: comparisonName,
    status: 'simulated',
    metrics: {
      accuracy: 0.85 + Math.random() * 0.1,
      f1_score: 0.82 + Math.random() * 0.12,
    },
    artifacts: [],
    notes: '模拟结果：真实复现需要 QCA Session 执行代码',
  };

  await ctx.engine.upsertResearchNode({
    runId: ctx.run.id,
    nodeId: `comparison-repro-${comparisonName}`,
    kind: 'comparison_reproduction',
    status: 'succeeded',
    title: `复现：${comparisonName}`,
    detail: reproductionResult,
  });

  await ctx.engine.appendEvent({
    runId: ctx.run.id,
    type: 'comparison_reproduced',
    summary: `复现完成：${comparisonName}（模拟）`,
    phaseTag: 'COMPARISON_REPRODUCTION',
    objectType: 'comparison',
    objectId: comparisonName,
  });

  return reproductionResult;
}

// ---------------------------------------------------------------------------
// Class B: validate_baseline — 验证基线（需要 QCA Session）
// ---------------------------------------------------------------------------

export async function executeValidateBaseline(ctx: TaskExecutionContext): Promise<Record<string, unknown>> {
  // Class B 重计算单元：需要 QCA Session 执行验证脚本
  // 当前使用模拟实现
  
  const taskPayload = (ctx.task.payload as Record<string, unknown> | null) ?? {};
  const baselineName = String(taskPayload.baseline_name ?? 'default-baseline');

  const validationResult = {
    baseline_name: baselineName,
    status: 'simulated',
    validation_passed: true,
    metrics: {
      accuracy: 0.88 + Math.random() * 0.08,
      f1_score: 0.85 + Math.random() * 0.1,
      runtime_seconds: 120 + Math.random() * 60,
    },
    notes: '模拟结果：真实验证需要 QCA Session 执行验证脚本',
  };

  await ctx.engine.upsertResearchNode({
    runId: ctx.run.id,
    nodeId: `baseline-validation-${baselineName}`,
    kind: 'baseline_validation',
    status: 'succeeded',
    title: `基线验证：${baselineName}`,
    detail: validationResult,
  });

  await ctx.engine.appendEvent({
    runId: ctx.run.id,
    type: 'baseline_validated',
    summary: `基线验证通过：${baselineName}（模拟）`,
    phaseTag: 'BASELINE_VALIDATED',
    objectType: 'baseline',
    objectId: baselineName,
  });

  return validationResult;
}

// ---------------------------------------------------------------------------
// Class B: run_experiment — 执行实验（需要 QCA Session）
// ---------------------------------------------------------------------------

export async function executeRunExperiment(ctx: TaskExecutionContext): Promise<Record<string, unknown>> {
  // Class B 重计算单元：需要 QCA Session 执行实验代码
  // 当前使用模拟实现
  
  const taskPayload = (ctx.task.payload as Record<string, unknown> | null) ?? {};
  const experimentName = String(taskPayload.experiment_name ?? ctx.task.external_task_id);
  const ideaId = String(taskPayload.idea_id ?? 'unknown');

  const experimentResult = {
    experiment_name: experimentName,
    idea_id: ideaId,
    status: 'simulated',
    metrics: {
      accuracy: 0.90 + Math.random() * 0.08,
      f1_score: 0.88 + Math.random() * 0.1,
      improvement_vs_baseline: 0.05 + Math.random() * 0.1,
    },
    artifacts: [],
    notes: '模拟结果：真实实验需要 QCA Session 执行实验代码',
  };

  await ctx.engine.upsertResearchNode({
    runId: ctx.run.id,
    nodeId: `experiment-${experimentName}`,
    kind: 'experiment',
    status: 'completed',
    title: `实验：${experimentName}`,
    detail: experimentResult,
  });

  await ctx.engine.appendEvent({
    runId: ctx.run.id,
    type: 'experiment_completed',
    summary: `实验完成：${experimentName}（模拟）`,
    phaseTag: 'EXPERIMENTING',
    objectType: 'experiment',
    objectId: experimentName,
  });

  return experimentResult;
}

// ---------------------------------------------------------------------------
// prepare_data：研究问题 + 已分析论文 → 数据准备计划
// ---------------------------------------------------------------------------

const DATA_PLAN_SCHEMA = `data-plan-v1:
{
  "datasets": [{"name": "string", "source": "string — where to obtain it", "role": "train|eval|calibration", "size_estimate": "string"}],
  "preprocessing": ["string — concrete preprocessing steps"],
  "splits": {"train": "string", "validation": "string", "test": "string"},
  "risks": ["string — data quality or leakage risks"]
}`;

export async function executePrepareData(ctx: TaskExecutionContext): Promise<Record<string, unknown>> {
  const papers = await ctx.engine.listTasks(ctx.run.id);
  const analyzedPapers = papers.filter((t) => t.kind === 'analyze_paper' && t.status === 'succeeded');
  const paperContexts = analyzedPapers.slice(0, 5).map((p) => {
    const r = (p.result as Record<string, unknown> | null) ?? {};
    return `Paper: ${r.title ?? p.external_task_id}\nMethod: ${r.method_summary ?? 'N/A'}\nUnknowns: ${JSON.stringify(r.unknowns ?? [])}`;
  });

  const result = await callLlm({
    instruction: 'Design a concrete data preparation plan for this research question: which datasets to obtain, how to preprocess them, how to split them, and what data risks (leakage, bias, size) to watch for. The plan must be executable by a computational experiment pipeline.',
    inputs: [
      { name: 'Research question', content: ctx.run.question ?? 'Not specified' },
      { name: 'Analyzed papers', content: paperContexts.join('\n---\n') || 'No papers analyzed yet.' },
    ],
    outputSchema: DATA_PLAN_SCHEMA,
    maxTokens: 2048,
  });

  const parsed = result.parsed ?? {};
  const datasets = Array.isArray(parsed.datasets) ? parsed.datasets : [];

  await ctx.engine.upsertResearchNode({
    runId: ctx.run.id,
    nodeId: `data-plan-${ctx.task.external_task_id}`,
    kind: 'data_plan',
    status: 'succeeded',
    title: '数据准备计划',
    detail: {
      datasets,
      preprocessing: parsed.preprocessing ?? [],
      splits: parsed.splits ?? null,
      risks: parsed.risks ?? [],
    },
  });

  await ctx.engine.appendEvent({
    runId: ctx.run.id,
    type: 'data_prepared',
    summary: `数据计划就绪：${datasets.length} 个数据集`,
    phaseTag: 'DATA_READY',
    objectType: 'data_plan',
    objectId: ctx.task.external_task_id,
  });

  await recordLlmCost(ctx, result, 'prepare_data');

  return { datasets, preprocessing: parsed.preprocessing ?? [], splits: parsed.splits ?? null, risks: parsed.risks ?? [], llm_usage: result.usage, llm_model: result.model };
}

// ---------------------------------------------------------------------------
// propose_protocol：研究问题 + 数据计划 → 评测协议
// ---------------------------------------------------------------------------

const PROTOCOL_SCHEMA = `protocol-v1:
{
  "metrics": [{"name": "string", "definition": "string", "higher_is_better": boolean}],
  "baselines": ["string — baseline methods to compare against"],
  "procedure": ["string — ordered experimental steps"],
  "stopping_criteria": "string",
  "threats_to_validity": ["string"]
}`;

export async function executeProposeProtocol(ctx: TaskExecutionContext): Promise<Record<string, unknown>> {
  const nodes = await ctx.engine.listResearchNodes(ctx.run.id);
  const dataPlan = nodes.find((n) => n.kind === 'data_plan' && n.status === 'succeeded');
  const comparisons = nodes.find((n) => n.kind === 'comparison_discovery');

  const result = await callLlm({
    instruction: 'Propose a rigorous evaluation protocol for this research question: metrics with precise definitions, baselines, an ordered experimental procedure, stopping criteria, and threats to validity. The protocol must make results reproducible and comparable.',
    inputs: [
      { name: 'Research question', content: ctx.run.question ?? 'Not specified' },
      { name: 'Data plan', content: dataPlan ? JSON.stringify(dataPlan.detail ?? {}) : 'No data plan yet.' },
      { name: 'Known comparisons', content: comparisons ? JSON.stringify(comparisons.detail ?? {}) : 'None discovered yet.' },
    ],
    outputSchema: PROTOCOL_SCHEMA,
    maxTokens: 2048,
  });

  const parsed = result.parsed ?? {};
  const metrics = Array.isArray(parsed.metrics) ? parsed.metrics : [];

  await ctx.engine.upsertResearchNode({
    runId: ctx.run.id,
    nodeId: `protocol-${ctx.task.external_task_id}`,
    kind: 'protocol',
    status: 'succeeded',
    title: '评测协议',
    detail: {
      metrics,
      baselines: parsed.baselines ?? [],
      procedure: parsed.procedure ?? [],
      stopping_criteria: parsed.stopping_criteria ?? null,
      threats_to_validity: parsed.threats_to_validity ?? [],
    },
  });

  await ctx.engine.appendEvent({
    runId: ctx.run.id,
    type: 'protocol_proposed',
    summary: `评测协议就绪：${metrics.length} 项指标`,
    phaseTag: 'PROTOCOL_PROPOSED',
    objectType: 'protocol',
    objectId: ctx.task.external_task_id,
  });

  await recordLlmCost(ctx, result, 'propose_protocol');

  return { metrics, baselines: parsed.baselines ?? [], procedure: parsed.procedure ?? [], llm_usage: result.usage, llm_model: result.model };
}

// ---------------------------------------------------------------------------
// screen_idea：已生成的 idea → 逐个评审，淘汰的不再进 EXPERIMENTING
// ---------------------------------------------------------------------------

const IDEA_SCREENING_SCHEMA = `idea-screening-v1:
{
  "screenings": [{"idea_id": "string", "verdict": "advance|reject", "score": number, "reason": "string"}]
}`;

export async function executeScreenIdea(ctx: TaskExecutionContext): Promise<Record<string, unknown>> {
  const nodes = await ctx.engine.listResearchNodes(ctx.run.id);
  const proposedIdeas = nodes.filter((n) => n.kind === 'idea' && n.status === 'proposed');
  if (proposedIdeas.length === 0) {
    return { screened: 0, advanced: 0, rejected: 0, note: '没有待评审的 idea' };
  }

  const result = await callLlm({
    instruction: 'Screen each research idea below against the research question. For each idea return a verdict (advance or reject), a 0-10 score, and a one-sentence reason. Reject ideas that are infeasible, untestable, or duplicate existing work. Return one screening entry per idea, using the exact idea_id given.',
    inputs: [
      { name: 'Research question', content: ctx.run.question ?? 'Not specified' },
      {
        name: 'Ideas',
        content: proposedIdeas.map((n) => `idea_id: ${n.node_id}\ntitle: ${n.title ?? ''}\n${JSON.stringify(n.detail ?? {})}`).join('\n---\n'),
      },
    ],
    outputSchema: IDEA_SCREENING_SCHEMA,
    maxTokens: 2048,
  });

  const parsed = result.parsed ?? {};
  const screenings = Array.isArray(parsed.screenings) ? parsed.screenings as Array<Record<string, unknown>> : [];
  let advanced = 0;
  let rejected = 0;

  for (const idea of proposedIdeas) {
    const verdict = screenings.find((s) => s.idea_id === idea.node_id);
    const decision = verdict?.verdict === 'reject' ? 'rejected' : 'proposed';
    if (decision === 'rejected') rejected++;
    else advanced++;
    await ctx.engine.upsertResearchNode({
      runId: ctx.run.id,
      nodeId: idea.node_id,
      kind: 'idea',
      status: decision,
      title: idea.title ?? undefined,
      detail: { ...(idea.detail ?? {}), screening: verdict ?? { verdict: 'advance', reason: '评审未覆盖，默认保留' } },
    });
  }

  await ctx.engine.appendEvent({
    runId: ctx.run.id,
    type: 'ideas_screened',
    summary: `Idea 评审完成：${advanced} 个晋级，${rejected} 个淘汰`,
    phaseTag: 'IDEA_SCREENING',
    objectType: 'idea',
    objectId: ctx.task.external_task_id,
  });

  await recordLlmCost(ctx, result, 'screen_idea');

  return { screened: proposedIdeas.length, advanced, rejected, llm_usage: result.usage, llm_model: result.model };
}

// ---------------------------------------------------------------------------
// 分发器
// ---------------------------------------------------------------------------

export async function executeTask(
  ctx: TaskExecutionContext,
): Promise<Record<string, unknown>> {
  switch (ctx.task.kind) {
    case 'calibrate':
      return executeCalibrate(ctx);
    case 'analyze_paper':
      return executeAnalyzePaper(ctx);
    case 'prepare_data':
      return executePrepareData(ctx);
    case 'propose_protocol':
      return executeProposeProtocol(ctx);
    case 'generate_idea':
      return executeGenerateIdea(ctx);
    case 'screen_idea':
      return executeScreenIdea(ctx);
    case 'discover_comparison':
      return executeDiscoverComparison(ctx);
    case 'reproduce_comparison':
      return executeReproduceComparison(ctx);
    case 'validate_baseline':
      return executeValidateBaseline(ctx);
    case 'run_experiment':
      return executeRunExperiment(ctx);
    default:
      throw new Error(`unknown task kind: ${ctx.task.kind}`);
  }
}
