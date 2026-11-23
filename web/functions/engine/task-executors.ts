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
  deepseekApiKey?: string | null;
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
    apiKey: ctx.deepseekApiKey ?? undefined,
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
    apiKey: ctx.deepseekApiKey ?? undefined,
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
    maxTokens: 512,
    apiKey: ctx.deepseekApiKey ?? undefined,
  });

  const parsed = result.parsed ?? {};

  await ctx.engine.appendEvent({
    runId: ctx.run.id,
    type: 'calibrated',
    summary: `校准完成：策略=${String(parsed.strategy ?? 'standard')}，预估论文=${String(parsed.estimated_papers ?? '?')}`,
    phaseTag: 'CALIBRATING',
  });

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
    case 'generate_idea':
      return executeGenerateIdea(ctx);
    default:
      return { status: 'completed', kind: ctx.task.kind };
  }
}
