/**
 * 同域业务请求。三处约定不能省：
 *
 * 1. `credentials: 'same-origin'`：浏览者身份来自网关注入的 user context，
 *    浏览器侧永远不带 token/PAT（`web/functions/index.ts` 也不接受自带身份头）。
 * 2. SPA 兜底会让**缺失的脚本路径返回 HTML 200**（SPIKE §3），所以先看
 *    content-type 再看状态码，否则登录页 HTML 会被当成一次成功响应。
 * 3. 服务端错误只映射成固定 code，绝不把原始 body 渲染出去——投影里已脱敏，
 *    错误串却可能带 SQL 片段或列名。
 */
export type ApiCode =
  | 'login_required'
  | 'no_access'
  | 'not_found'
  | 'rate_limited'
  | 'service_unavailable'
  | 'invalid_response'
  | 'network';

export class ApiError extends Error {
  readonly code: ApiCode;
  readonly status: number;

  constructor(code: ApiCode, message: string, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

const MESSAGES: Record<ApiCode, string> = {
  login_required: '需要登录 Qoder 后才能读取这份投影。',
  no_access: '当前账号没有这个项目的读取权限。',
  not_found: '云端没有这个对象——可能是投影尚未同步，或已被删除。',
  rate_limited: '请求过于频繁，稍后自动重试。',
  service_unavailable: '云端服务暂时不可用，投影仍然在本地正常写入。',
  invalid_response: '云端返回了无法解析的响应。',
  network: '无法连接云端。本地引擎不受影响。',
};

function codeFor(status: number, body?: string): ApiCode {
  if (status === 401) return 'login_required';
  if (status === 403) return 'no_access';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'service_unavailable';
  return body === 'invalid_json' ? 'invalid_response' : 'network';
}

/**
 * 未记名分享链接（Phase 9.5）。明文 token 只存在于访客手里的那条 URL 里，云端只留哈希，
 * 所以链接要真能读，SPA 必须把它附到**读**请求上——控制台是哈希路由，视图路径是前端
 * 自己拼的，网关不会替我们带。
 *
 * 只加在 `requestJson`（读）上，`mutateJson` 一律不带：share token 的授权上限就是 L2
 * 读，写面认它等于把"链接能打开"说成"链接能改"。
 */
let shareToken: string | null = readShareFromLocation();

function readShareFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash ?? '';
  const fromHash = hash.includes('?') ? new URLSearchParams(hash.slice(hash.indexOf('?') + 1)).get('share') : null;
  return fromHash ?? new URLSearchParams(window.location.search ?? '').get('share');
}

export function currentShareToken(): string | null {
  return shareToken;
}

function withShare(path: string): string {
  if (!shareToken || path.includes('share=')) return path;
  return `${path}${path.includes('?') ? '&' : '?'}share=${encodeURIComponent(shareToken)}`;
}

export async function requestJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(withShare(path), { credentials: 'same-origin', headers: { accept: 'application/json' }, signal });
  } catch {
    if (signal?.aborted) throw new ApiError('network', '请求已取消。');
    throw new ApiError('network', MESSAGES.network);
  }

  const type = response.headers.get('content-type') ?? '';
  if (!response.ok || !type.includes('application/json')) {
    // 不读 body：错误正文可能回显查询参数或内部标识，而我们只展示固定文案。
    const code = codeFor(response.status);
    throw new ApiError(code, MESSAGES[code], response.status);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError('invalid_response', MESSAGES.invalid_response, response.status);
  }
  if (!payload || typeof payload !== 'object' || (payload as { ok?: unknown }).ok !== true) {
    throw new ApiError('invalid_response', MESSAGES.invalid_response, response.status);
  }
  return payload as T;
}

/**
 * M6: 写操作（POST/DELETE/PATCH）。与 requestJson 同一套错误映射，
 * 但接受自定义 method 和 body。
 */
export async function mutateJson<T>(path: string, init: { method: string; body?: string }): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method,
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: init.body,
    });
  } catch {
    throw new ApiError('network', MESSAGES.network);
  }

  const type = response.headers.get('content-type') ?? '';
  if (!response.ok || !type.includes('application/json')) {
    const code = codeFor(response.status);
    throw new ApiError(code, MESSAGES[code], response.status);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError('invalid_response', MESSAGES.invalid_response, response.status);
  }
  return payload as T;
}

/** 401 时给用户的出口：网关登录入口只接受本站相对回跳路径。 */
export function loginHref(returnPath: string): string {
  const local = returnPath.startsWith('/') && !returnPath.startsWith('//') ? returnPath : '/';
  return `/__qoder_auth/start?return_path=${encodeURIComponent(local)}`;
}
