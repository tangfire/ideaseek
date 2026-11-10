import { describe, expect, it } from 'vitest';
import { resolveInsideWorkspace } from '../src/dsh-plugins/research-tools.js';

/**
 * Permission core of the `project_read` DSH tool: the path guard is the
 * in-process half of the capability profile (the DSH read-only sandbox is
 * the other half). Runs on the host OS, so assertions normalize separators.
 */
function slashes(path: string): string {
  return path.replace(/\\/g, '/');
}

describe('project_read path guard', () => {
  const posixRoot = '/home/user/project';

  it('accepts project-relative paths inside the workspace', () => {
    const resolved = resolveInsideWorkspace(posixRoot, 'papers/notes.md');
    expect(slashes(resolved)).toBe(`${posixRoot}/papers/notes.md`);
    expect(slashes(resolveInsideWorkspace(posixRoot, 'knowledge/input-manifest.json'))).toBe(
      `${posixRoot}/knowledge/input-manifest.json`,
    );
  });

  it('rejects OS-absolute paths (drive letters and UNC)', () => {
    expect(() => resolveInsideWorkspace(posixRoot, 'C:\\Windows\\system32')).toThrow(
      /absolute paths/,
    );
    expect(() => resolveInsideWorkspace(posixRoot, 'D:/outside/file.txt')).toThrow(
      /absolute paths/,
    );
    expect(() => resolveInsideWorkspace(posixRoot, '\\\\server\\share\\x')).toThrow(
      /absolute paths/,
    );
  });

  it('rejects traversal escapes', () => {
    expect(() => resolveInsideWorkspace(posixRoot, '../secrets')).toThrow(/escapes/);
    expect(() => resolveInsideWorkspace(posixRoot, 'papers/../../secrets')).toThrow(/escapes/);
    expect(() => resolveInsideWorkspace(posixRoot, 'a/..\\..\\b')).toThrow(/escapes/);
    expect(() => resolveInsideWorkspace(posixRoot, '..')).toThrow(/escapes/);
  });

  it('denies platform-managed and credential paths', () => {
    expect(() => resolveInsideWorkspace(posixRoot, '.research/workflow.db')).toThrow(
      /platform-managed/,
    );
    expect(() => resolveInsideWorkspace(posixRoot, '.env')).toThrow(/platform-managed/);
    expect(() => resolveInsideWorkspace(posixRoot, 'sub/.env.local')).toThrow(/platform-managed/);
    expect(slashes(resolveInsideWorkspace(posixRoot, '.git/config'))).toContain('.git/config');
  });

  it('treats a single leading separator as project-relative', () => {
    expect(slashes(resolveInsideWorkspace(posixRoot, '/papers/a.md'))).toBe(
      `${posixRoot}/papers/a.md`,
    );
  });

  it('contains results even when the root uses mixed separators', () => {
    const mixedRoot = 'C:/projects/ideaseek';
    expect(slashes(resolveInsideWorkspace(mixedRoot, 'reports/out.md'))).toBe(
      'C:/projects/ideaseek/reports/out.md',
    );
  });
});
