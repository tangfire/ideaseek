import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** ideaseek version for daemon metadata (dist/cli.js → ../package.json). */
export function readCliVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Metadata for a detached supervisor started by `run --detach`. */
export interface DaemonInfo {
  runId: string;
  pid: number;
  startedAt: number;
  heartbeatAt: number;
  logPath: string;
  version: string;
  exitedAt?: number;
  reason?: string;
}

export function daemonPath(researchDir: string): string {
  return join(researchDir, 'daemon.json');
}

/**
 * Writes daemon metadata. Sync on purpose: supervisors call this from
 * process exit handlers where async writes would be dropped. The write
 * itself is atomic (temp file + rename): `attach`/`watch` and the
 * supervisor test poll this file every 250 ms, and a plain truncate-
 * write let a reader parse a half-written JSON (observed under the
 * parallel gate: "Expected double-quoted property name at position
 * 260"). Readers now always see the previous or the new document,
 * never a torn one.
 */
export function writeDaemonInfo(researchDir: string, info: DaemonInfo): void {
  const path = daemonPath(researchDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
    renameSync(tmp, path);
  } catch {
    // Rename can lose a race with a concurrent reader on some filesystems;
    // fall back to the historical direct write rather than drop metadata
    // from an exit handler.
    try {
      writeFileSync(path, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
    } catch {
      // best-effort: daemon metadata must never break the exiting process
    }
  }
}

export function readDaemonInfo(researchDir: string): DaemonInfo | null {
  try {
    return JSON.parse(readFileSync(daemonPath(researchDir), 'utf8')) as DaemonInfo;
  } catch {
    return null;
  }
}

/** True when a pid exists (signal 0 probe; never sends an actual signal). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
