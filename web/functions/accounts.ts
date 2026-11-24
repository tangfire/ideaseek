/**
 * 自有账号与会话（AUTH_AND_CRUD_REFACTOR_PLAN.md §4）。
 *
 * 三件事：
 *   1. 注册/登录/登出/me —— 用户名+密码，密码只存 PBKDF2 派生值；
 *   2. 会话 = 随机 token 的 Cookie，库里只存 sha256（NFR-02 同款纪律）；
 *   3. `sessionOwnerId()` 给 `resolveViewer` 用：有会话就是那个 Owner，没有就是匿名。
 *
 * 平台网关身份（`x-qoder-user-context`）不再参与业务鉴权（D3 已定）：
 * 谁能注册平台账号谁就是"合法用户"，等于没有权限隔离。
 *
 * 明文密码/会话 token 不进事件、日志、错误栈——错误只回固定 code。
 */
import type { BackendErrorLike, Db } from './deps.ts';
import { rows } from './deps.ts';

export const SESSION_COOKIE = 'is_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 天
const PBKDF2_ITERATIONS = 310_000; // OWASP 2023 对 PBKDF2-SHA256 的下限
const MAX_FAILED_ATTEMPTS = 10;
const LOCK_MINUTES = 15;
const USERNAME_RE = /^[A-Za-z0-9_-]{3,32}$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

interface AccountRow {
  id: string;
  username: string;
  password_hash: string;
  display_name: string | null;
  failed_attempts: number;
  locked_until: string | null;
  created_at: string;
  last_login_at: string | null;
}

interface SessionRow {
  id: string;
  account_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  user_agent: string | null;
}

// ---------------------------------------------------------------------------
// 密码哈希
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  );
  return `pbkdf2$${iterations}$${toBase64Url(salt)}$${toBase64Url(new Uint8Array(bits))}`;
}

/** 常数时间比较：先算后比，且逐字节异或累加，不因提前 return 泄漏位信息。 */
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 5_000_000) return false;
  const salt = fromBase64Url(parts[2]!);
  const expected = fromBase64Url(parts[3]!);
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, expected.length * 8),
  );
  let diff = bits.length ^ expected.length;
  for (let i = 0; i < Math.max(bits.length, expected.length); i += 1) {
    diff |= (bits[i] ?? 0) ^ (expected[i] ?? 0);
  }
  return diff === 0;
}

/** 用户不存在时也走一次同价哈希，避免"响应快慢"暴露用户名是否存在。 */
let dummyHash: string | null = null;
async function burnPasswordTime(password: string): Promise<void> {
  if (!dummyHash) dummyHash = await hashPassword('dummy-password-for-timing-equalisation');
  await verifyPassword(password, dummyHash);
}

// ---------------------------------------------------------------------------
// Cookie
// ---------------------------------------------------------------------------

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

/** `Secure` 只在 https 下给：本地 dev 是 http://127.0.0.1，加了 Secure 浏览器会直接丢弃。 */
function sessionSetCookie(request: Request, token: string): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

function clearCookie(request: Request): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

async function issueSession(db: Db, request: Request, accountId: string): Promise<string> {
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const now = new Date();
  await db.from('cloud_session').insert({
    account_id: accountId,
    token_hash: await sha256Hex(token),
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString(),
    last_seen_at: now.toISOString(),
    revoked_at: null,
    user_agent: (request.headers.get('user-agent') ?? '').slice(0, 200) || null,
  });
  return token;
}

// ---------------------------------------------------------------------------
// 会话解析（resolveViewer 的身份来源）
// ---------------------------------------------------------------------------

/**
 * 有效会话 → `{ownerId, username}`；无 Cookie / 过期 / 已吊销 → null（= 匿名访客）。
 * `username` 取自 `cloud_owner.email`（注册时把用户名写进这一列，作为邀请标识，
 * 见 views.ts resolveViewer 的 grant 匹配）。
 */
export async function sessionIdentity(
  request: Request,
  db: Db,
  BackendError: BackendErrorLike,
): Promise<{ ownerId: string; username: string } | null> {
  const token = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
  if (!token) return null;

  const session = rows<SessionRow>(
    await db.from<SessionRow>('cloud_session').select('*').eq('token_hash', await sha256Hex(token)).limit(1),
    BackendError,
  )[0];
  if (!session || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) return null;

  const owner = rows<{ id: string; email: string | null }>(
    await db.from<{ id: string; email: string | null }>('cloud_owner').select('id,email').eq('account_id', session.account_id).limit(1),
    BackendError,
  )[0];
  if (!owner) return null;
  return { ownerId: owner.id, username: owner.email ?? '' };
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

const fail = (BackendError: BackendErrorLike, code: string, status: number): never => {
  throw new BackendError(code, status);
};

function validateCredentials(body: Record<string, unknown>, BackendError: BackendErrorLike): { username: string; password: string } {
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  if (!USERNAME_RE.test(username)) fail(BackendError, 'invalid_input:auth.username', 400);
  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    fail(BackendError, 'invalid_input:auth.password', 400);
  }
  return { username: username.toLowerCase(), password };
}

