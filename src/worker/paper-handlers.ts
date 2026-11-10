import { IdeaseekError } from '../core/errors.js';
import type { TaskContext, TaskHandler } from './types.js';
import { applyFaults } from './handlers.js';
import { parsePdf } from '../knowledge/pdf.js';
import { sha256OfFile } from '../core/hash.js';
import { basename, join } from 'node:path';

interface ParsedPaperArtifact {
  pageCount: number;
  pages: { page: number; text: string }[];
}

/** Reads the upstream `parsed-paper` artifact and adds `[page N]` markers. */
async function textFromParsedDependency(ctx: TaskContext): Promise<string> {
  for (const depId of ctx.task.dependsOn) {
    const dep = await ctx.runtime.db.getTask(depId);
    if (!dep || dep.status !== 'succeeded' || !dep.result) continue;
    const rows = await ctx.runtime.db.listArtifacts(dep.taskId);
    const parsedRow = rows.find((row) => row.kind === 'parsed-paper' && row.status === 'committed');
    if (!parsedRow) continue;
    const parsed = JSON.parse(
      await ctx.runtime.store.readFinalText(parsedRow.contentHash),
    ) as ParsedPaperArtifact;
    const text = parsed.pages
      .map((page) => `[page ${page.page}]\n${page.text.trim()}`)
      .join('\n\n');
    if (text.trim()) return text;
  }
  return '';
}

/** Phase 2 ingest: PDF -> page-tagged text artifact (evidence locators kept). */
export const paperParse: TaskHandler = async (ctx: TaskContext) => {
  await applyFaults(ctx);
  const pdfPath = typeof ctx.payload.pdfPath === 'string' ? ctx.payload.pdfPath : '';
  if (!pdfPath || !pdfPath.toLowerCase().endsWith('.pdf')) {
    const error = new IdeaseekError(
      'USER_INPUT_REQUIRED',
      'paper.parse needs payload.pdfPath pointing at a .pdf file',
    );
    (error as IdeaseekError & { permanent?: boolean }).permanent = true;
    throw error;
  }
  if (pdfPath.includes('..')) {
    const error = new IdeaseekError('INVALID_ARGUMENT', 'pdfPath must be project-relative');
    (error as IdeaseekError & { permanent?: boolean }).permanent = true;
    throw error;
  }
  const abs = join(ctx.runtime.paths.root, ...pdfPath.split('/'));
  const parsed = await parsePdf(abs);
  const sourceHash = await sha256OfFile(abs);
  const payload = {
    source: pdfPath,
    sourceHash,
    pageCount: parsed.pageCount,
    pages: parsed.pages,
    parser: parsed.parser,
  };
  return {
    artifacts: [
      {
        kind: 'parsed-paper',
        data: `${JSON.stringify(payload, null, 2)}\n`,
        meta: { filename: 'parsed-paper.json', parser: parsed.parser },
      },
    ],
    summary: `parsed ${parsed.pageCount} page(s) from ${basename(pdfPath)} (${parsed.parser})`,
    data: { pageCount: parsed.pageCount, sourceHash },
  };
};

/**
 * Phase 1 Paper Extractor task: feeds one paper excerpt through the harness
 * adapter under the `paper-extractor` capability profile and commits the
 * structured card as an artifact. The handler never sees credentials — the
 * adapter owns auth — and never persists raw prompts, only the structured
 * output the schema allows.
 *
 * Input resolution: explicit `payload.paperText`, or — when the workflow
 * chained `paper.parse` upstream — the dependency's `parsed-paper` artifact
 * rehydrated with `[page N]` markers so page evidence survives extraction.
 *
 * Idempotency key is derived from the workflow task id (not the attempt), so
 * a retried task maps to one logical agent call and duplicate commits stay
 * no-ops at the artifact layer.
 */
export const paperExtract: TaskHandler = async (ctx: TaskContext) => {
  await applyFaults(ctx);

  const harness = ctx.runtime.harness;
  if (!harness) {
    const error = new IdeaseekError(
      'INVALID_STATE',
      'no harness adapter configured for paper.extract (open the runtime with a harness)',
    );
    (error as IdeaseekError & { permanent?: boolean }).permanent = true;
    throw error;
  }

  // Idempotent: DshHarnessAdapter spawns its runtime here on first use;
  // FakeHarnessAdapter arms its guard.
  await harness.initialize();

  const paperName = typeof ctx.payload.paperName === 'string' ? ctx.payload.paperName : 'paper';
  let paperText = typeof ctx.payload.paperText === 'string' ? ctx.payload.paperText : '';
  if (!paperText.trim()) {
    // Chained after paper.parse: rehydrate the parsed pages with locators.
    paperText = await textFromParsedDependency(ctx);
  }
  if (!paperText.trim()) {
    const error = new IdeaseekError(
      'USER_INPUT_REQUIRED',
      'paper.extract needs payload.paperText or a succeeded paper.parse dependency',
    );
    (error as IdeaseekError & { permanent?: boolean }).permanent = true;
    throw error;
  }

  const result = await harness.runTask(
    {
      runId: ctx.run.runId,
      taskId: ctx.task.taskId,
      profile: 'paper-extractor',
      instruction:
        'Extract a structured paper card. Only report facts supported by the provided text; ' +
        'use "unknown" for anything not present. Output JSON matching the requested schema.',
      inputs: [{ kind: 'text', name: paperName, content: paperText }],
      outputSchema: 'papercard-lite-v1',
      budget: { timeoutMs: 60_000 },
      idempotencyKey: `paper-extract:${ctx.run.runId}:${ctx.task.taskId}`,
    },
    (event) => ctx.log(event.summary),
    ctx.signal,
  );

  const card = {
    source: { paperName, inputBytes: Buffer.byteLength(paperText, 'utf8') },
    harness: result.runtime,
    sessionId: result.sessionId ?? null,
    model: result.model,
    usage: result.usage,
    toolCalls: result.toolCalls,
    card: JSON.parse(result.output) as unknown,
  };

  // Persist an audit trail of every tool call the agent made: summaries are
  // sanitized by the adapter (no secrets, truncated arguments).
  for (const call of result.toolCalls) {
    await ctx.runtime.db.appendEvent({
      runId: ctx.run.runId,
      phase: ctx.task.phase,
      objectId: ctx.task.taskId,
      role: 'paper-extractor',
      eventType: 'harness_tool_call',
      summary: `${call.tool}(${call.summary}) ${call.ok ? 'ok' : 'failed'}`,
      status: call.ok ? 'ok' : 'error',
    });
  }

  return {
    artifacts: [
      {
        kind: 'papercard',
        data: `${JSON.stringify(card, null, 2)}\n`,
        meta: { filename: 'papercard.json', schema: 'papercard-lite-v1' },
      },
    ],
    summary: `extracted structured card for ${paperName} via ${result.runtime.kind}`,
    data: { model: result.model, outputBytes: Buffer.byteLength(result.output, 'utf8') },
  };
};
