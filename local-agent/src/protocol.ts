/**
 * 反向通道的共享类型与不变量。
 *
 * 这里的每一个上限都是从云端实现（`web/functions/commands.ts`）抄来的，不是本地偏好：
 * 超出的部分云端会静默截掉（`results.slice(0, 20)`、`git.slice(0, 20)`、
 * `nodes.slice(0, 2000)`），本地看不见就会变成"结果丢了"。改了云端必须同时改这里。
 */

export const AGENT_VERSION = '0.2.0';

/** 心跳里 `results` 的上限：超出的会被 applyResults 丢掉，不回报。 */
export const MAX_RESULTS_PER_HEARTBEAT = 20;
/** 单次心跳最多上报几个项目的仓库/文件读数（云端 slice(0, 20)）。 */
export const MAX_REPORTED_PROJECTS = 20;
/** `local_projects` 上限（云端 slice(0, 100)，且 path 截到 200、name 截到 80）。 */
export const MAX_LOCAL_PROJECTS = 100;
/** 每个项目最多文件节点（云端 MAX_FILE_NODES）。 */
export const MAX_FILE_NODES = 2_000;
/** 分支/冲突/远端读数的切片上限，同样抄自云端 sanitize*（超出的部分云端直接丢掉）。 */
export const MAX_REPORTED_BRANCHES = 200;
export const MAX_REPORTED_CONFLICTS = 200;
export const MAX_REPORTED_REMOTES = 20;
/** 单文件上报阈值：更大的文件不进清单，也不做哈希。 */
export const MAX_REPORTED_FILE_BYTES = 50 * 1024 * 1024;

export const STDOUT_TAIL_CHARS = 4_000;
/** 云端把 error 截到 500，只回显首行；本地先按首行截，避免整段 stdout 出网。 */
export const ERROR_LINE_CHARS = 300;

export type TerminalStatus = 'succeeded' | 'failed' | 'expired' | 'canceled';

export interface ClaimedCommand {
  command_id: string;
  type: string;
  payload: Record<string, unknown>;
  project_id: string | null;
}

export interface ResultEnvelope {
  command_id: string;
  status: TerminalStatus;
  result?: Record<string, unknown>;
  error?: string | null;
}

export interface LocalProjectRef {
  path: string;
  name: string;
  external_id: string | null;
}

export interface GitBranchReading {
  name: string;
  current: boolean;
  ahead: number | null;
  behind: number | null;
}

export interface GitReportEntry {
  external_id: string | null;
  branch: string | null;
  ahead: number | null;
  behind: number | null;
  staged: number | null;
  unstaged: number | null;
  untracked: number | null;
  dirty: boolean | null;
  last_commit_hash: string | null;
  last_commit_at: string | null;
  last_commit_text: string | null;
  /**
   * Phase 7 的三个读数：读失败必须是 `null`（云端写 null → 界面显示"还没上报"），
   * 不许用 `[]` 冒充"读到了但仓库是空的"——那会把"Agent 没这条读数"说成"你没有分支"。
   */
  branches: GitBranchReading[] | null;
  /** 冲突只有路径，没有正文：三栏 diff 需要的内容永远不进云（0004 头注）。 */
  conflicts: string[] | null;
  /** 只报 remote 名字：URL 可能内嵌凭据（`https://user:token@host`）。 */
  remotes: string[] | null;
}

export interface FileNode {
  path: string;
  kind: string;
  size: number;
  mime_type: string | null;
  updated_at: string;
}

export interface HeartbeatRequest {
  agent_version?: string;
  local_projects?: LocalProjectRef[];
  results?: ResultEnvelope[];
  reported?: { git?: GitReportEntry[]; files?: Array<{ external_id: string; nodes: FileNode[] }> };
}

export interface AppliedResult {
  command_id: string;
  applied: boolean;
  reason?: string;
}

