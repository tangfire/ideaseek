import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Discard exactly the files the generator owns.
 *
 * ARIS's repair ladder says a broken attempt should restart rather than be
 * patched forever, and it is emphatic that only the attempt's own scaffolding
 * may be deleted — the plan, trackers, user source, data and results never.
 * The generated-file manifest written by `writeIdeaFiles` is what makes that
 * boundary enforceable instead of aspirational: anything not listed there is
 * somebody else's work and stays.
 */
export const GENERATED_MANIFEST = 'src/.generated.json';

export async function clearGeneratedIdeaFiles(workspace: string): Promise<string[]> {
  let paths: string[] = [];
  try {
    const stored = JSON.parse(await readFile(join(workspace, GENERATED_MANIFEST), 'utf8')) as {
      files?: unknown;
    };
    paths = Array.isArray(stored.files)
      ? stored.files.filter(
          (path): path is string =>
            typeof path === 'string' && path.startsWith('src/') && !path.includes('..'),
        )
      : [];
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const path of paths) {
    const existed = await rm(join(workspace, path), { force: true })
      .then(() => true)
      .catch(() => false);
    if (existed) removed.push(path);
  }
  // The manifest goes last so an interrupted clear cannot leave a list
  // pointing at files that no longer exist.
  await rm(join(workspace, GENERATED_MANIFEST), { force: true }).catch(() => undefined);
  return removed;
}
