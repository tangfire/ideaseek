#!/usr/bin/env node
/**
 * Serialized TypeScript build for dist/ (cross-process lock).
 *
 * Two sessions building `tsc -p tsconfig.build.json` concurrently
 * interleave per-file writes and leave dist inconsistent — observed
 * twice under parallel development (missing exports / half-written
 * modules). `mkdir` is atomic on every platform, so it is the lock; a
 * lock whose owner pid is dead (or that is older than two minutes) is
 * stolen instead of waited on. `ideaseek update` and the vitest global
 * setup share this script so every dist writer serializes on one lock.
 *
 * The lock serializes WRITERS, not readers: arbitrary `node dist/cli.js`
 * spawns never take it, so a mid-suite rebuild still tears dist for them
 * (observed: pack.test's `update` rebuild raced sibling suites and their
 * children read half-written modules). IDEASEEK_BUILD_OUT redirects the
 * emit into a throwaway directory — tsc still type-checks the whole
 * project, the shared dist is left alone.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lockDir = join(root, '.build-lock');
const pidFile = join(lockDir, 'pid');
const WAIT_LIMIT_MS = 180_000;
const STALE_MS = 120_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function lockIsStale() {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8'));
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0); // owner alive → not stale
        return false;
      } catch {
        return true; // owner gone — steal immediately
      }
    }
  } catch {
    // no readable pid file yet — fall back to the lock's age
  }
  try {
    return Date.now() - statSync(lockDir).mtimeMs > STALE_MS;
  } catch {
    return false;
  }
}

async function acquire() {
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(pidFile, String(process.pid));
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (lockIsStale()) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > WAIT_LIMIT_MS) {
        throw new Error(
          `build lock busy for ${WAIT_LIMIT_MS}ms (${lockDir}) — another session may be stuck building`,
        );
      }
      await sleep(250);
    }
  }
}

function release() {
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // already gone
  }
}

await acquire();
process.on('exit', release);
try {
  const tscArgs = ['-p', 'tsconfig.build.json'];
  const outDir = process.env.IDEASEEK_BUILD_OUT;
  if (outDir) tscArgs.push('--outDir', outDir);
  const result = spawnSync(
    process.execPath,
    [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), ...tscArgs],
    { cwd: root, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  release();
}