export interface HeartbeatResponse {
  ok: boolean;
  server_time: string;
  lease_ms: number;
  applied_results: AppliedResult[];
  applied_reported: {
    git: string[];
    files: string[];
    file_nodes_written: number[];
    skipped: string[];
  };
  expired_commands: string[];
  commands: ClaimedCommand[];
}

const CREDENTIAL_SHAPE = /(api[_-]?key|secret|password|passwd|token|authorization)\s*[:=]\s*\S+/gi;
/**
 * git 的错误文本会把 remote URL 原样打出来（`unable to access
 * 'https://user:ghp_xxx@github.com/...'`），而带凭据的 URL 是用户自己配在仓库里的。
 * 这类串是本次运行里唯一会离开本机的第三方秘密，所以整段 userinfo 一律剥掉。
 */
const URL_USERINFO = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@:]+:[^\s@/]+@/g;

/**
 * ref 名的机械不变量，与云端 `commands.ts` 的 `isSafeRef` 同一条。本地再守一遍不是
 * 重复劳动：分支名是直接拼进 `git` argv 的，而以 `-` 开头的名字会被 git 当成开关，
 * 一个没有该校验的旧云端（或手工排的队）就等于递给用户一个参数注入面。
 */
export function isSafeRef(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 80) return false;
  if (value.startsWith('-') || value.startsWith('/') || value.startsWith('.')) return false;
  if (value.endsWith('/') || value.endsWith('.') || value.endsWith('.lock')) return false;
  if (/[\s~^:?*[\\@{}]/.test(value)) return false;
  if (value.includes('..')) return false;
  return !value.split('/').some((segment) => segment === '' || segment === '.');
}

/** 云端可删的分支集合之外的事不替用户决定：主分支删除只能在自己终端做。 */
export const PROTECTED_BRANCHES = new Set(['main', 'master']);

/**
 * 相对路径的机械不变量，与云端 `isSafeRelativePath` 同一条。要进云的路径（文件清单、
 * 冲突列表、`git_commit` 的 files）先按云的形状自检：形状不对的东西到了云端会被静默
 * 丢掉，本地不筛就等于上报一份"看起来成功了"的清单。
 */
export function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return false;
  if (value.startsWith('/') || value.startsWith('\\') || value.startsWith('~')) return false;
  if (/^[a-zA-Z]:/.test(value)) return false;
  if (value.includes('\\')) return false;
  return !value.split('/').some((segment) => segment === '..' || segment === '');
}

/**
 * 错误与输出在离机器之前先过一遍：
 * 1. 调用方给出的凭据值（token 等）整串替换；
 * 2. URL 里内嵌的 userinfo 剥掉；
 * 3. 凭据形状的 `key: value` 只留键名。
 * 这是本地兜底，不代替"绝不把密钥写进参数/文件"的规则——规则失守时这里再挡一次。
 */
export function redact(value: string, secrets: string[] = []): string {
  let out = value;
  for (const secret of secrets) {
    if (secret.length >= 6) out = out.split(secret).join('***');
  }
  return out.replace(URL_USERINFO, '$1***@').replace(CREDENTIAL_SHAPE, (_match, key: string) => `${key}=***`);
}

/** 首行 + 截断：与云端 commandCard 的读法一致，多行原文不出网。 */
export function firstLine(value: string, secrets: string[] = []): string {
  const lines = redact(value, secrets).split('\n');
  // 跳过 stack 帧：Node 的崩溃第一行往往是 `node:internal/modules/...:447`，
  // 对云端读者毫无信息量；真正的 `Error [...]:` 那行才是可行动的第一句。
  const informative =
    lines.find((line) => /^(error|Error|error:|ideaseek|fatal)/.test(line.trim())) ??
    lines.find((line) => line.trim() !== '' && !line.trim().startsWith('at '));
  return (informative ?? '').trim().slice(0, ERROR_LINE_CHARS);
}

export function tail(value: string, secrets: string[] = []): string {
  return redact(value, secrets).slice(-STDOUT_TAIL_CHARS);
}
