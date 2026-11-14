import { createHash } from 'node:crypto';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import type { ContentHash } from '../core/hash.js';

/**
 * Dataset acquisition (docs/MODES.md §Full Research: 发现/下载公开数据).
 *
 * Discovery recommends, `datasets authorize` grants, and this module is the
 * only place bytes leave the network for a dataset. It stages a single file
 * under the project's datasets directory — it never extracts, never overwrites
 * and never promotes a candidate (that stays `datasets link`'s job, so there is
 * exactly one promotion path).
 */

/** Minimal fetch shape, injectable so tests never touch the network. */
export type AcquireFetch = (
  url: string,
  init: { redirect: 'manual'; signal: AbortSignal },
) => Promise<AcquireResponse>;

export interface AcquireResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: AsyncIterable<Uint8Array> | null;
}

export interface AcquireInput {
  /** Public download URL from an authorized candidate. */
  url: string;
  /** Absolute directory to stage into; the final path stays inside it. */
  destDir: string;
  /** Hard byte ceiling; the stream aborts past it. */
  maxBytes: number;
  timeoutMs: number;
  fetchImpl?: AcquireFetch;
  maxRedirects?: number;
}

export interface AcquiredFile {
  /** Absolute staged path. */
  path: string;
  sha256: ContentHash;
  bytes: number;
  /** Origin + pathname only — query strings can carry access tokens. */
  sourceUrl: string;
}

const DEFAULT_MAX_REDIRECTS = 3;

/** Human byte count — a 2 KiB probe must not read as "0.0 MiB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

/** Origin + pathname, with any query/fragment (and thus tokens) dropped. */
export function safeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '(unparseable url)';
  }
  return `${parsed.origin}${parsed.pathname}`;
}

/** Validates the URL and returns it; https-only, no embedded credentials. */
function requirePublicHttps(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new IdeaseekError('INVALID_ARGUMENT', `dataset url is not a valid URL: ${safeUrl(url)}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new IdeaseekError(
      'NETWORK_BLOCKED',
      `dataset download requires https (got "${parsed.protocol}//" from ${safeUrl(url)}); ` +
        'plain http can be tampered with in transit and is refused',
    );
  }
  if (parsed.username || parsed.password) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `dataset url must not embed credentials (${safeUrl(url)})`,
    );
  }
  if (!parsed.hostname) {
    throw new IdeaseekError('INVALID_ARGUMENT', `dataset url has no host: ${safeUrl(url)}`);
  }
  return parsed;
}

/**
 * Last path segment as a plain filename. Rejects traversal, dot-prefixed and
 * control-character names so the staged file cannot escape destDir or become a
 * hidden/dot file.
 */
export function safeFilename(url: string): string {
  const pathname = requirePublicHttps(url).pathname;
  const last = decodeURIComponent(pathname.split('/').filter(Boolean).pop() ?? '');
  if (!last) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `dataset url has no file component: ${safeUrl(url)} — pass --name <file>`,
    );
  }
  // The filename comes from an untrusted URL: control characters must never
  // reach the filesystem, which is exactly what this rule normally warns about.
  // eslint-disable-next-line no-control-regex
  if (last.includes('/') || last.includes('\\') || /[\u0000-\u001f\u007f]/.test(last)) {
    throw new IdeaseekError('INVALID_ARGUMENT', `unsafe dataset filename: ${JSON.stringify(last)}`);
  }
  if (last === '.' || last === '..' || last.startsWith('.')) {
    throw new IdeaseekError('INVALID_ARGUMENT', `refusing dot-prefixed dataset filename: ${last}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(last)) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `dataset filename must be [A-Za-z0-9._-] (got ${JSON.stringify(last)}) — pass --name <file>`,
    );
  }
  return last;
}

async function defaultFetch(
  url: string,
  init: { redirect: 'manual'; signal: AbortSignal },
): Promise<AcquireResponse> {
  return (await fetch(url, init)) as unknown as AcquireResponse;
}

