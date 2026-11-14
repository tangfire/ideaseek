import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acquireDataset,
  safeFilename,
  safeUrl,
  type AcquireResponse,
} from '../src/knowledge/dataset-acquire.js';
import { sha256Of } from '../src/core/hash.js';

/**
 * Dataset acquisition guards (docs/MODES.md §Full Research). The transport is
 * injected: no test here touches the network.
 */

function response(
  status: number,
  chunks: Uint8Array[],
  headers: Record<string, string> = {},
): AcquireResponse {
  return {
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    body: (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
  };
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function dest(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ideaseek-acquire-'));
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'NO_ERROR';
  } catch (error) {
    return (error as { code?: string }).code ?? 'NO_ERROR';
  }
}

describe('url and filename validation', () => {
  it('refuses non-https so a dataset cannot be tampered with in transit', async () => {
    expect(
      await code(
        acquireDataset({
          url: 'http://x.test/a.zip',
          destDir: await dest(),
          maxBytes: 1024,
          timeoutMs: 1000,
        }),
      ),
    ).toBe('NETWORK_BLOCKED');
    expect(
      await code(
        acquireDataset({
          url: 'ftp://x.test/a.zip',
          destDir: await dest(),
          maxBytes: 1024,
          timeoutMs: 1000,
        }),
      ),
    ).toBe('NETWORK_BLOCKED');
  });

  it('refuses credentials embedded in the url', async () => {
    const dir = await dest();
    expect(
      await code(
        acquireDataset({
          url: 'https://user:secret@x.test/a.zip',
          destDir: dir,
          maxBytes: 1024,
          timeoutMs: 1000,
        }),
      ),
    ).toBe('INVALID_ARGUMENT');
  });

  it('keeps query strings out of anything that is recorded or printed', () => {
    expect(safeUrl('https://x.test/d/PACS.zip?sv=2024&se=abc&sig=TOKEN')).toBe(
      'https://x.test/d/PACS.zip',
    );
  });

  it('accepts only plain, non-hidden, separator-free filenames', () => {
    expect(safeFilename('https://x.test/d/PACS.zip')).toBe('PACS.zip');
    expect(() => safeFilename('https://x.test/d/%2E%2E%2Fevil.zip')).toThrow(/unsafe/);
    expect(() => safeFilename('https://x.test/d/.hidden')).toThrow(/dot-prefixed/);
    expect(() => safeFilename('https://x.test/')).toThrow(/no file component/);
    expect(() => safeFilename('https://x.test/d/weird name.zip')).toThrow(/must be/);
  });
});

describe('staging a file', () => {
  it('writes the file, reports sha256 and bytes, and leaves no .part', async () => {
    const dir = await dest();
    const payload = bytes('fedavg-payload');
    const result = await acquireDataset({
      url: 'https://x.test/d/pacs.zip?sig=TOKEN',
      destDir: dir,
      maxBytes: 1024,
      timeoutMs: 5000,
      fetchImpl: async () => response(200, [payload]),
    });
    expect(result.path).toBe(join(dir, 'pacs.zip'));
    expect(result.bytes).toBe(payload.byteLength);
    expect(result.sha256).toBe(sha256Of('fedavg-payload'));
    expect(result.sourceUrl).toBe('https://x.test/d/pacs.zip');
    expect(await readFile(result.path, 'utf8')).toBe('fedavg-payload');
    expect(await stat(`${result.path}.part`).catch(() => null)).toBeNull();
  });

  it('refuses to overwrite already staged data', async () => {
    const dir = await dest();
    await writeFile(join(dir, 'pacs.zip'), 'mine', 'utf8');
    expect(
      await code(
        acquireDataset({
          url: 'https://x.test/d/pacs.zip',
          destDir: dir,
          maxBytes: 1024,
          timeoutMs: 1000,
          fetchImpl: async () => response(200, [bytes('x')]),
        }),
      ),
    ).toBe('ALREADY_COMMITTED');
    expect(await readFile(join(dir, 'pacs.zip'), 'utf8')).toBe('mine');
  });

  it('refuses a leftover .part instead of silently re-fetching over it', async () => {
    const dir = await dest();
    await writeFile(join(dir, 'pacs.zip.part'), 'half', 'utf8');
    expect(
      await code(
        acquireDataset({
          url: 'https://x.test/d/pacs.zip',
          destDir: dir,
          maxBytes: 1024,
          timeoutMs: 1000,
          fetchImpl: async () => response(200, [bytes('x')]),
        }),
      ),
    ).toBe('INVALID_STATE');
  });

  it('honors a declared content-length before reading any body', async () => {
    const dir = await dest();
    const result = acquireDataset({
      url: 'https://x.test/d/big.tar',
      destDir: dir,
      maxBytes: 1024,
      timeoutMs: 1000,
      fetchImpl: async () => response(200, [], { 'content-length': String(10 * 1024 * 1024) }),
    });
    expect(await code(result)).toBe('USER_INPUT_REQUIRED');
    expect(await stat(join(dir, 'big.tar')).catch(() => null)).toBeNull();
  });

  it('aborts mid-stream past the ceiling and removes the partial file', async () => {
    const dir = await dest();
    const chunks = [bytes('aaaa'), bytes('bbbb'), bytes('cccc'), bytes('dddd')];
    expect(
      await code(
        acquireDataset({
          url: 'https://x.test/d/pacs.zip',
          destDir: dir,
          maxBytes: 8,
          timeoutMs: 1000,
          fetchImpl: async () => response(200, chunks),
        }),
      ),
    ).toBe('USER_INPUT_REQUIRED');
    expect(await stat(join(dir, 'pacs.zip')).catch(() => null)).toBeNull();
    expect(await stat(join(dir, 'pacs.zip.part')).catch(() => null)).toBeNull();
  });

  it('rejects an empty body and an http error status', async () => {
    const dir = await dest();
    expect(
      await code(
        acquireDataset({
          url: 'https://x.test/d/pacs.zip',
          destDir: dir,
          maxBytes: 1024,
          timeoutMs: 1000,
          fetchImpl: async () => response(200, []),
        }),
      ),
    ).toBe('EMPTY_FILE');
    expect(
      await code(
        acquireDataset({
          url: 'https://x.test/d/gone.zip',
          destDir: await dest(),
          maxBytes: 1024,
          timeoutMs: 1000,
          fetchImpl: async () => response(404, []),
        }),
      ),
    ).toBe('NETWORK_BLOCKED');
  });
});

describe('redirect handling', () => {
  it('follows an https hop but names the file from what was requested', async () => {
    const dir = await dest();
    const seen: string[] = [];
    const result = await acquireDataset({
      url: 'https://x.test/d/PACS.zip?sig=TOKEN',
      destDir: dir,
      maxBytes: 1024,
      timeoutMs: 1000,
      fetchImpl: async (url) => {
        seen.push(url);
        // A CDN redirect carries a content-hash path and a signed query, the
        // way HuggingFace resolve links do.
        if (url.includes('PACS.zip'))
          return response(302, [], {
            location: 'https://cdn.test/xet/0a333c43a051d4?Policy=abc&Signature=xyz',
          });
        return response(200, [bytes('x')]);
      },
    });
    expect(seen).toHaveLength(2);
    expect(result.path).toBe(join(dir, 'PACS.zip'));
    expect(result.sourceUrl).toBe('https://x.test/d/PACS.zip');
  });

  it('refuses a redirect that downgrades to http', async () => {
    expect(
      await code(
        acquireDataset({
          url: 'https://x.test/start.zip',
          destDir: await dest(),
          maxBytes: 1024,
          timeoutMs: 1000,
          fetchImpl: async () => response(301, [], { location: 'http://evil.test/pacs.zip' }),
        }),
      ),
    ).toBe('NETWORK_BLOCKED');
  });

  it('stops a redirect loop at the hop budget', async () => {
    let hops = 0;
    expect(
      await code(
        acquireDataset({
          url: 'https://x.test/loop.zip',
          destDir: await dest(),
          maxBytes: 1024,
          timeoutMs: 1000,
          maxRedirects: 2,
          fetchImpl: async () => {
            hops += 1;
            return response(302, [], { location: `https://x.test/loop${hops}.zip` });
          },
        }),
      ),
    ).toBe('NETWORK_BLOCKED');
    expect(hops).toBe(3);
  });
});
