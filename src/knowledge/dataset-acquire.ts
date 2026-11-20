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
 *
 * Transport budget: `timeoutMs` bounds the wait for response headers and the
 * gap between body chunks — never the total transfer, so a slow-but-steady
 * stream of a large file can finish (a total-duration kill made `--max-gib 50`
 * unreachable on any link slower than 85 MB/s). Interrupted downloads keep
 * their `.part`; the default stays fail-loud, `resume` opts into continuing
 * one with a ranged request.
 */

/** Minimal fetch shape, injectable so tests never touch the network. */
export type AcquireFetch = (
  url: string,
  init: { redirect: 'manual'; signal: AbortSignal; headers?: Record<string, string> },
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
  /** Response-header deadline and maximum gap between body chunks (ms). */
  timeoutMs: number;
  fetchImpl?: AcquireFetch;
  maxRedirects?: number;
  /** Continue a leftover `.part` from its current size with a ranged request. */
  resume?: boolean;
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
 * control-character names so the staged file cannot escape destDir or become
 * a hidden/dot file.
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
  init: { redirect: 'manual'; signal: AbortSignal; headers?: Record<string, string> },
): Promise<AcquireResponse> {
  return (await fetch(url, init)) as unknown as AcquireResponse;
}

/** `bytes 6-10/11` → { start: 6, total: 11 }; a `*` total becomes null. */
function parseContentRange(value: string | null): { start: number; total: number | null } | null {
  if (!value) return null;
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(value.trim());
  if (!match) return null;
  return { start: Number(match[1]), total: match[3] === '*' ? null : Number(match[3]) };
}

/**
 * Races one request against the response-header deadline. A hung connect (or a
 * server that never answers) aborts the shared controller and fails loudly;
 * clearing the timer on success keeps it from firing into the body phase.
 */
