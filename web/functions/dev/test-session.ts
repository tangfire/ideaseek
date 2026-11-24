/**
 * 测试身份夹具：身份从平台网关换成自有会话 Cookie（AUTH_AND_CRUD_REFACTOR_PLAN.md §4）
 * 之后，用例要能"以某某身份发请求"，而不再是往 `getUser` 里塞一个 id。
 *
 * 只造会话、不走密码登录——用例关心的是授权，不是口令学；密码路径由 auth.test.ts 单独覆盖。
 * 身份行按 `cloud_owner.email = 用户名` 对齐（注册时就把用户名写进这一列，见 accounts.ts），
 * 这样"先邀请后注册"的 cloud_grant 按 email 匹配在测试里也成立。
 */
import type { Db } from '../deps.ts';
import { rows } from '../deps.ts';
import type { SiteContext } from '../routes.ts';

export interface SessionFixture {
  cookie: string;
  ownerId: string;
  username: string;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 夹具查询失败就是夹具坏了：给出带 code/status 的错误，形状与平台 BackendError 一致。 */
const FixtureError = class extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
} as unknown as new (code: string, status: number) => Error;

/** 给用户名造出 account + owner + session 三行，返回可直接塞进请求的 Cookie 值。 */
export async function ensureSession(db: Db, username: string): Promise<SessionFixture> {
  const accounts = rows<{ id: string }>(
    await db.from<{ id: string }>('cloud_account').select('id').eq('username', username).limit(1),
    FixtureError,
  );
  let accountId = accounts[0]?.id;
  if (!accountId) {
    const created = rows<{ id: string }>(
      await db
        .from<{ id: string }>('cloud_account')
        .insert({
          username,
          // 语法合法但不可验证：这些身份从不走登录，走登录的用例在 auth.test.ts 里自己注册。
          password_hash: 'pbkdf2$1$YWJjZGVmZ2hpamtsbW5vcA$YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo',
          display_name: null,
          failed_attempts: 0,
          locked_until: null,
          last_login_at: null,
        })
        .select('id'),
      FixtureError,
    );
    accountId = created[0]!.id;
  }

  const owners = rows<{ id: string; account_id: string | null }>(
    await db.from<{ id: string; account_id: string | null }>('cloud_owner').select('id,account_id').eq('email', username).limit(1),
    FixtureError,
  );
  let ownerId = owners[0]?.id;
  if (!ownerId) {
    const created = rows<{ id: string }>(
      await db.from<{ id: string }>('cloud_owner').insert({ email: username, display_name: null, account_id: accountId }).select('id'),
      FixtureError,
    );
    ownerId = created[0]!.id;
  } else if (!owners[0]!.account_id) {
    // 夹具先 seed 了 owner 行（老写法）：把账号挂上去，sessionIdentity 才找得到。
    await db.from('cloud_owner').update({ account_id: accountId }).eq('id', ownerId);
  }

  const token = `test-session-${username}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const now = new Date();
  await db.from('cloud_session').insert({
    account_id: accountId,
    token_hash: await sha256Hex(token),
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
    last_seen_at: now.toISOString(),
    revoked_at: null,
    user_agent: 'test-fixture',
  });

  return { cookie: `is_session=${token}`, ownerId, username };
}

/**
 * 给 application 句柄包一层：以 `username` 的会话发请求。
 * GET/HEAD 无 body；其余方法把原 body 读成 ArrayBuffer 再重建请求，
 * 避开 `new Request(原请求)` 在带 body 时的 duplex 限制。
 */
export function withSession(
  handle: (ctx: SiteContext) => Promise<Response>,
  getCookie: () => Promise<string>,
): (ctx: SiteContext) => Promise<Response> {
  return async (ctx: SiteContext) => {
    const cookie = await getCookie();
    const original = ctx.request;
    const headers = new Headers(original.headers);
    headers.set('cookie', cookie);
    const hasBody = original.method !== 'GET' && original.method !== 'HEAD';
    const request = new Request(original.url, {
      method: original.method,
      headers,
      body: hasBody ? await original.arrayBuffer() : undefined,
    });
    return handle({ ...ctx, request });
  };
}
