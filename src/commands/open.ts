import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { action, jsonLine } from './shared.js';

/**
 * `ideaseek open [target]` — project selection for the current session
 * (docs/CLI_SPEC: `open <project-path>`; TERMINAL_UX `/open <path>`). A
 * registered project name or a directory path resolves to its root; the
 * switch is two-step — first show the target plus the mode/project/
 * permission summary, `--confirm` completes it — so control commands never
 * land in the wrong directory. With no project match the target is a
 * read-only document under knowledge/ or reports/ (never writes). The REPL
 * turns a confirmed target into a session chdir; one-shot CLI users get the
 * `--project <path>` equivalent.
 */

interface ProjectTarget {
  root: string;
  name: string;
}

async function requireRoot(): Promise<string> {
  const { findProjectRoot } = await import('../config/paths.js');
  const root = await findProjectRoot(process.cwd());
  if (!root) {
    throw new IdeaseekError('NOT_INITIALIZED', 'no IdeaSeek project here; run: ideaseek init');
  }
  return root;
}

async function projectName(root: string): Promise<string> {
  try {
    const { loadConfig } = await import('../config/config.js');
    const { projectPaths } = await import('../config/paths.js');
    return (await loadConfig(projectPaths(root))).resolved.project.name;
  } catch {
    const { basename } = await import('node:path');
    return basename(root);
  }
}

/**
 * Resolves a project by path first, then by registry name (exact, then
 * unique fuzzy). Returns null when no project matches — the caller falls
 * back to the document browser; an ambiguous match or a registered-but-
 * missing directory is a hard error (never guess, never hide staleness).
 */
async function resolveProjectTarget(target: string): Promise<ProjectTarget | null> {
  const { resolve } = await import('node:path');
  const { stat } = await import('node:fs/promises');
  const { isProjectRoot, findProjectRoot } = await import('../config/paths.js');
  const { listRegisteredProjects } = await import('../runtime/registry.js');

  const asPath = resolve(target);
  const info = await stat(asPath).catch(() => null);
  if (info?.isDirectory()) {
    const root = (await isProjectRoot(asPath)) ? asPath : await findProjectRoot(asPath);
    if (root) return { root, name: await projectName(root) };
  }

  const registered = await listRegisteredProjects();
  const needle = target.toLowerCase();
  const exact = registered.filter((p) => p.name.toLowerCase() === needle);
  if (exact.length > 0) {
    const entry = exact[0]!;
    const present = await stat(entry.root).catch(() => null);
    if (present?.isDirectory()) return { root: entry.root, name: entry.name };
    throw new IdeaseekError(
      'FILE_NOT_FOUND',
      `project "${entry.name}" is registered but missing on disk: ${entry.root}`,
    );
  }
  const fuzzy = registered.filter(
    (p) => p.name.toLowerCase().includes(needle) || p.root.toLowerCase().includes(needle),
  );
  if (fuzzy.length === 1) return { root: fuzzy[0]!.root, name: fuzzy[0]!.name };
  if (fuzzy.length > 1) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `ambiguous project "${target}" matches ${fuzzy.length}: ${fuzzy
        .map((p) => p.name)
        .join(', ')} — use the full name or a path`,
    );
  }
  return null; // not a project — the caller tries the document browser
}

interface DocEntry {
  relPath: string;
  absolutePath: string;
  bytes: number;
}

async function listDocuments(root: string): Promise<DocEntry[]> {
  const { readdir, stat } = await import('node:fs/promises');
  const { join: joinPath } = await import('node:path');
  const entries: DocEntry[] = [];
  for (const dir of ['knowledge', 'reports']) {
    const base = joinPath(root, dir);
    let names: string[];
    try {
      names = await readdir(base);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!/\.(md|json|txt|csv)$/i.test(name)) continue;
      const absolutePath = joinPath(base, name);
      const info = await stat(absolutePath).catch(() => null);
      if (!info?.isFile()) continue;
      entries.push({ relPath: `${dir}/${name}`, absolutePath, bytes: info.size });
    }
  }
  return entries;
}

async function openDocument(
  name: string,
  root: string,
  opts: { lines: number; json?: boolean },
): Promise<number> {
  const docs = await listDocuments(root);
  const needle = name.toLowerCase().replace(/\.(md|json|txt|csv)$/i, '');
  const matches = docs.filter((doc) => doc.relPath.toLowerCase().includes(needle));
  if (matches.length === 0) {
    throw new IdeaseekError(
      'FILE_NOT_FOUND',
      `no project or document matches "${name}" — ideaseek projects lists projects, ideaseek open lists documents`,
    );
  }
  if (matches.length > 1) {
    if (opts.json) {
      process.stdout.write(jsonLine({ ambiguous: true, matches: matches.map((m) => m.relPath) }));
      return 2;
    }
    process.stdout.write(`ambiguous: "${name}" matches ${matches.length} documents:\n`);
    for (const doc of matches) process.stdout.write(`  ${doc.relPath}\n`);
    return 2;
  }

  const doc = matches[0]!;
  const { readFile } = await import('node:fs/promises');
  const content = await readFile(doc.absolutePath, 'utf8');
  const head = content.split(/\r?\n/).slice(0, Math.max(1, opts.lines));
  if (opts.json) {
    process.stdout.write(
      jsonLine({ kind: 'document', path: doc.relPath, bytes: doc.bytes, head: head.join('\n') }),
    );
    return 0;
  }
  process.stdout.write(`${doc.relPath} (${doc.bytes} bytes)\n`);
  for (const line of head) process.stdout.write(`${line}\n`);
  const total = content.split(/\r?\n/).length;
  if (total > head.length) process.stdout.write(`… (${total - head.length} more lines)\n`);
  return 0;
}

