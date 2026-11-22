/**
 * 网关身份的读取面——**部署态实测纠正过的一条**。
 *
 * `getUser` / `requireUser` 不在平台注入的 `_qoder/backend.mjs` 里。那份模块只给
 * `createDatabaseClient` / `createSiteContext` / `errorResponse` / `BackendError`
 * （实测 boot 失败：`does not provide an export named 'getUser'`；安装目录的
 * `function-backend/index.ts` 导入行与此一致）。身份来自**随包上传**的
 * `auth.mjs`——Sites 文档 `assets/user-context/auth.mjs` 的逐字节副本，读的是
 * Upgraded Gateway 验签后注入、浏览器伪造不了的 `x-qoder-user-context`。
 * 副本的 sha256 记在 SPIKE_SITES_RUNTIME.md §10，改动只能靠重新复制，不能手改。
 *
 * 这里只做一件事：把平台的 `user_id` 换成本仓库统一的 `id`，字段名不进路由层。
 * 判定"谁能看什么"仍然只在 views.ts。
 */
import { getUser } from './auth.mjs';

export interface ViewerIdentity {
  id: string;
}

export interface IdentityContext {
  request: Request;
}

/** 未登录返回 `null`（公开站点上的匿名访客）；伪造/过期的上下文抛 `invalid_user_context` 403。 */
export function gatewayUser(ctx: IdentityContext): ViewerIdentity | null {
  const user = getUser(ctx.request);
  return user ? { id: user.user_id } : null;
}
