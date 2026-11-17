import { IdeaseekError } from '../core/errors.js';
import { sha256OfJson } from '../core/hash.js';
import { loadCompactCards } from '../knowledge/cards.js';
import {
  MAP_PROMPT_VERSION,
  SYNTHESIS_PROMPT_VERSION,
  capClusters,
  clusterCards,
  synthesisInputHash,
  validateResearchMap,
  validateTopicSynthesis,
  type ResearchMapRecord,
  type TopicSynthesisRecord,
} from '../knowledge/synthesis.js';
import type { TaskContext, TaskHandler } from './types.js';
import { applyFaults } from './handlers.js';

const SYNTHESIS_INSTRUCTION = [
  'You are synthesizing a topic cluster of research papers from verified PaperCard summaries.',
  'Only use facts present in the input; cite the providing paper source for every finding.',
  'Do not call any tools. Output ONLY one JSON object with this shape:',
  '{',
  '  "topic": string,',
  '  "methodLineage": [string],',
  '  "keyFindings": [{"text": string, "source": string, "page": number|null, "quote": string|null}],',
  '  "conflicts": [string],',
  '  "mechanisms": [{"name": string, "principle": string, "conditions": string}],',
  '  "openQuestions": [string]',
  '}',
  'Rules: source must be one of the input paper sources; quotes must be verbatim from the',
  'input claims when present; mechanisms describe WHY methods work and WHEN they fail,',
  'never bare module combinations; keep entries concise.',
].join('\n');

const MAP_INSTRUCTION = [
  'You are writing a research map from per-topic synthesis records of verified PaperCards.',
  'Do not call any tools. Output ONLY one JSON object with this shape:',
  '{',
  '  "landscape": string,',
  '  "lineages": [{"name": string, "summary": string}],',
  '  "conflicts": [{"topic": string, "detail": string}],',
  '  "gaps": [string],',
  '  "citations": [{"source": string, "title": string}]',
  '}',
  'Rules: every lineage/conflict/gap must trace to a cited input; gaps are candidate',
  'whitespace for idea generation, phrased as open research opportunities, not claims of novelty.',
].join('\n');

function requireHarness(ctx: TaskContext) {
  const harness = ctx.runtime.harness;
  if (!harness) {
    const error = new IdeaseekError(
      'INVALID_STATE',
      'no harness adapter configured for synthesis tasks',
    );
    (error as IdeaseekError & { permanent?: boolean }).permanent = true;
    throw error;
  }
  return harness;
}

async function existingArtifact(
  ctx: TaskContext,
  kind: 'topic-synthesis' | 'research-map',
  inputHash: string,
): Promise<string | null> {
  for (const artifact of await ctx.runtime.db.listArtifactsByKind(kind)) {
    if (artifact.meta.inputHash === inputHash) {
      try {
        return await ctx.runtime.store.readFinalText(artifact.contentHash);
      } catch {
        continue;
      }
    }
  }
  return null;
}