async function withHeaderDeadline(
  request: Promise<AcquireResponse>,
  timeoutMs: number,
  abort: AbortController,
  current: string,
): Promise<AcquireResponse> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(
        new IdeaseekError(
          'NETWORK_BLOCKED',
          `no response headers within ${timeoutMs}ms from ${safeUrl(current)} — ` +
            'raise --timeout-ms if the source legitimately answers slower',
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([request, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One body read bounded by the idle gap: while bytes keep arriving the
 * transfer may run as long as it needs (maxBytes still bounds it); a gap past
 * timeoutMs aborts the connection and fails loudly, keeping the .part.
 */
async function nextChunkOrStall<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
  abort: AbortController,
  sourceUrl: string,
): Promise<IteratorResult<T>> {
  let timer: NodeJS.Timeout | undefined;
  const stall = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(
        new IdeaseekError(
          'NETWORK_BLOCKED',
          `dataset download stalled — no bytes for ${timeoutMs}ms from ${sourceUrl}; ` +
            'raise --timeout-ms if the source legitimately pauses longer',
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([iterator.next(), stall]);
  } finally {
    clearTimeout(timer);
  }
}

interface StageInput {
  body: AsyncIterable<Uint8Array> | null;
  partPath: string;
  finalPath: string;
  maxBytes: number;
  sourceUrl: string;
  timeoutMs: number;
  abort: AbortController;
  /** Bytes already on disk in the .part (0 = fresh download). */
  offset: number;
  /** Full-file size the server promised, when it can be trusted. */
  expectedTotal: number | null;
}

/**
 * Streams the response body onto the .part (hashing the existing prefix first
 * when resuming), then atomically renames it into place. A stalled, truncated
 * or over-budget run keeps or removes the .part exactly so the next run can
 * resume or start clean — nothing is ever half-promoted.
 */
async function stage(input: StageInput): Promise<{ sha256: ContentHash; bytes: number }> {
  const {
    body,
    partPath,
    finalPath,
    maxBytes,
    sourceUrl,
    timeoutMs,
    abort,
    offset,
    expectedTotal,
  } = input;
  if (!body) {
    throw new IdeaseekError('EMPTY_FILE', `dataset response had no body: ${sourceUrl}`);
  }
  const hash = createHash('sha256');
  let bytes = offset;
  let received = 0;
  let overBudget = false;
  // 'wx' so a racing .part can never be written through; a resume reopens its
  // own leftover at its recorded size instead.
  const handle = offset > 0 ? await open(partPath, 'r+') : await open(partPath, 'wx');
  try {
    if (offset > 0) {
      // Hash the existing prefix so the final digest covers the whole file.
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      if (position !== offset) {
        throw new IdeaseekError(
          'INVALID_STATE',
          `leftover partial ${partPath} changed size while resuming (${offset} → ${position}) — ` +
            'inspect it, then delete it or retry --resume',
        );
      }
    }
    const iterator = body[Symbol.asyncIterator]();
    let writePosition = offset;
    for (;;) {
      const next = await nextChunkOrStall(iterator, timeoutMs, abort, sourceUrl);
      if (next.done) break;
      const chunk = next.value;
      bytes += chunk.byteLength;
      received += chunk.byteLength;
      if (bytes > maxBytes) {
        overBudget = true;
        throw new IdeaseekError(
          'USER_INPUT_REQUIRED',
          `download exceeded the ${(maxBytes / 1024 / 1024).toFixed(0)} MiB ceiling from ${sourceUrl} — ` +
            'raise --max-gib only after checking the dataset size and license',
        );
      }
      hash.update(chunk);
      // Explicit positions: positioned reads above do not move the cursor, so
      // an implicit write would land at 0 and clobber the resumed prefix.
      await handle.write(chunk, 0, chunk.byteLength, writePosition);
      writePosition += chunk.byteLength;
    }
  } finally {
    await handle.close();
    // Never leave a half-written .part behind to be mistaken for data.
    if (overBudget) await rm(partPath, { force: true }).catch(() => undefined);
  }
  if (received === 0) {
    // A fresh empty run removes its own file; a resume that learned nothing
    // keeps the prefix it did not write.
    if (offset === 0) await rm(partPath, { force: true }).catch(() => undefined);
    throw new IdeaseekError(
      'EMPTY_FILE',
      offset > 0
        ? `dataset download added 0 bytes to the partial: ${sourceUrl}`
        : `dataset download produced 0 bytes: ${sourceUrl}`,
    );
  }
  if (expectedTotal !== null && bytes !== expectedTotal) {
    // fetch ends a truncated body without erroring, so the only proof of a
    // complete file is the length the server promised. Keep the .part.
    throw new IdeaseekError(
      'NETWORK_BLOCKED',
      `download ended early: got ${formatBytes(bytes)} of ${formatBytes(expectedTotal)} from ` +
        `${sourceUrl} — re-run with --resume to continue the partial`,
    );
  }
  await rename(partPath, finalPath);
  return { sha256: `sha256:${hash.digest('hex')}` as ContentHash, bytes };
}

/**
 * Downloads one public dataset file into destDir. Fails loudly on an existing
 * target or (without `resume`) a leftover .part so a crashed run is never
 * silently re-fetched over.
 */
export async function acquireDataset(input: AcquireInput): Promise<AcquiredFile> {
  const fetchImpl = input.fetchImpl ?? defaultFetch;
  const maxRedirects = input.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  if (input.maxBytes <= 0) {
    throw new IdeaseekError('INVALID_ARGUMENT', 'maxBytes must be positive');
  }
  const resume = input.resume === true;

  // Resolve every local-path refusal before any network I/O: the staged name
  // comes from what was requested (HuggingFace resolve URLs 302 to a signed
  // CDN link whose path is a content hash), and a leftover partial must be
  // decided about before bytes can land.
  let current = requirePublicHttps(input.url).toString();
  const filename = safeFilename(input.url);
  const destDir = resolve(input.destDir);
  const finalPath = join(destDir, filename);
  await mkdir(destDir, { recursive: true });
  const existing = await stat(finalPath).catch(() => null);
  if (existing) {
    throw new IdeaseekError(
      'ALREADY_COMMITTED',
      `${finalPath} already exists — acquire never overwrites staged data; ` +
        'remove it or run ideaseek scan + ideaseek datasets link if it is already yours',
    );
  }
  const partPath = `${finalPath}.part`;
  const partStat = await stat(partPath).catch(() => null);
  if (partStat && !resume) {
    throw new IdeaseekError(
      'INVALID_STATE',
      `leftover partial download ${partPath} exists (${formatBytes(partStat.size)}) — pass ` +
        '--resume to continue it, or inspect and delete it to start over ' +
        '(a stale .part means an earlier run was interrupted)',
    );
  }
  const offset = resume && partStat ? partStat.size : 0;
  if (offset > input.maxBytes) {
    throw new IdeaseekError(
      'USER_INPUT_REQUIRED',
      `leftover partial is ${formatBytes(offset)}, over the ` +
        `${formatBytes(input.maxBytes)} ceiling from ${safeUrl(input.url)} — ` +
        'inspect it, then delete it or raise --max-gib',
    );
  }

  const abort = new AbortController();
  const rangeHeaders = offset > 0 ? { range: `bytes=${offset}-` } : undefined;
  let response: AcquireResponse | null = null;
  for (let hop = 0; ; hop += 1) {
    response = await withHeaderDeadline(
      fetchImpl(current, { redirect: 'manual', signal: abort.signal, headers: rangeHeaders }),
      input.timeoutMs,
      abort,
      current,
    );
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

  // An encoded body's declared length describes the wire bytes, not what the
  // stream hands us, so completeness is only provable on identity responses.
  const encoding = (response.headers.get('content-encoding') ?? 'identity').toLowerCase();
  const lengthReliable = encoding === '' || encoding === 'identity';
  const declared = Number(response.headers.get('content-length') ?? 'NaN');
  let expectedTotal: number | null = null;

  if (resume) {
    // A 200 here means the server ignored Range: appending its full body to
    // the prefix would silently corrupt the file, so refuse and say why.
    if (response.status === 200) {
      throw new IdeaseekError(
        'INVALID_STATE',
        `server ignored the ranged request for ${safeUrl(input.url)} (HTTP 200 with the whole ` +
          'file) — refusing to append it over the partial; delete the .part to start over',
      );
    }
    if (response.status !== 206) {
      throw new IdeaseekError(
        'NETWORK_BLOCKED',
        `ranged request for ${safeUrl(input.url)} returned HTTP ${response.status}, not 206`,
      );
    }
    const contentRange = parseContentRange(response.headers.get('content-range'));
    if (!contentRange || contentRange.start !== offset) {
      throw new IdeaseekError(
        'INVALID_STATE',
        `server answered a range that was not asked for: content-range ` +
          `"${response.headers.get('content-range') ?? 'missing'}", wanted bytes ${offset}- ` +
          `from ${safeUrl(input.url)} — delete the .part to start over`,
      );
    }
    if (contentRange.total !== null && contentRange.total > input.maxBytes) {
      throw new IdeaseekError(
        'USER_INPUT_REQUIRED',
        `server reports ${(contentRange.total / 1024 / 1024).toFixed(0)} MiB in total, over the ` +
          `${(input.maxBytes / 1024 / 1024).toFixed(0)} MiB ceiling — check the dataset size, then raise --max-gib`,
      );
    }
    if (lengthReliable) {
      expectedTotal = contentRange.total ?? (Number.isFinite(declared) ? offset + declared : null);
    }
  } else if (lengthReliable && Number.isFinite(declared)) {
    if (declared > input.maxBytes) {
      throw new IdeaseekError(
        'USER_INPUT_REQUIRED',
        `server reports ${(declared / 1024 / 1024).toFixed(0)} MiB, over the ` +
          `${(input.maxBytes / 1024 / 1024).toFixed(0)} MiB ceiling — check the dataset size, then raise --max-gib`,
      );
    }
    expectedTotal = declared;
  }

  const staged = await stage({
    body: response.body,
    partPath,
    finalPath,
    maxBytes: input.maxBytes,
    sourceUrl: safeUrl(current),
    timeoutMs: input.timeoutMs,
    abort,
    offset,
    expectedTotal,
  });
  return { path: finalPath, ...staged, sourceUrl: safeUrl(input.url) };
}
