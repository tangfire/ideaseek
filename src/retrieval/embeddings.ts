import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IdeaseekError } from '../core/errors.js';
import { ensureDir, writeFileAtomic } from '../core/atomic.js';
import { existsSync } from 'node:fs';
import type { ProjectRuntime } from '../workflow/runtime.js';
import type { PaperSearchHit } from '../workflow/db.js';

/**
 * Pluggable local embedding layer (user decision: local model, NO external
 * embedding APIs). BM25/FTS stays the base retrieval path: every function
 * here is optional — when the provider, its package, the model cache or the
 * network is unavailable, callers fall back to FTS and say so. Vector
 * similarity only re-ranks recall; conclusions must still cite source
 * snippets and PaperCard evidence.
 */
export const DEFAULT_EMBEDDING_MODEL = 'sentence-transformers/all-MiniLM-L6-v2';
/** Pinned fastembed wheel (worker venv, requirements.txt keeps them in sync). */
export const FASTEMBED_PIN = 'fastembed==0.9.1';

/**
 * Shared model cache (default ~/.cache/ideaseek/embeddings, override with
 * IDEASEEK_EMBEDDINGS_CACHE) so every project reuses one download; each
 * project records the resolved location in its embedding manifest.
 */
export interface EmbeddingInstallResult {
  manifest: EmbeddingModelManifest;
  createdVenv: boolean;
  pipInstalled: boolean;
}

/**
 * Explicit install path for setup/doctor: ensure the pinned worker venv,
 * install requirements.txt (locked wheels incl. fastembed), warm up the
 * model into the shared cache and record knowledge/embedding-model.json
 * (id/version/license/fingerprint/cache). Failure throws INSTALL_FAILED —
 * search keeps working on BM25/FTS regardless.
 */
export async function installEmbeddingStack(opts: {
  knowledgeDir: string;
  modelId?: string;
  timeoutMs?: number;
}): Promise<EmbeddingInstallResult> {
  const modelId = opts.modelId ?? DEFAULT_EMBEDDING_MODEL;
  const venvDir = join(workerPythonDir(), '.venv');
  const py = venvPython();
  const run = (args: string[], timeoutMs: number): Promise<{ code: number; out: string }> =>
    new Promise((promiseResolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(args[0]!, args.slice(1), {
          cwd: workerPythonDir(),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(new IdeaseekError('ENV_UNSUPPORTED', String(error)));
        return;
      }
      let out = '';
      child.stdout?.on('data', (chunk) => (out += String(chunk)));
      child.stderr?.on('data', (chunk) => (out += String(chunk)));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new IdeaseekError('INSTALL_FAILED', 'installation step timed out'));
      }, timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new IdeaseekError('ENV_UNSUPPORTED', error.message));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        promiseResolve({ code: code ?? -1, out });
      });
    });

  let createdVenv = false;
  if (!existsSync(py)) {
    const base = await run(
      [process.platform === 'win32' ? 'python' : 'python3', '-m', 'venv', venvDir],
      600_000,
    );
    if (base.code !== 0) {
      throw new IdeaseekError(
        'INSTALL_FAILED',
        `cannot create worker venv: ${base.out.slice(-300)}`,
      );
    }
    createdVenv = true;
  }
  const probe = await probeEmbeddingEnvironment(embeddingCacheDir(), modelId);
  let pipInstalled = false;
  if (!probe.packageInstalled) {
    const install = await run(
      [py, '-m', 'pip', 'install', '--progress-bar', 'off', '-r', 'requirements.txt'],
      opts.timeoutMs ?? 900_000,
    );
    if (install.code !== 0) {
      throw new IdeaseekError(
        'INSTALL_FAILED',
        `pip install failed (search keeps using BM25/FTS): ${install.out.slice(-400)}`,
      );
    }
    pipInstalled = true;
  }
  const warmup = await runEmbedWorkerChecked(['embed'], {
    stdinJson: {
      model: modelId,
      texts: ['warmup'],
      cacheDir: embeddingCacheDir(),
      warmupOnly: true,
    },
    timeoutMs: 600_000,
  });
  const manifest: EmbeddingModelManifest = {
    model: String(warmup.model ?? modelId),
    fastembedVersion: String(warmup.fastembedVersion ?? 'unknown'),
    license: String(warmup.license ?? 'unknown'),
    fingerprint: String(warmup.fingerprint ?? 'sha256:unknown'),
    cacheDir: String(warmup.cacheDir ?? embeddingCacheDir()),
    downloaded: warmup.downloaded === true,
    installedAt: Date.now(),
  };
  await ensureDir(opts.knowledgeDir);
  await writeFileAtomic(
    join(opts.knowledgeDir, 'embedding-model.json'),
    JSON.stringify(manifest, null, 2) + String.fromCharCode(10),
  );
  return { manifest, createdVenv, pipInstalled };
}
async function runEmbedWorkerChecked(
  args: string[],
  opts: { stdinJson: unknown; timeoutMs: number },
): Promise<Record<string, unknown>> {
  return runEmbedWorker(args, opts);
}
export function embeddingCacheDir(): string {
  const fromEnv = process.env.IDEASEEK_EMBEDDINGS_CACHE;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const home = process.env.USERPROFILE || process.env.HOME || '.';
  return join(home, '.cache', 'ideaseek', 'embeddings');
}
export const EVIDENCE_DISCLAIMER =
  'vector similarity only re-ranks recall — always verify claims against the returned source snippet and PaperCard evidence';

