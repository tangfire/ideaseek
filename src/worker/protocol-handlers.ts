import { IdeaseekError } from '../core/errors.js';
import { sha256OfJson } from '../core/hash.js';
import { loadCompactCards } from '../knowledge/cards.js';
import { discoveryCandidatesNote } from '../knowledge/dataset-discovery.js';
import {
  PROTOCOL_INSTRUCTION,
  PROTOCOL_PROMPT_VERSION,
  buildProtocolInput,
  type DatasetProfileSummary,
} from '../experiment/protocol-synth.js';
import { validateProtocolProposal } from '../experiment/protocol.js';
import type { TaskContext, TaskHandler } from './types.js';
import { applyFaults } from './handlers.js';

async function loadDatasetProfile(ctx: TaskContext): Promise<DatasetProfileSummary | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const raw = await readFile(join(ctx.runtime.paths.knowledgeDir, 'dataset-card.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      profiles?: {
        source: { path: string };
        rows: number;
        columns: { name: string }[];
        labelCandidates: { column: string }[];
      }[];
    };
    const profiles = parsed.profiles ?? [];
    if (profiles.length === 0) return null;
    return {
      present: true,
      files: profiles.map((profile) => ({
        path: profile.source.path,
        rows: profile.rows,
        columns: profile.columns.length,
        labelCandidates: profile.labelCandidates.map((candidate) => candidate.column),
      })),
      note: 'dataset profile from ideaseek data describe (deterministic profiling)',
    };
  } catch {
    return null;
  }
}

/**
 * Protocol Synthesis Agent task: proposal grounded in verified cards and the
 * deterministic dataset profile, platform-stamped (protocolId/generator/
 * timestamps are never model-authored) and validation-gated before commit.
 */
export const protocolPropose: TaskHandler = async (ctx: TaskContext) => {
  await applyFaults(ctx);
  const harness = ctx.runtime.harness;
  if (!harness) {
    const error = new IdeaseekError(
      'INVALID_STATE',
      'no harness adapter configured for protocol.propose',
    );
    (error as IdeaseekError & { permanent?: boolean }).permanent = true;
    throw error;
  }

  const cards = await loadCompactCards(ctx.runtime);
  if (cards.length === 0) {
    const error = new IdeaseekError(
      'USER_INPUT_REQUIRED',
      'protocol proposal needs extracted PaperCards; run: ideaseek extract',
    );
    (error as IdeaseekError & { permanent?: boolean }).permanent = true;
    throw error;
  }
  const datasetProfile = await loadDatasetProfile(ctx);
  // No registered dataset → surface discovered candidates as recommendations
  // only, so the proposal never treats them as experiment inputs (Phase 4.5B).
  const discoveryNote =
    datasetProfile === null ? await discoveryCandidatesNote(ctx.runtime.paths.knowledgeDir) : null;
  const input = buildProtocolInput({
    // Same source as the propose command (config snapshot, not the run's
    // adopt-fallback question) so incremental input hashes match.
    question: String(
      (ctx.run.config.research as { question?: string } | undefined)?.question ?? '',
    ),
    cards,
    datasetProfile,
    discoveryNote,
  });
  const inputHash = await sha256OfJson({
    inputs: input,
    generator: PROTOCOL_PROMPT_VERSION,
  });

  let output: string | null = null;
  let reused = false;
  for (const artifact of await ctx.runtime.db.listArtifactsByKind('protocol-proposal')) {
    if (artifact.meta.inputHash === inputHash) {
      try {
        output = await ctx.runtime.store.readFinalText(artifact.contentHash);
        reused = true;
        break;
      } catch {
        continue;
      }
    }
  }

  if (!output) {
    await harness.initialize();
    const result = await harness.runTask(
      {
        runId: ctx.run.runId,
        taskId: ctx.task.taskId,
        profile: 'synthesis-analyst',
        instruction: PROTOCOL_INSTRUCTION,
        inputs: [{ kind: 'text', name: 'corpus-and-dataset', content: JSON.stringify(input) }],
        outputSchema: 'protocol-proposal-v1',
        budget: { timeoutMs: 180_000, maxOutputTokens: 8192 },
        idempotencyKey: `protocol:${ctx.run.runId}:${ctx.task.taskId}`,
      },
      (event) => ctx.log(event.summary),
      ctx.signal,
    );
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(result.output) as Record<string, unknown>;
    } catch {
      throw new Error('protocol proposal output was not valid JSON');
    }
    const proposal = {
      ...parsed,
      protocolId: `proto-${inputHash.slice(7, 19)}-v1`,
      version: 1,
      generator: PROTOCOL_PROMPT_VERSION,
      generatedAt: ctx.runtime.clock.now(),
    };
    const validation = validateProtocolProposal(proposal);
    if (!validation.ok) {
      throw new Error(`protocol proposal invalid: ${validation.errors.slice(0, 3).join('; ')}`);
    }
    output = `${JSON.stringify(proposal, null, 2)}\n`;
  }

  return {
    artifacts: [
      {
        kind: 'protocol-proposal',
        data: output,
        meta: { filename: 'protocol-proposal.json', inputHash, reused },
      },
    ],
    summary: reused
      ? 'protocol proposal unchanged (inputs identical)'
      : `proposed protocol for ${cards.length} paper card(s)`,
    data: { papers: cards.length, reused, inputHash },
  };
};
