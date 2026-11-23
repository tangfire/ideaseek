/**
 * 命令路由：云端排队的 type → 本机真实 CLI 调用。
 *
 * 三条形状约定：
 * 1. 每个 handler 返回 `{status, result, error}`，**不抛**。抛出去等于丢结果——
 *    云端只会看到 lease 过期，而过期不重投（`run_start` 重放就是重复花费）。
 * 2. `result` 是引擎 `--json` 的输出（能解析时）加 `{exit_code, stdout_tail, duration_ms}`；
 *    尾部和错误都先过 `redact()`，token 与凭据形状的串不出机。
 * 3. 本地没有对应 CLI 表面的字段一律显式 `failed`，不去偷偷改引擎拥有的文件：
 *    写坏 `research.yaml` 比一次可见的失败更糟。
 */
import { mkdir, lstat, realpath, unlink } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { CLIExecutor, type ExecResult } from './executor.js';
import {
  PROTECTED_BRANCHES,
  firstLine,
  isSafeRef,
  isSafeRelativePath,
  tail,
  type ClaimedCommand,
  type LocalProjectRef,
  type ResultEnvelope,
} from './protocol.js';
import { resolveWithin, type ManifestCache } from './manifest.js';

export interface TargetContext {
  projectDir: string;
  project: LocalProjectRef | null;
}

export type CommandHandler = (
  payload: Record<string, unknown>,
  target: TargetContext,
) => Promise<Omit<ResultEnvelope, 'command_id'>>;

export interface RouterDeps {
  executor: CLIExecutor;
  agentRoot: string;
  /** 每轮心跳刷新一次的项目清单（由 LocalAgent 缓存）。 */
  projects: () => Promise<LocalProjectRef[]>;
  manifests: ManifestCache;
  /** 命令动过工作区之后清掉上报缓存：否则界面要等一整个 TTL 才看到你刚按下去的结果。 */
  invalidateReports?: () => void;
  /** 参与脱敏的本地已知密钥值：只有 token，Agent 不持有别的凭据。 */
  secrets?: string[];
  log?: (line: string) => void;
}

/** 引擎 `--json` 输出解析失败时的兜底：仍然回传退出码与尾部，不假装是结构化结果。 */
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const GIT_TIMEOUT_MS = 2 * 60_000;

export class CommandRouter {
  private readonly handlers = new Map<string, CommandHandler>();
  private readonly executor: CLIExecutor;
  private readonly agentRoot: string;
  private readonly projects: () => Promise<LocalProjectRef[]>;
  private readonly manifests: ManifestCache;
  private readonly invalidateReports: (() => void) | undefined;
  private readonly secrets: string[];
  private readonly log: (line: string) => void;

  constructor(deps: RouterDeps) {
    this.executor = deps.executor;
    this.agentRoot = resolve(deps.agentRoot);
    this.projects = deps.projects;
    this.manifests = deps.manifests;
    this.invalidateReports = deps.invalidateReports;
    this.secrets = deps.secrets ?? [];
    this.log = deps.log ?? (() => {});
    this.registerDefaults();
  }

  register(type: string, handler: CommandHandler): void {
    this.handlers.set(type, handler);
  }

  get supportedTypes(): string[] {
    return [...this.handlers.keys()].sort();
  }

  /** 执行一条已领取的命令；返回值一定可以直接进结果缓冲区。 */
  async execute(command: ClaimedCommand): Promise<ResultEnvelope> {
    const handler = this.handlers.get(command.type);
    if (!handler) {
      return {
        command_id: command.command_id,
        status: 'failed',
        error: `unsupported_command_type:${command.type}`,
      };
    }

    const resolved = await this.resolveTarget(command);
    if (!resolved.ok) {
      return { command_id: command.command_id, status: 'failed', error: resolved.reason };
    }

    try {
      const outcome = await handler(command.payload ?? {}, resolved.target);
      return { command_id: command.command_id, ...outcome };
    } catch (error) {
      // 兜底 catch 只为把 panic 变成终态；正常路径不经过这里。
      return {
        command_id: command.command_id,
        status: 'failed',
        error: firstLine(error instanceof Error ? error.message : String(error), this.secrets),
      };
    }
  }