/** Streams one response body to disk incrementally, hashing as it goes. */
async function stage(
  body: AsyncIterable<Uint8Array> | null,
  partPath: string,
  finalPath: string,
  maxBytes: number,
  sourceUrl: string,
): Promise<{ sha256: ContentHash; bytes: number }> {
  if (!body) {
    throw new IdeaseekError('EMPTY_FILE', `dataset response had no body: ${sourceUrl}`);
  }
  const hash = createHash('sha256');
  let bytes = 0;
  // 'wx' so a racing .part can never be written through.
  const handle = await open(partPath, 'wx');
  let overBudget = false;
  try {
    for await (const chunk of body) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        overBudget = true;
        throw new IdeaseekError(
          'USER_INPUT_REQUIRED',
          `download exceeded the ${(maxBytes / 1024 / 1024).toFixed(0)} MiB ceiling from ${sourceUrl} — ` +
            'raise --max-gib only after checking the dataset size and license',
        );
      }
      hash.update(chunk);
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
    // Never leave a half-written .part behind to be mistaken for data.
    if (overBudget) await rm(partPath, { force: true }).catch(() => undefined);
  }
  if (bytes === 0) {
    await rm(partPath, { force: true }).catch(() => undefined);
    throw new IdeaseekError('EMPTY_FILE', `dataset download produced 0 bytes: ${sourceUrl}`);
  }
  await rename(partPath, finalPath);
  return { sha256: `sha256:${hash.digest('hex')}` as ContentHash, bytes };
}

/**
 * Downloads one public dataset file into destDir. Fails loudly on an existing
 * target or a leftover .part so a crashed run is never silently re-fetched over.
 */
export async function acquireDataset(input: AcquireInput): Promise<AcquiredFile> {
  const fetchImpl = input.fetchImpl ?? defaultFetch;
  const maxRedirects = input.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  if (input.maxBytes <= 0) {
    throw new IdeaseekError('INVALID_ARGUMENT', 'maxBytes must be positive');
  }

  let current = requirePublicHttps(input.url).toString();
  let response: AcquireResponse | null = null;
  for (let hop = 0; ; hop += 1) {
    response = await fetchImpl(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(input.timeoutMs),
    });
    if (response.status >= 200 && response.status < 300) break;
    if (response.status >= 300 && response.status < 400) {
      if (hop >= maxRedirects) {
        throw new IdeaseekError(
          'NETWORK_BLOCKED',
          `dataset download hit a redirect loop after ${maxRedirects} hops from ${safeUrl(input.url)}`,
        );
      }
      const location = response.headers.get('location');
      if (!location) {
        throw new IdeaseekError(
          'NETWORK_BLOCKED',
          `redirect ${response.status} without a location from ${safeUrl(current)}`,
        );
      }
      // Re-validate every hop: a redirect must not downgrade to http or
      // smuggle credentials.
      current = requirePublicHttps(new URL(location, current).toString()).toString();
      continue;
    }
    throw new IdeaseekError(
      'NETWORK_BLOCKED',
      `dataset download failed with HTTP ${response.status} from ${safeUrl(current)}`,
    );
  }

  const filename = safeFilename(current);
  const destDir = resolve(input.destDir);
  const finalPath = join(destDir, filename);
  await mkdir(destDir, { recursive: true });

  const declared = Number(response.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > input.maxBytes) {
    throw new IdeaseekError(
      'USER_INPUT_REQUIRED',
      `server reports ${(declared / 1024 / 1024).toFixed(0)} MiB, over the ` +
        `${(input.maxBytes / 1024 / 1024).toFixed(0)} MiB ceiling — check the dataset size, then raise --max-gib`,
    );
  }

  const existing = await stat(finalPath).catch(() => null);
  if (existing) {
    throw new IdeaseekError(
      'ALREADY_COMMITTED',
      `${finalPath} already exists — acquire never overwrites staged data; ` +
        'remove it or run ideaseek scan + ideaseek datasets link if it is already yours',
    );
  }
  const partPath = `${finalPath}.part`;
  if (await stat(partPath).catch(() => null)) {
    throw new IdeaseekError(
      'INVALID_STATE',
      `leftover partial download ${partPath} exists — inspect and delete it, then retry ` +
        '(a stale .part means an earlier run was interrupted)',
    );
  }

  const staged = await stage(response.body, partPath, finalPath, input.maxBytes, safeUrl(current));
  return { path: finalPath, ...staged, sourceUrl: safeUrl(input.url) };
}
