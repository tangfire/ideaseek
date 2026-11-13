import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Of } from '../core/hash.js';
import { IdeaseekError } from '../core/errors.js';
import { redactSecrets } from '../core/redact.js';
import { runProcess } from '../core/proc.js';
import type { HarnessAdapter, HarnessImageInput } from '../dsh/adapter.js';
import type { ImageCapability } from '../models/image-capability.js';

/**
 * Page/figure vision analysis (Phase 2 图像/曲线视觉理解, DSH image
 * attachment reuse): a PDF page is rendered to PNG with pdftoppm and
 * passed to the model as an SDK image block — the DSH admission store
 * normalizes and durables it (no IdeaSeek-side image storage system).
 *
 * Hard rules (docs/EVALUATION + PROGRESS Phase 2):
 * - capability is resolved BEFORE any model call; unsupported routes
 *   degrade to a text fallback with low confidence + needsUserReview;
 * - results bind paperHash/page/figureId/attachmentSha256/model/route —
 *   stamped by the platform, never model-claimed;
 * - the model produces captions/observations only — numeric conclusions
 *   come from tables/structured experiment files, never from eyeballing
 *   pixels.
 */

export const PAGE_VISUAL_SCHEMA = 'page-visual-v1';

const VISUAL_INSTRUCTION = [
  'You are the paper figure/page analyst (docs/EVALUATION 图像理解).',
  'Describe what this rendered paper page shows: figures, tables, curves, layout.',
  'Rules:',
  '- Do NOT estimate numeric values from pixels (bar heights, curve points) — numbers come from tables and structured result files only.',
  '- If a plot has no readable axis labels, say so in uncertainty instead of guessing values.',
  '- Confidence reflects how much of the caption is directly readable, not how important the page is.',
  '',
  'Return ONLY one JSON object:',
  '{"caption": string (non-empty), "confidence": number (0..1), "uncertainty": string (non-empty), "observations": [string] (>=1, each a directly-readable fact)}',
].join('\n');

export interface VisualAnalysisResult {
  /** Platform-stamped: sha256 of the analyzed PDF bytes. */
  paperHash: string;
  /** Platform-stamped 1-based page number. */
  page: number;
  /** Platform-stamped figure id when the caller named one. */
  figureId: string | null;
  /** Platform-stamped sha256 of the PNG sent as the image block (vision only). */
  attachmentSha256: string | null;
  /** Model actually reported by the harness runtime (never model-claimed). */
  model: string | null;
  /** Capability basis string (route declaration / pinned catalog / …). */
  route: string;
  caption: string;
  confidence: number;
  uncertainty: string;
  observations: string[];
  source: 'vision' | 'text-fallback';
  /** True when a human must double-check (fallback or low confidence). */
  needsUserReview: boolean;
}

export interface RenderPageResult {
  png: Buffer;
  sha256: string;
}

/**
 * Renders one PDF page to PNG via pdftoppm (TeX Live ships it; same
 * subprocess adapter with timeout + tree-kill). Corrupt/unreadable PDFs
 * fail with the stable error taxonomy — never a crash.
 */
