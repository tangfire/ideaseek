import { readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { listSourceFiles } from './workspace.js';

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

/** The recorded paths, or empty when the manifest is missing or unreadable. */
async function readManifestFiles(workspace: string): Promise<string[]> {
  try {
    const stored = JSON.parse(await readFile(join(workspace, GENERATED_MANIFEST), 'utf8')) as {
      files?: unknown;
    };
    return Array.isArray(stored.files)
      ? stored.files.filter(
          (path): path is string =>
            typeof path === 'string' && path.startsWith('src/') && !path.includes('..'),
        )
      : [];
  } catch {
    return [];
  }
}

export async function clearGeneratedIdeaFiles(workspace: string): Promise<string[]> {
  const paths = await readManifestFiles(workspace);
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

/**
 * Record what a tool-enabled session actually authored.
 *
 * The session writes files with its own tools, so nothing in the platform
 * returns them and `writeIdeaFiles` never runs — which left the first real
 * agent implementation on FDG with thirteen files in `src/` and no manifest.
 * The consequence was not cosmetic bookkeeping: `clearGeneratedIdeaFiles` at
 * the start of the next attempt deleted nothing, so the previous attempt's
 * code survived into the round that is supposed to grade fresh work, and a
 * SMOKE_TESTED verdict could be partly inherited rather than produced.
 *
 * Ownership is decided by a filesystem diff against a pre-turn snapshot rather
 * than a list of expected filenames: whatever the agent created or rewrote is
 * the agent's, including a scaffold file it replaced (that file's contents are
 * no longer the template's). Paths the agent only read are untouched and stay
 * out of the list.
 */
export async function recordAuthoredIdeaFiles(
  workspace: string,
  baseline: ReadonlyMap<string, string>,
): Promise<string[]> {
  const current = await listSourceFiles(workspace);
  const authored = new Set<string>(await readManifestFiles(workspace));
  for (const [path, digest] of current) {
    if (path === GENERATED_MANIFEST) continue;
    if (baseline.get(path) !== digest) authored.add(path);
  }
  const files = [...authored].sort();
  await writeFile(
    join(workspace, GENERATED_MANIFEST),
    `${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`,
    'utf8',
  );
  return files;
}

/**
 * Files in `src/` that are neither the untouched scaffold template nor
 * recorded as generated.
 *
 * The manifest is the only thing that separates "the platform wrote this" from
 * "a researcher wrote this", and it can be missing for work that exists: the
 * agent-session route wrote thirteen files into the first FDG idea without
 * recording any of them (fixed above), and an interrupted run can lose the list
 * while keeping the code. Those files must not be deleted — losing
 * bookkeeping is not evidence that somebody's work is disposable — but they
 * must not be silently inherited either, because then a green ladder may be
 * standing partly on code this attempt never produced. So: keep, and name.
 *
 * Membership in the template is decided by comparing bytes against
 * `scaffoldFiles(card)` rather than against a list of template filenames: the
 * agent can add or rewrite any file, and a hardcoded set of names would decide
 * what counts as authored work instead of reporting what happened.
 */
export async function unrecordedSourceFiles(
  workspace: string,
  template: readonly { path: string; content: string }[],
): Promise<string[]> {
  const current = await listSourceFiles(workspace);
  const recorded = new Set(await readManifestFiles(workspace));
  const templateDigest = new Map(
    template.map((file) => [
      file.path,
      createHash('sha256').update(file.content, 'utf8').digest('hex'),
    ]),
  );
  const unrecorded: string[] = [];
  for (const [path, digest] of current) {
    if (path === GENERATED_MANIFEST || recorded.has(path)) continue;
    if (templateDigest.get(path) === digest) continue;
    unrecorded.push(path);
  }
  return unrecorded.sort();
}