  /**
   * 目标项目定位。
   *
   * 心跳回给 Agent 的是云内 `project_id`（uuid），不是 Agent 上报的 `external_id`
   * （web/functions/commands.ts 的 claimed 映射），所以本地无法把命令对回目录：
   * 单项目根可以无歧义地选定，多项目根只能显式失败，绝不猜一个目录去跑 `git push`。
   */
  private async resolveTarget(
    command: ClaimedCommand,
  ): Promise<{ ok: true; target: TargetContext } | { ok: false; reason: string }> {
    if (command.type === 'project_create') {
      const name = asString(command.payload?.name);
      if (!name) return { ok: false, reason: 'invalid_project_name' };
      const dir = join(this.agentRoot, slugify(name));
      if (!resolveWithin(this.agentRoot, slugify(name))) {
        return { ok: false, reason: 'invalid_project_name' };
      }
      return { ok: true, target: { projectDir: dir, project: null } };
    }

    const projects = await this.projects();
    if (projects.length === 0) return { ok: false, reason: 'no_local_projects' };
    if (projects.length > 1) {
      return { ok: false, reason: `ambiguous_project_target:${projects.length}` };
    }
    const only = projects[0]!;
    return { ok: true, target: { projectDir: only.path, project: only } };
  }

  private registerDefaults(): void {
    this.register('project_create', (payload) => this.projectCreate(payload));
    this.register('project_settings', (payload, target) => this.projectSettings(payload, target));
    this.register('project_archive', () => this.projectArchive());
    this.register('run_start', (payload, target) => this.runStart(payload, target));
    this.register('run_pause', (payload, target) => this.control('pause', payload, target));
    this.register('run_resume', (payload, target) => this.control('resume', payload, target));
    this.register('run_continue', (payload, target) => this.control('continue', payload, target));
    this.register('run_cancel', (payload, target) => this.control('cancel', payload, target));
    this.register('git_commit', (payload, target) => this.gitCommit(payload, target));
    this.register('git_push', (payload, target) => this.gitRemote('push', payload, target));
    this.register('git_pull', (payload, target) => this.gitRemote('pull', payload, target));
    this.register('git_fetch', (payload, target) => this.gitFetch(payload, target));
    this.register('git_branch', (payload, target) => this.gitBranch(payload, target));
    this.register('git_branch_delete', (payload, target) => this.gitBranchDelete(payload, target));
    this.register('git_checkout', (payload, target) => this.gitCheckout(payload, target));
    this.register('git_merge', (payload, target) => this.gitMerge(payload, target));
    this.register('git_merge_abort', (payload, target) => this.gitMergeAbort(payload, target));
    this.register('file_delete', (payload, target) => this.fileDelete(payload, target));
  }

  // ------------------------------------------------------------------ 项目

  private async projectCreate(payload: Record<string, unknown>): Promise<Omit<ResultEnvelope, 'command_id'>> {
    const name = asString(payload.name);
    if (!name) return failed('invalid_project_name');

    const autonomy = asString(payload.autonomy);
    // policy.autonomy_mode 在 research.yaml 里，但引擎没有写它的命令；非默认值就拒绝，
    // 因为"创建成功但策略没落地"是假成功。默认 guided 与引擎默认一致，可以放行。
    if (autonomy && autonomy !== 'guided') return failed(`no_local_surface_for:autonomy(${autonomy})`);

    await mkdir(this.projectDirOf(name), { recursive: true });
    const args = ['start', '--name', name, '--json'];
    const question = asString(payload.question);
    if (question) args.push('--question', question);
    const start = await this.withResult(await this.executor.ideaseek(args, { cwd: this.projectDirOf(name), timeoutMs: DEFAULT_TIMEOUT_MS }));
    if (start.status !== 'succeeded') return start;

    const strategy = asString(payload.strategy);
    if (strategy) {
      const mode = await this.withResult(
        await this.executor.ideaseek(['mode', '--strategy', strategy, '--confirm', '--json'], {
          cwd: this.projectDirOf(name),
          timeoutMs: DEFAULT_TIMEOUT_MS,
        }),
      );
      if (mode.status !== 'succeeded') return mode;
      return { status: 'succeeded', result: { ...(start.result ?? {}), ...(mode.result ?? {}) } };
    }
    return start;
  }

  private projectDirOf(name: string): string {
    return join(this.agentRoot, slugify(name));
  }

