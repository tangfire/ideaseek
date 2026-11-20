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

async function failure(promise: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await promise;
    return {};
  } catch (error) {
    return error as { code?: string; message?: string };
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
    const result = await failure(
      acquireDataset({
        url: 'https://x.test/d/pacs.zip',
        destDir: dir,
        maxBytes: 1024,
        timeoutMs: 1000,
        fetchImpl: async () => response(200, [bytes('x')]),
      }),
    );
    expect(result.code).toBe('INVALID_STATE');
    expect(result.message).toMatch(/--resume/);
  });

  it('refuses a partial that already exceeds the ceiling before any request', async () => {
    const dir = await dest();
    await writeFile(join(dir, 'pacs.zip.part'), 'x'.repeat(64), 'utf8');
    let fetched = false;
    const result = await failure(
      acquireDataset({
        url: 'https://x.test/d/pacs.zip',
        destDir: dir,
        maxBytes: 16,
        timeoutMs: 1000,
        resume: true,
        fetchImpl: async () => {
          fetched = true;
          return response(206, []);
        },
      }),
    );
    expect(result.code).toBe('USER_INPUT_REQUIRED');
    expect(fetched).toBe(false);
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

describe('idle timeout: slow but steady transfers are allowed to finish', () => {
  it('lets a stream run past timeoutMs while chunks keep arriving', async () => {
    const dir = await dest();
    const payloads = Array.from({ length: 15 }, (_, i) => bytes(`c${i};`));
    const body = (async function* () {
      for (const chunk of payloads) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        yield chunk;
      }
    })();
    // ~1.5s of streaming against a 1s budget: only a total-duration timer
    // would kill this, every chunk gap stays far below the idle limit.
    const result = await acquireDataset({
      url: 'https://x.test/d/slow.zip',
      destDir: dir,
      maxBytes: 1024,
      timeoutMs: 1000,
      fetchImpl: async () => ({ status: 200, headers: { get: () => null }, body }),
    });
    expect(result.bytes).toBe(payloads.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    expect(await readFile(result.path, 'utf8')).toBe(
      payloads.map((chunk) => new TextDecoder().decode(chunk)).join(''),
    );
  });

  it('aborts when the stream goes silent past timeoutMs and keeps the .part', async () => {
    const dir = await dest();
    const body = (async function* () {
      yield bytes('partial');
      await new Promise(() => {});
    })();
    const result = await failure(
      acquireDataset({
        url: 'https://x.test/d/stall.zip',
        destDir: dir,
        maxBytes: 1024,
        timeoutMs: 200,
        fetchImpl: async () => ({ status: 200, headers: { get: () => null }, body }),
      }),
    );
    expect(result.code).toBe('NETWORK_BLOCKED');
    expect(result.message).toMatch(/stalled/);
    expect(await readFile(join(dir, 'stall.zip.part'), 'utf8')).toBe('partial');
  });
});

describe('truncation detection', () => {
  it('fails loudly when the promised content-length is not delivered', async () => {
    const dir = await dest();
    const result = await failure(
      acquireDataset({
        url: 'https://x.test/d/pacs.zip',
        destDir: dir,
        maxBytes: 1024,
        timeoutMs: 1000,
        fetchImpl: async () => response(200, [bytes('1234')], { 'content-length': '10' }),
      }),
    );
    expect(result.code).toBe('NETWORK_BLOCKED');
    expect(result.message).toMatch(/ended early/);
    expect(await readFile(join(dir, 'pacs.zip.part'), 'utf8')).toBe('1234');
  });
});

describe('resuming an interrupted download (resume)', () => {
  it('continues from the .part size with a ranged request and hashes the full file', async () => {
    const dir = await dest();
    await writeFile(join(dir, 'pacs.zip.part'), 'hello ', 'utf8');
    let sawRange: string | undefined;
    const result = await acquireDataset({
      url: 'https://x.test/d/pacs.zip',
      destDir: dir,
      maxBytes: 1024,
      timeoutMs: 1000,
      resume: true,
      fetchImpl: async (_url, init) => {
        sawRange = init.headers?.range;
        return response(206, [bytes('world')], {
          'content-range': 'bytes 6-10/11',
          'content-length': '5',
        });
      },
    });
    expect(sawRange).toBe('bytes=6-');
    expect(result.path).toBe(join(dir, 'pacs.zip'));
    expect(result.bytes).toBe(11);
    expect(result.sha256).toBe(sha256Of('hello world'));
    expect(await readFile(result.path, 'utf8')).toBe('hello world');
    expect(await stat(`${result.path}.part`).catch(() => null)).toBeNull();
  });

  it('refuses to append when the server ignores Range and returns the whole file', async () => {
    const dir = await dest();
    await writeFile(join(dir, 'pacs.zip.part'), 'hello ', 'utf8');
    const result = await failure(
      acquireDataset({
        url: 'https://x.test/d/pacs.zip',
        destDir: dir,
        maxBytes: 1024,
        timeoutMs: 1000,
        resume: true,
        fetchImpl: async () => response(200, [bytes('hello world')]),
      }),
    );
    expect(result.code).toBe('INVALID_STATE');
    expect(result.message).toMatch(/ignored the ranged request/);
    expect(await readFile(join(dir, 'pacs.zip.part'), 'utf8')).toBe('hello ');
  });

  it('refuses a content-range that does not start at the partial size', async () => {
    const dir = await dest();
    await writeFile(join(dir, 'pacs.zip.part'), 'hello ', 'utf8');
    const result = await failure(
      acquireDataset({
        url: 'https://x.test/d/pacs.zip',
        destDir: dir,
        maxBytes: 1024,
        timeoutMs: 1000,
        resume: true,
        fetchImpl: async () =>
          response(206, [bytes('world')], { 'content-range': 'bytes 3-10/11' }),
      }),
    );
    expect(result.code).toBe('INVALID_STATE');
    expect(result.message).toMatch(/range that was not asked for/);
  });

  it('keeps the partial when the server ends early, and the next resume finishes it', async () => {
    const dir = await dest();
    await writeFile(join(dir, 'pacs.zip.part'), 'hello ', 'utf8');
    const early = await failure(
      acquireDataset({
        url: 'https://x.test/d/pacs.zip',
        destDir: dir,
        maxBytes: 1024,
        timeoutMs: 1000,
        resume: true,
        fetchImpl: async () => response(206, [bytes('wo')], { 'content-range': 'bytes 6-10/11' }),
      }),
    );
    expect(early.code).toBe('NETWORK_BLOCKED');
    expect(early.message).toMatch(/ended early/);
    expect(await readFile(join(dir, 'pacs.zip.part'), 'utf8')).toBe('hello wo');
    // The follow-up resumes from 8 bytes instead of re-fetching from zero.
    let from: string | undefined;
    const done = await acquireDataset({
      url: 'https://x.test/d/pacs.zip',
      destDir: dir,
      maxBytes: 1024,
      timeoutMs: 1000,
      resume: true,
      fetchImpl: async (_url, init) => {
        from = init.headers?.range;
        return response(206, [bytes('rld')], { 'content-range': 'bytes 8-10/11' });
      },
    });
    expect(from).toBe('bytes=8-');
    expect(done.sha256).toBe(sha256Of('hello world'));
    expect(await readFile(done.path, 'utf8')).toBe('hello world');
  });
});
