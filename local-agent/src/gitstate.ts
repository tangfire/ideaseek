/**
 * 单个项目目录的仓库读数 → `reported.git` 条目。
 *
 * 全部走 plumbing 而不是 `git status` 的人类输出：porcelain v1 与 `--format` 是 git 承诺
 * 稳定的接口，人读格式不是。任何一步失败只影响对应字段（置 null），不抛错——
 * 控制台宁可看到"branch 有、ahead 无"，也不要一个没配 remote 的新仓库把整轮心跳打死。
 */
import type { CLIExecutor } from './executor.js';
import {
  MAX_REPORTED_BRANCHES,
  MAX_REPORTED_CONFLICTS,
  MAX_REPORTED_REMOTES,
  isSafeRef,
  type GitBranchReading,
  type GitReportEntry,
} from './protocol.js';

const GIT_TIMEOUT_MS = 15_000;
/**
 * 分支名与冲突路径都可能带非 ASCII（中文目录/分支）。git 默认 `core.quotepath=true`
 * 会把它们输出成 `"\\344\\270\\255..."` 这种八进制转义，转义串既过不了云端的路径校验，
 * 也不是人能读的名字——所有要上报名字的读数都强制关掉 quotepath。
 */
const QUOTEPATH_OFF = ['-c', 'core.quotepath=false'];

export async function readGitReport(
  projectDir: string,
  externalId: string | null,
  executor: CLIExecutor,
): Promise<GitReportEntry | null> {
  const inside = await git(executor, projectDir, ['rev-parse', '--is-inside-work-tree']);
  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') return null;

  const branch = await git(executor, projectDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  // 分离 HEAD 时 --abbrev-ref 输出字面量 "HEAD"，而上游 refs/heads/HEAD 是 git 自己
  // 不允许的分支名：所以看到 "HEAD" 就是"没有分支"，报成 null 而不是一个叫 HEAD 的分支。
  const branchName = branch.exitCode === 0 ? orNull(branch.stdout) : null;
  const entry: GitReportEntry = {
    external_id: externalId,
    branch: branchName === 'HEAD' ? null : branchName,
    ahead: null,
    behind: null,
    staged: null,
    unstaged: null,
    untracked: null,
    dirty: null,
    last_commit_hash: null,
    last_commit_at: null,
    last_commit_text: null,
    branches: null,
    conflicts: null,
    remotes: null,
  };

  const upstream = await git(executor, projectDir, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}',
  ]);
  if (upstream.exitCode === 0 && upstream.stdout.trim() !== '') {
    const name = upstream.stdout.trim();
    entry.ahead = await countRange(executor, projectDir, `${name}..HEAD`);
    entry.behind = await countRange(executor, projectDir, `HEAD..${name}`);
  }

  const status = await git(executor, projectDir, ['status', '--porcelain=v1']);
  if (status.exitCode === 0) {
    const counts = countStatusLines(status.stdout);
    entry.staged = counts.staged;
    entry.unstaged = counts.unstaged;
    entry.untracked = counts.untracked;
    entry.dirty = counts.staged + counts.unstaged + counts.untracked > 0;
  }

  const branches = await readBranches(executor, projectDir);
  if (branches) entry.branches = branches;

  // 只在真的脏的时候才查冲突：一次额外的 `diff --diff-filter=U` 在干净仓库上是纯浪费，
  // 而冲突只在有未合并路径时可能存在。
  if (entry.dirty) {
    const conflicts = await gitOut(executor, projectDir, [...QUOTEPATH_OFF, 'diff', '--name-only', '--diff-filter=U']);
    if (conflicts !== null) {
      entry.conflicts = conflicts
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('"'))
        .slice(0, MAX_REPORTED_CONFLICTS);
    }
  } else {
    entry.conflicts = [];
  }

  const remotes = await gitOut(executor, projectDir, ['remote']);
  if (remotes !== null) {
    entry.remotes = remotes
      .split('\n')
      .map((line) => line.trim())
      .filter((name) => isSafeRef(name))
      .slice(0, MAX_REPORTED_REMOTES);
  }

  // %x1f 分隔：提交摘要里可能出现空格或短横，用制表符切才不会把 subject 切错。
  const last = await git(executor, projectDir, ['log', '-1', '--format=%H%x1f%cI%x1f%s']);
  if (last.exitCode === 0) {
    const [hash, at, ...subject] = last.stdout.trim().split('\u001f');
    if (hash) {
      entry.last_commit_hash = hash;
      entry.last_commit_at = at ?? null;
      entry.last_commit_text = subject.join('\u001f') || null;
    }
  }

  return entry;
}

/**
 * 一次 `for-each-ref` 拿到全部分支 + 当前指针 + 上游跟踪读数。
 *
 * 不用 N 次 `rev-list` 逐分支算领先/落后：分支多的心跳会把每个项目变成几十次 git
 * 进程启动（Windows 上每次 30–60 ms）。`%(upstream:track)` 的字符串是 git 的稳定输出，
 * 解析不出来就报 null——界面显示"未知"比显示错误的数字好。
 */
async function readBranches(executor: CLIExecutor, dir: string): Promise<GitBranchReading[] | null> {
  const result = await gitOut(executor, dir, [
    ...QUOTEPATH_OFF,
    'for-each-ref',
    '--format=%(refname:strip=2)%1f%(HEAD)%1f%(upstream:track)',
    'refs/heads/',
  ]);
  if (result === null) return null;

  const items: GitBranchReading[] = [];
  for (const line of result.split('\n')) {
    const [name, head, track] = line.split('\u001f');
    if (!name || !isSafeRef(name)) continue;
    const ahead = /ahead (\d+)/.exec(track ?? '');
    const behind = /behind (\d+)/.exec(track ?? '');
    items.push({
      name,
      current: head === '*',
      ahead: ahead ? Number(ahead[1]) : null,
      behind: behind ? Number(behind[1]) : null,
    });
    if (items.length >= MAX_REPORTED_BRANCHES) break;
  }
  return items;
}

async function countRange(executor: CLIExecutor, dir: string, range: string): Promise<number | null> {
  const result = await git(executor, dir, ['rev-list', '--count', range]);
  if (result.exitCode !== 0) return null;
  const value = Number(result.stdout.trim());
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function countStatusLines(porcelain: string): { staged: number; unstaged: number; untracked: number } {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of porcelain.split('\n')) {
    if (line.length < 3) continue;
    const index = line[0]!;
    const worktree = line[1]!;
    if (index === '?' && worktree === '?') {
      untracked += 1;
      continue;
    }
    if (index === '!') continue;
    if (index !== ' ') staged += 1;
    if (worktree !== ' ') unstaged += 1;
  }
  return { staged, unstaged, untracked };
}

async function git(executor: CLIExecutor, dir: string, args: string[]) {
  return executor.git(['-C', dir, ...args], { timeoutMs: GIT_TIMEOUT_MS, captureLimit: 1_000_000 });
}

/** 只要 stdout 的读数：非零退出返回 null，调用方按"没读到"处理，不冒充"读到空"。 */
async function gitOut(executor: CLIExecutor, dir: string, args: string[]): Promise<string | null> {
  const result = await git(executor, dir, args);
  return result.exitCode === 0 ? result.stdout : null;
}

function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