// ---------------------------------------------------------------------------
// 注册 / 登录 / 登出 / me
// ---------------------------------------------------------------------------

export async function registerAccount(
  db: Db,
  request: Request,
  body: Record<string, unknown>,
  BackendError: BackendErrorLike,
): Promise<Response> {
  const { username, password } = validateCredentials(body, BackendError);

  // 显式查重（fake-db 不 enforcing唯一索引）；真库的 lower(username) 唯一索引兜并发。
  const existing = rows<{ id: string }>(
    await db.from<{ id: string }>('cloud_account').select('id').eq('username', username).limit(1),
    BackendError,
  )[0];
  if (existing) fail(BackendError, 'conflict', 409);

  const passwordHash = await hashPassword(password);
  const created = rows<AccountRow>(
    await db
      .from<AccountRow>('cloud_account')
      .insert({
        username,
        password_hash: passwordHash,
        display_name: typeof body.display_name === 'string' && body.display_name.trim() ? body.display_name.trim().slice(0, 64) : null,
        failed_attempts: 0,
        locked_until: null,
        last_login_at: null,
      })
      .select('*'),
    BackendError,
  )[0];
  if (!created) fail(BackendError, 'write_failed', 500);

  const owner = rows<{ id: string }>(
    await db
      .from<{ id: string }>('cloud_owner')
      // email 存用户名：cloud_grant 靠 email 匹配"先邀请、后注册"的读者（见 resolveViewer）。
      .insert({ email: username, display_name: created.display_name ?? username, account_id: created.id })
      .select('id'),
    BackendError,
  )[0];
  if (!owner) fail(BackendError, 'write_failed', 500);

  const token = await issueSession(db, request, created.id);
  return Response.json(
    { ok: true, username: created.username, owner_id: owner.id },
    { status: 201, headers: { 'set-cookie': sessionSetCookie(request, token) } },
  );
}

export async function loginAccount(
  db: Db,
  request: Request,
  body: Record<string, unknown>,
  BackendError: BackendErrorLike,
): Promise<Response> {
  const { username, password } = validateCredentials(body, BackendError);

  const account = rows<AccountRow>(
    await db.from<AccountRow>('cloud_account').select('*').eq('username', username).limit(1),
    BackendError,
  )[0];

  if (!account) {
    await burnPasswordTime(password);
    fail(BackendError, 'invalid_input:auth.credentials', 400);
  }

  if (account.locked_until && new Date(account.locked_until).getTime() > Date.now()) {
    fail(BackendError, 'rate_limited', 429);
  }

  const ok = await verifyPassword(password, account.password_hash);
  if (!ok) {
    const failed = account.failed_attempts + 1;
    await db
      .from('cloud_account')
      .update({
        failed_attempts: failed,
        locked_until: failed >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null,
      })
      .eq('id', account.id);
    fail(BackendError, 'invalid_input:auth.credentials', 400);
  }

  await db
    .from('cloud_account')
    .update({ failed_attempts: 0, locked_until: null, last_login_at: new Date().toISOString() })
    .eq('id', account.id);

  const owner = rows<{ id: string }>(
    await db.from<{ id: string }>('cloud_owner').select('id').eq('account_id', account.id).limit(1),
    BackendError,
  )[0];
  if (!owner) fail(BackendError, 'write_failed', 500);

  const token = await issueSession(db, request, account.id);
  return Response.json(
    { ok: true, username: account.username, owner_id: owner.id },
    { headers: { 'set-cookie': sessionSetCookie(request, token) } },
  );
}

export async function logoutAccount(
  db: Db,
  request: Request,
  BackendError: BackendErrorLike,
): Promise<Response> {
  const token = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
  if (token) {
    // 吊销而不是删行：留痕可审计，且同 token 再来一律失效。
    await db.from('cloud_session').update({ revoked_at: new Date().toISOString() }).eq('token_hash', await sha256Hex(token));
  }
  return Response.json({ ok: true }, { headers: { 'set-cookie': clearCookie(request) } });
}

export async function authMe(
  db: Db,
  request: Request,
  BackendError: BackendErrorLike,
): Promise<Response> {
  const token = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
  if (!token) fail(BackendError, 'login_required', 401);

  const session = rows<SessionRow>(
    await db.from<SessionRow>('cloud_session').select('*').eq('token_hash', await sha256Hex(token)).limit(1),
    BackendError,
  )[0];
  if (!session || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) {
    fail(BackendError, 'login_required', 401);
  }

  const account = rows<AccountRow>(
    await db.from<AccountRow>('cloud_account').select('*').eq('id', session.account_id).limit(1),
    BackendError,
  )[0];
  if (!account) fail(BackendError, 'login_required', 401);

  const owner = rows<{ id: string }>(
    await db.from<{ id: string }>('cloud_owner').select('id').eq('account_id', account.id).limit(1),
    BackendError,
  )[0];
  if (!owner) fail(BackendError, 'login_required', 401);

  return Response.json({ ok: true, username: account.username, owner_id: owner.id });
}
