/**
 * 本地入口：把真实依赖换成内存实现，跑的是**同一份** routes.ts。
 *
 * 只在开发机执行，不属于任何上传目录（`web/functions/` 才是 functionDirectory）。
 * 适配器形状在 `fake-db.ts`（本地测试用同一份），这里只保留 Deno 相关的部分。
 * 它证明的是路由与授权逻辑，不证明平台数据库、身份或 WS 握手——那些必须等部署后
 * 在真实路由上量（SPIKE §8 的 M-1…M-4）。
 */
import { application } from '../routes.ts';
import { createFakeDb } from './fake-db.ts';

const fake = createFakeDb();

/** 本地身份开关：只有 dev 入口读这个头，部署入口只认网关注入的 context。 */
function fakeUser(request: Request): { id: string } | null {
  const header = request.headers.get('x-local-user');
  return header ? { id: header } : null;
}

const handle = application({
  db: fake.db,
  BackendError: fake.BackendError,
  getUser: (ctx) => fakeUser(ctx.request),
  upgradeWebSocket: (request: Request) =>
    (Deno as unknown as { upgradeWebSocket(r: Request): { socket: WebSocket; response: Response } }).upgradeWebSocket(request),
});

Deno.serve({ hostname: '127.0.0.1', port: 8000 }, async (request: Request) => {
  try {
    return await handle({ request, requestId: 'local' });
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'internal';
    const status = (error as { status?: number }).status ?? 500;
    return Response.json({ ok: false, code }, { status });
  }
});

console.log('local function on http://127.0.0.1:8000/functions/v1/app');
