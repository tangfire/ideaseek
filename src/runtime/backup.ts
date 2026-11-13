import { appendFile, copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { sha256OfFile, verifyFileHash, type ContentHash } from '../core/hash.js';
import { IdeaseekError } from '../core/errors.js';
import { projectPaths } from '../config/paths.js';
import { rebindProjectRoot, vacuumSqliteInto } from '../workflow/sqlite.js';

/**
 * Project backup + restore (docs/LONG_RUNNING_WORKFLOWS 多周运行定期备份 DB
 * 和 artifact manifest；OPERATIONS 备份与恢复；USER_JOURNEY_ACCEPTANCE
 * Journey F/H): a THIN adapter that snapshots the workflow DB (VACUUM INTO
 * — consistent while the runtime holds it open), the secret-free config,
 * the content-addressed artifact store (evidence trail) and writes a
 * sha256 manifest. Every attempt — success or failure — is appended to
 * `.research/backups.jsonl` so a backup failure becomes a durable FACT
 * the alerts adapter can report. Never throws from the backup path: like
 * notify, a failed backup records the failure and returns it.
 *
 * Restore is deliberately conservative: it verifies EVERY manifest entry
 * before writing anything (tampered backup → OUTPUT_HASH_MISMATCH) and
 * refuses to touch an existing project (rollback keeps the old directory;
 * restore goes into a fresh one — the cross-machine Journey H flow).
 */

export interface BackupFileEntry {
  /** File path inside the backup directory (posix separators). */
  path: string;
  bytes: number;
  sha256: ContentHash;
}

export interface BackupRecord {
  at: number;
  status: 'ok' | 'failed';
  /** Project-relative backup directory; null when nothing usable was written. */
  dir: string | null;
  files: BackupFileEntry[];
  error: string | null;
}

export interface BackupOptions {
  /** Injected clock for deterministic backup ids/timestamps (tests). */
  now?: number;
}

function backupsDir(root: string): string {
  return join(projectPaths(root).researchDir, 'backups');
}

function recordsPath(root: string): string {
  return join(projectPaths(root).researchDir, 'backups.jsonl');
}

/** Append-only outcome log (newest last). Unreadable log → no records. */
export async function listBackupRecords(root: string, limit = 50): Promise<BackupRecord[]> {
  try {
    const raw = await readFile(recordsPath(root), 'utf8');
    const records = raw
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as BackupRecord)
      .filter((record) => record && (record.status === 'ok' || record.status === 'failed'));
    return records.slice(-limit);
  } catch {
    return [];
  }
}

/** Most recent backup OUTCOME (ok or failed — the alert surface), or null. */
export async function readLatestBackup(root: string): Promise<BackupRecord | null> {
  const records = await listBackupRecords(root);
  return records.length > 0 ? records[records.length - 1]! : null;
}

/** Recursive relative file list (posix separators) under a directory. */
async function listBackupFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(join(dir, prefix))).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const info = await stat(join(dir, rel));
    if (info.isDirectory()) out.push(...(await listBackupFiles(dir, rel)));
    else out.push(rel);
  }
  return out;
}

/** Content-addressed artifact files (excluding the staged tmp area). */
async function collectArtifactRels(artifactsDir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    let names: string[] = [];
    try {
      names = await readdir(join(artifactsDir, rel));
    } catch {
      return; // no artifacts yet
    }
    for (const name of names.sort()) {
      if (rel === '' && name === 'tmp') continue; // staged temps are not evidence
      const childRel = rel ? `${rel}/${name}` : name;
      const info = await stat(join(artifactsDir, childRel));
      if (info.isDirectory()) await walk(childRel);
      else out.push(childRel);
    }
  };
  await walk('');
  return out;
}

