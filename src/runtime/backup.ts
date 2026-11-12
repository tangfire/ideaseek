import { appendFile, copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { sha256OfFile, type ContentHash } from '../core/hash.js';
import { projectPaths } from '../config/paths.js';
import { vacuumSqliteInto } from '../workflow/sqlite.js';

/**
 * Project backup (docs/LONG_RUNNING_WORKFLOWS 多周运行定期备份 DB 和
 * artifact manifest；OPERATIONS 备份与恢复): a THIN adapter that snapshots
 * the workflow DB (VACUUM INTO — consistent while the runtime holds it
 * open), copies the secret-free config and writes a sha256 manifest. Every
 * attempt — success or failure — is appended to `.research/backups.jsonl`
 * so a backup failure becomes a durable FACT the alerts adapter can report
 * (备份失败进入显式告警状态). Never throws: like notify, a failed backup
 * must not take down the caller; it records the failure and returns it.
 *
 * Scope (deliberate, thinnest slice): DB + config + manifest. Full artifact
 * file backup and cross-host copies stay with the Phase 8 restore drill.
 */

export interface BackupFileEntry {
  /** File name inside the backup directory. */
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
    const { readFile } = await import('node:fs/promises');
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

/** Most recent backup attempt (ok or failed), null when never run. */
export async function readLatestBackup(root: string): Promise<BackupRecord | null> {
  const records = await listBackupRecords(root);
  return records.length > 0 ? records[records.length - 1]! : null;
}

/**
 * Runs one backup attempt and records its outcome durably.
 * Failure modes (missing DB, blocking path at the destination, config
 * unreadable, …) are captured as `status: 'failed'` facts — never thrown.
 */
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
    vacuumSqliteInto(paths.dbFile, join(dir, 'workflow.db'));
    await copyFile(paths.configFile, join(dir, 'research.yaml'));

    const files: BackupFileEntry[] = [];
    for (const name of (await readdir(dir)).sort()) {
      const full = join(dir, name);
      const info = await stat(full);
      if (!info.isFile()) continue;
      files.push({ path: name, bytes: info.size, sha256: await sha256OfFile(full) });
    }
    const manifest = {
      at,
      files,
      note: 'workflow DB snapshot (VACUUM INTO) + research.yaml; no secrets by policy',
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