export async function renderPagePng(pdfPath: string, page: number): Promise<RenderPageResult> {
  if (!Number.isInteger(page) || page < 1) {
    throw new IdeaseekError('INVALID_ARGUMENT', '--page must be an integer >= 1');
  }
  const { stat } = await import('node:fs/promises');
  try {
    const info = await stat(pdfPath);
    if (!info.isFile()) throw new Error('not a file');
  } catch {
    throw new IdeaseekError('FILE_NOT_FOUND', `PDF not found: ${pdfPath}`);
  }
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const workDir = await mkdtemp(join(tmpdir(), 'ideaseek-visual-'));
  const prefix = join(workDir, 'page');
  try {
    const result = await runProcess(
      'pdftoppm',
      ['-f', String(page), '-l', String(page), '-png', '-r', '144', pdfPath, prefix],
      { timeoutMs: 60_000, env: process.env },
    );
    if (result.timedOut) {
      throw new IdeaseekError('PARSE_FAILED', `page render timed out for page ${page}`);
    }
    if (result.code !== 0) {
      const detail = redactSecrets(`${result.stderr}\n${result.stdout}`.trim().slice(0, 400));
      throw new IdeaseekError(
        'PARSE_FAILED',
        `cannot render page ${page} (pdftoppm exit ${result.code}) — corrupt or unsupported PDF${detail ? `: ${detail}` : ''}`,
      );
    }
    const files = (await readdir(workDir)).filter((name) => name.endsWith('.png'));
    if (files.length === 0) {
      throw new IdeaseekError('PARSE_FAILED', `page ${page} produced no image (empty page?)`);
    }
    files.sort();
    const pngPath = join(workDir, files[0]!);
    const png = await readFile(pngPath);
    if (png.length === 0) {
      throw new IdeaseekError('PARSE_FAILED', `page ${page} rendered an empty image`);
    }
    return { png, sha256: sha256Of(png) };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Model output contract for the vision pass (bindings are platform-stamped). */
export interface VisualModelOutput {
  caption: string;
  confidence: number;
  uncertainty: string;
  observations: string[];
}

function parseVisualOutput(output: string): VisualModelOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `page-visual output is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (!isObject(parsed)) {
    throw new IdeaseekError('PARSE_FAILED', 'page-visual output must be an object');
  }
  const errors: string[] = [];
  if (!nonEmpty(parsed.caption)) errors.push('caption must be a non-empty string');
  if (
    typeof parsed.confidence !== 'number' ||
    !Number.isFinite(parsed.confidence) ||
    parsed.confidence < 0 ||
    parsed.confidence > 1
  ) {
    errors.push('confidence must be within [0, 1]');
  }
  if (!nonEmpty(parsed.uncertainty)) errors.push('uncertainty must be a non-empty string');
  if (!Array.isArray(parsed.observations) || parsed.observations.length === 0) {
    errors.push('observations must be a non-empty array');
  } else if (parsed.observations.some((item) => !nonEmpty(item))) {
    errors.push('observations entries must be non-empty strings');
  }
  if (errors.length > 0) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `page-visual output violates ${PAGE_VISUAL_SCHEMA}: ${errors.slice(0, 4).join('; ')}`,
      { errors },
    );
  }
  return parsed as unknown as VisualModelOutput;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export interface AnalyzePageOptions {
  paperHash: string;
  page: number;
  pdfPath: string;
  /** Resolved BEFORE any model call (image-capability.ts). */
  capability: ImageCapability;
  figureId?: string | null;
  question?: string;
  /** Page text from the committed parsed-paper artifact (fallback input). */
  pageTextFallback?: string;
  /** Harness — required only on the vision path; pass null for fallback. */
  harness?: HarnessAdapter | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Analyzes one page. Vision path runs only when the capability check
 * passed; otherwise a text fallback records low confidence and flags the
 * result for user review — never a silent guess.
 */
export async function analyzePageVisual(opts: AnalyzePageOptions): Promise<VisualAnalysisResult> {
  const figureId = opts.figureId ?? null;

  if (!opts.capability.supported) {
    const text = (opts.pageTextFallback ?? '').trim();
    const caption = text ? text.replace(/\s+/g, ' ').slice(0, 280) : '';
    return {
      paperHash: opts.paperHash,
      page: opts.page,
      figureId,
      attachmentSha256: null,
      model: null,
      route: opts.capability.detail,
      caption,
      confidence: caption ? 0.35 : 0.1,
      uncertainty: `image input not supported on this route (${opts.capability.basis}); text-only fallback — visual details were NOT verified`,
      observations: caption
        ? ['text extracted from the committed parsed-paper artifact (no pixels inspected)']
        : ['no text available for this page — provide OCR output or an image-capable route'],
      source: 'text-fallback',
      needsUserReview: true,
    };
  }

  if (!opts.harness) {
    throw new IdeaseekError(
      'INVALID_STATE',
      'vision path requires a harness (capability said image input is supported)',
    );
  }

  const rendered = await renderPagePng(opts.pdfPath, opts.page);
  const imageInput: HarnessImageInput = {
    kind: 'image',
    name: `page-${opts.page}`,
    data: rendered.png.toString('base64'),
    mimeType: 'image/png',
    source: {
      paperHash: opts.paperHash,
      page: opts.page,
      ...(figureId ? { figureId } : {}),
    },
  };
  const question = opts.question ?? 'Describe this paper page: figures, tables, curves and layout.';

  const harness = opts.harness;
  await harness.initialize();
  const result = await harness.runTask(
    {
      runId: `page-visual:${opts.paperHash.slice(7, 19)}:${opts.page}`,
      taskId: `page-visual-${opts.page}`,
      profile: 'paper-extractor',
      instruction: VISUAL_INSTRUCTION,
      inputs: [{ kind: 'text', name: 'task', content: question }, imageInput],
      outputSchema: PAGE_VISUAL_SCHEMA,
      budget: { timeoutMs: opts.timeoutMs ?? 120_000, maxOutputTokens: 4_096 },
      idempotencyKey: `page-visual:${opts.paperHash}:${opts.page}:${figureId ?? '-'}`,
    },
    undefined,
    opts.signal,
  );

  const parsed = parseVisualOutput(result.output);
  return {
    paperHash: opts.paperHash, // platform stamp
    page: opts.page, // platform stamp
    figureId,
    attachmentSha256: rendered.sha256, // platform stamp (hash of sent bytes)
    model: result.model, // harness-reported, never model-claimed
    route: opts.capability.detail,
    caption: parsed.caption,
    confidence: parsed.confidence,
    uncertainty: parsed.uncertainty,
    observations: parsed.observations,
    source: 'vision',
    // Low-confidence visual claims need human verification (Phase 2 rule).
    needsUserReview: parsed.confidence < 0.7,
  };
}

/** Persisted per-page analysis (knowledge/visual/…), hash-bound. */
export interface StoredVisualAnalysis extends VisualAnalysisResult {
  contract: typeof PAGE_VISUAL_SCHEMA;
  inputHash: string;
  generatedAt: number;
}

export function visualInputHash(result: VisualAnalysisResult): string {
  return sha256Of(
    stableJsonLite({
      contract: PAGE_VISUAL_SCHEMA,
      paperHash: result.paperHash,
      page: result.page,
      figureId: result.figureId,
      attachmentSha256: result.attachmentSha256,
      model: result.model,
      route: result.route,
      caption: result.caption,
      confidence: result.confidence,
      uncertainty: result.uncertainty,
      observations: result.observations,
      source: result.source,
    }),
  );
}

/** Minimal stable JSON (sorted keys) — avoids importing experiment/spec. */
function stableJsonLite(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJsonLite).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJsonLite(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