/** Topic synthesis: one task per cluster, incremental on cluster+prompt hash. */
export const synthTopic: TaskHandler = async (ctx: TaskContext) => {
  await applyFaults(ctx);
  const topicId = typeof ctx.payload.topicId === 'string' ? ctx.payload.topicId : '';
  const maxTopics =
    typeof ctx.payload.maxTopics === 'number' && ctx.payload.maxTopics > 0
      ? ctx.payload.maxTopics
      : 4;
  if (!topicId.startsWith('topic-')) {
    const error = new IdeaseekError('INVALID_ARGUMENT', 'synth.topic needs payload.topicId');
    (error as IdeaseekError & { permanent?: boolean }).permanent = true;
    throw error;
  }

  const cards = await loadCompactCards(ctx.runtime);
  if (cards.length === 0) {
    const error = new IdeaseekError('USER_INPUT_REQUIRED', 'no extracted cards to synthesize');
    (error as IdeaseekError & { permanent?: boolean }).permanent = true;
    throw error;
  }
  const clusters = capClusters(clusterCards(cards), maxTopics);
  const cluster = clusters.find((entry) => entry.topicId === topicId);
  if (!cluster) {
    const error = new IdeaseekError(
      'INVALID_ARGUMENT',
      `cluster ${topicId} no longer exists (input changed); re-run ideaseek synthesize`,
    );
    (error as IdeaseekError & { permanent?: boolean }).permanent = true;
    throw error;
  }
  const inputHash = await synthesisInputHash(cluster);

  let output = await existingArtifact(ctx, 'topic-synthesis', inputHash);
  const reused = output !== null;
  if (!output) {
    const harness = requireHarness(ctx);
    await harness.initialize();
    const payload = JSON.stringify({
      topic: cluster.label,
      papers: cluster.members.map((member) => ({
        source: member.source,
        title: member.title,
        problem: member.problem,
        methodSummary: member.methodSummary,
        datasets: member.datasets,
        metrics: member.metrics,
        topClaims: member.topClaims,
        limitations: member.limitations,
      })),
    });
    const result = await harness.runTask(
      {
        runId: ctx.run.runId,
        taskId: ctx.task.taskId,
        profile: 'synthesis-analyst',
        instruction: SYNTHESIS_INSTRUCTION,
        inputs: [{ kind: 'text', name: `cluster:${cluster.topicId}`, content: payload }],
        outputSchema: 'topic-synthesis-v1',
        budget: { timeoutMs: 180_000, maxOutputTokens: 8192 },
        idempotencyKey: `synth:${ctx.run.runId}:${ctx.task.taskId}`,
      },
      (event) => ctx.log(event.summary),
      ctx.signal,
    );
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(result.output) as Record<string, unknown>;
    } catch {
      throw new Error('synthesis output was not valid JSON');
    }
    const record: TopicSynthesisRecord = {
      ...(parsed as unknown as TopicSynthesisRecord),
      topicId,
      inputHash,
      papers: cluster.members.map((member) => ({
        paperId: member.paperId,
        title: member.title,
      })),
      generator: SYNTHESIS_PROMPT_VERSION,
      generatedAt: ctx.runtime.clock.now(),
    };
    const validation = validateTopicSynthesis(record);
    if (!validation.ok) {
      throw new Error(`synthesis output invalid: ${validation.errors.slice(0, 3).join('; ')}`);
    }
    output = `${JSON.stringify(record, null, 2)}\n`;
  }

  return {
    artifacts: [
      {
        kind: 'topic-synthesis',
        data: output,
        meta: { filename: 'topic-synthesis.json', topicId, inputHash, reused },
      },
    ],
    summary: reused
      ? `topic ${topicId} unchanged (${cluster.members.length} papers reused)`
      : `synthesized topic ${topicId} from ${cluster.members.length} paper(s)`,
    data: { topicId, papers: cluster.members.length, reused },
  };
};

