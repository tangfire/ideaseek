/**
 * 自有账号与会话（AUTH_AND_CRUD_REFACTOR_PLAN.md §4）的回归。
 *
 * 覆盖：注册（形状/重复/弱密码）、登录（凭据/锁定/成功）、会话（me/登出/过期）、
 * 以及最关键的一条——**身份换了之后写面仍然只认会话**：匿名 401、带 Cookie 才放行。
 * 跑法见仓库门禁（rolldown 打包后 `node --test`）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { application } from '../routes.ts';
import type { SiteContext } from '../routes.ts';
import { createFakeDb } from '../dev/fake-db.ts';

async function build() {
  const fake = createFakeDb();
  const handle = application({
    db: fake.db,
    BackendError: fake.BackendError,
    // D3：平台身份不参与业务鉴权，这里给不给都一样。
    getUser: () => null,
    upgradeWebSocket: () => {
      throw new Error('本用例不测握手');
    },
  });
  return { fake, handle };
}

interface CallResult {
  status: number;
  raw: string;
  json: Record<string, unknown>;
  setCookie: string | null;
}

async function call(handle: (ctx: SiteContext) => Promise<Response>, path: string, init?: RequestInit): Promise<CallResult> {
  try {
    const response = await handle({ request: new Request(`https://site.test/functions/v1/app${path}`, init), requestId: 'test' });
    const raw = await response.text();
    const json = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    return { status: response.status, raw, json, setCookie: response.headers.get('set-cookie') };
  } catch (error) {
    const thrown = error as { code?: string; status?: number };
    return { status: thrown.status ?? 500, raw: '', json: { code: thrown.code ?? 'internal' }, setCookie: null };
  }
}

const web = (json: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) });

/** 从 `Set-Cookie` 里取 `name=value`，拼成请求的 `Cookie` 头。 */
function cookiePair(setCookie: string | null): string {
  assert.ok(setCookie, '响应必须下发 Set-Cookie');
  return setCookie.split(';')[0]!;
}

const withCookie = (cookie: string): { headers: Record<string, string> } => ({ headers: { cookie } });

// --------------------------------------------------------------------------- 注册

test('注册：成功下发会话 Cookie，且建出自己的 Owner 行', async () => {
  const { fake, handle } = await build();
  const res = await call(handle, '/auth/register', web({ username: 'alice', password: 'correct-horse' }));
  assert.equal(res.status, 201, res.raw);
  assert.equal(res.json.username, 'alice');
  assert.ok(res.json.owner_id, '注册即拥有 owner_id');

  const account = fake.rowsOf('cloud_account')[0]!;
  assert.equal(account.username, 'alice');
  assert.ok(String(account.password_hash).startsWith('pbkdf2$'), '库里只有派生值');
  assert.ok(!String(account.password_hash).includes('correct-horse'), '明文密码不入库');

  const owner = fake.rowsOf('cloud_owner').find((o) => o.id === res.json.owner_id)!;
  assert.equal(owner.account_id, account.id, 'owner 挂到账号上');
  assert.equal(owner.email, 'alice', 'email 列存用户名，供 cloud_grant 邀请匹配');

  const cookie = cookiePair(res.setCookie);
  assert.ok(cookie.startsWith('is_session='), '会话 Cookie 名固定');
  // 会话表只存哈希：明文 token 只在 Cookie 里
  const stored = fake.rowsOf('cloud_session')[0]!;
  assert.ok(!String(stored.token_hash).includes(cookie.slice('is_session='.length)), '明文 token 不入库');
});

test('注册：重复用户名 409，弱密码与非法用户名 400', async () => {
  const { handle } = await build();
  assert.equal((await call(handle, '/auth/register', web({ username: 'bob', password: 'long-enough-pass' }))).status, 201);

  const dup = await call(handle, '/auth/register', web({ username: 'BOB', password: 'long-enough-pass' }));
  assert.equal(dup.status, 409, '大小写不同也算同一个用户名');
  assert.equal(dup.json.code, 'conflict');

  const weak = await call(handle, '/auth/register', web({ username: 'carol', password: 'short' }));
  assert.equal(weak.status, 400);
  assert.equal(weak.json.code, 'invalid_input:auth.password');

  const badName = await call(handle, '/auth/register', web({ username: '带空格的名字', password: 'long-enough-pass' }));
  assert.equal(badName.status, 400);
  assert.equal(badName.json.code, 'invalid_input:auth.username');
});

