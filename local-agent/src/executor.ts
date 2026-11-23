/**
 * CLI 执行器：跑 `ideaseek …` 与 `git …`，捕获输出。
 *
 * 这里刻意不经过 shell：命令载荷的字段会被拼进 argv，`shell: true` 等于把云端排队的
 * 字符串交给本机 shell 解释（Windows 上是 cmd）。`spawn` 直接收 argv 数组即可。
 *
 * 超时不 reject：一条被杀掉的命令仍然要有终态回写，否则云端只会看到 lease 过期。
 * 输出在内存里只保留尾部，长 `run` 的 stdout 不该把 Agent 撑爆。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ExecOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** 单个流保留的最大字符数；超出只留尾部。 */
  captureLimit?: number;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CAPTURE_LIMIT = 200_000;

export interface ExecutorOptions {
  /** `ideaseek` 命令名，或引擎入口 js 的路径。 */
  cli?: string;
  node?: string;
  env?: Record<string, string | undefined>;
}

export class CLIExecutor {
  private readonly cli: string;
  private readonly node: string;
  private readonly baseEnv: Record<string, string | undefined>;
  private current: ReturnType<typeof spawn> | null = null;

  constructor(options: ExecutorOptions = {}) {
    this.cli = options.cli ?? resolveDefaultCli();
    this.node = options.node ?? process.execPath;
    this.baseEnv = options.env ?? process.env;
  }

  /** 供启动摘要展示：只报解析出来的命令形状，不含任何凭据。 */
  get cliInvocation(): { command: string; args: string[] } {
    return isJsEntry(this.cli)
      ? { command: this.node, args: [this.cli] }
      : { command: this.cli, args: [] };
  }

  async ideaseek(args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    return isJsEntry(this.cli)
      ? this.run(this.node, [this.cli, ...args], options)
      : this.run(this.cli, args, options);
  }

  async git(args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    return this.run('git', args, options);
  }

  async run(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const limit = options.captureLimit ?? DEFAULT_CAPTURE_LIMIT;
    const started = Date.now();

    return new Promise<ExecResult>((resolvePromise) => {
      const child = spawn(command, args, {
        cwd: options.cwd ?? process.cwd(),
        env: { ...this.baseEnv, ...options.env } as NodeJS.ProcessEnv,
        shell: false,
        windowsHide: true,
      });
      this.current = child;

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const finish = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.current === child) this.current = null;
        resolvePromise({ exitCode, stdout, stderr, durationMs: Date.now() - started, timedOut });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        this.killChild(child);
      }, timeoutMs);

      const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
        const text = chunk.toString();
        if (target === 'stdout') stdout = keepTail(stdout + text, limit);
        else stderr = keepTail(stderr + text, limit);
      };
      child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));

      child.on('close', (code) => finish(code));
      child.on('error', (error) => {
        // 找不到可执行文件时 close 不会带着退出码来；把它编码成 stderr 里的失败。
        stderr = keepTail(`${stderr}\nspawn_failed: ${error.name}: ${error.message}`, limit);
        finish(null);
      });
    });
  }

  /** 杀掉当前子进程（SIGTERM，Windows 上 node 的 SIGTERM≈直接终止）。 */
  cancel(): void {
    if (this.current) this.killChild(this.current);
  }

  private killChild(child: ReturnType<typeof spawn>): void {
    try {
      child.kill('SIGTERM');
    } catch {
      /* 已经退出 */
    }
  }
}

function keepTail(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(value.length - limit);
}

function isJsEntry(cli: string): boolean {
  return cli.endsWith('.js') || cli.includes('/') || cli.includes('\\') || resolve(cli) !== cli;
}

/**
 * 默认引擎入口：`IDEASEEK_CLI` 覆盖 → 相邻仓库构建产物 `dist/cli.js` → PATH 上的 `ideaseek`。
 * 不写死 `../dist/cli.js`：Agent 的 cwd 是项目根而不是仓库根时那条路径必然不存在，
 * 失败会表现为每条命令都 spawn_failed。
 */
function resolveDefaultCli(): string {
  const fromEnv = process.env.IDEASEEK_CLI?.trim();
  if (fromEnv) return fromEnv;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    resolve(here, '..', '..', 'dist', 'cli.js'),
    resolve(here, '..', 'dist', 'cli.js'),
    join(process.cwd(), 'dist', 'cli.js'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return 'ideaseek';
}
