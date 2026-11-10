import { IdeaseekError } from '../core/errors.js';
import type { TaskContext, TaskHandler } from './types.js';
import { applyFaults } from './handlers.js';
import { parsePdf } from '../knowledge/pdf.js';
import { verifyPaperEvidence } from '../knowledge/checker.js';
import { sha256OfFile, sha256Of } from '../core/hash.js';
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
      outputSchema: 'papercard-v1',
      budget: { timeoutMs: 60_000 },
      idempotencyKey: `paper-extract:${ctx.run.runId}:${ctx.task.taskId}`,
    },
    (event) => ctx.log(event.summary),
    ctx.signal,
  );

  // Platform-stamped provenance: document identity is computed here, never
  // trusted from model output (the Evidence Checker re-verifies binding).
  const modelCard = JSON.parse(result.output) as Record<string, unknown>;
  const documentHash = await computeSourceHash(ctx);
  const card = {
    source: {
      paperName,
      sourcePath: typeof ctx.payload.sourcePath === 'string' ? ctx.payload.sourcePath : null,
      inputBytes: Buffer.byteLength(paperText, 'utf8'),
    },
    harness: result.runtime,
    sessionId: result.sessionId ?? null,
    model: result.model,
    usage: result.usage,
    toolCalls: result.toolCalls,
    card: {
      ...modelCard,
      paper_id: documentHash ? `paper-${documentHash.slice(7, 19)}` : 'unknown',
      document_hash: documentHash ?? modelCard.document_hash,
    },
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
        meta: { filename: 'papercard.json', schema: 'papercard-v1' },
      },
    ],
    summary: `extracted structured card for ${paperName} via ${result.runtime.kind}`,
    data: { model: result.model, outputBytes: Buffer.byteLength(result.output, 'utf8') },
  };
};

/** Source hash for provenance: the real file when known, else the excerpt bytes. */
async function computeSourceHash(ctx: TaskContext): Promise<string | null> {
  const sourcePath = typeof ctx.payload.sourcePath === 'string' ? ctx.payload.sourcePath : '';
  if (sourcePath && !sourcePath.includes('..')) {
    return sha256OfFile(join(ctx.runtime.paths.root, ...sourcePath.split('/')));
  }
  const paperText = typeof ctx.payload.paperText === 'string' ? ctx.payload.paperText : '';
  return paperText ? sha256Of(paperText) : null;
}

/**
 * Evidence Checker task (deterministic layer): re-reads the committed
 * papercard, verifies structure, hash binding and every claim quote against
 * the parsed pages (or raw text), and commits an evidence-report. The check
 * always commits its report — a failing verdict is information for the
 * workflow, not a crash.
 */
export const paperVerify: TaskHandler = async (ctx: TaskContext) => {
  await applyFaults(ctx);

  const extractId = ctx.task.dependsOn[0];
  if (!extractId) {
    const error = new IdeaseekError(
      'DEPENDENCY_NOT_MET',
      'paper.verify requires paper.extract as its dependency',
    );
    (error as IdeaseekError & { permanent?: boolean }).permanent = true;
    throw error;
  }
  const extract = await ctx.runtime.db.getTask(extractId);
  if (!extract || extract.status !== 'succeeded' || !extract.result) {
    const error = new IdeaseekError('DEPENDENCY_NOT_MET', 'paper.extract has not succeeded yet');
    (error as IdeaseekError & { permanent?: boolean }).permanent = true;
    throw error;
  }
  const extractArtifacts = await ctx.runtime.db.listArtifacts(extract.taskId);
  const cardRow = extractArtifacts.find(
    (row) => row.kind === 'papercard' && row.status === 'committed',
  );
  if (!cardRow) {
    const error = new IdeaseekError('DEPENDENCY_NOT_MET', 'papercard artifact missing');
    (error as IdeaseekError & { permanent?: boolean }).permanent = true;
    throw error;
  }
  const wrapper = JSON.parse(await ctx.runtime.store.readFinalText(cardRow.contentHash)) as {
    card: unknown;
  };

  // Pages from the chained parse task, or raw text for excerpt inputs.
  let pages: { page: number; text: string }[] | null = null;
  let sourceText: string | null = null;
  // Independently recomputed source hash — never taken from the card itself,
  // otherwise the binding check would be circular.
  let independentHash: string | null = null;
  const parseId = extract.dependsOn[0];
  if (parseId) {
    const parseTask = await ctx.runtime.db.getTask(parseId);
    if (parseTask?.status === 'succeeded') {
      const rows = await ctx.runtime.db.listArtifacts(parseTask.taskId);
      const parsedRow = rows.find(
        (row) => row.kind === 'parsed-paper' && row.status === 'committed',
      );
      if (parsedRow) {
        const parsed = JSON.parse(await ctx.runtime.store.readFinalText(parsedRow.contentHash)) as {
          pages: { page: number; text: string }[];
          sourceHash?: string;
        };
        pages = parsed.pages;
        independentHash = parsed.sourceHash ?? null;
      }
    }
  }
  const sourcePath = extract.payload.sourcePath;
  if (!pages) {
    if (typeof sourcePath === 'string' && sourcePath && !sourcePath.includes('..')) {
      try {
        const abs = join(ctx.runtime.paths.root, ...sourcePath.split('/'));
        sourceText = await (await import('node:fs/promises')).readFile(abs, 'utf8');
        independentHash ??= await sha256OfFile(abs);
      } catch {
        sourceText = null;
      }
    }
  }
  if (!pages && !sourceText) {
    const paperText =
      typeof extract.payload.paperText === 'string' ? extract.payload.paperText : '';
    sourceText = paperText || null;
    independentHash ??= paperText ? sha256Of(paperText) : null;
  }

  const report = verifyPaperEvidence({
    card: wrapper.card,
    pages,
    sourceText,
    sourceHash: independentHash,
    now: ctx.runtime.clock.now(),
  });

  await ctx.runtime.db.appendEvent({
    runId: ctx.run.runId,
    phase: ctx.task.phase,
    objectId: ctx.task.taskId,
    role: 'evidence-checker',
    eventType: 'evidence_verdict',
    summary: `${report.verdict}: ${report.stats.verified} verified, ${report.stats.weak} weak, ${report.stats.failed} failed`,
    status: report.verdict,
  });

  return {
    artifacts: [
      {
        kind: 'evidence-report',
        data: `${JSON.stringify(report, null, 2)}\n`,
        meta: { filename: 'evidence-report.json', verdict: report.verdict },
      },
    ],
    summary: `evidence ${report.verdict} (${report.stats.verified}/${report.stats.spans} spans verified)`,
    data: { verdict: report.verdict, ...report.stats },
  };
};