  private async projectSettings(
    payload: Record<string, unknown>,
    target: TargetContext,
  ): Promise<Omit<ResultEnvelope, 'command_id'>> {
    // 支持的字段先算清楚：只要有任一字段本地没有 CLI 表面，整条命令拒绝、不改任何东西。
    const unsupported = ['title', 'visibility', 'autonomy'].filter((key) => payload[key] !== undefined);
    if (unsupported.length > 0) return failed(`no_local_surface_for:${unsupported.join(',')}`);

    const steps: string[][] = [];
    const question = asString(payload.question);
    if (question) steps.push(['setup', '--question', question, '--json']);
    const strategy = asString(payload.strategy);
    if (strategy) steps.push(['mode', '--strategy', strategy, '--confirm', '--json']);
    if (steps.length === 0) return failed('empty_settings_patch');

    const results: Record<string, unknown> = {};
    for (const args of steps) {
      const outcome = await this.withResult(
        await this.executor.ideaseek(args, { cwd: target.projectDir, timeoutMs: DEFAULT_TIMEOUT_MS }),
      );
      if (outcome.status !== 'succeeded') return outcome;
      Object.assign(results, outcome.result ?? {});
    }
    return { status: 'succeeded', result: results };
  }

  private async projectArchive(): Promise<Omit<ResultEnvelope, 'command_id'>> {
    // 诚实的答案：本地没有"归档投影"这个命令。`ideaseek maintenance archive` 归档的是
    // 一次 run 的报告包，`cloud reset|discard` 清的是同步缓冲——都不是投影生命周期。
    return failed('no_local_surface_for:project_archive');
  }

  // ------------------------------------------------------------------ 运行

  private async runStart(
    payload: Record<string, unknown>,
    target: TargetContext,
  ): Promise<Omit<ResultEnvelope, 'command_id'>> {
    const question = asString(payload.question);
    if (!question) return failed('invalid_input:question');
    const args = ['run', '-q', question];
    const harness = asString(payload.harness);
    if (harness === 'fake' || harness === 'dsh') args.push('--harness', harness);
    if (payload.enqueue_only === true) args.push('--enqueue-only');
    // --detach：命令必须在 lease_ms 内回写终态，而云端续租并不延长租约（见 README），
    // 所以长任务交给引擎自己的 supervisor，Agent 只确认它起来了。
    args.push('--detach', '--json');
    return this.withResult(await this.executor.ideaseek(args, { cwd: target.projectDir, timeoutMs: DEFAULT_TIMEOUT_MS }));
  }

  private async control(
    verb: 'pause' | 'resume' | 'continue' | 'cancel',
    payload: Record<string, unknown>,
    target: TargetContext,
  ): Promise<Omit<ResultEnvelope, 'command_id'>> {
    const args = [verb, '--json'];
    const run = asString(payload.run);
    if (run) args.push('--run', run);
    if (verb === 'pause' && payload.hard === true) args.push('--hard');
    // control.ts 对 cancel 故意返回 4（"已进入终态"不是错误）。
    const accepted = verb === 'cancel' ? [0, 4] : [0];
    return this.withResult(
      await this.executor.ideaseek(args, { cwd: target.projectDir, timeoutMs: DEFAULT_TIMEOUT_MS }),
      accepted,
    );
  }

  // ------------------------------------------------------------------ git

  private async gitCommit(
    payload: Record<string, unknown>,
    target: TargetContext,
  ): Promise<Omit<ResultEnvelope, 'command_id'>> {
    const message = asString(payload.message);
    if (!message) return failed('invalid_input:message');

    const files = Array.isArray(payload.files) ? payload.files.map((f) => asString(f)).filter((f): f is string => Boolean(f)) : null;
    if (Array.isArray(payload.files) && files && files.length === 0) return failed('invalid_input:files');

    if (files) {
      for (const file of files) {
        if (!resolveWithin(target.projectDir, file)) return failed(`unsafe_path:${basename(file)}`);
      }
      const add = await this.executor.git(['-C', target.projectDir, 'add', '--', ...files], { timeoutMs: GIT_TIMEOUT_MS });
      const addOutcome = this.withResult(add);
      if (addOutcome.status !== 'succeeded') return addOutcome;
    } else {
      const add = await this.executor.git(['-C', target.projectDir, 'add', '-A'], { timeoutMs: GIT_TIMEOUT_MS });
      const addOutcome = this.withResult(add);
      if (addOutcome.status !== 'succeeded') return addOutcome;
    }

    // 不带 --no-verify：钩子是仓库自己的规则，云端按钮没有权限绕过它。
    const commit = await this.executor.git(['-C', target.projectDir, 'commit', '-m', message], {
      timeoutMs: GIT_TIMEOUT_MS,
    });
    const outcome = this.withResult(commit);
    if (outcome.status === 'failed' && isNothingToCommit(commit.stdout + commit.stderr)) {
      this.markDirty();
      return { status: 'succeeded', result: { ...(outcome.result ?? {}), noop: 'nothing_to_commit' } };
    }
    if (outcome.status === 'succeeded') this.markDirty();
    return outcome;
  }

