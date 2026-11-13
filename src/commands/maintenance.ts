import type { Command } from 'commander';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { redactSecrets } from '../core/redact.js';
import { sha256OfFile } from '../core/hash.js';
import { ensureDir, writeFileAtomic } from '../core/atomic.js';
import { action, jsonLine, resolveRun } from './shared.js';

/**
 * Result lifecycle (PRODUCT_GAPS #6): cleanup / archive / export.
 * - cleanup only ever enumerates PLATFORM-OWNED rebuildable paths
 *   (.research/artifacts/tmp + stale daemon state); originals, papers,
 *   protocols, cards, results and handoffs are structurally out of reach.
 * - archive writes a read-only summary bundle under reports/ and marks the
 *   run with an event; the run stays fully readable.
 * - export copies a run's artifacts/events/tasks with a hash manifest and
 *   NEVER includes .env or any secret material.
 */

interface TmpScan {
  files: { path: string; bytes: number }[];
  referencedTemps: Set<string>;
}

async function scanTmp(
  root: string,
  runtime: Awaited<ReturnType<typeof openRuntime>>,
): Promise<TmpScan> {
  const { readdir, stat } = await import('node:fs/promises');
  const tmpDir = join(root, '.research', 'artifacts', 'tmp');
  const files: { path: string; bytes: number }[] = [];
  try {
    for (const name of await readdir(tmpDir)) {
      const path = join(tmpDir, name);
      const info = await stat(path).catch(() => null);
      if (info?.isFile()) files.push({ path, bytes: info.size });
    }
  } catch {
    // no tmp dir yet
  }
  // Any temp still referenced by a staged artifact row is NOT garbage.
  const referenced = new Set<string>();
  const staged = await runtime.db.listStagedTempPaths();
  for (const tempPath of staged) {
    if (tempPath) referenced.add(tempPath);
  }
  return { files, referencedTemps: referenced };
}

async function openRuntime(root: string) {
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  return ProjectRuntime.open({ cwd: root });
}

async function openRoot(): Promise<string> {
  const { findProjectRoot } = await import('../config/paths.js');
  const root = await findProjectRoot(process.cwd());
  if (!root) {
    throw new IdeaseekError('NOT_INITIALIZED', 'no IdeaSeek project here; run: ideaseek init');
  }
  return root;
}