export async function runProjectBackup(
  root: string,
  opts: BackupOptions = {},
): Promise<BackupRecord> {
  const paths = projectPaths(root);
  const at = opts.now ?? Date.now();
  const dir = join(backupsDir(root), `b-${at}`);
  let record: BackupRecord;

  try {
    await mkdir(backupsDir(root), { recursive: true });
    // Non-recursive: a file already sitting at this id fails the attempt and
    // is recorded (deterministic failure injection point for soak tests).
    await mkdir(dir);
    await vacuumSqliteInto(paths.dbFile, join(dir, 'workflow.db'));
    await copyFile(paths.configFile, join(dir, 'research.yaml'));

    // Evidence trail: the content-addressed artifact store (skip staged
    // tmp) so a restore can re-verify artifact hashes (Journey F/H).
    for (const rel of await collectArtifactRels(paths.artifactsDir)) {
      const dest = join(dir, 'artifacts', ...rel.split('/'));
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(join(paths.artifactsDir, ...rel.split('/')), dest);
    }

    const files: BackupFileEntry[] = [];
    for (const rel of (await listBackupFiles(dir)).sort()) {
      const full = join(dir, rel);
      files.push({ path: rel, bytes: (await stat(full)).size, sha256: await sha256OfFile(full) });
    }
    const manifest = {
      at,
      files,
      note: 'workflow DB snapshot (VACUUM INTO) + research.yaml + artifacts; no secrets by policy',
    };
    const manifestPath = join(dir, 'manifest.json');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    files.push({
      path: 'manifest.json',
      bytes: (await stat(manifestPath)).size,
      sha256: await sha256OfFile(manifestPath),
    });

    record = {
      at,
      status: 'ok',
      dir: relative(paths.root, dir).replace(/\\/g, '/'),
      files,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record = { at, status: 'failed', dir: null, files: [], error: message.slice(0, 300) };
  }

  await mkdir(paths.researchDir, { recursive: true });
  await appendFile(recordsPath(root), `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

export interface RestoreResult {
  target: string;
  /** Files copied (every one hash-verified first). */
  files: number;
}

/**
 * Restores a backup into a FRESH directory (disaster recovery / another
 * machine — Journey H). Never overwrites an existing project: rollback
 * keeps the old directory, restore goes somewhere new. Every manifest
 * entry is hash-verified BEFORE any copy — a tampered backup fails
 * closed with OUTPUT_HASH_MISMATCH.
 */
export async function restoreProjectBackup(
  backupDir: string,
  targetRoot: string,
): Promise<RestoreResult> {
  const backup = resolve(backupDir);
  const target = resolve(targetRoot);

  let manifestRaw: string;
  try {
    manifestRaw = await readFile(join(backup, 'manifest.json'), 'utf8');
  } catch {
    throw new IdeaseekError(
      'FILE_NOT_FOUND',
      `not a backup directory (manifest.json missing): ${backupDir}`,
    );
  }
  let manifest: { files?: unknown };
  try {
    manifest = JSON.parse(manifestRaw);
  } catch {
    throw new IdeaseekError('INVALID_ARTIFACT', 'backup manifest is not valid JSON');
  }
  if (!Array.isArray(manifest.files)) {
    throw new IdeaseekError('INVALID_ARTIFACT', 'backup manifest is malformed');
  }

  // Refuse to touch an existing project (rollback = keep it, restore elsewhere).
  try {
    await stat(join(target, '.research'));
    throw new IdeaseekError(
      'INVALID_STATE',
      'target already contains .research — restore refuses to overwrite an existing project; ' +
        'roll back by keeping it and restoring into a fresh directory',
    );
  } catch (error) {
    if (error instanceof IdeaseekError) throw error;
    // no .research → fresh target, good
  }

  const entries = manifest.files as { path: string; sha256: `sha256:${string}` }[];
  // Verify EVERY file BEFORE writing anything (fail closed on tampering).
  for (const entry of entries) {
    const source = join(backup, ...entry.path.split('/'));
    if (!(await verifyFileHash(source, entry.sha256))) {
      throw new IdeaseekError(
        'OUTPUT_HASH_MISMATCH',
        `backup file failed verification: ${entry.path} — refusing to restore a tampered backup`,
      );
    }
  }

  const paths = projectPaths(target);
  // Standard workspace layout (same dirs `init` creates) so doctor/status
  // on the restored project report a healthy tree.
  const { initInternals } = await import('../commands/init.js');
  for (const workspaceDir of initInternals.WORKSPACE_DIRS) {
    await mkdir(join(target, workspaceDir), { recursive: true });
  }
  await mkdir(paths.researchDir, { recursive: true });
  await mkdir(paths.logsDir, { recursive: true });

  let copied = 0;
  for (const entry of entries) {
    const source = join(backup, ...entry.path.split('/'));
    let dest: string;
    if (entry.path === 'workflow.db') dest = paths.dbFile;
    else if (entry.path === 'research.yaml') dest = paths.configFile;
    else if (entry.path.startsWith('artifacts/')) {
      dest = join(paths.artifactsDir, ...entry.path.slice('artifacts/'.length).split('/'));
    } else {
      continue; // unknown manifest entry — skip rather than guess
    }
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(source, dest);
    copied += 1;
  }

  // The project row binds to its ORIGINAL absolute root; rebind it to the
  // restore target so ensureProject(status/attach) finds the same project
  // id instead of inserting a fresh empty one.
  rebindProjectRoot(paths.dbFile, target);
  return { target, files: copied };
}
