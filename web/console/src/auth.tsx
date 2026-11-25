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
    throw new ApiError('network', '无法连接云端，请检查网络后重试。');
  }
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new ApiError('invalid_response', '云端返回了无法解析的响应。', response.status);
  }
  // 登出无论如何都清本地 token：服务端已吊销，本地留着只会让下一次请求带一张死票。
  if (path.endsWith('/logout')) setSessionToken(null);
  if (!response.ok || payload.ok !== true) {
    const code = String(payload.error ?? '');
    const message =
      AUTH_ERRORS[code] ?? (response.status === 401 ? '请先登录。' : '操作失败，请稍后重试。');
    // 必须把 401 标成 login_required：守卫靠它区分"没登录（进游客模式）"和"真的坏了"。
    // 上一版这里抛的是普通 Error，守卫只能当网络故障处理，于是登录页变成一句报错。
    if (response.status === 401 || code === 'login_required') {
      throw new ApiError('login_required', message, 401);
    }
    if (response.status === 400) throw new ApiError('invalid_input', message, 400);
    if (response.status === 409) throw new ApiError('conflict', message, 409);
    if (response.status === 429) throw new ApiError('rate_limited', message, 429);
    throw new ApiError('service_unavailable', message, response.status);
  }
  // 登录/注册把会话 token 放在 JSON 里（网关剥 Cookie，只能这么带回来）。
  if (typeof payload.session_token === 'string') setSessionToken(payload.session_token);
  return payload as unknown as Me;
}

/** 当前登录账号；未登录 = `data: null`（正常态，不是错误），读取失败才是 error。 */
export function useMe() {
  return useQuery<Me | null>({
    queryKey: ['auth', 'me'],
    queryFn: async () => {
      try {
        return await authFetch(`${AUTH}/me`);
      } catch (err) {
        // 未登录是**正常状态**：返回 null 让查询成功落地。
        // 若把它当 error，查询会处于"error 且无 data"——子树里每个 useMe 观察者
        // 挂载都会触发 refetchOnMount 重新拉一次，而守卫又因 pending 卸载子树，
        // 子树再挂载再拉……线上实测 140+ 次 /auth/me 的死循环就是这么来的。
        if (err instanceof ApiError && err.code === 'login_required') return null;
        throw err;
      }
    },
    retry: false,
    staleTime: 30_000,
  });
}

export async function logout(): Promise<void> {
  await authFetch(`${AUTH}/logout`, {});
}

/** 登录 / 注册同一张表单，按 mode 切换。 */
export function AuthPanel({ initialMode = 'login' }: { initialMode?: 'login' | 'register' }) {
  const [mode, setMode] = useState<'login' | 'register'>(initialMode);
  useEffect(() => {
    setMode(initialMode);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMode]);
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
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div className="panel" style={{ width: '100%', maxWidth: 380 }}>
        <h1 style={{ fontSize: 24, margin: '0 0 4px' }}>IdeaSeek</h1>
        <p className="muted" style={{ margin: '0 0 16px', fontSize: 15 }}>
          {mode === 'login' ? '登录后管理你的研究项目' : '注册一个账号，立刻开始'}
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit.mutate();
          }}
          style={{ display: 'grid', gap: 10 }}
        >
          <label className="form-field">
            用户名
            <input
              placeholder="用户名"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              aria-label="用户名"
            />
          </label>
          <label className="form-field">
            密码
            <input
              placeholder="密码（至少 8 位）"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              aria-label="密码"
            />
          </label>
          {error ? (
            <p className="status-chip" data-state="fail" style={{ margin: 0 }}>
              {error}
            </p>
          ) : null}
          <button
            className="btn-primary"
            type="submit"
            disabled={submit.isPending || username.trim().length === 0 || password.length === 0}
          >
            {submit.isPending ? '请稍候…' : mode === 'login' ? '登录' : '注册并登录'}
          </button>
        </form>
        <p className="muted" style={{ margin: '14px 0 0', fontSize: 15 }}>
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
        <p className="muted" style={{ margin: '10px 0 0', fontSize: 14 }}>
          <a href="#/">返回首页</a>
        </p>
      </div>
    </div>
  );
}

/**
 * 控制台入口：校验登录态，但**没登录不是错误**——那是游客模式。
 * 只有真的读不到账号状态（网络/服务故障）才报错；未登录一律放行进游客视图，
 * 由 GuestBanner 说明"能看什么、要什么权限、去哪注册登录"。
 */
export function AuthGate({ children }: { children: ReactElement }) {
  const me = useMe();

  // 还没查过：先等一次，避免闪一帧无权限的内容。
  if (me.isPending) {
    return (
      <p className="muted" style={{ padding: 24 }}>
        正在校验登录…
      </p>
    );
  }
  // 只有真故障（网络/服务）才拦；未登录是 data === null，放行进游客视图。
  if (me.isError) {
    return (
      <p className="status-chip" data-state="fail" style={{ margin: 24 }}>
        读取账号状态失败：{(me.error as Error).message}
      </p>
    );
  }
  return children;
}

/**
 * 游客横幅：登录了就不出现。文案只说三件事——现在是什么状态、缺什么权限、去哪补。
 */
export function GuestBanner() {
  const me = useMe();
  if (me.data || me.isPending) return null;
  return (
    <div
      className="panel"
      style={{
        borderLeftColor: 'var(--active)',
        display: 'flex',
        gap: 12,
        alignItems: 'center',
        flexWrap: 'wrap',
        marginBottom: 16,
      }}
    >
      <span className="status-chip" data-state="idle">
        游客模式
      </span>
      <span style={{ fontSize: 15 }}>
        现在只能查看公开的演示项目；创建、编辑、归档需要注册或登录。
      </span>
      <span style={{ display: 'inline-flex', gap: 8, marginLeft: 'auto' }}>
        <a className="btn-primary" href="#/register">
          注册
        </a>
        <a className="btn-secondary" href="#/login">
          登录
        </a>
      </span>
    </div>
  );
}
