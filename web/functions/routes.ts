/**
 * 路由表。业务前缀之外一律 404——平台文档明确要求"未知路径不得一律返回成功"
 * （SPIKE §7），否则一个拼错的深链会被静默当成有效读数。
 *
 * 路径匹配规则照抄平台参照实现：网关把逻辑名 `app` 换成部署后的物理名
 * （`app-d<32hex>`）并保留后缀与 query，Provider 还可能先剥掉 `/functions/v1`。
 * 因此**不得假定收到的完整路径里含有 `app`**。
 */
import type { BackendErrorLike, Db } from './deps.ts';
import { rows } from './deps.ts';
import { ContractError, parseEnvelope } from './contract.ts';
import { authenticateSyncToken, assertProjectAllowed, SYNC_TOKEN_HEADER } from './token.ts';
import { ingestBatch } from './ingest.ts';
import { projectIndex, projectView, resolveViewer, approvalIndex, submitIntent, costView, egressView, tokenList, tokenCreate, tokenRevoke, syncHealth } from './views.ts';
import { authorizeLive, LIVE_LIMITS, startLivePump, wantsUpgrade } from './live.ts';
import { agentCommandHeartbeat, agentHeartbeat, agentView, commandView, enqueueCommand, projectCreateView, repoView } from './commands.ts';

export interface Deps {
  db: Db;
  BackendError: BackendErrorLike;
  getUser(ctx: SiteContext): { id: string } | null;
  upgradeWebSocket(request: Request): { socket: WebSocket; response: Response };
}

export interface SiteContext {
  request: Request;
  requestId?: string;
}

const BODY_PROBE_CAP = 32 * 1024 * 1024;

/**
 * 诊断路由的闸门。
 *
 * 站点接入模式必须是 `public`（见 SPIKE_SITES_RUNTIME.md §1）：`private` 下网关在
 * 我们的代码之前就 401（`x-qoder-error: sites_gateway_login_required`），本地引擎
 * 的 `cloud push` 与匿名浏览者都进不来。代价是 `/probe/*` 也一起对公网开放，而
 * `sleep` 最长 120 s、`ws-echo` 是公开回声——挂在共享基础设施上就是现成的滥用面。
 * 所以探针不吃网关身份，只认 Owner 自己签发的 sync token + `diagnostics` 范围，
 * 与 `/ingest` 同一主体表；没带凭据一律 401，不带任何运行时读数。
 */
const DIAGNOSTIC_SCOPE = 'diagnostics';

async function requireDiagnostic(request: Request, db: Db, BackendError: BackendErrorLike): Promise<void> {
  const principal = await authenticateSyncToken(request, db, BackendError);
  if (!principal.scopes.includes(DIAGNOSTIC_SCOPE)) throw new BackendError('no_access', 403);
}

