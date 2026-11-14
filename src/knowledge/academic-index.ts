import { sha256Of, type ContentHash } from '../core/hash.js';

/**
 * Academic index port for the Dataset Discovery Agent
 * (docs/ARIS_INTEGRATION_PLAN §P1 数据集发现: 从 "允许的学术索引" 发现数据集).
 *
 * Build-vs-reuse gate (ARIS_INTEGRATION_PLAN §Build-vs-reuse gate):
 * 1. DSH exposes no academic-index capability (no such tool).
 * 2. ARIS has `openalex` / `semantic-scholar` / `research-lit` skills, but they
 *    are instructions for a shell-capable executor that runs python fetchers
 *    (`openalex_fetch.py`, `semantic_scholar_fetch.py`) with Bash — IdeaSeek's
 *    discovery runs as one schema-bound harness instruction with no shell tools,
 *    so their bodies cannot execute as written.
 * 3. Not configurable into a port: the skills produce prose, not a
 *    DatasetCandidate provenance record.
 * 4. The gap is a structured, refusal-honest transport (persisted response
 *    hash + per-endpoint failure records), so this thin port mirrors only the
 *    skills' query/dedup semantics: bounded limits, OpenAlex open works +
 *   Semantic Scholar venue papers, keyless access, HTTP failures surfaced as
 *    per-endpoint errors the collector records as refused/failed sources.
 *
 * Credentials: both APIs allow keyless access (rate limited). No API key is
 * read, logged or persisted here; keys stay in the host credential store.
 */

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface IndexHit {
  endpoint: 'openalex' | 'semantic-scholar';
  /** Raw work/paper title as returned by the index. */
  title: string;
  abstract: string | null;
  /** Landing page (works as a provenance URL; not a direct download URL). */
  url: string | null;
  /** Index identifier (OpenAlex work id / S2 paper id / DOI when present). */
  indexId: string | null;
  year: number | null;
}

/** Per-endpoint transport record: hash of the raw response body for provenance. */
export interface IndexEndpointResult {
  endpoint: 'openalex' | 'semantic-scholar';
  ok: boolean;
  contentHash: ContentHash | null;
  hits: number;
  /** Transport/HTTP/parsing failure (never a secret, never a stack trace). */
  error?: string;
}

export interface IndexSearchResult {
  query: string;
  hits: IndexHit[];
  endpoints: IndexEndpointResult[];
}

export interface AcademicIndexClient {
  search(
    query: string,
    opts?: { limit?: number; signal?: AbortSignal },
  ): Promise<IndexSearchResult>;
}

export interface IndexClientOptions {
  /** Injectable fetch (tests never touch the network). */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

const OPENALEX = 'https://api.openalex.org/works';
const SEMANTIC_SCHOLAR = 'https://api.semanticscholar.org/graph/v1/paper/search';
const S2_FIELDS = 'title,abstract,year,url,externalIds';

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Default transport: global fetch with a hard timeout per request. */
function defaultFetch(timeoutMs: number): FetchLike {
  return async (url, init) => {
    const signal = init?.signal ?? AbortSignal.timeout(timeoutMs);
    const response = await globalThis.fetch(url, { signal, headers: init?.headers });
    return { ok: response.ok, status: response.status, text: () => response.text() };
  };
}

/**
 * Both indexes throttle anonymous callers. OpenAlex's polite pool and
 * Semantic Scholar's higher limit are identification, not secrets, so they
 * come from the environment and are simply omitted when unset.
 */
function contactEmail(): string | null {
  const value = process.env.IDEASEEK_CONTACT_EMAIL;
  return value && value.trim() && value.includes('@') ? value.trim() : null;
}

function s2ApiKey(): string | null {
  const value = process.env.IDEASEEK_S2_API_KEY;
  return value && value.trim() ? value.trim() : null;
}

async function parseOpenAlex(body: string): Promise<IndexHit[]> {
  const parsed = JSON.parse(body) as { results?: unknown };
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const hits: IndexHit[] = [];
  for (const raw of results) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const title = str(row.display_name);
    if (!title) continue;
    hits.push({
      endpoint: 'openalex',
      title,
      // OpenAlex abstracts come as inverted indexes; reconstructing them is
      // out of scope for name extraction, so titles carry the evidence.
      abstract: null,
      url: str(row.id) ?? str(row.doi),
      indexId: str(row.id) ?? str(row.doi),
      year: num(row.publication_year),
    });
  }
  return hits;
}