  private async gitRemote(
    verb: 'push' | 'pull',
    payload: Record<string, unknown>,
    target: TargetContext,
  ): Promise<Omit<ResultEnvelope, 'command_id'>> {
    if (payload.force === true) return failed('refused:force');
    const remote = this.refField(payload, 'remote');
    if ('error' in remote) return failed(remote.error);
    const branch = this.refField(payload, 'branch');
    if ('error' in branch) return failed(branch.error);

    const args = ['-C', target.projectDir, verb];
    if (verb === 'pull' && payload.rebase === true) args.push('--rebase');
    // `git push <remote> <branch>` 需要 remote 才能带 branch；只给 branch 时按当前分支推。
    if (remote.value) args.push(remote.value);
    if (branch.value) {
      if (!remote.value) args.push('origin');
      args.push(branch.value);
    }
    // 永远不传 --force：云端按钮不该有覆盖历史的能力。
    const outcome = this.withResult(await this.executor.git(args, { timeoutMs: GIT_TIMEOUT_MS }));
    if (outcome.status === 'succeeded') this.markDirty();
    return outcome;
  }

  private async gitFetch(
    payload: Record<string, unknown>,
    target: TargetContext,
  ): Promise<Omit<ResultEnvelope, 'command_id'>> {
    const remote = this.refField(payload, 'remote');
    if ('error' in remote) return failed(remote.error);
    const args = ['-C', target.projectDir, 'fetch'];
    if (remote.value) args.push(remote.value);
    if (payload.prune === true) args.push('--prune');
    const outcome = this.withResult(await this.executor.git(args, { timeoutMs: GIT_TIMEOUT_MS }));
    // fetch 改的是 .git/refs，分支清单与领先/落后读数当场过期。
    if (outcome.status === 'succeeded') this.markDirty();
    return outcome;
  }

  private async gitBranch(
    payload: Record<string, unknown>,
    target: TargetContext,
  ): Promise<Omit<ResultEnvelope, 'command_id'>> {
    const name = this.refField(payload, 'name');
    if ('error' in name) return failed(name.error);
    if (!name.value) return failed('invalid_input:name');
    const from = this.refField(payload, 'from');
    if ('error' in from) return failed(from.error);

    // git 的 `branch -c` 是"复制分支"，不是"创建"；创建用裸形式（见 README 的偏差说明）。
    // 起点同样只接受 ref 形状，不给 rev-parse 表达式留位置。
    const args = ['-C', target.projectDir, 'branch', name.value];
    if (from.value) args.push(from.value);
    const created = this.withResult(await this.executor.git(args, { timeoutMs: GIT_TIMEOUT_MS }));
    if (created.status !== 'succeeded') return created;
    this.markDirty();
    if (payload.checkout !== true) return created;
    return this.gitCheckout({ branch: name.value }, target);
  }

  private async gitBranchDelete(
    payload: Record<string, unknown>,
    target: TargetContext,
  ): Promise<Omit<ResultEnvelope, 'command_id'>> {
    const name = this.refField(payload, 'name');
    if ('error' in name) return failed(name.error);
    if (!name.value) return failed('invalid_input:name');
    // 云端已经拦过一次主分支；这里再守一遍，因为旧云端或手工排的队未必有那道校验。
    if (PROTECTED_BRANCHES.has(name.value)) return failed('protected_branch');
    // `-d` 而不是 `-D`：未合并的分支删掉就是丢历史，强删应当在自己终端里做。
    const outcome = this.withResult(
      await this.executor.git(['-C', target.projectDir, 'branch', '-d', name.value], { timeoutMs: GIT_TIMEOUT_MS }),
    );
    if (outcome.status === 'succeeded') this.markDirty();
    return outcome;
  }

