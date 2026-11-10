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
const DENIED_PREFIXES = ['.research/', '.env'];

function workspaceRoot(): string | null {
  const root = process.env.IDEASEEK_WORKSPACE_ROOT;
  return root && isAbsolute(root) ? normalize(root) : null;
}

function resolveInsideWorkspace(root: string, relative: string): string {
  if (isAbsolute(relative)) {
    throw new Error('project_read: absolute paths are not allowed; pass a project-relative path');
  }
  const normalized = normalize(relative).replace(/^([/\\])+/, '');
  if (normalized.split(/[\\/]/).includes('..')) {
    throw new Error('project_read: path escapes the workspace root');
  }
  const lower = normalized.replace(/\\/g, '/').toLowerCase();
  if (
    DENIED_PREFIXES.some(
      (prefix) => lower === prefix.replace(/\/$/, '') || lower.startsWith(prefix),
    )
  ) {
    throw new Error(`project_read: ${normalized} is platform-managed and not readable by agents`);
  }
  const abs = join(root, normalized);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) {
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
