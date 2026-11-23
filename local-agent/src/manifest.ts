/**
 * 输入清单 → `reported.files`。
 *
 * 只走输入目录（papers/datasets/comparisons + 配置里的 *_dir + incoming），只读：
 * 原始输入按策略不可修改，这里连内容都不打开（不读、不哈希），只取目录项 metadata。
 * 清单里只有路径、大小、类型与 mtime——协议也只定义这些字段。
 *
 * 遍历用 lstat 并跳过符号链接：跟随链接会让"只报项目内文件"变成假话，
 * 一个指向 / 的链接就能把整台机器的文件树报上云。
 */
import { lstat, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { readInputDirs, RESEARCH_DIR } from './registry.js';
import { MAX_FILE_NODES, MAX_REPORTED_FILE_BYTES, type FileNode } from './protocol.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', 'venv', '__pycache__', RESEARCH_DIR]);

/** 常见科研输入的 MIME；未知扩展名一律 application/octet-stream，不做内容嗅探。 */
const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  bib: 'application/x-bibtex',
  tex: 'application/x-tex',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  jsonl: 'application/x-ndjson',
  ndjson: 'application/x-ndjson',
  parquet: 'application/vnd.apache.parquet',
  npy: 'application/x-npy',
  npz: 'application/x-npz',
  gz: 'application/gzip',
  gzip: 'application/gzip',
  zip: 'application/zip',
  tar: 'application/x-tar',
  tgz: 'application/gzip',
  md: 'text/markdown',
  txt: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  py: 'text/x-python',
  ipynb: 'application/x-ipynb+json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
};

export interface ManifestOptions {
  maxNodes?: number;
  maxFileBytes?: number;
}

/**
 * 心跳每 15 s 一轮，输入目录可能有几千个 PDF；按 TTL 复用上一次遍历结果，
 * 否则每个周期都在重扫 metadata。文件删除命令执行后由 router 主动失效。
 */
export class ManifestCache {
  private readonly entries = new Map<string, { builtAt: number; nodes: FileNode[] }>();

  constructor(
    private readonly ttlMs: number,
    private readonly options: ManifestOptions = {},
  ) {}

  async get(projectDir: string): Promise<FileNode[]> {
    const cached = this.entries.get(projectDir);
    if (cached && Date.now() - cached.builtAt < this.ttlMs) return cached.nodes;
    const nodes = await buildFileManifest(projectDir, this.options);
    this.entries.set(projectDir, { builtAt: Date.now(), nodes });
    return nodes;
  }

  invalidate(projectDir?: string): void {
    if (projectDir) this.entries.delete(projectDir);
    else this.entries.clear();
  }
}

export async function buildFileManifest(
  projectDir: string,
  options: ManifestOptions = {},
): Promise<FileNode[]> {
  const maxNodes = options.maxNodes ?? MAX_FILE_NODES;
  const maxBytes = options.maxFileBytes ?? MAX_REPORTED_FILE_BYTES;
  const root = resolve(projectDir);
  const nodes: FileNode[] = [];

  for (const { dir, kind } of await readInputDirs(root)) {
    const base = resolveWithin(root, dir);
    if (!base) continue;
    await walk(root, base, kind, nodes, maxNodes, maxBytes);
    if (nodes.length >= maxNodes) break;
  }
  return nodes.sort((a, b) => a.path.localeCompare(b.path));
}

async function walk(
  root: string,
  dir: string,
  kind: string,
  nodes: FileNode[],
  maxNodes: number,
  maxBytes: number,
): Promise<void> {
  if (nodes.length >= maxNodes) return;

  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }

  for (const name of names.sort()) {
    if (nodes.length >= maxNodes) return;
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    const target = join(dir, name);

    const info = await lstat(target).catch(() => null);
    if (!info || info.isSymbolicLink()) continue;

    if (info.isDirectory()) {
      await walk(root, target, kind, nodes, maxNodes, maxBytes);
      continue;
    }
    if (!info.isFile() || info.size > maxBytes) continue;

    nodes.push({
      path: toPosix(relative(root, target)),
      kind,
      size: info.size,
      mime_type: mimeOf(name),
      updated_at: info.mtime.toISOString(),
    });
  }
}

function mimeOf(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return MIME[ext] ?? 'application/octet-stream';
}

function toPosix(path: string): string {
  // 云端 isSafeRelativePath 明确拒绝反斜杠；Windows 上 relative() 给的就是反斜杠。
  return sep === '/' ? path : path.split(sep).join('/');
}

export function resolveWithin(root: string, relPath: string): string | null {
  if (relPath.length === 0) return null;
  if (relPath.startsWith('/') || relPath.startsWith('\\') || relPath.startsWith('~')) return null;
  if (/^[a-zA-Z]:/.test(relPath)) return null;
  if (relPath.split(/[\\/]/).some((segment) => segment === '..')) return null;
  // root 要先 resolve：调用方可能传 `/` 分隔的同一个目录（git bash、云端配置、
  // path.join 三种来源各不相同），不归一化就会把合法的项目内路径判成越界。
  const base = resolve(root);
  const candidate = resolve(base, relPath);
  return candidate === base || candidate.startsWith(base + sep) ? candidate : null;
}
