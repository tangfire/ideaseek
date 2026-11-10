import { IdeaseekError, isIdeaseekError } from '../core/errors.js';
import type { TaskContext, TaskHandler } from './types.js';
import { applyFaults } from './handlers.js';
import { extractTables, parsePdf } from '../knowledge/pdf.js';
import { verifyPaperEvidence } from '../knowledge/checker.js';
import { sha256OfFile, sha256Of } from '../core/hash.js';
import { basename, join } from 'node:path';

interface ParsedPaperArtifact {
  source?: string;
  sourceHash?: string;
  parser?: string | null;
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
  // Batch map extracts carry no same-run parse dependency: fall back to the
  // globally committed parsed artifact for this source (cross-run reuse).
  const sourcePath = typeof ctx.payload.sourcePath === 'string' ? ctx.payload.sourcePath : '';
  const parsed = await loadParsedByPath(ctx, sourcePath);
  if (parsed) {
    const text = parsed.pages
      .map((page) => `[page ${page.page}]\n${page.text.trim()}`)
      .join('\n\n');
    if (text.trim()) return text;
  }
  return '';
}

/**
 * Finds the committed parsed-paper artifact for a project-relative PDF path
 * across all runs (content-addressed parse reuse in the batch map stage).
 */
async function loadParsedByPath(
  ctx: TaskContext,
  sourcePath: string,
): Promise<ParsedPaperArtifact | null> {
  if (!sourcePath || sourcePath.includes('..') || !sourcePath.toLowerCase().endsWith('.pdf')) {
    return null;
  }
  const artifacts = await ctx.runtime.db.listArtifactsByKind('parsed-paper');
  for (let index = artifacts.length - 1; index >= 0; index -= 1) {
    const row = artifacts[index]!;
    try {
      const payload = JSON.parse(
        await ctx.runtime.store.readFinalText(row.contentHash),
      ) as ParsedPaperArtifact;
      if (payload.source === sourcePath && Array.isArray(payload.pages)) return payload;
    } catch {
      continue; // unreadable artifact: keep searching older generations
    }
  }
  return null;
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
  let parsed;
  try {
    parsed = await parsePdf(abs);
  } catch (error) {
    // File-level parse failures are content-addressed: retrying identical
    // bytes cannot heal them, so fail fast and let the run flag this paper
    // without burning attempts (docs: 失败论文被标记而不是丢失).
    if (
      isIdeaseekError(error) &&
      ['PARSE_FAILED', 'FILE_NOT_FOUND', 'EMPTY_FILE', 'ENCRYPTED_PDF', 'NO_TEXT_LAYER'].includes(
        error.code,
      )
    ) {
      (error as IdeaseekError & { permanent?: boolean }).permanent = true;
    }
    throw error;
  }
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
/** Prompt+schema version for provenance; bump when the instruction changes. */
export const PAPERCARD_PROMPT_VERSION = 'papercard-v1-prompt.3';

/**
 * Self-contained extraction instruction. The schema is embedded (a real run
 * showed the model improvising an incompatible card when it could not read
 * schema files), and evidence quotes must be verbatim substrings anchored to
 * the nearest `[page N]` marker so the Evidence Checker can verify them.
 */
export const PAPERCARD_INSTRUCTION = [
  'Extract a structured paper card from the provided text only.',
  'Only report facts supported by the provided text; use "unknown" for anything not present.',
  'Do not call any tools; do not use outside knowledge; produce ONLY one JSON object, no prose, no fences.',
  'Shape:',
  '{',
  '  "title": string,',
  '  "problem": string,',
  '  "method": {"summary": string, "steps": [string], "motivation": [string]},',
  '  "datasets": [string],',
  '  "metrics": [string],',
  '  "baselines": [string],',
  '  "limitations": [string],',
  '  "claims": [{"text": string, "evidence": [{"page": number, "quote": string}]}],',
  '  "unknowns": [string]',
  '}',
  'Rules:',
  '- evidence.quote must be an EXACT verbatim substring of the input text (copy character-for-character; no paraphrase, no ellipsis).',
  '- evidence.page = the number of the nearest preceding "[page N]" marker before the quote.',
  '- include every numeric result you can support as a claim with a quote.',
  '- method.steps/motivation, datasets, metrics, baselines, limitations, unknowns: plain short strings.',
  '- Keep it concise: at most 5 method steps, 6 motivation items, 8 claims, and 8 items in each string array.',
  '- Never quote more than 30 words per evidence quote.',
].join('\n');

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

  // Bound prompt size: full text stays in the artifact for evidence checks;
  // the extractor sees at most INPUT_CAP bytes (long papers otherwise time out).
  const INPUT_CAP = 64 * 1024;
  const originalBytes = Buffer.byteLength(paperText, 'utf8');
  const feedText =
    originalBytes > INPUT_CAP
      ? paperText.slice(0, INPUT_CAP) +
        '\n\n[... input truncated for the extractor; evidence checks still use the full parsed source ...]'
      : paperText;
  const result = await harness.runTask(
    {
      runId: ctx.run.runId,
      taskId: ctx.task.taskId,
      profile: 'paper-extractor',
      instruction: PAPERCARD_INSTRUCTION,
      inputs: [{ kind: 'text', name: paperName, content: feedText }],
      outputSchema: 'papercard-v1',
      budget: { timeoutMs: 180_000, maxOutputTokens: 8192 },
      idempotencyKey: `paper-extract:${ctx.run.runId}:${ctx.task.taskId}`,
    },
    (event) => ctx.log(event.summary),
    ctx.signal,
  );

  // Platform-stamped provenance: document identity, parser and schema
  // versions are computed here, never trusted from model output (the
  // Evidence Checker re-verifies the binding).
  const modelCard = JSON.parse(result.output) as Record<string, unknown>;
  const documentHash = await computeSourceHash(ctx);
  const sourcePathStr = typeof ctx.payload.sourcePath === 'string' ? ctx.payload.sourcePath : '';
  let depParser = await readChainedParserVersion(ctx);
  if (!depParser && sourcePathStr) {
    depParser = (await loadParsedByPath(ctx, sourcePathStr))?.parser ?? null;
  }
  const card = {
    source: {
      paperName,
      sourcePath: typeof ctx.payload.sourcePath === 'string' ? ctx.payload.sourcePath : null,
      inputBytes: originalBytes,
      fedBytes: Buffer.byteLength(feedText, 'utf8'),
      promptVersion: PAPERCARD_PROMPT_VERSION,
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
      parser_version: depParser ?? 'unknown',
      prompt_schema_version: 'papercard-v1',
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

/** Parser version from the chained paper.parse artifact (provenance stamp). */
async function readChainedParserVersion(ctx: TaskContext): Promise<string | null> {
  const parseId = ctx.task.dependsOn[0];
  if (!parseId) return null;
  const parseTask = await ctx.runtime.db.getTask(parseId);
  if (!parseTask || parseTask.status !== 'succeeded') return null;
  const rows = await ctx.runtime.db.listArtifacts(parseTask.taskId);
  const parsedRow = rows.find((row) => row.kind === 'parsed-paper' && row.status === 'committed');
  if (!parsedRow) return null;
  try {
    const parsed = JSON.parse(await ctx.runtime.store.readFinalText(parsedRow.contentHash)) as {
      parser?: string;
    };
    return parsed.parser ?? null;
  } catch {
    return null;
  }
}

/**
 * Opt-in table extraction (docs: 表格/图表解析): pdfplumber grids for one
 * paper, committed as a paper-tables artifact. nonBlocking like other
 * per-paper data tasks: a broken layout flags the paper, never the run.
 */
export const paperTables: TaskHandler = async (ctx: TaskContext) => {
  await applyFaults(ctx);
  const pdfPath = typeof ctx.payload.pdfPath === 'string' ? ctx.payload.pdfPath : '';
  if (!pdfPath || !pdfPath.toLowerCase().endsWith('.pdf') || pdfPath.includes('..')) {
    const error = new IdeaseekError(
      'USER_INPUT_REQUIRED',
      'paper.tables needs a project-relative payload.pdfPath',
    );
    (error as IdeaseekError & { permanent?: boolean }).permanent = true;
    throw error;
  }
  const abs = join(ctx.runtime.paths.root, ...pdfPath.split('/'));
  let result;
  try {
    result = await extractTables(abs);
  } catch (error) {
    if (
      isIdeaseekError(error) &&
      ['PARSE_FAILED', 'FILE_NOT_FOUND', 'EMPTY_FILE', 'PARSER_MISSING'].includes(error.code)
    ) {
      (error as IdeaseekError & { permanent?: boolean }).permanent =
        error.code !== 'PARSER_MISSING';
    }
    throw error;
  }
  const sourceHash = await sha256OfFile(abs);
  const payload = {
    source: pdfPath,
    sourceHash,
    tables: result.tables,
    tableCount: result.tableCount,
    parser: result.parser,
  };
  return {
    artifacts: [
      {
        kind: 'paper-tables',
        data: `${JSON.stringify(payload, null, 2)}
`,
        meta: { filename: 'paper-tables.json', parser: result.parser },
      },
    ],
    summary: `extracted ${result.tableCount} table(s) from ${pdfPath}`,
    data: { tableCount: result.tableCount, sourceHash },
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
  if (!pages && typeof sourcePath === 'string' && sourcePath.toLowerCase().endsWith('.pdf')) {
    // Batch map: no same-run parse dependency — use the global artifact.
    const parsed = await loadParsedByPath(ctx, sourcePath);
    if (parsed) {
      pages = parsed.pages;
      independentHash ??= parsed.sourceHash ?? null;
    }
  }
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
