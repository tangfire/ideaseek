import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { isPidAlive, readDaemonInfo } from './daemon.js';

/**
 * Advisory project lock (PRODUCT_GAPS #5): one mutating top-level controller
 * (run / setup-style writers) at a time per project directory. Task workers
 * are NOT locked — they coordinate through DB leases. Stale locks (dead pid)
 * are taken over automatically with a note; live conflicts fail fast with a
 * copyable recovery hint instead of interleaving writes.
 */

export interface ProjectLock {
  pid: number;
  purpose: string;
  acquiredAt: number;
}

function lockPath(projectRoot: string): string {
  return join(projectRoot, '.research', 'project-lock.json');
}

async function readLock(projectRoot: string): Promise<ProjectLock | null> {
  const path = lockPath(projectRoot);
  const { readFile } = await import('node:fs/promises');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new IdeaseekError(
      'INVALID_STATE',
      `cannot read project lock ${path}: ${(error as Error).message} — if no other ideaseek process is running, move the file aside, then rerun`,
    );
  }
  // A corrupt lock must never read as "no lock": that silently bypasses
  // mutual exclusion and lets two controllers interleave writes.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new IdeaseekError(
      'INVALID_STATE',
      `project lock ${path} is not valid JSON — if no other ideaseek process is running, move the file aside, then rerun`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as ProjectLock).pid !== 'number' ||
    typeof (parsed as ProjectLock).purpose !== 'string'
  ) {
    throw new IdeaseekError(
      'INVALID_STATE',
      `project lock ${path} has an unexpected shape — if no other ideaseek process is running, move the file aside, then rerun`,
    );
  }
  return parsed as ProjectLock;
}

export interface AcquireResult {
  acquired: boolean;
  /** Set when a dead-pid lock was taken over. */
  tookOverStale: boolean;
}

/**
 * Acquires the project lock for this process. A lock held by a live foreign
 * pid throws RUN_BLOCKED; a dead pid is treated as stale and taken over.
 */
export async function acquireProjectLock(
  projectRoot: string,
  purpose: string,
): Promise<AcquireResult> {
  const existing = await readLock(projectRoot);
  if (existing && existing.pid !== process.pid) {
    if (isPidAlive(existing.pid)) {
      throw new IdeaseekError(
        'RUN_BLOCKED',
        `another process holds the project lock (pid ${existing.pid}, purpose=${existing.purpose}); ` +
          'wait for it to finish or recover the stale lock after the process is gone',
        { pid: existing.pid, purpose: existing.purpose },
      );
    }
    // Stale: owner is gone — take over and record the takeover.
    await writeLock(projectRoot, { pid: process.pid, purpose, acquiredAt: Date.now() });
    return { acquired: true, tookOverStale: true };
  }
  await writeLock(projectRoot, { pid: process.pid, purpose, acquiredAt: Date.now() });
  return { acquired: true, tookOverStale: false };
}

async function writeLock(projectRoot: string, lock: ProjectLock): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(join(projectRoot, '.research'), { recursive: true });
  await writeFile(lockPath(projectRoot), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

/** Releases only our own lock (never clobbers a successor's lock). */
export async function releaseProjectLock(projectRoot: string): Promise<void> {
  const existing = await readLock(projectRoot);
  if (!existing || existing.pid !== process.pid) return;
  const { rm } = await import('node:fs/promises');
  await rm(lockPath(projectRoot), { force: true });
}

/** Current lock + liveness for `projects` / `status` displays. */
export async function inspectProjectLock(
  projectRoot: string,
): Promise<{ lock: ProjectLock; alive: boolean } | null> {
  const lock = await readLock(projectRoot);
  if (!lock) return null;
  return { lock, alive: isPidAlive(lock.pid) };
}

/** Whether daemon.json overlaps this root (informational for `projects`). */
export function daemonSummary(projectRoot: string): { pid: number; state: string } | null {
  const info = readDaemonInfo(join(projectRoot, '.research'));
  if (!info) return null;
  const state = info.exitedAt
    ? `exited(${info.reason ?? 'unknown'})`
    : isPidAlive(info.pid)
      ? 'running'
      : 'process gone';
  return { pid: info.pid, state };
}
