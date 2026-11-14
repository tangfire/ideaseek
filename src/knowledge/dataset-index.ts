/**
 * HuggingFace dataset index lookup (docs/MODEL_ROUTING.md-adjacent policy:
 * network egress is gated by research.external_search + runtime.allow_network
 * at the caller). Papers name datasets but never give a download endpoint, so
 * this is the source that turns a candidate into something `datasets acquire`
 * can actually fetch.
 */

export type DatasetIndexFetch = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface DatasetIndexHit {
  /** `author/name`, e.g. `flwrlabs/pacs`. */
  id: string;
  /** Landing page on the serving endpoint. */
  url: string;
  /** Concrete file a download would fetch, or null when the repo lists none. */
  fileUrl: string | null;
  fileName: string | null;
  /** Total listed repo size in bytes (null when the API gave none). */
  bytes: number | null;
  tags: string[];
  licenseTag: string | null;
  downloads: number | null;
  /** Which host answered — provenance, because a mirror is not the origin. */
  endpoint: string;
}

export interface DatasetIndexSearchResult {
  hits: DatasetIndexHit[];
  endpoint: string | null;
  error: string | null;
}

export interface DatasetIndexClient {
  search(query: string, opts?: { limit?: number }): Promise<DatasetIndexSearchResult>;
}

export interface DatasetIndexOptions {
  fetchImpl?: DatasetIndexFetch;
  timeoutMs?: number;
  /** Primary host; the mirror is tried when it is unreachable. */
  endpoint?: string;
  mirror?: string;
}

const PRIMARY = 'https://huggingface.co';
const MIRROR = 'https://hf-mirror.com';
/** Extensions worth fetching whole; anything else is treated as loose files. */
const ARCHIVE_PATTERN = /\.(zip|tar|tgz|gz|parquet|csv|npy|npz|arrow)$/i;
/** Documentation and repo plumbing — never the corpus a researcher wants. */
const METADATA_PATTERN =
  /^(readme|license|licence|notice|citation|contributing|changelog|dataset_infos|\.git|\.github)/i;

function defaultFetch(timeoutMs: number): DatasetIndexFetch {
  return async (url, init) => {
    const response = await globalThis.fetch(url, {
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
    return { ok: response.ok, status: response.status, text: () => response.text() };
  };
}

function envEndpoint(): string {
  const value = process.env.IDEASEEK_HF_ENDPOINT;
  return value && value.trim() ? value.trim().replace(/\/+$/, '') : PRIMARY;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Pick the file a download should fetch: a real data file, largest first.
 * Repo metadata is never the corpus — on the first live run PACS resolved to
 * `README.md`, which would have "succeeded" while downloading documentation.
 */
export function pickFile(entries: unknown[]): { path: string | null; bytes: number | null } {
  const files = entries
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    // Directories carry a path too, so type must be excluded explicitly —
    // otherwise `data/` can be chosen as the file to download.
    .filter((entry) => entry.type !== 'directory')
    .filter((entry) => typeof entry.path === 'string' && entry.path.length > 0);
  if (files.length === 0) return { path: null, bytes: null };
  const total = files.reduce((sum, entry) => sum + (num(entry.size) ?? 0), 0);
  const scored = files
    .map((entry) => ({ path: String(entry.path), size: num(entry.size) ?? 0 }))
    .filter((file) => !METADATA_PATTERN.test(file.path))
    .map((file) => ({ ...file, weight: ARCHIVE_PATTERN.test(file.path) ? 2 : 1 }))
    .sort((a, b) => b.weight - a.weight || b.size - a.size);
  return { path: scored[0]?.path ?? null, bytes: total > 0 ? total : null };
}

async function fetchJson(
  fetchImpl: DatasetIndexFetch,
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; body: unknown } | { ok: false; error: string }> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false, status: response.status, body: null };
    return { ok: true, status: response.status, body: JSON.parse(await response.text()) };
  } catch (error) {
    return { ok: false, error: (error as Error).message.slice(0, 160) };
  }
}

export function createDatasetIndexClient(opts: DatasetIndexOptions = {}): DatasetIndexClient {
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const fetchImpl = opts.fetchImpl ?? defaultFetch(timeoutMs);
  const primary = opts.endpoint ?? envEndpoint();
  const mirror = opts.mirror ?? MIRROR;

  async function searchOn(
    base: string,
    query: string,
    limit: number,
  ): Promise<DatasetIndexHit[] | { error: string }> {
    const listed = await fetchJson(
      fetchImpl,
      `${base}/api/datasets?search=${encodeURIComponent(query)}&limit=${limit}`,
      timeoutMs,
    );
    if (!('error' in listed)) {
      if (!listed.ok) return { error: `http ${listed.status}` };
    } else {
      return { error: `network refused: ${listed.error}` };
    }
    const rows = Array.isArray(listed.body) ? (listed.body as Record<string, unknown>[]) : [];
    const hits: DatasetIndexHit[] = [];
    for (const row of rows) {
      const id = str(row.id);
      if (!id) continue;
      const tags = Array.isArray(row.tags) ? row.tags.map(String).slice(0, 12) : [];
      const hit: DatasetIndexHit = {
        id,
        url: `${base}/datasets/${id}`,
        fileUrl: null,
        fileName: null,
        bytes: num(row.usedStorage) ?? null,
        tags,
        licenseTag: tags.map((tag) => /^license:(.+)$/i.exec(tag)?.[1]).find(Boolean) ?? null,
        downloads: num(row.downloads) ?? null,
        endpoint: base,
      };
      // One tree call per candidate: without a concrete file there is nothing
      // for acquire to fetch, so the URL would be a landing page only.
      // recursive=true is not optional — hub corpora usually keep their
      // parquet shards under data/, and a flat listing shows only README and
      // .gitattributes, which reads as "no fetchable file".
      const tree = await fetchJson(
        fetchImpl,
        `${base}/api/datasets/${id}/tree/main?recursive=true`,
        timeoutMs,
      );
      if (!('error' in tree) && tree.ok && Array.isArray(tree.body)) {
        const picked = pickFile(tree.body as unknown[]);
        if (picked.path) {
          hit.fileUrl = `${base}/datasets/${id}/resolve/main/${picked.path}`;
          hit.fileName = picked.path;
        }
        if (picked.bytes !== null) hit.bytes = picked.bytes;
      }
      hits.push(hit);
      if (hits.length >= limit) break;
    }
    return hits;
  }

  return {
    async search(query, searchOpts = {}) {
      const limit = Math.max(1, Math.min(searchOpts.limit ?? 6, 12));
      const first = await searchOn(primary, query, limit);
      if (Array.isArray(first)) {
        return { hits: first, endpoint: primary, error: null };
      }
      if (primary === mirror) {
        return { hits: [], endpoint: null, error: `${primary}: ${first.error}` };
      }
      const second = await searchOn(mirror, query, limit);
      if (Array.isArray(second)) {
        return { hits: second, endpoint: mirror, error: null };
      }
      return {
        hits: [],
        endpoint: null,
        error: `${primary}: ${first.error}; ${mirror}: ${second.error}`,
      };
    },
  };
}
