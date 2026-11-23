import type { LiveFrame } from './types';

/**
 * 实时通道：优先 WebSocket，连不上就按 REQUIREMENTS 的兜底走 15 s 短轮询，
 * 并把**当前实际使用的传输**回报给界面——页面不许在轮询时说自己是实时。
 *
 * WS 不带自定义 Authorization 头（浏览器做不到），身份仍是同域登录态。
 * 服务端 4408/4401 关闭码分别表示"权限已撤销"和"未登录"，两者都不重连到
 * 业务帧上：前者要停止展示，后者要重新登录。
 *
 * F17.5: 指数退避重连 1→30s 封顶 + 抖动；重连成功后必须先 REST 全量再收增量。
 * F17.6: 后台标签页停推——visibilitychange=hidden 主动关连接，回前台重连补帧。
 */
export type Transport = 'connecting' | 'websocket' | 'polling' | 'closed';

export interface LiveHandle {
  close(): void;
}

export interface LiveOptions {
  projectId: string;
  /** 断点续传游标：只请求比它更新的帧（WS-04）。 */
  since?: number;
  onFrame(frame: LiveFrame, transport: 'websocket' | 'polling'): void;
  onTransport(transport: Transport): void;
  onError?(reason: string): void;
  pollIntervalMs?: number;
  /** F17.5: 重连退避基数（毫秒），默认 1000。 */
  reconnectBaseMs?: number;
  /** F17.5: 重连退避封顶（毫秒），默认 30000。 */
  reconnectCapMs?: number;
}

export function openLive(options: LiveOptions): LiveHandle {
  const url = new URL('/functions/v1/app/live', location.href);
  url.searchParams.set('action', 'live');
  url.searchParams.set('project', options.projectId);
  const wsUrl = url.toString().replace(/^http/, 'ws');
  let seq = options.since ?? 0;
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let transport: Transport = 'connecting';
  let reconnectAttempts = 0;
  let wasConnected = false; // 标记是否曾经成功连接过（用于 F17.5 重连后补全量）

  const setTransport = (next: Transport) => {
    if (transport === next || closed) return;
    transport = next;
    options.onTransport(next);
  };

  const clearReconnectTimer = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  /**
   * F17.5: 计算重连延迟——指数退避 + 抖动。
   * delay = min(base * 2^attempts, cap) + random(0, base)
   */
  const computeReconnectDelay = (): number => {
    const base = options.reconnectBaseMs ?? 1000;
    const cap = options.reconnectCapMs ?? 30000;
    const exponential = Math.min(base * Math.pow(2, reconnectAttempts), cap);
    const jitter = Math.random() * base;
    return exponential + jitter;
  };

  /**
   * F17.5: 重连成功后先 REST 全量再收增量。
   * 调用 /live?since=0 获取完整帧列表，然后更新 seq 游标。
   */
  const fetchFullSnapshot = async (): Promise<void> => {
    try {
      const poll = new URL('/functions/v1/app/live', location.href);
      poll.searchParams.set('project', options.projectId);
      poll.searchParams.set('since', '0'); // 从头开始
      const response = await fetch(poll.toString(), {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) return;
      const body = (await response.json()) as { frames?: LiveFrame[] };
      for (const frame of body.frames ?? []) {
        if ('seq' in frame && frame.seq > seq) seq = frame.seq;
        options.onFrame(frame, 'websocket');
      }
    } catch {
      // 全量获取失败不阻塞后续增量推送
    }
  };

  const startPolling = (reason: string) => {
    if (closed || transport === 'polling') return;
    options.onError?.(reason);
    if (ws) {
      const dying = ws;
      ws = null;
      dying.onclose = null;
      dying.close();
    }
    setTransport('polling');
    const tick = async () => {
      if (closed) return;
      try {
        const poll = new URL('/functions/v1/app/live', location.href);
        poll.searchParams.set('project', options.projectId);
        poll.searchParams.set('since', String(seq));
        const response = await fetch(poll.toString(), {
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        });
        if (response.status === 304) return;
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as { frames?: LiveFrame[] };
        for (const frame of body.frames ?? []) {
          if ('seq' in frame && frame.seq > seq) seq = frame.seq;
          options.onFrame(frame, 'polling');
        }
      } catch {
        // 轮询失败不改传输状态：下一拍继续，界面保留最后一次已知投影。
      }
    };
    void tick();
    const schedule = () => {
      if (closed) return;
      timer = setTimeout(async () => {
        await tick();
        schedule();
      }, options.pollIntervalMs ?? 15_000);
    };
    schedule();
  };

  const connectWebSocket = () => {
    if (closed) return;
    clearReconnectTimer();
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      startPolling('浏览器未能发起 WebSocket 连接');
      return;
    }

    ws.onopen = () => {
      setTransport('websocket');
      reconnectAttempts = 0; // 重置重连计数
      // F17.5: 重连成功后先补全量（只有曾经连接过才需要）
      if (wasConnected) {
        void fetchFullSnapshot().then(() => {
          wasConnected = true;
        });
      } else {
        wasConnected = true;
      }
    };
    ws.onmessage = (event: MessageEvent<string>) => {
      let frame: LiveFrame;
      try {
        frame = JSON.parse(event.data) as LiveFrame;
      } catch {
        return;
      }
      if ('seq' in frame && frame.seq > seq) seq = frame.seq;
      options.onFrame(frame, 'websocket');
    };
    ws.onerror = () => {
      // 不立即降级到轮询，先尝试重连（F17.5）
      scheduleReconnect('WebSocket 传输错误');
    };
    ws.onclose = (event: CloseEvent) => {
      if (closed) return;
      if (event.code === 4401) {
        setTransport('closed');
        options.onError?.('未登录或登录态失效');
        return;
      }
      if (event.code === 4408) {
        setTransport('closed');
        options.onError?.('读取权限已被撤销');
        return;
      }
      // 非永久错误，尝试重连（F17.5）
      scheduleReconnect('WebSocket 连接关闭，尝试重连');
    };
  };

  const scheduleReconnect = (reason: string) => {
    if (closed) return;
    clearReconnectTimer();
    if (ws) {
      const dying = ws;
      ws = null;
      dying.onclose = null;
      dying.close();
    }
    // 超过 5 次重连失败后降级到轮询
    if (reconnectAttempts >= 5) {
      startPolling(reason + '（重连次数过多，降级为轮询）');
      return;
    }
    reconnectAttempts++;
    const delay = computeReconnectDelay();
    reconnectTimer = setTimeout(() => {
      connectWebSocket();
    }, delay);
  };

  // F17.6: 后台标签页停推——visibilitychange=hidden 主动关连接
  const handleVisibilityChange = () => {
    if (document.hidden) {
      // 进入后台：关闭连接，停止轮询
      if (ws) {
        const dying = ws;
        ws = null;
        dying.onclose = null;
        dying.close(1000);
      }
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      clearReconnectTimer();
      setTransport('closed');
    } else {
      // 回到前台：重新连接
      if (!closed && transport === 'closed') {
        connectWebSocket();
      }
    }
  };

  document.addEventListener('visibilitychange', handleVisibilityChange);

  // 初始连接
  connectWebSocket();

  function shutdown(): void {
    closed = true;
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    if (timer) clearTimeout(timer);
    clearReconnectTimer();
    if (ws) {
      ws.onclose = null;
      ws.close(1000);
    }
  }

  return { close: shutdown };
}