// --------------------------------------------------------------------------- 登录

test('登录：正确密码拿会话，错误密码与不存在的用户同一条错误（不区分）', async () => {
  const { handle } = await build();
  await call(handle, '/auth/register', web({ username: 'dave', password: 'long-enough-pass' }));

  const bad = await call(handle, '/auth/login', web({ username: 'dave', password: 'wrong-password' }));
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'invalid_input:auth.credentials');

  const ghost = await call(handle, '/auth/login', web({ username: 'nobody', password: 'wrong-password' }));
  assert.equal(ghost.status, 400);
  assert.equal(ghost.json.code, 'invalid_input:auth.credentials', '不回显"这个用户存不存在"');

  const ok = await call(handle, '/auth/login', web({ username: 'dave', password: 'long-enough-pass' }));
  assert.equal(ok.status, 200, ok.raw);
  assert.equal(ok.json.username, 'dave');
  assert.ok(cookiePair(ok.setCookie).startsWith('is_session='));
});

test('登录：连续失败 10 次锁 15 分钟，锁着的时候密码对也拒绝', async () => {
  const { fake, handle } = await build();
  await call(handle, '/auth/register', web({ username: 'erin', password: 'long-enough-pass' }));

  for (let i = 0; i < 10; i += 1) {
    const res = await call(handle, '/auth/login', web({ username: 'erin', password: 'wrong-password' }));
    assert.equal(res.status, 400, `第 ${i + 1} 次失败应是 400`);
  }

  const locked = await call(handle, '/auth/login', web({ username: 'erin', password: 'long-enough-pass' }));
  assert.equal(locked.status, 429, '锁定期连正确密码也拒绝');
  assert.equal(locked.json.code, 'rate_limited');

  const account = fake.rowsOf('cloud_account')[0]!;
  assert.equal(account.failed_attempts, 10, '失败计数落在账号上');
  assert.ok(account.locked_until && new Date(String(account.locked_until)).getTime() > Date.now(), '锁到期时间已设置');
});

// --------------------------------------------------------------------------- 会话

test('会话：/auth/me 认 Cookie；登出吊销后立刻 401', async () => {
  const { handle } = await build();
  const anon = await call(handle, '/auth/me');
  assert.equal(anon.status, 401, '没有 Cookie 就是未登录');

  const reg = await call(handle, '/auth/register', web({ username: 'frank', password: 'long-enough-pass' }));
  const cookie = cookiePair(reg.setCookie);

  const me = await call(handle, '/auth/me', { method: 'GET', ...withCookie(cookie) });
  assert.equal(me.status, 200, me.raw);
  assert.equal(me.json.username, 'frank');

  const out = await call(handle, '/auth/logout', { method: 'POST', ...withCookie(cookie) });
  assert.equal(out.status, 200);
  assert.ok(out.setCookie!.startsWith('is_session=;'), '登出要清 Cookie');

  const after = await call(handle, '/auth/me', { method: 'GET', ...withCookie(cookie) });
  assert.equal(after.status, 401, '吊销后同一张票立刻失效');
});

test('身份隔离的地基：写面只认会话，匿名 401、带 Cookie 放行', async () => {
  const { handle } = await build();

  // 匿名创建：现在必须先登录（改造前这里是 200，靠平台网关身份）
  const anon = await call(handle, '/projects', web({ command_id: crypto.randomUUID(), name: '匿名项目', question: '', strategy: 'standard', autonomy: 'guided' }));
  assert.equal(anon.status, 401, '没有会话不能创建项目');

  const reg = await call(handle, '/auth/register', web({ username: 'grace', password: 'long-enough-pass' }));
  const cookie = cookiePair(reg.setCookie);
  const mine = await call(handle, '/projects', { ...web({ command_id: crypto.randomUUID(), name: '我的项目', question: '', strategy: 'standard', autonomy: 'guided' }), ...withCookie(cookie) });
  assert.equal(mine.status, 200, mine.raw);
  assert.equal(mine.json.cloud_executed, true);
});