  private async gitCheckout(
    payload: Record<string, unknown>,
    target: TargetContext,
  ): Promise<Omit<ResultEnvelope, 'command_id'>> {
    if (payload.discard_uncommitted === true) return failed('refused:discard_uncommitted');
    const branch = this.refField(payload, 'branch');
    if ('error' in branch) return failed(branch.error);
    if (!branch.value) return failed('invalid_input:branch');

    const args = ['-C', target.projectDir, 'checkout'];
    // create:true 用 -b：云端把"新建并切换"当成一个动作排的队，不该在本地变成两步中间失败。
    if (payload.create === true) args.push('-b');
    args.push(branch.value);
    // 没有 --force：把工作区丢进云端按钮等于给用户一个"没提示就没了改动"的入口。
    const outcome = this.withResult(await this.executor.git(args, { timeoutMs: GIT_TIMEOUT_MS }));
    if (outcome.status === 'succeeded') this.markDirty();
    return outcome;
  }

  private async gitMerge(
    payload: Record<string, unknown>,
    target: TargetContext,
  ): Promise<Omit<ResultEnvelope, 'command_id'>> {
    const source = this.refField(payload, 'target');
    if ('error' in source) return failed(source.error);
    if (!source.value) return failed('invalid_input:target');
    const strategy = asString(payload.strategy) ?? 'ff-only';
    if (strategy !== 'ff-only' && strategy !== 'no-ff' && strategy !== 'squash') {
      return failed(`unsupported_merge_strategy:${strategy}`);
    }

    const args = ['-C', target.projectDir, 'merge', `--${strategy}`];
    const message = asString(payload.message);
    // --squash 不产生提交，消息无处可去；带着它只会被 git 拒掉，所以显式说明而不是假装用上。
    if (message && strategy !== 'squash') args.push('-m', message);
    args.push(source.value);
    const exec = await this.executor.git(args, { timeoutMs: GIT_TIMEOUT_MS });
    if (exec.exitCode !== 0) {
      const conflicts = await this.conflictedPaths(target.projectDir);
      if (conflicts.length > 0) {
        // 冲突不是"命令没跑成"就完事：把冲突文件当场回给云端，界面立刻能指出是哪几个。
        this.markDirty();
        return {
          status: 'failed',
          result: {
            exit_code: exec.exitCode,
            conflicts,
            stdout_tail: tail(exec.stdout + exec.stderr, this.secrets),
            duration_ms: exec.durationMs,
          },
          error: `merge_conflict:${conflicts.slice(0, 5).join(',')}`,
        };
      }
    }
    const outcome = this.withResult(exec);
    if (outcome.status !== 'succeeded') return outcome;
    this.markDirty();
    if (strategy === 'squash' && message) {
      return { status: 'succeeded', result: { ...(outcome.result ?? {}), message_ignored: 'squash_does_not_commit' } };
    }
    return outcome;
  }

  /**
   * 冲突文件列表走 `diff --diff-filter=U`，不解析 stderr 的 `CONFLICT (...)` 文本：
   * 后者是人读消息，措辞随 git 版本与语言环境变；未合并过滤是稳定接口。
   */
  private async conflictedPaths(projectDir: string): Promise<string[]> {
    const result = await this.executor.git(
      ['-C', projectDir, '-c', 'core.quotepath=false', 'diff', '--name-only', '--diff-filter=U'],
      { timeoutMs: GIT_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) return [];
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => isSafeRelativePath(line));
  }

  private async gitMergeAbort(
    _payload: Record<string, unknown>,
    target: TargetContext,
  ): Promise<Omit<ResultEnvelope, 'command_id'>> {
    const exec = await this.executor.git(['-C', target.projectDir, 'merge', '--abort'], { timeoutMs: GIT_TIMEOUT_MS });
    const outcome = this.withResult(exec);
    if (outcome.status === 'succeeded') {
      this.markDirty();
      return outcome;
    }
    // `--squash` 冲突不写 MERGE_HEAD，于是 `merge --abort` 报"没有合并进行中"，而未合并的
    // 索引还原样留在仓库里。这时候回 succeeded 就是骗界面（用户以为冲突已被放弃）。
    // 真要继续只能 reset/checkout -f 丢工作区——那是云端按钮不该有的权力，所以显式失败。
    if (/no merge in progress|MERGE_HEAD missing/i.test(`${exec.stdout}\n${exec.stderr}`)) {
      const conflicts = await this.conflictedPaths(target.projectDir);
      if (conflicts.length === 0) {
        return { status: 'succeeded', result: { ...(outcome.result ?? {}), noop: 'no_merge_in_progress' } };
      }
      this.markDirty();
      return {
        status: 'failed',
        result: { ...(outcome.result ?? {}), conflicts },
        error: `refused:unmerged_index_without_merge_head(${conflicts.slice(0, 5).join(',')})`,
      };
    }
    return outcome;
  }

