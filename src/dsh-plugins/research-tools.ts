import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * IdeaSeek research tool plugin, loaded into the DSH subprocess via a
 * generated Cordis patch (absolute path). Registered tools automatically feed
 * their schemas into system-prompt assembly; every model-driven call lands in
 * the durable session log as `tool/call` + `tool/result` (the audit trail).
 *
 * Security: `project_read` is read-only and hard-restricted to the project
 * workspace passed through `IDEASEEK_WORKSPACE_ROOT` (defense in depth under
 * the DSH read-only sandbox): absolute paths and `..` escapes are rejected.
 * The tool never touches credentials, `.research/` internals or files outside
 * the workspace root.
 */
export const inject = ['tools'];

const MAX_BYTES = 1024 * 1024;

function workspaceRoot(): string | null {
  const root = process.env.IDEASEEK_WORKSPACE_ROOT;
  return root && isAbsolute(root) ? normalize(root) : null;
}

/** Windows drive (`C:\…`) or UNC (`\\server\share`) — rejected as absolute. */
const WIN_ABSOLUTE = /^(?:[a-zA-Z]:[/\\]|[\\/]{2})/;

/**
 * Resolves a caller-supplied path strictly inside the workspace root.
 * Platform-agnostic: works with either separator in `root` or `relative`
 * (the DSH subprocess runs on the host OS, tests run on both). A single
 * leading separator means "relative to the project root", never OS-absolute.
 * Exported for permission unit tests; also used by `execute`.
 */
export function resolveInsideWorkspace(root: string, relative: string): string {
  if (WIN_ABSOLUTE.test(relative)) {
    throw new Error('project_read: absolute paths are not allowed; pass a project-relative path');
  }
  const cleaned = relative.replace(/^[/\\]+/, '');
  if (cleaned.split(/[\\/]/).includes('..')) {
    throw new Error('project_read: path escapes the workspace root');
  }
  // Deny platform-managed segments anywhere in the path: the .research
  // database/audit tree and any .env* credential file.
  const denied = cleaned
    .split(/[\\/]/)
    .some(
      (segment) => segment === '.research' || segment === '.env' || segment.startsWith('.env.'),
    );
  if (denied) {
    throw new Error(`project_read: ${cleaned} is platform-managed and not readable by agents`);
  }
  const rootNorm = normalize(root);
  const abs = normalize(join(rootNorm, cleaned));
  const rootWithSep = rootNorm.endsWith(sep) ? rootNorm : rootNorm + sep;
  if (abs !== rootNorm && !abs.startsWith(rootWithSep)) {
    throw new Error('project_read: path escapes the workspace root');
  }
  return abs;
}

/**
 * Resolves the ideaseek CLI for the knowledge_search tool: explicit env wins,
 * else the built CLI next to this module (dist/dsh-plugins → dist/cli.js).
 */
export function resolveIdeaseekCli(): string | null {
  const fromEnv = process.env.IDEASEEK_CLI_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/dsh-plugins → dist/cli.js (built layout); src/dsh-plugins →
  // ../../dist/cli.js (tests import sources but spawn the built CLI).
  for (const candidate of [
    resolvePath(here, '..', 'cli.js'),
    resolvePath(here, '..', '..', 'dist', 'cli.js'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface KnowledgeSearchOptions {
  query: string;
  limit?: number;
  cwd: string;
  timeoutMs?: number;
}

/**
 * Runs `ideaseek search --json` in the project and formats page-level hits
 * for the model. The DSH subprocess never opens the workflow DB directly —
 * the CLI is the single writer/reader protocol, keeping locking and schema
 * in one place. Output is bounded and contains only indexed page snippets.
 */
export function runKnowledgeSearch(opts: KnowledgeSearchOptions): string {
  const terms = opts.query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) throw new Error('knowledge_search: empty query');
  const cli = resolveIdeaseekCli();
  if (!cli) {
    throw new Error(
      'knowledge_search: ideaseek CLI not found (build dist/ or set IDEASEEK_CLI_PATH)',
    );
  }
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const result = spawnSync(
    process.execPath,
    [cli, 'search', ...terms, '--json', '--limit', String(limit)],
    { cwd: opts.cwd, encoding: 'utf8', timeout: opts.timeoutMs ?? 120_000 },
  );
  if (result.error) {
    throw new Error(`knowledge_search: ${result.error.message}`);
  }
  const stdout = (result.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim().slice(0, 300);
    throw new Error(
      `knowledge_search failed (exit ${result.status}): ${stderr || stdout.slice(0, 200)}`,
    );
  }
  let payload: { hits?: { source: string; page: number; snippet: string }[] };
  try {
    payload = JSON.parse(stdout) as typeof payload;
  } catch {
    throw new Error('knowledge_search: unreadable CLI output');
  }
  const hits = payload.hits ?? [];
  if (hits.length === 0) return 'no matching passages in parsed papers';
  return hits.map((hit) => `${hit.source}:p${hit.page} — ${hit.snippet}`).join('\n');
}

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'knowledge_search',
      description:
        'Full-text search across parsed papers in this project; returns page-level ' +
        'hits with snippets (source:pN — text). Read-only.',
      parameters: {
        query: { type: 'string', required: true, description: 'search terms' },
        limit: { type: 'number', description: 'maximum hits (default 10, max 50)' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args: { query: string; limit?: number }): Promise<string> {
        const cwd = workspaceRoot() ?? process.cwd();
        return runKnowledgeSearch({ query: args.query, limit: args.limit, cwd });
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'project_read',
      description:
        'Read a UTF-8 text file from the IdeaSeek project workspace. Read-only; ' +
        'project-relative paths only; platform directories (.research, .env) are denied.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Project-relative file path, e.g. "papers/notes.md"',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args: { path: string }): Promise<string> {
        const root = workspaceRoot();
        if (!root) {
          throw new Error(
            'project_read: IDEASEEK_WORKSPACE_ROOT is not set; the tool is unavailable',
          );
        }
        const target = resolveInsideWorkspace(root, args.path);
        const text = await readFile(target, 'utf8');
        if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
          return `${text.slice(0, MAX_BYTES)}\n…[truncated at ${MAX_BYTES} bytes]`;
        }
        return text;
      },
    }),
  );
}
