/**
 * 写入侧的机器凭据。
 *
 * 浏览者走网关注入的 user context；**本地投影器不走那条路**——它是机器对机器的
 * 投递，凭的是 `cloud_sync_token.token_hash`（SPIKE_SITES_RUNTIME.md §5 的主体表）。
 * 库里只存哈希：明文 token 入库等于把吊销能力变成摆设（NFR-02）。
 *
 * 载体是 **`x-ideaseek-token`**，不是 `Authorization`：部署实测（§10）显示 Sites 网关
 * 会把 `Authorization` 与 `Cookie` 一起剥掉（`x-qoder-*` 同样进不来），而自定义头
 * 原样到达 Function。Bearer 那条继续留着，因为 Provider 直连与本地入口能带它，
 * 但它在这条链路上必然失败——M-5 的反绕过验收会用到这个差别。
 *
 * 比对用 `crypto.subtle.digest` + 定长十六进制，不做"前缀相等就通过"的比较：
 * 命中即返回，未命中一律同一个错误，不透露"这个哈希存在但已吊销"。
 */
import type { BackendErrorLike, Db } from './deps.ts';

export interface SyncPrincipal {
  tokenId: string;
  ownerId: string;
  scopes: string[];
  projectScope: string[];
}

/** 部署态唯一可用的凭据头；值不入库、不进日志、不进错误。 */
export const SYNC_TOKEN_HEADER = 'x-ideaseek-token';

function bearerOf(header: string): string {
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function authenticateSyncToken(
  request: Request,
  db: Db,
  BackendError: BackendErrorLike,
): Promise<SyncPrincipal> {
  const token = request.headers.get(SYNC_TOKEN_HEADER) ?? bearerOf(request.headers.get('authorization') ?? '');
  if (token.length < 32) throw new BackendError('login_required', 401);

  const found = await db
    .from('cloud_sync_token')
    .select('id,owner_id,scopes,project_scope,revoked_at')
    .eq('token_hash', await sha256Hex(token))
    .limit(1);
  if (found.error) throw new BackendError(found.error.code ?? 'service_unavailable', found.error.status ?? 503);

  const row = found.data?.[0] as
    | { id: string; owner_id: string; scopes: unknown; project_scope: unknown; revoked_at: string | null }
    | undefined;
  if (!row || row.revoked_at) throw new BackendError('login_required', 401);

  return {
    tokenId: row.id,
    ownerId: row.owner_id,
    scopes: Array.isArray(row.scopes) ? (row.scopes as string[]) : [],
    projectScope: Array.isArray(row.project_scope) ? (row.project_scope as string[]) : [],
  };
}

/** 空 `project_scope` = 全部项目；否则只能投给它登记过的那几个。 */
export function assertProjectAllowed(principal: SyncPrincipal, externalId: string, BackendError: BackendErrorLike): void {
  if (principal.projectScope.length === 0) return;
  if (!principal.projectScope.includes(externalId)) throw new BackendError('no_access', 403);
}

/** 只在本地算哈希，永不落盘、永不回显——错误里也不能带。 */
export function tokenFingerprint(token: string): string {
  return token.slice(0, 4) + '…';
}
