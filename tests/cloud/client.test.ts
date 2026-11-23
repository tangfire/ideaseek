/**
 * 传输层单测（F1.7 / F1.8 / F1.10 / F1.11）。
 *
 * 全程假 `fetch`：这里要钉住的是**结局分类**——哪一类算成功、哪一类算未知、
 * 哪一类必须停手——以及请求头的形状。真站点的投递在 M1 的 spike 脚本里量过，
 * 那一层的回归由云端契约测试守着。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMEOUT_MS,
  SYNC_TOKEN_HEADER,
  USER_AGENT,
  ingestUrl,
  sendBatch,
  type FetchLike,
} from '../../src/cloud/client.js';
import { isIdeaseekError } from '../../src/core/errors.js';

const TOKEN = 'tok-0123456789abcdef0123456789abcdef';
const SITE = 'https://demo.qoder.site';

function batch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    external_batch_id: 'bat-0000000000000001',
    project: {
      external_id: 'proj-a1b2c3d4e5f60718',
      title: 't',
      visibility: 'private',
      source_host: 'host-3f7868fca315',
    },
    generated_at: 1_700_001_000_000,
    local_schema_version: 10,
    entities: { runs: [], stages: [], events: [] },
    ...overrides,
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** 记录每一次请求，方便断言"根本没出网"。 */
function recorder(result: () => Promise<Response>): {
  fetch: FetchLike;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init: init ?? {} });
      return result();
    },
  };
}

describe('ingest endpoint shape (F1.7)', () => {
  it('points at the mounted Function path and keeps the token out of the URL', () => {
    expect(ingestUrl(SITE)).toBe(`${SITE}/functions/v1/app/ingest`);
    expect(ingestUrl(`${SITE}/`)).toBe(`${SITE}/functions/v1/app/ingest`);
    let caught: unknown;
    try {
      ingestUrl('file:///etc/passwd');
    } catch (error) {
      caught = error;
    }
    expect(isIdeaseekError(caught) && caught.code).toBe('INVALID_ARGUMENT');
  });

  it('sends the machine credential in the header the gateway does not strip', async () => {
    const spy = recorder(() =>
      Promise.resolve(
        json({
          ok: true,
          status: 'accepted',
          external_batch_id: 'bat-0000000000000001',
          counts: { events: 2 },
        }),
      ),
    );
    const outcome = await sendBatch(batch(), { site: SITE, token: TOKEN, fetch: spy.fetch });
    expect(outcome.kind).toBe('accepted');
    const headers = spy.calls[0]!.init.headers as Record<string, string>;
    expect(headers[SYNC_TOKEN_HEADER]).toBe(TOKEN);
    // 网关对空 UA 直接 403 BOT_DETECTED（M1 实测），Origin 缺失判成跨站写。
    expect(headers['user-agent']).toBe(USER_AGENT);
    expect(headers.origin).toBe('demo.qoder.site');
    expect(headers['content-type']).toBe('application/json');
    expect(spy.calls[0]!.init.method).toBe('POST');
    expect(String(spy.calls[0]!.init.signal)).toContain('AbortSignal');
    expect(spy.calls[0]!.url).not.toContain(TOKEN);
    expect(String(spy.calls[0]!.init.body)).not.toContain(TOKEN);
  });

  it('defaults to a timeout well inside the Function execution budget', () => {
    expect(DEFAULT_TIMEOUT_MS).toBeLessThan(50_000);
  });
});

