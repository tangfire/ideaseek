import type { LiveFrame } from './types';

/**
 * 实时通道：优先 WebSocket，连不上就按 REQUIREMENTS 的兜底走 15 s 短轮询，
 * 并把**当前实际使用的传输**回报给界面——页面不许在轮询时说自己是实时。
 *
 * WS 不带自定义 Authorization 头（浏览器做不到），身份仍是同域登录态。
 * 服务端 4408/4401 关闭码分别表示"权限已撤销"和"未登录"，两者都不重连到
 * 业务帧上：前者要停止展示，后者要重新登录。
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
}

export function openLive(options: LiveOptions): LiveHandle {
  const url = new URL('/functions/v1/app/live', location.href);
  url.searchParams.set('action', 'live');
  url.searchParams.set('project', options.projectId);
  const wsUrl = url.toString().replace(/^http/, 'ws');
  let seq = options.since ?? 0;
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let transport: Transport = 'connecting';

  const setTransport = (next: Transport) => {
    if (transport === next || closed) return;
    transport = next;
    options.onTransport(next);
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

  try {
    ws = new WebSocket(wsUrl);
  } catch {
    startPolling('浏览器未能发起 WebSocket 连接');
    return { close: shutdown };
  }

  ws.onopen = () => setTransport('websocket');
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
  ws.onerror = () => startPolling('WebSocket 传输错误');
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
    startPolling('WebSocket 未建立握手，已降级为 15 s 轮询');
  };

  function shutdown(): void {
    closed = true;
    if (timer) clearTimeout(timer);
    if (ws) {
      ws.onclose = null;
      ws.close(1000);
    }
  }

  return { close: shutdown };
}
