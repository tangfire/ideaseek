/**
 * Sites Function 部署入口。打包器把本目录压成 `runtime/app.zip`，入口必须在根，
 * 逻辑名 `app`，运行时 Deno edge。
 *
 * 两条导入面**不是一回事**，混过一次就把整包打挂（实测 boot 失败，见 SPIKE §10）：
 *
 * - `./_qoder/backend.mjs`：部署前由平台 Worker 注入，只给
 *   `createDatabaseClient` / `createSiteContext` / `errorResponse` / `BackendError`。
 *   本地**不得**创建 `_qoder/` 目录（打包器遇到它就拒绝整包），所以这条导入只在
 *   部署期解析，本地检查走 `dev/local.ts` 注入假依赖的路。
 * - `./identity.ts` → `./auth.mjs`：随包上传的普通源文件，读网关注入的
 *   `x-qoder-user-context`。平台模块里**没有** `getUser`。
 */
import { createDatabaseClient, createSiteContext, errorResponse, BackendError } from './_qoder/backend.mjs';
import { application, isContractError } from './routes.ts';
import { gatewayUser } from './identity.ts';

const handle = application({
  db: createDatabaseClient(),
  BackendError,
  getUser: gatewayUser,
  upgradeWebSocket: (request: Request) =>
    (Deno as unknown as { upgradeWebSocket(r: Request): { socket: WebSocket; response: Response } }).upgradeWebSocket(request),
});

Deno.serve(async (request: Request) => {
  let context;
  try {
    context = createSiteContext(request);
    return await handle(context);
  } catch (error) {
    // 只有契约错误带自己的 HTTP 码（415 版本不认识、413 超行上限、400 形状不合）。
    // 权限类的 BackendError 必须原样交给平台边界：把 401/403/404 统统改写成
    // `invalid_projection` 会抹掉"需要登录"和"撤销后 404"这两条判定。
    if (isContractError(error)) {
      return Response.json({ ok: false, code: 'invalid_projection', message: error.message }, { status: error.status });
    }
    return errorResponse(error, context?.requestId);
  }
});