export interface EmbeddingProbeResult {
  packageInstalled: boolean;
  fastembedVersion: string | null;
  model: string;
  modelCached: boolean;
  license: string;
  cacheDir: string;
  fingerprint?: string;
}

export interface EmbeddingModelManifest {
  model: string;
  fastembedVersion: string;
  license: string;
  fingerprint: string;
  cacheDir: string;
  downloaded: boolean;
  installedAt: number;
}

function workerPythonDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'worker', 'python');
}

function venvPython(): string {
  return process.platform === 'win32'
    ? join(workerPythonDir(), '.venv', 'Scripts', 'python.exe')
    : join(workerPythonDir(), '.venv', 'bin', 'python');
}

/** Runs a worker python module command with stdin JSON; strict JSON stdout. */
function runEmbedWorker(
  args: string[],
  opts: { stdinJson?: unknown; timeoutMs: number },
): Promise<Record<string, unknown>> {
  return new Promise((promiseResolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(venvPython(), ['-m', 'ideaseek_worker', ...args], {
        cwd: workerPythonDir(),
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(
        new IdeaseekError(
          'ENV_UNSUPPORTED',
          `cannot spawn venv python: ${(error as Error).message}`,
        ),
      );
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new IdeaseekError('INSTALL_FAILED', 'embedding worker timed out'));
    }, opts.timeoutMs);
    child.stdout?.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr?.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', () => {
      clearTimeout(timer);
      reject(
        new IdeaseekError(
          'ENV_UNSUPPORTED',
          'worker venv python missing (see worker/python/README)',
        ),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
        try {
          promiseResolve(JSON.parse(line) as Record<string, unknown>);
        } catch (error) {
          reject(
            new IdeaseekError(
              'PARSE_FAILED',
              `bad embedding worker output: ${(error as Error).message}`,
            ),
          );
        }
        return;
      }
      let payload: { code?: string; message?: string } | null = null;
      for (const line of stderr.trim().split(/\r?\n/).reverse()) {
        if (!line.startsWith('{')) continue;
        try {
          payload = JSON.parse(line) as { code?: string; message?: string };
          break;
        } catch {
          continue;
        }
      }
      const known = new Set([
        'FASTEMBED_MISSING',
        'MODEL_UNAVAILABLE',
        'PARSE_FAILED',
        'INSTALL_FAILED',
        'FILE_NOT_FOUND',
      ]);
      const rawCode = payload?.code ?? '';
      const errorCode = known.has(rawCode) ? (rawCode as 'INSTALL_FAILED') : 'INSTALL_FAILED';
      reject(
        new IdeaseekError(
          errorCode,
          payload?.message ?? `embedding worker failed (exit ${String(rawCode)})`,
        ),
      );
    });
    if (opts.stdinJson !== undefined) child.stdin?.end(JSON.stringify(opts.stdinJson));
    else child.stdin?.end();
  });
}

/** Fast capability probe (never downloads a model). */
export function probeEmbeddingEnvironment(
  cacheDir: string,
  modelId: string = DEFAULT_EMBEDDING_MODEL,
): Promise<EmbeddingProbeResult> {
  return runEmbedWorker(['embed-probe', '--model', modelId, '--cache-dir', cacheDir], {
    timeoutMs: 30_000,
  }) as Promise<unknown> as Promise<EmbeddingProbeResult>;
}

/** Local fastembed provider: project-managed cache, version/license/fingerprint recorded. */
export class LocalFastEmbedProvider {
  readonly providerId = 'local-fastembed';
  readonly modelId: string;
  readonly cacheDir: string;
  private manifest: EmbeddingModelManifest | null = null;