  // ------------------------------------------------------------------ 文件

  private async fileDelete(
    payload: Record<string, unknown>,
    target: TargetContext,
  ): Promise<Omit<ResultEnvelope, 'command_id'>> {
    const rel = asString(payload.path);
    if (!rel) return failed('invalid_input:path');
    // upstream/ 是第三方仓库工作区，按策略只读；输入原件同样不许 Agent 删。
    if (rel.split('/').includes('upstream')) return failed(`refused_path:upstream(${basename(rel)})`);

    const candidate = resolveWithin(target.projectDir, rel);
    if (!candidate) return failed(`unsafe_path:${basename(rel)}`);

    const info = await lstat(candidate).catch(() => null);
    if (!info) return failed(`not_found:${basename(candidate)}`);
    if (info.isSymbolicLink()) return failed(`refused_symlink:${basename(candidate)}`);
    if (!info.isFile()) return failed('refuses_directory');

    // 符号链接逃逸：真实父目录必须仍在真实项目根之内。
    const realRoot = await realpath(target.projectDir).catch(() => resolve(target.projectDir));
    const realParent = await realpath(join(candidate, '..')).catch(() => null);
    if (!realParent) return failed(`not_found:${basename(candidate)}`);
    if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) {
      return failed('escaped_project_root');
    }

    await unlink(candidate);
    this.manifests.invalidate(target.projectDir);
    this.markDirty();
    this.log(`deleted one file in ${target.project?.name ?? basename(target.projectDir)}`);
    return { status: 'succeeded', result: { exit_code: 0, deleted: true, duration_ms: 0 } };
  }

  // ------------------------------------------------------------------ 公共

  /**
   * 载荷里的 ref 字段：`undefined` 与非法值必须分开——前者是"没要求"，后者要当场失败，
   * 静默忽略等于把用户点的按钮变成 no-op。
   */
  private refField(payload: Record<string, unknown>, key: string): { value: string | null } | { error: string } {
    const raw = payload[key];
    if (raw === undefined || raw === null) return { value: null };
    return isSafeRef(raw) ? { value: raw } : { error: `invalid_input:${key}` };
  }

  /** 工作区被命令改过：清掉上报缓存，下一轮心跳带的就是新读数。 */
  private markDirty(): void {
    this.invalidateReports?.();
  }

  /** 把一次子进程执行压成协议里的 result 形状。 */
  private withResult(exec: ExecResult, acceptedCodes: number[] = [0]): Omit<ResultEnvelope, 'command_id'> {
    const ok = exec.exitCode !== null && acceptedCodes.includes(exec.exitCode) && !exec.timedOut;
    const parsed = parseJsonOutput(exec.stdout);
    const result: Record<string, unknown> = {
      ...(parsed ?? {}),
      exit_code: exec.exitCode,
      stdout_tail: tail(exec.stdout, this.secrets),
      duration_ms: exec.durationMs,
    };
    if (exec.timedOut) result.timed_out = true;
    return ok
      ? { status: 'succeeded', result }
      : {
          status: 'failed',
          result,
          error: exec.timedOut
            ? `timeout_after_${Math.round((exec.durationMs ?? 0) / 1000)}s`
            : firstLine(exec.stderr || exec.stdout || `exit_code_${exec.exitCode}`, this.secrets),
        };
  }
}

function failed(error: string): Omit<ResultEnvelope, 'command_id'> {
  return { status: 'failed', error };
}

function parseJsonOutput(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split('\n').filter((line) => line.trim() !== '');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line.trimStart().startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* 继续往上找那条真正的 --json 行 */
    }
  }
  return null;
}

function isNothingToCommit(output: string): boolean {
  return output.includes('nothing to commit') || output.includes('nothing added to commit');
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * 目录名只用得到"安全字符 + 原名"：云端的 name 已经限长 80，但 `..`、分隔符、
 * 盘符必须挡掉，否则 `project_create` 就是一个任意目录创建原语。
 */
function slugify(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/\.+$/, '')
    .slice(0, 60);
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? `project-${Date.now()}` : cleaned;
}