export function registerMaintenanceCommands(program: Command): void {
  program
    .command('cleanup')
    .description('preview or delete platform-owned rebuildable files (never originals)')
    .option('--cache', 'actually delete the previewed files (default is dry-run)')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { cache?: boolean; json?: boolean }) => {
        const root = await openRoot();
        const runtime = await openRuntime(root);
        try {
          const { files, referencedTemps } = await scanTmp(root, runtime);
          const deletable = files.filter((f) => !referencedTemps.has(f.path));
          const protectedFiles = files.filter((f) => referencedTemps.has(f.path));

          // Stale daemon bookkeeping (process gone, file left behind).
          const { readDaemonInfo, isPidAlive } = await import('../runtime/daemon.js');
          const daemon = readDaemonInfo(join(root, '.research'));
          const staleDaemon = Boolean(daemon && !daemon.exitedAt && !isPidAlive(daemon.pid));

          let deleted = 0;
          let freedBytes = 0;
          if (opts.cache) {
            const { rm } = await import('node:fs/promises');
            for (const file of deletable) {
              await rm(file.path, { force: true });
              deleted += 1;
              freedBytes += file.bytes;
            }
            if (staleDaemon) {
              const { rm: rmFile } = await import('node:fs/promises');
              await rmFile(join(root, '.research', 'daemon.json'), { force: true });
            }
          }

          const payload = {
            mode: opts.cache ? 'delete' : 'dry-run',
            deletable: deletable.map((f) => ({
              path: f.path.replace(root, '.'),
              bytes: f.bytes,
            })),
            kept: protectedFiles.map((f) => f.path.replace(root, '.')),
            staleDaemonFile: staleDaemon,
            deleted,
            freedBytes,
            rules: [
              'only .research/artifacts/tmp and stale daemon state are ever considered',
              'papers/, datasets/, comparisons/, knowledge/, ideas/, reports/ are never touched',
              'temps referenced by staged artifacts are kept',
            ],
          };
          if (opts.json) {
            process.stdout.write(jsonLine(payload));
            return 0;
          }
          process.stdout.write(
            `cleanup ${payload.mode}: ${payload.deletable.length} file(s) deletable` +
              ` · ${payload.kept.length} kept (staged) · daemon.json stale=${String(staleDaemon)}\n`,
          );
          for (const file of payload.deletable.slice(0, 10)) {
            process.stdout.write(`  ${file.path} (${file.bytes} bytes)\n`);
          }
          if (payload.deletable.length > 10) {
            process.stdout.write(`  … ${payload.deletable.length - 10} more\n`);
          }
          if (!opts.cache) {
            process.stdout.write(
              `preview only — rerun with --cache to delete ${payload.deletable.length} file(s)\n`,
            );
          } else {
            process.stdout.write(`deleted ${deleted} file(s), freed ${freedBytes} bytes\n`);
          }
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );

  program
    .command('archive')
    .description('write a read-only archive bundle of a run under reports/ (run stays readable)')
    .option('--run <runId>', 'run id (default: latest)')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { run?: string; json?: boolean }) => {
        const root = await openRoot();
        const runtime = await openRuntime(root);
        try {
          const run = await resolveRun(runtime, opts.run);
          const tasks = await runtime.db.listTasks(run.runId);
          const events = await runtime.db.listEvents(run.runId, { limit: 100_000 });
          const artifacts = await runtime.db.listArtifactsByRun(run.runId);

          const archiveDir = join(root, 'reports', `archive-${run.runId}`);
          await ensureDir(archiveDir);
          await writeFileAtomic(
            join(archiveDir, 'events.json'),
            `${JSON.stringify(events, null, 2)}\n`,
          );
          await writeFileAtomic(
            join(archiveDir, 'tasks.json'),
            `${JSON.stringify(tasks, null, 2)}\n`,
          );
          await writeFileAtomic(
            join(archiveDir, 'artifacts.json'),
            `${JSON.stringify(
              artifacts.map((a) => ({
                artifactId: a.artifactId,
                kind: a.kind,
                contentHash: a.contentHash,
                relPath: a.relPath,
                size: a.size,
              })),
              null,
              2,
            )}\n`,
          );
          await writeFileAtomic(
            join(archiveDir, 'archive.json'),
            `${JSON.stringify(
              {
                runId: run.runId,
                status: run.status,
                phase: run.phase,
                archivedAt: Date.now(),
                counts: {
                  tasks: tasks.length,
                  events: events.length,
                  artifacts: artifacts.length,
                },
                note: 'read-only summary; the original run rows are untouched and remain queryable',
              },
              null,
              2,
            )}\n`,
          );
          const event = await runtime.db.appendEvent({
            runId: run.runId,
            phase: run.phase,
            objectId: null,
            role: 'user',
            eventType: 'decision',
            summary: `archived run bundle → reports/archive-${run.runId}`,
            status: 'confirmed',
          });
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                runId: run.runId,
                archiveDir,
                counts: { tasks: tasks.length, events: events.length, artifacts: artifacts.length },
                decisionSeq: event.seq,
              }),
            );
          } else {
            process.stdout.write(
              `archived ${run.runId} → ${archiveDir} ` +
                `(${tasks.length} tasks, ${events.length} events, ${artifacts.length} artifacts)\n`,
            );
            process.stdout.write('  the run stays fully readable (status/attach/events)\n');
          }
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );

  program
    .command('export')
    .description("export a run's artifacts, events and tasks with a hash manifest (no secrets)")
    .option('--run <runId>', 'run id (default: latest)')
    .requiredOption('--to <dir>', 'target directory (created if missing)')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { run?: string; to: string; json?: boolean }) => {
        const root = await openRoot();
        const runtime = await openRuntime(root);
        try {
          const run = await resolveRun(runtime, opts.run);
          const tasks = await runtime.db.listTasks(run.runId);
          const events = await runtime.db.listEvents(run.runId, { limit: 100_000 });
          const artifacts = await runtime.db.listArtifactsByRun(run.runId);

          const { mkdir, copyFile } = await import('node:fs/promises');
          await mkdir(opts.to, { recursive: true });
          const artifactsDir = join(opts.to, 'artifacts');
          await mkdir(artifactsDir, { recursive: true });

          const manifest: {
            runId: string;
            exportedAt: number;
            files: { path: string; sha256: string; bytes: number }[];
            exclusions: string[];
          } = {
            runId: run.runId,
            exportedAt: Date.now(),
            files: [],
            exclusions: ['.env and all secret material', 'original papers/datasets (never copied)'],
          };

          let copiedArtifacts = 0;
          for (const artifact of artifacts) {
            try {
              const source = runtime.store.resolvePath(artifact.contentHash);
              const target = join(
                artifactsDir,
                `${artifact.artifactId}-${artifact.relPath.replace(/[\\/]/g, '_')}`,
              );
              await copyFile(source, target);
              const hash = await sha256OfFile(target);
              manifest.files.push({
                path: target.replace(opts.to, '.'),
                sha256: hash,
                bytes: artifact.size,
              });
              copiedArtifacts += 1;
            } catch {
              // missing blob on disk: record the gap instead of failing the bundle
              manifest.files.push({
                path: `MISSING:${artifact.contentHash}`,
                sha256: artifact.contentHash,
                bytes: artifact.size,
              });
            }
          }

          await writeFileAtomic(
            join(opts.to, 'events.json'),
            `${JSON.stringify(
              events.map((e) => ({ ...e, summary: redactSecrets(e.summary) })),
              null,
              2,
            )}\n`,
          );
          await writeFileAtomic(
            join(opts.to, 'tasks.json'),
            `${JSON.stringify(
              tasks.map((t) => ({
                ...t,
                error: t.error ? { ...t.error, message: redactSecrets(t.error.message) } : null,
              })),
              null,
              2,
            )}\n`,
          );
          await writeFileAtomic(
            join(opts.to, 'run.json'),
            `${JSON.stringify({ ...run, question: redactSecrets(run.question) }, null, 2)}\n`,
          );
          manifest.files.push(
            {
              path: './events.json',
              sha256: await sha256OfFile(join(opts.to, 'events.json')),
              bytes: 0,
            },
            {
              path: './tasks.json',
              sha256: await sha256OfFile(join(opts.to, 'tasks.json')),
              bytes: 0,
            },
            { path: './run.json', sha256: await sha256OfFile(join(opts.to, 'run.json')), bytes: 0 },
          );
          await writeFileAtomic(
            join(opts.to, 'export-manifest.json'),
            `${JSON.stringify(manifest, null, 2)}\n`,
          );

          // Belt: never ship a key-shaped value in the bundle.
          for (const name of ['events.json', 'tasks.json', 'run.json', 'export-manifest.json']) {
            const text = await (
              await import('node:fs/promises')
            ).readFile(join(opts.to, name), 'utf8');
            if (/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/.test(text)) {
              throw new IdeaseekError('INTERNAL', `refusing to export key-shaped value in ${name}`);
            }
          }

          if (opts.json) {
            process.stdout.write(
              jsonLine({
                runId: run.runId,
                to: opts.to,
                artifacts: copiedArtifacts,
                manifest: join(opts.to, 'export-manifest.json'),
              }),
            );
          } else {
            process.stdout.write(
              `exported ${run.runId} → ${opts.to} (${copiedArtifacts} artifacts, ` +
                `${events.length} events, ${tasks.length} tasks)\n`,
            );
            process.stdout.write('  manifest: export-manifest.json (sha256 per file, no .env)\n');
          }
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );

  program
    .command('backup')
    .description(
      'snapshot workflow DB + config + artifacts with a sha256 manifest (append-only outcome log)',
    )
    .option('--list', 'list recorded backup outcomes instead of creating one')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { list?: boolean; json?: boolean }) => {
        const { runProjectBackup, listBackupRecords } = await import('../runtime/backup.js');
        if (opts.list) {
          const root = await openRoot();
          const records = await listBackupRecords(root);
          if (opts.json) {
            process.stdout.write(jsonLine({ records }));
            return 0;
          }
          if (records.length === 0) {
            process.stdout.write('no backups recorded yet — run: ideaseek backup\n');
            return 0;
          }
          for (const record of records.slice(-20)) {
            const when = new Date(record.at).toISOString();
            process.stdout.write(
              `  [${record.status}] ${when} ${record.dir ?? '(failed)'} ${
                record.error ? `— ${record.error.slice(0, 80)}` : `(${record.files.length} files)`
              }\n`,
            );
          }
          return 0;
        }
        const root = await openRoot();
        const record = await runProjectBackup(root);
        if (opts.json) {
          process.stdout.write(jsonLine(record));
          return record.status === 'ok' ? 0 : 1;
        }
        if (record.status === 'ok') {
          process.stdout.write(
            `backup ok: ${record.dir} (${record.files.length} files incl. manifest)\n`,
          );
          process.stdout.write(
            '  workflow.db (VACUUM INTO) + research.yaml + artifacts/, no secrets\n',
          );
          process.stdout.write(
            `next: restore elsewhere with: ideaseek restore <project>/${record.dir}   ·   list: ideaseek backup --list\n`,
          );
          return 0;
        }
        process.stderr.write(
          `backup FAILED (recorded in .research/backups.jsonl): ${record.error}\n`,
        );
        process.stderr.write('next: free disk/permissions, then rerun ideaseek backup\n');
        return 1;
      }),
    );

  program
    .command('restore')
    .description(
      'restore a backup into a FRESH directory (hash-verified; never overwrites an existing project)',
    )
    .argument(
      '<backupDir>',
      'backup directory (e.g. .research/backups/b-<ts> from another machine)',
    )
    .option('--json', 'machine-readable output')
    .action(
      action(async (backupDir: string, opts: { json?: boolean }) => {
        // Deliberately cwd-based: restore runs on a machine with NO project yet.
        const { restoreProjectBackup } = await import('../runtime/backup.js');
        const result = await restoreProjectBackup(backupDir, process.cwd());
        if (opts.json) {
          process.stdout.write(jsonLine({ restored: true, ...result }));
        } else {
          process.stdout.write(
            `restored ${result.files} file(s) into ${result.target} (every file hash-verified)\n`,
          );
          process.stdout.write(
            'next: ideaseek doctor   →   ideaseek status   →   ideaseek attach\n',
          );
        }
        return 0;
      }),
    );
}