  constructor(opts: { modelId?: string; cacheDir: string }) {
    this.modelId = opts.modelId ?? DEFAULT_EMBEDDING_MODEL;
    this.cacheDir = opts.cacheDir;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const payload = await runEmbedWorker(['embed'], {
      stdinJson: { model: this.modelId, texts, cacheDir: this.cacheDir },
      timeoutMs: 300_000,
    });
    const vectors = payload.vectors;
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      throw new IdeaseekError('MODEL_UNAVAILABLE', 'embedding worker returned no vectors');
    }
    this.manifest = {
      model: String(payload.model),
      fastembedVersion: String(payload.fastembedVersion),
      license: String(payload.license),
      fingerprint: String(payload.fingerprint),
      cacheDir: String(payload.cacheDir),
      downloaded: payload.downloaded === true,
      installedAt: Date.now(),
    };
    return vectors as number[][];
  }

  async describe(): Promise<EmbeddingModelManifest | null> {
    if (this.manifest) return this.manifest;
    const probe = await probeEmbeddingEnvironment(this.cacheDir, this.modelId);
    if (!probe.modelCached || !probe.fingerprint) return null;
    return {
      model: probe.model,
      fastembedVersion: probe.fastembedVersion ?? 'unknown',
      license: probe.license,
      fingerprint: probe.fingerprint,
      cacheDir: probe.cacheDir,
      downloaded: true,
      installedAt: 0,
    };
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface RankedHit {
  source: string;
  page: number;
  rank: number;
  /** Content hash used as the fts/paper key (vector rows know theirs). */
  sourceHash?: string;
}

/** Reciprocal-rank fusion (k=60): FTS and vector lists merge fairly. */
export function rrfMerge(lists: RankedHit[][], k = 60): RankedHit[] {
  const scores = new Map<string, RankedHit & { score: number }>();
  for (const list of lists) {
    list.forEach((hit, index) => {
      const key = `${hit.source}#${hit.page}`;
      const existing = scores.get(key);
      if (existing) existing.score += 1 / (k + index + 1);
      else scores.set(key, { ...hit, score: 1 / (k + index + 1) });
    });
  }
  return [...scores.values()].sort((a, b) => b.score - a.score);
}

export interface RefreshEmbeddingsResult {
  embedded: number;
  skipped: number;
  failed: number;
}

/**
 * Incremental: embeds only pages of parsed sources that have no row for the
 * current provider+model. New papers embed; unchanged ones are skipped.
 */
export async function refreshEmbeddings(
  runtime: ProjectRuntime,
  provider: LocalFastEmbedProvider,
  opts: { batchChars?: number; limit?: number } = {},
): Promise<RefreshEmbeddingsResult> {
  const existing = new Set(
    (await runtime.db.listEmbeddings(provider.providerId, provider.modelId)).map(
      (row) => `${row.sourceHash}#${row.page}`,
    ),
  );

  const seenKeys = new Set<string>();
  const pending: { sourceHash: string; source: string; page: number; text: string }[] = [];
  for (const artifact of await runtime.db.listArtifactsByKind('parsed-paper')) {
    let payload: {
      source?: string;
      sourceHash?: string;
      pages?: { page: number; text: string }[];
    };
    try {
      payload = JSON.parse(await runtime.store.readFinalText(artifact.contentHash));
    } catch {
      continue;
    }
    if (!payload.source || !payload.sourceHash || !Array.isArray(payload.pages)) continue;
    for (const page of payload.pages) {
      const text = (page.text ?? '').trim();
      if (!text) continue;
      const key = `${payload.sourceHash}#${page.page}`;
      if (existing.has(key) || seenKeys.has(key)) continue;
      seenKeys.add(key);
      pending.push({
        sourceHash: payload.sourceHash,
        source: payload.source,
        page: page.page,
        text: text.slice(0, 2000), // embedding input bound (MiniLM truncates far earlier)
      });
      if (opts.limit && pending.length >= opts.limit) break;
    }
    if (opts.limit && pending.length >= opts.limit) break;
  }
  if (pending.length === 0) return { embedded: 0, skipped: existing.size, failed: 0 };

  const batchChars = opts.batchChars ?? 8_000;
  const batches: (typeof pending)[] = [];
  let current: typeof pending = [];
  let chars = 0;
  for (const item of pending) {
    if (current.length > 0 && chars + item.text.length > batchChars) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += item.text.length;
  }
  if (current.length > 0) batches.push(current);

  let embedded = 0;
  let failed = 0;
  for (const batch of batches) {
    try {
      const vectors = await provider.embed(batch.map((item) => item.text));
      for (let i = 0; i < batch.length; i += 1) {
        const item = batch[i]!;
        const vector = vectors[i]!;
        await runtime.db.upsertEmbedding({
          source: item.source,
          sourceHash: item.sourceHash,
          page: item.page,
          preview: item.text.slice(0, 200),
          provider: provider.providerId,
          modelId: provider.modelId,
          dim: vector.length,
          vector,
          createdAt: runtime.clock.now(),
        });
        embedded += 1;
      }
    } catch {
      failed += batch.length; // fallback happens at the search layer
      break;
    }
  }
  if (embedded > 0) {
    // Record provenance once: model id/version/license/fingerprint/cache.
    try {
      const manifestPath = join(runtime.paths.knowledgeDir, 'embedding-model.json');
      if (!existsSync(manifestPath)) {
        const manifest = await provider.describe();
        if (manifest) {
          await ensureDir(runtime.paths.knowledgeDir);
          await writeFileAtomic(
            manifestPath,
            JSON.stringify({ ...manifest, installedAt: runtime.clock.now() }, null, 2) +
              String.fromCharCode(10),
          );
        }
      }
    } catch {
      // Manifest is provenance, never a blocker for search.
    }
  }
  return { embedded, skipped: existing.size, failed };
}

export interface HybridSearchOptions {
  query: string;
  limit?: number;
}

export interface HybridSearchResult {
  mode: 'fts' | 'hybrid';
  hits: (PaperSearchHit & { via: 'fts' | 'vector' })[];
  fusion: { ftsHits: number; vectorHits: number };
  note?: string;
}

/**
 * BM25/FTS-first hybrid search: FTS always runs; when embeddings for the
 * current provider+model cover the corpus, a vector pass is fused in via
 * RRF. ANY embedding failure degrades to pure FTS with an explanatory note —
 * search never fails because of the optional vector layer.
 */
export async function hybridSearch(
  runtime: ProjectRuntime,
  provider: LocalFastEmbedProvider | null,
  opts: HybridSearchOptions,
): Promise<HybridSearchResult> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const ftsHits = await runtime.db.searchPapers(opts.query, { limit: limit * 2 });
  const ftsRanked: RankedHit[] = ftsHits.map((hit, index) => ({
    source: hit.source,
    page: hit.page,
    rank: index,
  }));

  if (!provider) {
    return {
      mode: 'fts',
      hits: ftsHits.map((hit) => ({ ...hit, via: 'fts' as const })),
      fusion: { ftsHits: ftsHits.length, vectorHits: 0 },
      note: 'embedding provider unavailable: BM25/FTS only',
    };
  }

  let queryVector: number[] | null = null;
  try {
    const embedded = await provider.embed([opts.query]);
    queryVector = embedded[0] ?? null;
  } catch (error) {
    return {
      mode: 'fts',
      hits: ftsHits.map((hit) => ({ ...hit, via: 'fts' as const })),
      fusion: { ftsHits: ftsHits.length, vectorHits: 0 },
      note: `embedding unavailable (${(error as Error).message.slice(0, 120)}): BM25/FTS only`,
    };
  }
  if (!queryVector) {
    return {
      mode: 'fts',
      hits: ftsHits.map((hit) => ({ ...hit, via: 'fts' as const })),
      fusion: { ftsHits: ftsHits.length, vectorHits: 0 },
      note: 'embedding produced no query vector: BM25/FTS only',
    };
  }

  const rows = await runtime.db.listEmbeddings(provider.providerId, provider.modelId);
  const scored = rows
    .map((row) => ({ row, score: cosineSimilarity(queryVector!, row.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit * 2);
  const vectorRanked: RankedHit[] = scored.map((entry, index) => ({
    source: entry.row.source,
    page: entry.row.page,
    rank: index,
    sourceHash: entry.row.sourceHash,
  }));

  const fused = rrfMerge([ftsRanked, vectorRanked]).slice(0, limit);
  const byKey = new Map<string, (PaperSearchHit & { via: 'fts' | 'vector' })[]>();
  for (const hit of ftsHits) {
    const key = `${hit.source}#${hit.page}`;
    byKey.set(key, [{ ...hit, via: 'fts' }]);
  }
  const previewBySourcePage = new Map<string, string>();
  for (const row of rows) previewBySourcePage.set(`${row.source}#${row.page}`, row.preview);

  const hits: (PaperSearchHit & { via: 'fts' | 'vector' })[] = [];
  for (const entry of fused) {
    const key = `${entry.source}#${entry.page}`;
    const existing = byKey.get(key);
    if (existing?.[0]) {
      // Present in both lists: keep the richer FTS snippet, mark fusion.
      hits.push({ ...existing[0], via: 'fts' });
      byKey.delete(key);
      continue;
    }
    hits.push({
      paperKey: entry.sourceHash ?? entry.source,
      source: entry.source,
      page: entry.page,
      snippet: previewBySourcePage.get(key) ?? '',
      score: entry.rank,
      via: 'vector',
    });
  }
  // FTS hits the fusion dropped entirely: append tail (still useful recall).
  for (const leftovers of byKey.values()) {
    if (hits.length >= limit) break;
    hits.push(leftovers[0]!);
  }

  return {
    mode: 'hybrid',
    hits: hits.slice(0, limit),
    fusion: { ftsHits: ftsRanked.length, vectorHits: vectorRanked.length },
  };
}