async function readBounded(request: Request, cap: number): Promise<{ bytes: number; truncated: boolean }> {
  const reader = request.body?.getReader();
  if (!reader) return { bytes: 0, truncated: false };
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value?.byteLength ?? 0;
      if (bytes > cap) {
        await reader.cancel();
        return { bytes, truncated: true };
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { bytes, truncated: false };
}

/**
 * 只报"存在哪些平台注入的环境变量名"，永不取值、永不报长度，并且**区分两种空**：
 * 读不到（`Deno.env.toObject()` 抛）与读到了但没有 `QODER_*`。把它们混成一个空数组，
 * 等于在 M-1 的读数上再撒一次谎。
 *
 * 部署实测（§10）：`env_probe.readable=true`、`getter=true`、
 * `names=["QODER_DATABASE","QODER_STORAGE"]`，`deno_version` 报的是
 * `supabase-edge-runtime-（compatible with Deno v1.45.2）`。**env 里有名字不等于
 * 可以拿名字去取值**：这里只出示名单，Secret 的值仍然只在平台注入侧，M2 要用哪一个
 * 之前先按"能读到"与"读到的是谁的"分开验收，别按上一版"env 完全不可用"的读数做设计。
 */
function envProbe(): { readable: boolean; getter: boolean; names: string[] } {
  const denied = { readable: false, getter: false, names: [] as string[] };
  try {
    const deno = Deno as unknown as { env?: { toObject?(): Record<string, string>; get?(key: string): string | undefined } };
    const all = deno.env?.toObject?.();
    if (!all) return denied;
    return {
      readable: true,
      // Secret 注入面只报"有没有按名读取的能力"，值一律不外传。
      getter: typeof deno.env?.get === 'function',
      names: Object.keys(all)
        .filter((name) => name.startsWith('QODER_') || name === 'DENO_REGION')
        .sort(),
    };
  } catch {
    return denied;
  }
}

export function application(deps: Deps) {
  const { db, BackendError, getUser } = deps;

  const route = async (ctx: SiteContext): Promise<Response> => {
    const request = ctx.request;
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/(?:functions\/v1\/)?(?:app|app-d[0-9a-f]{32})(\/.*)?$/);
    if (!match) throw new BackendError('not_found', 404);
    const path = match[1] ?? '/';

    if (path === '/probe/ingress' && request.method === 'GET') {
      // 唯一一条不鉴权的探针，因为它要回答的问题是"凭据到底有没有走到这里"：
      // 站点转公开后 `/probe/health` 带着正确 token 仍回 `login_required`，而库里的
      // token 行、哈希、吊销状态都核对过——剩下一种解释是网关改了转发头。
      // 只报布尔与头**名**，永不回显任何值；这条读数决定 M2 的 push 通道形状。
      const names = [...new Set([...request.headers.keys()])].sort();
      return Response.json({
        ok: true,
        authorization: request.headers.has('authorization'),
        // 部署态真正该到的那一个（§10：网关剥 Authorization，自定义头原样到达）。
        sync_header: request.headers.has(SYNC_TOKEN_HEADER),
        user_context: request.headers.has('x-qoder-user-context'),
        header_count: names.length,
        header_names: names,
      });
    }

    if (path === '/probe/health' && request.method === 'GET') {
      await requireDiagnostic(request, db, BackendError);
      return Response.json({
        ok: true,
        runtime: 'deno',
        deno_version: (Deno as unknown as { version?: Record<string, string> }).version ?? null,
        has_fetch: typeof fetch === 'function',
        has_crypto_subtle: typeof crypto?.subtle?.digest === 'function',
        has_random_uuid: typeof crypto?.randomUUID === 'function',
        has_upgrade_websocket: typeof deps.upgradeWebSocket === 'function',
        env_probe: envProbe(),
        now: new Date().toISOString(),
      });
    }

    if (path === '/probe/sleep' && request.method === 'GET') {
      await requireDiagnostic(request, db, BackendError);
      const ms = Math.min(Number(url.searchParams.get('ms') ?? '1000'), 120_000);
      const started = Date.now();
      await new Promise((resolve) => setTimeout(resolve, ms));
      return Response.json({ ok: true, requested_ms: ms, elapsed_ms: Date.now() - started });
    }

    if (path === '/probe/body' && request.method === 'POST') {
      await requireDiagnostic(request, db, BackendError);
      // 找的是**平台**的请求体上限，所以这里自己不放小闸口；超上限时
      // 网关会先返回 413，读不到 body 也算一次有效观测。
      const { bytes, truncated } = await readBounded(request, BODY_PROBE_CAP);
      return Response.json({ ok: true, received_bytes: bytes, aborted_at_cap: truncated });
    }

    if (path === '/probe/db' && request.method === 'GET') {
      await requireDiagnostic(request, db, BackendError);
      const tables = ['cloud_project', 'cloud_run', 'cloud_run_event', 'cloud_sync_batch', 'live_outbox'];
      const counts: Record<string, number | string> = {};
      for (const table of tables) {
        try {
          counts[table] = rows(await db.from(table).select('id').limit(500), BackendError).length;
        } catch (error) {
          counts[table] = `error:${(error as { code?: string }).code ?? 'unknown'}`;
        }
      }
      return Response.json({ ok: true, counts });
    }

    if (path === '/ingest' && request.method === 'POST') {
      const principal = await authenticateSyncToken(request, db, BackendError);
      const raw = await request.json().catch(() => {
        throw new BackendError('invalid_input', 400);
      });
      const batch = parseEnvelope(raw);
      return ingestBatch(db, principal, batch, assertProjectAllowed, BackendError);
    }

    if (path === '/views/index' && request.method === 'GET') {
      const viewer = await resolveViewer(request, db, getUser(ctx), BackendError);
      return projectIndex(db, viewer, BackendError);
    }

    if (path === '/views/project' && request.method === 'GET') {
      const externalId = url.searchParams.get('external_id') ?? '';
      if (!externalId) throw new BackendError('invalid_input', 400);
      const viewer = await resolveViewer(request, db, getUser(ctx), BackendError);
      return projectView(db, viewer, externalId, BackendError);
    }

    // M6: 审批信箱（F11）
    if (path === '/views/approvals' && request.method === 'GET') {
      const viewer = await resolveViewer(request, db, getUser(ctx), BackendError);
      return approvalIndex(db, viewer, BackendError);
    }

    // M6: 提交审批意向（F11.3）
    const intentMatch = path.match(/^\/approvals\/([^/]+)\/intent$/);
    if (intentMatch && request.method === 'POST') {
      const viewer = await resolveViewer(request, db, getUser(ctx), BackendError);
      const body = await request.json().catch(() => {
        throw new BackendError('invalid_input', 400);
      }) as { choice?: string; note?: string };
      if (!body.choice || typeof body.choice !== 'string') throw new BackendError('invalid_input', 400);
      return submitIntent(db, viewer, intentMatch[1]!, body.choice, body.note ?? null, BackendError);
    }

    // M6: 成本与额度（F12）
    if (path === '/views/costs' && request.method === 'GET') {
      const externalId = url.searchParams.get('external_id') ?? '';
      if (!externalId) throw new BackendError('invalid_input', 400);
      const viewer = await resolveViewer(request, db, getUser(ctx), BackendError);
      return costView(db, viewer, externalId, BackendError);
    }

    // M6: 外发台账（F13）
    if (path === '/views/egress' && request.method === 'GET') {
      const externalId = url.searchParams.get('external_id') ?? '';
      if (!externalId) throw new BackendError('invalid_input', 400);
      const viewer = await resolveViewer(request, db, getUser(ctx), BackendError);
      return egressView(db, viewer, externalId, BackendError);
    }

    // M6: Token 管理（F16）
    if (path === '/views/tokens' && request.method === 'GET') {
      const viewer = await resolveViewer(request, db, getUser(ctx), BackendError);
      return tokenList(db, viewer, BackendError);
    }

    if (path === '/views/tokens' && request.method === 'POST') {
      const viewer = await resolveViewer(request, db, getUser(ctx), BackendError);
      const body = await request.json().catch(() => {
        throw new BackendError('invalid_input', 400);
      }) as { label?: string; scopes?: string[]; project_scope?: string[] };
      if (!body.scopes || !Array.isArray(body.scopes)) throw new BackendError('invalid_input', 400);
      return tokenCreate(db, viewer, body.label ?? null, body.scopes, body.project_scope ?? [], BackendError);
    }

    const tokenRevokeMatch = path.match(/^\/views\/tokens\/([^/]+)$/);
    if (tokenRevokeMatch && request.method === 'DELETE') {
      const viewer = await resolveViewer(request, db, getUser(ctx), BackendError);
      return tokenRevoke(db, viewer, tokenRevokeMatch[1]!, BackendError);
    }

    // M6: 同步健康自检（F16.2）
    if (path === '/views/health' && request.method === 'GET') {
      const externalId = url.searchParams.get('external_id') ?? '';
      if (!externalId) throw new BackendError('invalid_input', 400);
      const viewer = await resolveViewer(request, db, getUser(ctx), BackendError);
      return syncHealth(db, viewer, externalId, BackendError);
    }

    if (path === '/live') {
      const externalId = url.searchParams.get('project') ?? '';
      if (!externalId) throw new BackendError('invalid_input', 400);
      const viewer = await resolveViewer(request, db, getUser(ctx), BackendError);
      const project = await authorizeLive(db, viewer, externalId, BackendError);
      const since = Number(url.searchParams.get('since') ?? '0');

      if (request.method === 'GET' && !wantsUpgrade(request)) {
        // 兜底分支（S6 不通时走这条）：无变更返回 304，帧语义与 WS 完全一致。
        const frames = rows<{ seq: number; frame_type: string; payload: unknown }>(
          await db
            .from<{ seq: number; frame_type: string; payload: unknown }>('live_outbox')
            .select('seq,frame_type,payload')
            .eq('project_id', project.id)
            .gte('seq', since + 1)
            .order('seq', { ascending: true })
            .limit(50),
          BackendError,
        );
        if (frames.length === 0) return new Response(null, { status: 304 });
        return Response.json({
          ok: true,
          frames: frames.map((frame) => ({ type: frame.frame_type, project_id: project.id, seq: frame.seq, ...(frame.payload as object) })),
        });
      }

      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') throw new BackendError('invalid_input', 400);
      const { socket, response } = deps.upgradeWebSocket(request);
      socket.addEventListener('open', () => {
        const stop = startLivePump(socket, db, project, since, BackendError);
        socket.addEventListener('close', stop, { once: true });
      });
      socket.addEventListener('message', (event) => {
        // 客户端只能发 ping；任何别的帧都丢掉而不是回显——回声只在 /probe/ws-echo 上开。
        if (typeof event.data === 'string' && event.data === 'ping') socket.send('{"type":"pong"}');
        else socket.send('{"type":"ignored"}');
      });
      return response;
    }

    if (path === '/probe/ws-echo') {
      // 诊断专用：只认 sync token（终端客户端能带 Authorization，浏览器 WS 不能），
      // 无私有数据、限 4 KiB/帧。它验证的是传输本身，不代表 /live 的授权路径已验收。
      await requireDiagnostic(request, db, BackendError);
      const { socket, response } = deps.upgradeWebSocket(request);
      socket.addEventListener('message', (event) => {
        const size = typeof event.data === 'string' ? new TextEncoder().encode(event.data).byteLength : (event.data as ArrayBuffer).byteLength;
        if (size > LIVE_LIMITS.MAX_MESSAGE_BYTES) {
          socket.close(1009, 'message_too_large');
          return;
        }
        socket.send(event.data as string | ArrayBuffer);
      });
      setTimeout(() => {
        if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'lifetime');
      }, LIVE_LIMITS.LIFETIME_MS);
      return response;
    }

    // Phase 2/4: 本地 Agent 心跳——回写结果、上报仓库/文件读数、领走待执行命令。
    // 只认 sync token + `commands` 范围：这是机器对机器的通道，浏览者身份不该能领命令。
    if (path === '/agent/heartbeat' && request.method === 'POST') {
      const principal = await authenticateSyncToken(request, db, BackendError);
      const body = await request.json().catch(() => {
        throw new BackendError('invalid_input', 400);
      });
      return agentHeartbeat(db, principal, body as object, BackendError);
    }

    if (path === '/agent/command' && request.method === 'POST') {
      const principal = await authenticateSyncToken(request, db, BackendError);
      const body = await request.json().catch(() => {
        throw new BackendError('invalid_input', 400);
      });
      return agentCommandHeartbeat(db, principal, body as { command_id?: unknown; status?: unknown }, BackendError);
    }

    // Phase 3/4: 命令排队（Owner-only，见 commands.ts 头注第 2/3 条）。
    const commandMatch = path.match(/^\/commands\/([a-z_]+)$/);
    if (commandMatch && request.method === 'POST') {
      const viewer = await resolveViewer(request, db, getUser(ctx), BackendError);
      const body = await request.json().catch(() => {
        throw new BackendError('invalid_input', 400);
      });
      return enqueueCommand(db, viewer, commandMatch[1]!, body as Record<string, unknown>, BackendError);
    }

    // 创建项目同样是排队：云端不建项目行，只把 `ideaseek start` 交给本机 Agent，
    // 项目行由本地投影写回来（投影表不由浏览器写）。
    if (path === '/projects' && request.method === 'POST') {
      const viewer = await resolveViewer(request, db, getUser(ctx), BackendError);
      const body = await request.json().catch(() => {
        throw new BackendError('invalid_input', 400);
      });
      return projectCreateView(db, viewer, body as Record<string, unknown>, BackendError);
    }

    if (path === '/views/commands' && request.method === 'GET') {
      const externalId = url.searchParams.get('external_id') ?? '';
      if (!externalId) throw new BackendError('invalid_input', 400);
      const viewer = await resolveViewer(request, db, getUser(ctx), BackendError);
      return commandView(db, viewer, externalId, BackendError);
    }

    if (path === '/views/agent' && request.method === 'GET') {
      const externalId = url.searchParams.get('external_id') ?? '';
      if (!externalId) throw new BackendError('invalid_input', 400);
      const viewer = await resolveViewer(request, db, getUser(ctx), BackendError);
      return agentView(db, viewer, externalId, BackendError);
    }

    if (path === '/views/repo' && request.method === 'GET') {
      const externalId = url.searchParams.get('external_id') ?? '';
      if (!externalId) throw new BackendError('invalid_input', 400);
      const viewer = await resolveViewer(request, db, getUser(ctx), BackendError);
      return repoView(db, viewer, externalId, BackendError);
    }

    throw new BackendError('not_found', 404);
  };

  return async (ctx: SiteContext): Promise<Response> => {
    const response = await route(ctx);
    // 101 是 WS 握手的响应本身，重新包一层就把升级弄断了。
    if (response.status === 101) return response;
    // 每条业务读数都随身份而变：网关或浏览器只要缓存了 Owner 的那一份，下一个
    // 访客拿到的就是别人的可见性判定。身份端点参照实现写的也是同一句 no-store。
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'private, no-store');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}

/** 契约错误映射成它的 HTTP 码，其余交给平台的 errorResponse 边界。 */
export function isContractError(error: unknown): error is ContractError {
  return error instanceof ContractError;
}
