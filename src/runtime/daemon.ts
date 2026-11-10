import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
 * process exit handlers where async writes would be dropped.
 */
export function writeDaemonInfo(researchDir: string, info: DaemonInfo): void {
  const path = daemonPath(researchDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
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
