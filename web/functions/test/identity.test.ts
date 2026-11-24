/**
 * 部署态身份面的回归：`auth.mjs`（平台参照实现，逐字节副本）+ `identity.ts` 的
 * 形状映射，再接到**同一份** `routes.ts` 上跑一次读路径。
 *
 * 这一Lane 存在的原因是 M1 实测踩过的那次整包打挂：`getUser` 被当成平台注入模块
 * （`_qoder/backend.mjs`）的导出，worker 启动即失败（SPIKE_SITES_RUNTIME.md §10）。
 * 平台模块在本地不存在，所以能测的边界是"身份头的语义 + 我们的映射"，不能测的
 * 是"网关是否真的会注入这个头"——后者属于 M-5 的反绕过验收。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getUser } from '../auth.mjs';
import { gatewayUser } from '../identity.ts';
import { application } from '../routes.ts';
import { createFakeDb } from '../dev/fake-db.ts';
import { ensureSession } from '../dev/test-session.ts';

interface ContextPayload {
  user_id: string;
  name: string;
  picture: string;
  site_id: string;
  host_id: string;
  session_expires_at: number;
}

/** 网关注入的是 base64url、无 padding；这里造一份同样形状的。 */
function contextHeader(overrides: Partial<ContextPayload> = {}): string {
  const payload: ContextPayload = {
    user_id: 'u-8842',
    name: '',
    picture: '',
    site_id: 'site-1',
    host_id: 'host-1',
    session_expires_at: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function withHeader(value: string): Request {
  return new Request('https://site.test/functions/v1/app/views/index', { headers: { 'x-qoder-user-context': value } });
}

/**
 * `handle` 只生产响应，抛出的 `BackendError` 由**入口**映射（`index.ts` /
 * `dev/local.ts` 的 catch）。测试直接调 handle 时必须自己补上这一层，否则
 * "被拒"会变成一条未捕获异常，看起来像崩溃而不是 404。
 */
async function run(handle: ReturnType<typeof application>, request: Request): Promise<{ status: number; code: string; json: Record<string, unknown> }> {
  try {
    const response = await handle({ request, requestId: 'test' });
    const text = await response.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    return { status: response.status, code: String(json.code ?? ''), json };
  } catch (error) {
    const thrown = error as { code?: string; status?: number };
    return { status: thrown.status ?? 500, code: thrown.code ?? 'internal', json: {} };
  }
}

test('缺上下文头 = 匿名访客（公开站点的正常路径）', () => {
  assert.equal(gatewayUser({ request: new Request('https://site.test/views/index') }), null);
});

test('合法上下文映射成 {id}，平台字段名不进路由层', () => {
  const viewer = gatewayUser({ request: withHeader(contextHeader()) });
  assert.deepEqual(viewer, { id: 'u-8842' });
});

test('过期的上下文是失败，不是降级成匿名', () => {
  // 静默把"身份读不懂"当成"没登录"，等于让一次网关故障变成一次权限降级。
  assert.throws(
    () => gatewayUser({ request: withHeader(contextHeader({ session_expires_at: Math.floor(Date.now() / 1000) - 10 })) }),
    (error: unknown) => {
      const thrown = error as { code?: string; status?: number };
      return thrown.code === 'invalid_user_context' && thrown.status === 403;
    },
  );
});

test('伪造的头一律 403', () => {
  for (const forged of ['not-base64url!!', contextHeader({ user_id: '' }), contextHeader({ user_id: 'x'.repeat(200) })]) {
    assert.throws(
      () => gatewayUser({ request: withHeader(forged) }),
      (error: unknown) => (error as { code?: string }).code === 'invalid_user_context',
      `应当拒绝：${forged.slice(0, 24)}`,
    );
  }
});

test('映射接到读路径：会话 Cookie 让 Owner 读到私有；平台身份头不再算数', async () => {
  const fake = createFakeDb();
  const owner = fake.seed('cloud_owner', { email: 'u-8842', display_name: null });
  fake.seed('cloud_project', {
    owner_id: owner.id,
    external_id: 'prj-private',
    title: '私有项目',
    visibility: 'private',
    archived_at: null,
    last_sync_at: null,
  });
  const handle = application({
    db: fake.db,
    BackendError: fake.BackendError,
    getUser: gatewayUser,
    upgradeWebSocket: () => assert.fail('不该升级'),
  });
  const url = 'https://site.test/functions/v1/app/views/project?external_id=prj-private';
  const cookie = (await ensureSession(fake.db, 'u-8842')).cookie;

  const asOwner = await run(handle, new Request(url, { headers: { cookie } }));
  assert.equal(asOwner.status, 200);
  assert.equal(asOwner.json.projection_level, 'full');

  // D3：平台网关身份退出业务鉴权——只带头、没有会话，等于匿名。
  const headerOnly = await run(handle, new Request(url, { headers: { 'x-qoder-user-context': contextHeader() } }));
  assert.equal(headerOnly.status, 404, '平台身份头不再是万能钥匙');

  // 匿名被拒 = 当作不存在：私有项目的存在性本身就是信息。
  const asAnonymous = await run(handle, new Request(url));
  assert.equal(asAnonymous.status, 404);
  assert.equal(asAnonymous.code, 'not_found');
});

test('`x-local-user` 只属于 dev 入口，部署面不认', async () => {
  const fake = createFakeDb();
  // 同名 Owner 带着自己的私有项目在库里等着：若部署面认了这个头，列表就会亮。
  const owner = fake.seed('cloud_owner', { email: 'u-8842', display_name: null });
  fake.seed('cloud_project', {
    owner_id: owner.id,
    external_id: 'prj-private',
    title: '私有项目',
    visibility: 'private',
    archived_at: null,
    last_sync_at: null,
  });
  const handle = application({
    db: fake.db,
    BackendError: fake.BackendError,
    // 部署入口注入的是 gatewayUser：本地那个头从这里进不来。
    getUser: gatewayUser,
    upgradeWebSocket: () => assert.fail('不该升级'),
  });
  const outcome = await run(handle, new Request('https://site.test/functions/v1/app/views/index', { headers: { 'x-local-user': 'u-8842' } }));
  assert.equal(outcome.status, 200);
  assert.deepEqual(outcome.json.projects, []);
  assert.equal(getUser(new Request('https://site.test/', { headers: { 'x-local-user': 'u-8842' } })), null);
});
