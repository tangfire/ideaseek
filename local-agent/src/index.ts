/**
 * Local Agent 主循环：HTTP 轮询领取命令、回写终态、上报仓库/文件读数。
 *
 * 时序约束都来自协议本身，不是本地偏好：
 * - 一条领取到的命令只下发一次；`lease_ms` 内没有终态回写就被云端标 expired 且**不重投**，
 *   所以结果先进内存缓冲，心跳失败时留待下一轮，进程内绝不丢。
 * - 命令串行执行：同一个项目上并发两个 `ideaseek run` 会抢同一把项目锁
 *   （`src/runtime/project-lock.ts`），后一个直接失败。
 * - 心跳间隔必须远小于云端的在线窗口（90 s），否则界面一直显示离线。
 */
import { resolve } from 'node:path';
import { CLIExecutor } from './executor.js';
import { CommandRouter } from './router.js';
import { CloudTransport, ResultBuffer, TransportError } from './transport.js';
import { discoverProjects } from './registry.js';
import { readGitReport } from './gitstate.js';
import { ManifestCache } from './manifest.js';
import {
  AGENT_VERSION,
  MAX_LOCAL_PROJECTS,
  MAX_REPORTED_PROJECTS,
  MAX_RESULTS_PER_HEARTBEAT,
  firstLine,
  redact,
  type ClaimedCommand,
  type FileNode,
  type GitReportEntry,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type LocalProjectRef,
} from './protocol.js';

export interface LocalAgentOptions {
  base: string;
  token: string;
  root: string;
  /** 心跳间隔；默认 15 s，必须小于云端 90 s 的在线窗口。 */
  intervalMs?: number;
  /** `ideaseek cloud push` 间隔；投影仍由本地引擎负责，Agent 只定期触发它。 */
  syncIntervalMs?: number;
  cli?: string;
  /** 命令跑过这个时长后才开始续租。 */
  leaseRenewAfterMs?: number;
  leaseRenewIntervalMs?: number;
  /** 仓库读数与项目清单的缓存窗口：每轮心跳重跑 6 条 git plumbing 在 Windows 上太贵。 */
  reportTtlMs?: number;
  /** 停机时等待在飞命令的宽限，超时则回写 canceled。 */
  stopGraceMs?: number;
  log?: (level: string, line: string) => void;
}

export interface AgentSummary {
  base: string;
  tokenMasked: string;
  root: string;
  cli: { command: string; args: string[] };
  projects: LocalProjectRef[];
  intervalMs: number;
  syncIntervalMs: number;
}

const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(token: string, level = 'info'): (level: string, line: string) => void {
  const threshold = LEVELS[level] ?? 20;
  return (entryLevel, line) => {
    if ((LEVELS[entryLevel] ?? 20) < threshold) return;
    // 日志是最后一道脱敏网：token 值与凭据形状的串都不许出现在 stdout/stderr。
    process.stdout.write(`${new Date().toISOString()} ${entryLevel.toUpperCase().padEnd(5)} ${redact(line, [token])}\n`);
  };
}

export class LocalAgent {
  private readonly transport: CloudTransport;
  private readonly executor: CLIExecutor;
  private readonly manifests: ManifestCache;
  private readonly buffer = new ResultBuffer();
  private readonly router: CommandRouter;
  private readonly log: (level: string, line: string) => void;
  private readonly token: string;
  private readonly root: string;

  private readonly intervalMs: number;
  private readonly syncIntervalMs: number;
  private readonly leaseRenewAfterMs: number;
  private readonly leaseRenewIntervalMs: number;
  private readonly reportTtlMs: number;
  private readonly stopGraceMs: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private commandChain: Promise<void> = Promise.resolve();
  private inFlight = new Map<string, ClaimedCommand>();
  private projectsCache: { at: number; items: LocalProjectRef[] } | null = null;
  private reportCache: { at: number; git: GitReportEntry[]; files: Array<{ external_id: string; nodes: FileNode[] }> } | null = null;
  private lastPushAt = 0;

  constructor(options: LocalAgentOptions) {
    this.token = options.token;
    this.root = resolve(options.root);
    this.log = options.log ?? createLogger(options.token);
    this.intervalMs = Math.max(5_000, options.intervalMs ?? 15_000);
    this.syncIntervalMs = Math.max(this.intervalMs, options.syncIntervalMs ?? 60_000);
    this.leaseRenewAfterMs = options.leaseRenewAfterMs ?? 60_000;
    this.leaseRenewIntervalMs = options.leaseRenewIntervalMs ?? 300_000;
    this.reportTtlMs = options.reportTtlMs ?? 30_000;
    this.stopGraceMs = options.stopGraceMs ?? 60_000;

    this.transport = new CloudTransport({ base: options.base, token: options.token });
    this.executor = new CLIExecutor({ cli: options.cli });
    this.manifests = new ManifestCache(this.syncIntervalMs);
    this.router = new CommandRouter({
      executor: this.executor,
      agentRoot: this.root,
      projects: () => this.discover(),
      manifests: this.manifests,
      // 命令动过仓库或文件之后必须清缓存：读数 TTL 是性能优化，不能变成界面上的延迟。
      invalidateReports: () => {
        this.reportCache = null;
      },
      secrets: [options.token],
      log: (line) => this.log('info', line),
    });
  }