describe('outcome classification', () => {
  const send = (response: () => Promise<Response>) =>
    sendBatch(batch(), { site: SITE, token: TOKEN, fetch: recorder(response).fetch });

  it('counts accepted and replay as synced, with the cloud counts', async () => {
    const accepted = await send(() =>
      Promise.resolve(
        json({
          ok: true,
          status: 'accepted',
          external_batch_id: 'bat-0000000000000001',
          counts: { runs: 1, stages: 3, events: 40 },
        }),
      ),
    );
    expect(accepted.kind).toBe('accepted');
    if (accepted.kind === 'accepted') {
      expect(accepted.receipt.counts).toEqual({ runs: 1, stages: 3, events: 40 });
      expect(accepted.receipt.externalBatchId).toBe('bat-0000000000000001');
    }
    const replay = await send(() =>
      Promise.resolve(
        json({ ok: true, status: 'replay', external_batch_id: 'bat-0000000000000001' }),
      ),
    );
    expect(replay.kind).toBe('replay');
  });

  it('refuses to call an unreadable 200 a success', async () => {
    // 把"看不懂"记成已同步，游标就会跳过这批，时间线永久缺一块。
    const weird = await send(() => Promise.resolve(json({ ok: true })));
    expect(weird.kind).toBe('unavailable');
    const notJson = await send(() =>
      Promise.resolve(new Response('<html>502</html>', { status: 200 })),
    );
    expect(notJson.kind).toBe('unavailable');
  });

  it('treats 401 and 403 as a credential problem, never as a retry', async () => {
    for (const status of [401, 403]) {
      const outcome = await send(() =>
        Promise.resolve(
          json({ ok: false, code: 'invalid_sync_token', message: '令牌无效' }, status),
        ),
      );
      expect(outcome.kind).toBe('unauthorized');
      if (outcome.kind === 'unauthorized') expect(outcome.code).toBe('invalid_sync_token');
    }
    // 网关的跨站/UA 拦截只有响应头，没有可读 JSON 体，也要归到 unauthorized。
    const gateway = await send(() =>
      Promise.resolve(
        new Response('forbidden', {
          status: 403,
          headers: { 'x-qoder-error': 'sites_gateway_origin_forbidden' },
        }),
      ),
    );
    expect(gateway.kind).toBe('unauthorized');
    if (gateway.kind === 'unauthorized')
      expect(gateway.code).toBe('sites_gateway_origin_forbidden');
  });

  it('separates a version negotiation failure from a shape rejection', async () => {
    const version = await send(() =>
      Promise.resolve(
        json({ ok: false, code: 'invalid_projection', message: '不支持的投影版本：99' }, 415),
      ),
    );
    expect(version.kind).toBe('version-unsupported');
    const shape = await send(() =>
      Promise.resolve(
        json(
          { ok: false, code: 'invalid_projection', message: '/runs/0/status 必须是字符串' },
          400,
        ),
      ),
    );
    expect(shape.kind).toBe('rejected');
    if (shape.kind === 'rejected') expect(shape.message).toContain('必须是字符串');
    // 8 MiB 实测连接级失败、32 MiB 给 413：体积超限同样是"别再重试这段字节"。
    const tooBig = await send(() =>
      Promise.resolve(
        json({ ok: false, code: 'request_too_large', message: 'body too large' }, 413),
      ),
    );
    expect(tooBig.kind).toBe('rejected');
  });

  it('reads the unimplemented collections back out of the 501 code', async () => {
    const outcome = await send(() =>
      Promise.resolve(
        json(
          {
            ok: false,
            code: 'projection_collections_not_implemented:tasks,claims',
            message: '尚未实装',
          },
          501,
        ),
      ),
    );
    expect(outcome.kind).toBe('collections-unsupported');
    if (outcome.kind === 'collections-unsupported')
      expect(outcome.collections).toEqual(['tasks', 'claims']);
  });

  it('keeps 429 and 5xx as unknown-outcome failures worth replaying', async () => {
    for (const status of [429, 500, 503]) {
      const outcome = await send(() => Promise.resolve(new Response('busy', { status })));
      expect(outcome.kind).toBe('unavailable');
    }
  });

  it('reports a connection failure as unknown, not as delivered', async () => {
    const outcome = await sendBatch(batch(), {
      site: SITE,
      token: TOKEN,
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind === 'unavailable') expect(outcome.reason).toBe('network');
  });

  it('names the timeout distinctly from a dead connection', async () => {
    const outcome = await sendBatch(batch(), {
      site: SITE,
      token: TOKEN,
      timeoutMs: 1,
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('The operation was aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    });
    expect(outcome.kind).toBe('unavailable');
    // 真 fetch 在 `AbortSignal.timeout` 下抛 `TimeoutError`；这里用等价形状的 AbortError。
    if (outcome.kind === 'unavailable') expect(outcome.reason).toBe('timeout');
  });
});

describe('nothing leaves the machine (F1.13)', () => {
  it('makes no request when the token is missing or too short', async () => {
    for (const token of ['', 'short', 'x'.repeat(31)]) {
      const spy = recorder(() => Promise.reject(new Error('无凭据不该出网')));
      const outcome = await sendBatch(batch(), { site: SITE, token, fetch: spy.fetch });
      expect(spy.calls).toHaveLength(0);
      expect(outcome.kind).toBe('unauthorized');
    }
  });
});
