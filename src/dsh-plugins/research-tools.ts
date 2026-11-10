import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';

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

export function apply(ctx: Context): void {
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
