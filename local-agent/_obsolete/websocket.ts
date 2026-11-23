/**
 * Local Agent WebSocket 客户端
 * 连接云端，接收命令，回传结果
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';

export interface AgentConfig {
  wsUrl: string;
  token: string;
  projectId: string;
  heartbeatInterval?: number;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

export interface CloudCommand {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface CommandResult {
  commandId: string;
  success: boolean;
  output?: string;
  error?: string;
  timestamp: string;
}

type AgentEvents = {
  connected: [];
  disconnected: [reason: string];
  command: [command: CloudCommand];
  error: [error: Error];
};

export class AgentWebSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: AgentConfig;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private isConnected = false;

  constructor(config: AgentConfig) {
    super();
    this.config = {
      heartbeatInterval: 30_000,
      reconnectInterval: 5_000,
      maxReconnectAttempts: 10,
      ...config,
    };
  }

  connect(): void {
    if (this.ws) {
      this.ws.close();
    }

    const url = new URL(this.config.wsUrl);
    url.searchParams.set('token', this.config.token);
    url.searchParams.set('projectId', this.config.projectId);

    this.ws = new WebSocket(url.toString());

    this.ws.on('open', () => {
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.emit('connected');
      this.startHeartbeat();
    });

    this.ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'command') {
          this.emit('command', message.payload as CloudCommand);
        } else if (message.type === 'ping') {
          this.send({ type: 'pong' });
        }
      } catch (err) {
        this.emit('error', new Error(`消息解析失败：${err}`));
      }
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.isConnected = false;
      this.stopHeartbeat();
      this.emit('disconnected', reason.toString());
      this.attemptReconnect();
    });

    this.ws.on('error', (err: Error) => {
      this.emit('error', err);
    });
  }

  disconnect(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
  }

  send(data: unknown): void {
    if (this.ws && this.isConnected) {
      this.ws.send(JSON.stringify(data));
    }
  }

  sendResult(result: CommandResult): void {
    this.send({ type: 'result', payload: result });
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'ping' });
    }, this.config.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts!) {
      console.error(`达到最大重连次数 (${this.config.maxReconnectAttempts})，停止重连`);
      return;
    }

    this.reconnectAttempts++;
    console.log(`尝试重连 (${this.reconnectAttempts}/${this.config.maxReconnectAttempts})...`);

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.config.reconnectInterval);
  }

  get connected(): boolean {
    return this.isConnected;
  }
}