async function parseSemanticScholar(body: string): Promise<IndexHit[]> {
  const parsed = JSON.parse(body) as { data?: unknown };
  const rows = Array.isArray(parsed.data) ? parsed.data : [];
  const hits: IndexHit[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const title = str(row.title);
    if (!title) continue;
    const externalIds = (row.externalIds ?? {}) as Record<string, unknown>;
    hits.push({
      endpoint: 'semantic-scholar',
      title,
      abstract: str(row.abstract),
      url:
        str(row.url) ??
        (str(externalIds.DOI) ? `https://doi.org/${String(externalIds.DOI)}` : null),
      indexId: str(row.paperId) ?? str(externalIds.DOI) ?? null,
      year: num(row.year),
    });
  }
  return hits;
}

/**
 * Runs one query against the allowed indexes. Each endpoint succeeds or fails
 * independently (partial results are legal: the collector records which ones
 * contributed); transport failures never throw out of `search`.
 */
export function createAcademicIndexClient(opts: IndexClientOptions = {}): AcademicIndexClient {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const fetchImpl = opts.fetchImpl ?? defaultFetch(timeoutMs);
  return {
    async search(query, searchOpts = {}) {
      const limit = Math.max(1, Math.min(searchOpts.limit ?? 10, 25));
      const endpoints: IndexEndpointResult[] = [];
      const hits: IndexHit[] = [];

      const email = contactEmail();
      const openalexUrl = `${OPENALEX}?search=${encodeURIComponent(query)}&per-page=${limit}${
        email ? `&mailto=${encodeURIComponent(email)}` : ''
      }`;
      try {
        const response = await fetchImpl(openalexUrl, { signal: searchOpts.signal });
        if (!response.ok) {
          endpoints.push({
            endpoint: 'openalex',
            ok: false,
            contentHash: null,
            hits: 0,
            error: `http ${response.status}${
              response.status === 429 && !email
                ? ' (rate limited — set IDEASEEK_CONTACT_EMAIL to use OpenAlex polite pool)'
                : response.status === 429
                  ? ' (rate limited even with IDEASEEK_CONTACT_EMAIL)'
                  : ''
            }`,
          });
        } else {
          const body = await response.text();
          const parsed = await parseOpenAlex(body);
          endpoints.push({
            endpoint: 'openalex',
            ok: true,
            contentHash: sha256Of(body),
            hits: parsed.length,
          });
          hits.push(...parsed);
        }
      } catch (error) {
        endpoints.push({
          endpoint: 'openalex',
          ok: false,
          contentHash: null,
          hits: 0,
          error: `network refused: ${(error as Error).message.slice(0, 160)}`,
        });
      }

      const s2Key = s2ApiKey();
      const s2Url =
        `${SEMANTIC_SCHOLAR}?query=${encodeURIComponent(query)}` +
        `&limit=${limit}&fields=${S2_FIELDS}`;
      try {
        const response = await fetchImpl(s2Url, {
          signal: searchOpts.signal,
          headers: s2Key ? { 'x-api-key': s2Key } : undefined,
        });
        if (!response.ok) {
          endpoints.push({
            endpoint: 'semantic-scholar',
            ok: false,
            contentHash: null,
            hits: 0,
            error: `http ${response.status}${
              response.status === 429 && !s2Key
                ? ' (rate limited — set IDEASEEK_S2_API_KEY for the authenticated limit)'
                : response.status === 429
                  ? ' (rate limited even with IDEASEEK_S2_API_KEY)'
                  : ''
            }`,
          });
        } else {
          const body = await response.text();
          const parsed = await parseSemanticScholar(body);
          endpoints.push({
            endpoint: 'semantic-scholar',
            ok: true,
            contentHash: sha256Of(body),
            hits: parsed.length,
          });
          hits.push(...parsed);
        }
      } catch (error) {
        endpoints.push({
          endpoint: 'semantic-scholar',
          ok: false,
          contentHash: null,
          hits: 0,
          error: `network refused: ${(error as Error).message.slice(0, 160)}`,
        });
      }

      return { query, hits, endpoints };
    },
  };
}
