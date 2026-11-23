/**
 * 状态同步器
 * 读取本地 SQLite 状态，同步到云端
 */

import { EventEmitter } from 'events';
import { AgentWebSocket } from './websocket';
import fs from 'fs/promises';
import path from 'path';

export interface SyncConfig {
  projectDir: string;
  syncInterval?: number;
}

export interface ProjectStatus {
  projectId: string;
  runId?: string;
  phase: string;
  status: string;
  lastSyncAt: string;
  unsyncedEvents: number;
}

type SyncEvents = {
  synced: [status: ProjectStatus];
  error: [error: Error];
};

export class StatusSyncer extends EventEmitter {
  private config: SyncConfig;
  private ws: AgentWebSocket;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private lastSyncCursor = 0;

  constructor(config: SyncConfig, ws: AgentWebSocket) {
    super();
    this.config = {
      syncInterval: 10_000, // 10 秒同步一次
      ...config,
    };
    this.ws = ws;
  }

  /**
   * 开始定期同步
   */
  start(): void {
    this.syncTimer = setInterval(() => {
      this.sync().catch((err) => {
        this.emit('error', err);
      });
    }, this.config.syncInterval);

    // 立即执行一次同步
    this.sync().catch((err) => {
      this.emit('error', err);
    });
  }

  /**
   * 停止同步
   */
  stop(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  /**
   * 执行一次同步
   */
  async sync(): Promise<ProjectStatus> {
    const status = await this.readLocalStatus();

    // 发送状态到云端
    this.ws.send({
      type: 'status',
      payload: status,
    });

    this.emit('synced', status);
    return status;
  }

  /**
   * 读取本地项目状态
   */
  private async readLocalStatus(): Promise<ProjectStatus> {
    const projectDir = this.config.projectDir;
    const researchDir = path.join(projectDir, '.research');

    try {
      // 读取 research.yaml 获取项目信息
      const researchYaml = await fs.readFile(
        path.join(researchDir, 'research.yaml'),
        'utf-8'
      );

      // 简单解析 YAML（实际应使用 yaml 库）
      const projectId = this.extractYamlValue(researchYaml, 'project_id') || 'unknown';
      const runId = this.extractYamlValue(researchYaml, 'current_run_id');

      // 读取 SQLite 获取运行状态
      // 这里简化处理，实际应查询数据库
      const status: ProjectStatus = {
        projectId,
        runId,
        phase: 'INIT',
        status: 'IDLE',
        lastSyncAt: new Date().toISOString(),
        unsyncedEvents: 0,
      };

      return status;
    } catch (err) {
      // 项目目录不存在或文件缺失
      return {
        projectId: 'unknown',
        phase: 'INIT',
        status: 'NOT_INITIALIZED',
        lastSyncAt: new Date().toISOString(),
        unsyncedEvents: 0,
      };
    }
  }

  /**
   * 简单 YAML 值提取（临时方案）
   */
  private extractYamlValue(yaml: string, key: string): string | null {
    const regex = new RegExp(`${key}:\\s*(.+)`, 'i');
    const match = yaml.match(regex);
    return match ? match[1].trim() : null;
  }

  /**
   * 获取未同步事件数量
   */
  async getUnsyncedEventCount(): Promise<number> {
    // 实际应查询 SQLite 中 seq > lastSyncCursor 的事件数
    return 0;
  }
}