  /** 启动摘要：只有路径、掩码 token 与项目身份；在线状态由云端算，这里不假装知道。 */
  async describe(): Promise<AgentSummary> {
    return {
      base: this.transport.base,
      tokenMasked: this.transport.fingerprint,
      root: this.root,
      cli: this.executor.cliInvocation,
      projects: await this.discover(true),
      intervalMs: this.intervalMs,
      syncIntervalMs: this.syncIntervalMs,
    };
  }

  /** 常驻循环；stop() 完成冲刷后 resolve。启动摘要由调用方用 describe() 打印。 */
  async start(): Promise<void> {
    this.log('info', `agent ${AGENT_VERSION} · polling ${this.transport.base}/agent/heartbeat every ${this.intervalMs}ms`);
    await this.cycle();
    if (this.stopping) return;
    this.timer = setInterval(() => void this.cycle(), this.intervalMs);
  }

  /** 一轮心跳 + 执行 + 冲刷：`--once` 的验收路径。 */
  async runOnce(): Promise<void> {
    await this.cycle();
    await this.commandChain;
    await this.flush();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.quiesce(this.stopGraceMs);
    this.log('info', `stopped (undelivered results: ${this.buffer.size})`);
  }

  // ------------------------------------------------------------------ 循环

  private async cycle(): Promise<void> {
    if (this.stopping) return;

    const projects = await this.discover();
    const results = this.buffer.peek(MAX_RESULTS_PER_HEARTBEAT);
    const reported = await this.buildReported(projects);

    const request: HeartbeatRequest = {
      agent_version: AGENT_VERSION,
      local_projects: projects.slice(0, MAX_LOCAL_PROJECTS),
      ...(results.length > 0 ? { results } : {}),
      ...(reported ? { reported } : {}),
    };

    let response: HeartbeatResponse;
    try {
      response = await this.transport.heartbeat(request);
    } catch (error) {
      // 结果留在缓冲里下一轮再带；这里只报告失败形状。
      this.log('warn', `heartbeat failed: ${describeError(error, this.token)}`);
      return;
    }

    // 云端逐条答复它看到的结果；没被答复的那几条继续留在缓冲里重试。
    this.buffer.settle(response.applied_results.map((entry) => entry.command_id));
    const rejected = response.applied_results.filter((entry) => !entry.applied && entry.reason);
    if (rejected.length > 0) {
      this.log('warn', `results not applied: ${rejected.map((entry) => `${entry.command_id}:${entry.reason}`).join(' ')}`);
    }
    if (response.expired_commands.length > 0) {
      this.log('warn', `lease expired without result (cloud marks them, no redelivery): ${response.expired_commands.join(' ')}`);
    }
    if (response.applied_reported.skipped.length > 0) {
      this.log('debug', `reported skipped: ${response.applied_reported.skipped.join(' ')}`);
    }
    for (const command of response.commands) {
      this.log('info', `claimed ${command.command_id} type=${command.type} project_id=${command.project_id ?? 'null'}`);
      this.submit(command);
    }

    if (Date.now() - this.lastPushAt >= this.syncIntervalMs) {
      this.lastPushAt = Date.now();
      void this.pushProjections();
    }
  }

  private async buildReported(
    projects: LocalProjectRef[],
  ): Promise<{ git: GitReportEntry[]; files: Array<{ external_id: string; nodes: FileNode[] }> } | undefined> {
    // 只有拿到投影身份的项目才值得上报：云端按 external_id 找行，缺它只会变成 skipped 噪声。
    const reportable = projects.filter((project): project is LocalProjectRef & { external_id: string } => Boolean(project.external_id)).slice(0, MAX_REPORTED_PROJECTS);
    if (reportable.length === 0) return undefined;
    if (this.reportCache && Date.now() - this.reportCache.at < this.reportTtlMs) {
      return { git: this.reportCache.git, files: this.reportCache.files };
    }

    const git: GitReportEntry[] = [];
    const files: Array<{ external_id: string; nodes: FileNode[] }> = [];
    for (const project of reportable) {
      const entry = await readGitReport(project.path, project.external_id, this.executor);
      if (entry) git.push(entry);
      const nodes = await this.manifests.get(project.path);
      if (nodes.length > 0) files.push({ external_id: project.external_id, nodes });
    }
    this.reportCache = { at: Date.now(), git, files };
    return { git, files };
  }