/**
 * Bare `open` with no current project: list what is registered and say how to
 * enter it. The door back into research work has to be findable from inside a
 * general coding session, otherwise "switch back" has no discoverable answer.
 */
async function showRegistryOnly(opts: { json?: boolean }): Promise<number> {
  const { listRegisteredProjects } = await import('../runtime/registry.js');
  const registered = await listRegisteredProjects();
  if (opts.json) {
    process.stdout.write(jsonLine({ kind: 'projects', current: null, projects: registered }));
    return 0;
  }
  if (registered.length === 0) {
    process.stdout.write('no registered projects — ideaseek init here, or: ideaseek open <path>\n');
    return 0;
  }
  process.stdout.write(`${registered.length} registered project(s):\n`);
  for (const project of registered) {
    process.stdout.write(`  ${project.name.padEnd(22)}${project.root}\n`);
  }
  process.stdout.write('enter one: /open <name|path> --confirm   (or: cd <path> && ideaseek)\n');
  process.stdout.write('until then this directory stays a general coding session\n');
  return 0;
}

async function showOverview(root: string, opts: { json?: boolean }): Promise<number> {
  const { buildSessionSummary, renderSessionSummary } = await import('../session/mode.js');
  const { listRegisteredProjects } = await import('../runtime/registry.js');
  const summary = await buildSessionSummary(root);
  const registered = await listRegisteredProjects();
  const docs = await listDocuments(root);

  if (opts.json) {
    process.stdout.write(
      jsonLine({
        kind: 'overview',
        ...summary,
        sessionMode: summary.mode,
        projects: registered.map((p) => ({ name: p.name, root: p.root })),
        documents: docs.map((d) => d.relPath),
      }),
    );
    return 0;
  }

  for (const line of renderSessionSummary(summary)) process.stdout.write(`${line}\n`);
  if (registered.length > 0) {
    process.stdout.write(`${registered.length} registered project(s):\n`);
    for (const project of registered) {
      const mark = project.root === summary.root ? '>' : ' ';
      process.stdout.write(` ${mark} ${project.name}  ${project.root}\n`);
    }
  }
  if (docs.length > 0) {
    process.stdout.write(`${docs.length} document(s):\n`);
    for (const doc of docs) process.stdout.write(`  ${doc.relPath}  (${doc.bytes} bytes)\n`);
  }
  process.stdout.write(
    'next: /open <project> --confirm to switch · /open <name> to read a document\n',
  );
  return 0;
}

export function registerOpenCommand(program: Command): void {
  program
    .command('open')
    .description('select a project for this session (two-step with --confirm) or read a document')
    .argument('[target]', 'project name/path, or a document name')
    .option('--confirm', 'complete the project switch (REPL chdirs its session)')
    .option('--lines <n>', 'lines to show when opening a document', (value) => Number(value), 40)
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (
          target: string | undefined,
          opts: { confirm?: boolean; lines: number; json?: boolean },
        ) => {
          // A project target resolves from anywhere (docs: open an existing
          // project from an arbitrary directory); overview/documents need a
          // current project.
          if (!target) {
            const { findProjectRoot } = await import('../config/paths.js');
            const root = await findProjectRoot(process.cwd());
            if (root) return showOverview(root, opts);
            // From a general coding session there is no project to summarize
            // and no project docs to browse — but "which research projects can
            // I go back to" is exactly the question being asked here, and it
            // used to fail with NOT_INITIALIZED.
            return showRegistryOnly(opts);
          }

          const project = await resolveProjectTarget(target);

          if (project) {
            const { buildSessionSummary, renderSessionSummary } =
              await import('../session/mode.js');
            const summary = await buildSessionSummary(project.root);
            if (!opts.confirm) {
              if (opts.json) {
                process.stdout.write(
                  jsonLine({
                    kind: 'switch-target',
                    name: project.name,
                    root: project.root,
                    summary,
                  }),
                );
                return 0;
              }
              process.stdout.write(`switch target : ${project.name}  (${project.root})\n`);
              for (const line of renderSessionSummary(summary)) process.stdout.write(`${line}\n`);
              process.stdout.write(
                `confirm: ideaseek open ${target} --confirm   (REPL: /open ${target} --confirm)\n`,
              );
              return 0;
            }
            if (opts.json) {
              process.stdout.write(
                jsonLine({ kind: 'project', name: project.name, root: project.root, summary }),
              );
              return 0;
            }
            process.stdout.write(`selected project: ${project.name}  (${project.root})\n`);
            for (const line of renderSessionSummary(summary)) process.stdout.write(`${line}\n`);
            process.stdout.write(
              `next: cd ${project.root} — or one-shot: ideaseek --project ${project.root} <command>\n`,
            );
            return 0;
          }

          return openDocument(target, await requireRoot(), opts);
        },
      ),
    );
}
