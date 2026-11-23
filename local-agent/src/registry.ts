/**
 * 本地项目发现。
 *
 * 权威来源是引擎自己写的文件，不做任何发明：
 * - 项目标记 = 目录里有 `.research/`（`src/config/paths.ts` 的 `isProjectRoot` 就是这么判的；
 *   `research.yaml` 在项目根而不是 `.research/` 下）。
 * - 显示名 = `research.yaml` 的 `project.name`，缺省退回目录名（同 `loadConfig` 的默认值）。
 * - `external_id` = 云端投影用的那个 `proj-…`，只在 `.research/workflow.db` 的 `project` 表里
 *   （`ProjectRuntime.open` → `db.ensureProject({root})`）。本地 Agent 没有 SQL 依赖，
 *   所以按"引擎已经写出的投影字节 → node:sqlite → 未知"三级读取；读不到就报 null，
 *   让控制台明白这个项目还没有可对齐的投影身份，而不是编一个。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { LocalProjectRef } from './protocol.js';

export const RESEARCH_DIR = '.research';
const CONFIG_FILE = 'research.yaml';
/** 不往下钻的目录：既省 inode，也避免把论文目录当成项目。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'upstream', 'worktrees', '.venv', 'venv', '__pycache__']);
const MAX_DEPTH = 3;
export const MAX_DISCOVERED_PROJECTS = 100;

export interface ResearchConfig {
  project?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  policy?: Record<string, unknown>;
  research?: Record<string, unknown>;
}

export async function readConfig(projectDir: string): Promise<ResearchConfig | null> {
  try {
    const parsed = parseYaml(await readFile(join(projectDir, CONFIG_FILE), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as ResearchConfig) : null;
  } catch {
    return null;
  }
}

export async function discoverProjects(agentRoot: string): Promise<LocalProjectRef[]> {
  const found: LocalProjectRef[] = [];
  await scan(resolve(agentRoot), 0, found);
  return found;
}

async function scan(dir: string, depth: number, out: LocalProjectRef[]): Promise<void> {
  if (out.length >= MAX_DISCOVERED_PROJECTS) return;

  if (await isDirectory(join(dir, RESEARCH_DIR))) {
    out.push({ path: dir, name: await projectName(dir), external_id: await readExternalId(dir) });
    // 项目内部不再递归：嵌套项目不是本引擎的布局假设，钻进去只会把 papers/ 扫一遍。
    return;
  }
  if (depth >= MAX_DEPTH) return;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries.sort()) {
    if (out.length >= MAX_DISCOVERED_PROJECTS) return;
    if (SKIP_DIRS.has(entry)) continue;
    if (entry.startsWith('.') && entry !== RESEARCH_DIR) continue;
    const child = join(dir, entry);
    if (!(await isDirectory(child))) continue;
    await scan(child, depth + 1, out);
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function projectName(dir: string): Promise<string> {
  const name = (await readConfig(dir))?.project?.name;
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : basename(dir);
}

/**
 * 投影批次里就带着 `project.external_id`（`src/cloud/projector.ts` 的 envelope）。
 * 队列文件在 accepted 之后会被删除，所以这只是"最近一次 push 用过的身份"；
 * 拿不到再走 SQLite，最后才认 null。
 */
async function readExternalId(projectDir: string): Promise<string | null> {
  const queueDirs = [
    join(projectDir, RESEARCH_DIR, 'cloud', 'pending'),
    join(projectDir, RESEARCH_DIR, 'cloud', 'dropped'),
  ];
  for (const dir of queueDirs) {
    const id = await externalIdFromQueue(dir);
    if (id) return id;
  }
  return externalIdFromDatabase(join(projectDir, RESEARCH_DIR, 'workflow.db'), projectDir);
}

async function externalIdFromQueue(dir: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  // 文件名即顺序（`000012-bat-….json`），最大序号那条 = 最近一次投影。
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort().reverse()) {
    try {
      const record = JSON.parse(await readFile(join(dir, name), 'utf8')) as {
        batch?: { project?: { external_id?: unknown } };
      };
      const id = record.batch?.project?.external_id;
      if (typeof id === 'string' && id.length > 0) return id;
    } catch {
      continue;
    }
  }
  return null;
}

interface DatabaseLike {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean; timeout?: number }) => DatabaseLike;
}

async function externalIdFromDatabase(dbFile: string, projectDir: string): Promise<string | null> {
  let sqlite: SqliteModule;
  try {
    // node:sqlite 只在 Node ≥22.5 存在；没有它就等于"这个项目还没有可读的身份"。
    sqlite = (await import('node:sqlite')) as unknown as SqliteModule;
  } catch {
    return null;
  }
  let handle: DatabaseLike | null = null;
  try {
    handle = new sqlite.DatabaseSync(dbFile, { readOnly: true, timeout: 500 });
    const rows = handle.prepare('SELECT id, root FROM project').all() as Array<{ id: string; root: string }>;
    const wanted = normalizeRoot(projectDir);
    const match = rows.find((row) => normalizeRoot(String(row.root ?? '')) === wanted);
    return typeof match?.id === 'string' && match.id.length > 0 ? match.id : null;
  } catch {
    return null;
  } finally {
    try {
      handle?.close();
    } catch {
      /* 从未打开或已关闭 */
    }
  }
}

function normalizeRoot(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const unified = trimmed.split(/[\\/]/).join(sep);
  // Windows：盘符大小写与分隔符在不同调用路径上不一致（git bash / node / 引擎各一套）。
  return process.platform === 'win32' ? unified.toLowerCase() : unified;
}

/**
 * 输入目录（manifest 只读这些）：`research.yaml` 的 inputs 段优先，缺省用引擎默认值，
 * 再补 `incoming/`——它没有配置键，但 Workspace Intake 按 rootName 分类时把它算作入口
 * （`src/knowledge/scan.ts`）。
 */
export async function readInputDirs(projectDir: string): Promise<Array<{ dir: string; kind: string }>> {
  const inputs = (await readConfig(projectDir))?.inputs ?? {};
  const pick = (key: string, fallback: string): string =>
    typeof inputs[key] === 'string' && inputs[key]!.trim() !== '' ? String(inputs[key]).trim() : fallback;
  return [
    { dir: pick('papers_dir', 'papers'), kind: 'paper' },
    { dir: pick('datasets_dir', 'datasets'), kind: 'dataset' },
    { dir: pick('comparisons_dir', 'comparisons'), kind: 'comparison' },
    { dir: 'incoming', kind: 'incoming' },
  ];
}
