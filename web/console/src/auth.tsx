/**
 * 自有账号的前端面（AUTH_AND_CRUD_REFACTOR_PLAN.md §4/§5.5）。
 *
 * 登录态只有一处真源：`GET /auth/me`（Cookie 会话）。列表、项目页、写面都靠它挡在
 * 门外，前端不做任何"看起来像登录"的本地标记——本地标记可以被改，服务端判定才算数。
 *
 * 认证接口的错误要区分到"账号或密码错误 / 用户名已占用 / 已锁定"，
 * 所以这里不走 api.ts 的固定文案映射：那些 code 是我们自己定的，回显是安全的。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactElement } from 'react';
import { useLocation } from 'wouter';
import { ApiError, getSessionToken, setSessionToken } from './api';

const AUTH = '/functions/v1/app/auth';

export interface Me {
  ok: true;
  username: string;
  owner_id: string;
}

/** 认证失败的固定文案：code 是我们自己的枚举，不存在泄漏内部结构的问题。 */
const AUTH_ERRORS: Record<string, string> = {
  'invalid_input:auth.username': '用户名需 3-32 位字母、数字、下划线或短横。',
  'invalid_input:auth.password': '密码至少 8 位、至多 128 位。',
  'invalid_input:auth.credentials': '账号或密码错误。',
  conflict: '该用户名已被使用，换一个试试。',
  rate_limited: '尝试次数过多，账号已锁定 15 分钟。',
  login_required: '请先登录。',
};

async function authFetch(path: string, body?: unknown): Promise<Me> {
  const token = getSessionToken();
  let response: Response;
  try {
    response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        // 网关剥 cookie 头，会话只能走自定义头（见 api.ts 的注释）。
        ...(token ? { 'x-ideaseek-session': token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('无法连接云端，请检查网络后重试。');
  }
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error('云端返回了无法解析的响应。');
  }
  // 登出无论如何都清本地 token：服务端已吊销，本地留着只会让下一次请求带一张死票。
  if (path.endsWith('/logout')) setSessionToken(null);
  if (!response.ok || payload.ok !== true) {
    const code = String(payload.error ?? '');
    throw new Error(AUTH_ERRORS[code] ?? (response.status === 401 ? '请先登录。' : '操作失败，请稍后重试。'));
  }
  // 登录/注册把会话 token 放在 JSON 里（网关剥 Cookie，只能这么带回来）。
  if (typeof payload.session_token === 'string') setSessionToken(payload.session_token);
  return payload as unknown as Me;
}

/** 当前登录账号；未登录 = ApiError('login_required')。 */
export function useMe() {
  return useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => authFetch(`${AUTH}/me`) as Promise<Me>,
    retry: false,
    staleTime: 30_000,
  });
}

export async function logout(): Promise<void> {
  await authFetch(`${AUTH}/logout`, {});
}

/** 登录 / 注册同一张表单，按 mode 切换。 */
export function AuthPanel() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const client = useQueryClient();
  const [, navigate] = useLocation();

  const submit = useMutation({
    mutationFn: () => authFetch(`${AUTH}/${mode}`, { username, password }),
    onSuccess: async () => {
      setError(null);
      await client.invalidateQueries({ queryKey: ['auth', 'me'] });
      await client.invalidateQueries({ queryKey: ['index'] });
      navigate('/console');
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div className="panel" style={{ width: '100%', maxWidth: 380 }}>
        <h1 style={{ fontSize: 24, margin: '0 0 4px' }}>IdeaSeek</h1>
        <p className="muted" style={{ margin: '0 0 16px', fontSize: 13 }}>
          {mode === 'login' ? '登录后管理你的研究项目' : '注册一个账号，立刻开始'}
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit.mutate();
          }}
          style={{ display: 'grid', gap: 10 }}
        >
          <input
            placeholder="用户名"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            aria-label="用户名"
          />
          <input
            placeholder="密码（至少 8 位）"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            aria-label="密码"
          />
          {error ? (
            <p className="status-chip" data-state="fail" style={{ margin: 0 }}>
              {error}
            </p>
          ) : null}
          <button className="btn-primary" type="submit" disabled={submit.isPending || username.trim().length === 0 || password.length === 0}>
            {submit.isPending ? '请稍候…' : mode === 'login' ? '登录' : '注册并登录'}
          </button>
        </form>
        <p className="muted" style={{ margin: '14px 0 0', fontSize: 13 }}>
          {mode === 'login' ? '还没有账号？' : '已经有账号了？'}{' '}
          <a
            href="#/login"
            onClick={(event) => {
              event.preventDefault();
              setError(null);
              setMode(mode === 'login' ? 'register' : 'login');
            }}
          >
            {mode === 'login' ? '去注册' : '去登录'}
          </a>
        </p>
        <p className="muted" style={{ margin: '10px 0 0', fontSize: 12 }}>
          <a href="#/">返回首页</a>
        </p>
      </div>
    </div>
  );
}

/** 控制台守卫：没登录就送去登录页，登录态由 /auth/me 说了算。 */
export function RequireAuth({ children }: { children: ReactElement }) {
  const me = useMe();

  if (me.isError) {
    const code = me.error instanceof ApiError ? me.error.code : 'network';
    if (code === 'login_required') return <RedirectToLogin />;
    return (
      <p className="status-chip" data-state="fail" style={{ margin: 24 }}>
        读取账号状态失败：{(me.error as Error).message}
      </p>
    );
  }
  if (me.isPending) {
    return (
      <p className="muted" style={{ padding: 24 }}>
        正在校验登录…
      </p>
    );
  }
  return children;
}

function RedirectToLogin() {
  const [, navigate] = useLocation();
  useEffect(() => {
    navigate('/login');
  }, [navigate]);
  return (
    <p className="muted" style={{ padding: 24 }}>
      未登录，正在前往登录页…
    </p>
  );
}