/** Research map: reduce over the run's topic syntheses (incremental on their hashes). */
export const synthMap: TaskHandler = async (ctx: TaskContext) => {
  await applyFaults(ctx);
  const syntheses: TopicSynthesisRecord[] = [];
  for (const artifact of await ctx.runtime.db.listArtifactsByKind('topic-synthesis')) {
    try {
      const record = JSON.parse(
        await ctx.runtime.store.readFinalText(artifact.contentHash),
      ) as TopicSynthesisRecord;
      if (record.topicId) syntheses.push(record);
    } catch {
      continue;
    }
  }
  if (syntheses.length === 0) {
    const error = new IdeaseekError(
      'DEPENDENCY_NOT_MET',
      'research map needs at least one topic synthesis',
    );
    (error as IdeaseekError & { permanent?: boolean }).permanent = true;
    throw error;
  }
  syntheses.sort((a, b) => a.topicId.localeCompare(b.topicId));
  const inputHash = await sha256OfJson({
    topics: syntheses.map((entry) => entry.inputHash),
    generator: MAP_PROMPT_VERSION,
  });

  let output = await existingArtifact(ctx, 'research-map', inputHash);
  const reused = output !== null;
  if (!output) {
    const harness = requireHarness(ctx);
    await harness.initialize();
    // Project each stored record into the map prompt's input. Every field is
    // read defensively because these artifacts are re-read from disk years
    // later, possibly written by an older build: the previous version called
    // `entry.mechanisms.map(...)` directly, OUTSIDE the per-artifact try/catch
    // above, so one legacy record without `mechanisms` threw a TypeError out of
    // `synth.map` and the task failed permanently — re-running never healed it,
    // because the offending artifact is still in the store.
    //
    // `conflicts` is also converted deliberately. Topic synthesis records store
    // conflicts as plain strings (the topic contract says `[string]`), while the
    // MAP prompt asks the model for `{"topic","detail"}` objects. Handing it
    // strings and requiring objects invited a compliant model to echo the
    // strings back, which the map validator used to accept — and
    // `renderResearchMap` then printed "- **undefined**: undefined" into
    // knowledge/research-map.md as a clean success.
    const payload = JSON.stringify(
      syntheses.map((entry) => ({
        topic: String(entry.topic ?? ''),
        keyFindings: Array.isArray(entry.keyFindings) ? entry.keyFindings : [],
        conflicts: (Array.isArray(entry.conflicts) ? entry.conflicts : []).map(
          (conflict: string | { topic?: unknown; detail?: unknown }) =>
            typeof conflict === 'string'
              ? { topic: conflict, detail: conflict }
              : {
                  topic: String(conflict?.topic ?? ''),
                  detail: String(conflict?.detail ?? ''),
                },
        ),
        mechanisms: (Array.isArray(entry.mechanisms) ? entry.mechanisms : []).map((mechanism) =>
          String(mechanism?.name ?? mechanism ?? ''),
        ),
        openQuestions: Array.isArray(entry.openQuestions) ? entry.openQuestions : [],
        papers: Array.isArray(entry.papers) ? entry.papers : [],
      })),
    );
    const result = await harness.runTask(
      {
        runId: ctx.run.runId,
        taskId: ctx.task.taskId,
        profile: 'synthesis-analyst',
        instruction: MAP_INSTRUCTION,
        inputs: [{ kind: 'text', name: 'topic-syntheses', content: payload }],
        outputSchema: 'research-map-v1',
        budget: { timeoutMs: 180_000, maxOutputTokens: 8192 },
        idempotencyKey: `synth-map:${ctx.run.runId}:${ctx.task.taskId}`,
      },
      (event) => ctx.log(event.summary),
      ctx.signal,
    );
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(result.output) as Record<string, unknown>;
    } catch {
      throw new Error('research map output was not valid JSON');
    }
    const citations = Array.isArray(parsed.citations) ? parsed.citations : [];
    const record: ResearchMapRecord = {
      ...(parsed as unknown as ResearchMapRecord),
      inputHash,
      // Ground citations in real papers when the model omits them.
      citations:
        citations.length > 0
          ? citations
          : syntheses
              .flatMap((entry) => entry.papers)
              .slice(0, 20)
              .map((paper) => ({ source: paper.paperId, title: paper.title })),
      generator: MAP_PROMPT_VERSION,
      generatedAt: ctx.runtime.clock.now(),
    };
    const validation = validateResearchMap(record);
    if (!validation.ok) {
      throw new Error(`research map invalid: ${validation.errors.slice(0, 3).join('; ')}`);
    }
    output = `${JSON.stringify(record, null, 2)}\n`;
  }

  return {
    artifacts: [
      {
        kind: 'research-map',
        data: output,
        meta: { filename: 'research-map.json', inputHash, reused },
      },
    ],
    summary: reused
      ? `research map unchanged (${syntheses.length} topics)`
      : `research map from ${syntheses.length} topic synthesis(es)`,
    data: { topics: syntheses.length, reused },
  };
};
