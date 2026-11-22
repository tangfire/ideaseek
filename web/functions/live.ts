/**
 * 实时帧通道（S6）。
 *
 * 传输是 `Deno.upgradeWebSocket`，就在同一个 `app` Function 里——平台文档明确
 * "Upgrade 是一个由 Function 处理的 HTTP 请求，不是启动常驻服务"。
 * 浏览器 WS 带不了自定义 Authorization 头，所以身份只有同域登录态这一条路；
 * 权限判定复用 views.ts 的 `canRead`，握手前完成，不在帧里再判。
 *
 * 帧来自 `live_outbox`：WS 层不直读 cloud_*（F17.3），否则每次 push 的读次数
 * 会随连接数增长，而且会长出第二套视图。
 */
import type { BackendErrorLike, Db } from './deps.ts';
import { rows } from './deps.ts';
import type { Viewer } from './views.ts';
import { canRead, deniesAsAbsent } from './views.ts';

/** 参照实现的边界，不是平台配额（SPIKE §6）：数值本身等 M-4 实测。 */
const MAX_MESSAGE_BYTES = 4 * 1024;
const MAX_BUFFERED_BYTES = 512 * 1024;
const LIFETIME_MS = 55_000;
const IDLE_POLL_MS = 2_000;

export interface LiveProjectRow {
  id: string;
  owner_id: string;
  visibility: string;
  archived_at: string | null;
}

/** 握手前把权限、项目存在性都定下来；此后连接存续期间不再改变判定输入。 */
export async function authorizeLive(
  db: Db,
  viewer: Viewer,
  externalId: string,
  BackendError: BackendErrorLike,
): Promise<LiveProjectRow> {
  const found = rows<LiveProjectRow>(
    await db.from<LiveProjectRow>('cloud_project').select('id,owner_id,visibility,archived_at').eq('external_id', externalId).limit(1),
    BackendError,
  );
  const project = found[0];
  if (!project || project.archived_at) throw new BackendError('not_found', 404);
  // 与 projectView 同一条判定：匿名被拒等于该项目对他不存在（WS-07/08）。
  if (!canRead(viewer, project as never)) {
    const absent = deniesAsAbsent(viewer);
    throw new BackendError(absent ? 'not_found' : 'no_access', absent ? 404 : 403);
  }
  return project;
}

/**
 * 帧泵：读 outbox 中 seq 大于游标的行并下发。消费后即删留给 M2 的清理任务——
 * M1 先保留历史，因为断点续传（WS-04）要靠 seq 单调性判断缺口。
 */
export function startLivePump(
  socket: WebSocket,
  db: Db,
  project: LiveProjectRow,
  since: number,
  BackendError: BackendErrorLike,
): () => void {
  let cursor = since;
  let stopped = false;

  const tick = async () => {
    if (stopped || socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      // 客户端跟不上就先停这条连接，而不是无界缓冲把实例内存吃掉。
      socket.close(1013, 'backpressure');
      return;
    }
    try {
      const frames = rows<{ seq: number; frame_type: string; payload: unknown }>(
        await db
          .from<{ seq: number; frame_type: string; payload: unknown }>('live_outbox')
          .select('seq,frame_type,payload')
          .eq('project_id', project.id)
          .gte('seq', cursor + 1)
          .order('seq', { ascending: true })
          .limit(50),
        BackendError,
      );
      for (const frame of frames) {
        cursor = frame.seq;
        socket.send(JSON.stringify({ type: frame.frame_type, project_id: project.id, seq: frame.seq, ...(frame.payload as object) }));
      }
    } catch {
      socket.close(1011, 'dependency_error');
    }
  };

  const timer = setInterval(() => void tick(), IDLE_POLL_MS);
  void tick();
  const lifetime = setTimeout(() => {
    // 有上限的寿命是文档建议做法：让客户端重连时重新过一次权限判定，
    // 撤销不会因一条长连接而悬空（WS-06）。
    socket.close(1000, 'lifetime');
  }, LIFETIME_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(lifetime);
  };
}

export interface UpgradeResult {
  response: Response;
}

/** 只有 `?action=live` 才升级；其余 /live 请求走轮询兜底（返回 frames）。 */
export function wantsUpgrade(request: Request): boolean {
  const url = new URL(request.url);
  return url.searchParams.get('action') === 'live' && (url.searchParams.get('upgrade') ?? 'websocket') === 'websocket';
}

export function upgrade(request: Request): UpgradeResult {
  const { socket, response } = (Deno as unknown as {
    upgradeWebSocket(input: Request): { socket: WebSocket; response: Response };
  }).upgradeWebSocket(request);
  return { response };
}

export const LIVE_LIMITS = { MAX_MESSAGE_BYTES, MAX_BUFFERED_BYTES, LIFETIME_MS, IDLE_POLL_MS };
