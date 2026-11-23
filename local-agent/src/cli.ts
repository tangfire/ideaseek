#!/usr/bin/env node

/**
 * `ideaseek-agent` 入口。
 *
 * token 是唯一的秘密参数，所以默认建议 `--token env:NAME`：命令行 argv 在 Windows 与
 * Linux 上都是同机器任何进程可读的（`ps`、WMI），把 sync token 放上去等于把它半公开。
 * 本文件打印任何内容之前都只带掩码，不带原值。
 */
import { createLogger, LocalAgent, type LocalAgentOptions } from './index.js';

const USAGE = `ideaseek-agent — IdeaSeek 本地执行节点（HTTP 轮询）

用法:
  ideaseek-agent start --base <url> --token <t|env:NAME> [--root <dir>]
                       [--interval 15000] [--sync-interval 60000]
                       [--cli <path-or-name>] [--log-level debug|info|warn] [--once]

  --base            Function 基址，含物理函数名，例：
                    https://<site>.qoder.zone/functions/v1/app
                    末尾斜杠会被剥掉；请求打到 <base>/agent/heartbeat 与 <base>/agent/command。
  --token           sync token（需 commands 范围）。写 env:NAME 时从环境读取。
  --root            Agent 的项目根，默认当前目录；只在这里发现与执行项目。
  --interval        心跳间隔 ms（默认 15000，必须小于云端 90s 在线窗口）
  --sync-interval   每个项目跑一次 \`ideaseek cloud push --json\` 的间隔 ms（默认 60000）
  --cli             引擎入口：ideaseek 命令名或 dist/cli.js 路径（默认自动寻找）
  --once            跑一轮心跳+执行+回写后退出（部署验收用）

示例:
  IDEASEEK_SYNC_TOKEN=... ideaseek-agent start \\
    --base https://demo.qoder.zone/functions/v1/app --token env:IDEASEEK_SYNC_TOKEN \\
    --root /srv/research --once
`;

interface ParsedArgs {
  command: string | null;
  options: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const options: Record<string, string | boolean> = {};
  let command: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith('-')) {
      if (command === null) command = arg;
      continue;
    }
    if (arg === '--once') {
      options.once = true;
      continue;
    }
    const key = arg.replace(/^--/, '');
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return { command, options };
}

function resolveToken(value: string | boolean | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.startsWith('env:')) return process.env[value.slice(4)] ?? null;
  return value;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exit(1);
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.options.help === true || parsed.command === null) {
    process.stdout.write(USAGE);
    return parsed.command === null && parsed.options.help === undefined ? 1 : 0;
  }
  if (parsed.command !== 'start') {
    fail(`未知子命令：${parsed.command}`);
  }

  const base = typeof parsed.options.base === 'string' ? parsed.options.base : null;
  if (!base) fail('缺少 --base <url>');
  const token = resolveToken(parsed.options.token);
  if (!token) fail('缺少 --token，或 env:NAME 指向的变量不存在');
  if (token.length < 32) fail('token 太短：云端对 <32 字符的 token 直接 401');

  const agentOptions: LocalAgentOptions = {
    base,
    token,
    root: typeof parsed.options.root === 'string' ? parsed.options.root : process.cwd(),
    intervalMs: numberOption(parsed.options.interval),
    syncIntervalMs: numberOption(parsed.options.syncInterval),
    cli: typeof parsed.options.cli === 'string' ? parsed.options.cli : undefined,
    log: createLogger(token, typeof parsed.options['log-level'] === 'string' ? parsed.options['log-level'] : 'info'),
  };

  const agent = new LocalAgent(agentOptions);
  const summary = await agent.describe();

  process.stdout.write(
    [
      `base          ${summary.base}`,
      `token         ${summary.tokenMasked}`,
      `root          ${summary.root}`,
      `engine cli    ${summary.cli.command} ${summary.cli.args.join(' ')}`.trimEnd(),
      `interval      ${summary.intervalMs}ms heartbeat · ${summary.syncIntervalMs}ms cloud push`,
      `projects      ${summary.projects.length}`,
      ...summary.projects.map(
        (project) =>
          `  ${project.name.padEnd(20)} ${project.path}  external_id=${project.external_id ?? '(unreadable)'}`,
      ),
      '',
    ].join('\n'),
  );

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`${signal} received: stop claiming, drain in-flight, flush results\n`);
    void agent.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  if (parsed.options.once === true) {
    await agent.runOnce();
    return 0;
  }

  await agent.start();
  // start() 只装 timer；进程靠它一直活着，退出只走信号路径。
  return 0;
}

function numberOption(value: string | boolean | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // 错误信息里可能带 base（含站点名，安全），但不带 token：token 只进过请求头。
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