  private async discover(force = false): Promise<LocalProjectRef[]> {
    if (!force && this.projectsCache && Date.now() - this.projectsCache.at < this.reportTtlMs) {
      return this.projectsCache.items;
    }
    const items = await discoverProjects(this.root);
    this.projectsCache = { at: Date.now(), items };
    return items;
  }

  // ------------------------------------------------------------------ 命令

  /** 串行队列：命令一条一条跑，但心跳照常继续（否则长命令会把 Agent 变成离线）。 */
  private submit(command: ClaimedCommand): void {
    this.inFlight.set(command.command_id, command);
    this.commandChain = this.commandChain.then(() => this.runCommand(command));
  }

  private async runCommand(command: ClaimedCommand): Promise<void> {
    if (this.stopping) {
      this.inFlight.delete(command.command_id);
      this.buffer.push({ command_id: command.command_id, status: 'canceled', error: 'agent_stopping' });
      return;
    }
    const renewal = this.startRenewal(command.command_id);
    try {
      const result = await this.router.execute(command);
      this.buffer.push(result);
      this.log(result.status === 'succeeded' ? 'info' : 'warn', `command ${command.command_id} ${command.type} → ${result.status}${result.error ? ` (${result.error})` : ''}`);
    } finally {
      renewal.stop();
      this.inFlight.delete(command.command_id);
    }
  }

  /**
   * 续租。注意：云端 `claimQueued` 按 `claimed_at` 判过期，而 `/agent/command` 只写
   * `heartbeat_at`，所以这条续租目前并不延长租约（详见 README 的"未实现/存疑"）。
   * 长跑任务因此靠 `run --detach` 让命令本身快速返回。
   */
  private startRenewal(commandId: string): { stop: () => void } {
    let interval: ReturnType<typeof setInterval> | null = null;
    const first = setTimeout(() => {
      void this.renew(commandId);
      interval = setInterval(() => void this.renew(commandId), this.leaseRenewIntervalMs);
    }, this.leaseRenewAfterMs);

    return {
      stop: () => {
        clearTimeout(first);
        if (interval) clearInterval(interval);
      },
    };
  }

  private async renew(commandId: string): Promise<void> {
    try {
      await this.transport.renewLease(commandId);
      this.log('debug', `lease heartbeat sent for ${commandId}`);
    } catch (error) {
      this.log('warn', `lease renew failed for ${commandId}: ${describeError(error, this.token)}`);
    }
  }

  // ------------------------------------------------------------------ 投影

  /** 投影归本地引擎（M2 的 `ideaseek cloud push`）；非零退出只当警告，不中断循环。 */
  private async pushProjections(): Promise<void> {
    for (const project of await this.discover()) {
      if (this.stopping) return;
      const exec = await this.executor.ideaseek(['cloud', 'push', '--json'], {
        cwd: project.path,
        timeoutMs: Math.max(60_000, this.syncIntervalMs),
      });
      if (exec.exitCode !== 0) {
        this.log('warn', `cloud push ${project.name}: exit ${exec.exitCode} ${firstLine(exec.stderr || exec.stdout, [this.token])}`);
      }
    }
  }

  // ------------------------------------------------------------------ 停机

  /** 等在飞命令跑完；超过宽限就把它们记成 canceled（协议不允许无声消失）。 */
  private async quiesce(graceMs: number): Promise<void> {
    const deadline = Date.now() + graceMs;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await new Promise((waitResolve) => setTimeout(waitResolve, 250));
    }
    for (const [commandId, command] of this.inFlight) {
      this.log('warn', `command ${commandId} ${command.type} abandoned at shutdown`);
      this.buffer.push({ command_id: commandId, status: 'canceled', error: 'agent_shutdown' });
    }
    this.inFlight = new Map();
    await this.flush();
  }

  /** 停机前把缓冲里的终态尽量送出去；云端对重复回写只回 ignored，所以重试安全。 */
  private async flush(): Promise<void> {
    for (let attempt = 0; attempt < 3 && this.buffer.size > 0; attempt += 1) {
      const results = this.buffer.peek(MAX_RESULTS_PER_HEARTBEAT);
      try {
        const response = await this.transport.heartbeat({ agent_version: AGENT_VERSION, results });
        this.buffer.settle(response.applied_results.map((entry) => entry.command_id));
      } catch (error) {
        this.log('warn', `flush attempt ${attempt + 1} failed: ${describeError(error, this.token)}`);
        break;
      }
    }
    if (this.buffer.size > 0) {
      this.log('warn', `${this.buffer.size} result(s) undelivered; they will expire on the cloud side`);
    }
  }
}

function describeError(error: unknown, token: string): string {
  if (error instanceof TransportError) {
    return `${error.kind}(status=${error.status ?? '-'}) ${redact(error.message, [token]).slice(0, 200)}`;
  }
  return redact(error instanceof Error ? error.message : String(error), [token]).slice(0, 200);
}
