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
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

/**
 * Move a stale lock out of the way.
 *
 * Deleting it is not enough on Windows: while any process holds a handle on the
 * directory (the editor's file watcher does, most of the time), `rmSync` returns
 * without throwing, the path survives in delete-pending state, and the next
 * `mkdirSync` still reports EEXIST. Renaming succeeds where deleting silently
 * does not, and it keeps the owner pid as evidence instead of erasing it.
 */
function discardStaleLock() {
  // One fixed dump name, so a lock that refuses to die cannot pile up a
  // `.stale-<ts>` directory per retry; only when that name is itself occupied
  // (still delete-pending, so it can be listed but not replaced) does the
  // timestamped variant take the overflow.
  const dump = lockDir + '.stale';
  try {
    rmSync(dump, { recursive: true, force: true });
  } catch {
    // occupied — fall through to the unique name
  }
  try {
    renameSync(lockDir, dump);
    return;
  } catch {
    // maybe it really is deletable — try that before giving up
  }
  try {
    renameSync(lockDir, `${dump}-${Date.now()}`);
  } catch {
    // nothing moved; the wait limit makes a lock that never clears loud
  }
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // leave it to the next round; the wait limit makes that failure loud
  }
}

async function acquire() {
  const started = Date.now();
  for (;;) {
    // Checked at the top of every turn: the steal path `continue`s without
    // sleeping, so a lock that refuses to disappear used to spin here forever —
    // silent, at full CPU, and past WAIT_LIMIT_MS.
    if (Date.now() - started > WAIT_LIMIT_MS) {
      throw new Error(
        `build lock busy for ${WAIT_LIMIT_MS}ms (${lockDir}) — another session may be stuck building`,
      );
    }
    try {
      mkdirSync(lockDir);
      writeFileSync(pidFile, String(process.pid));
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (lockIsStale()) {
        discardStaleLock();
        // A rename that "succeeded" can still leave the old path blocking mkdir
        // for a moment (Windows delete-pending); the pause keeps the retry from
        // spinning hot across that window.
        await sleep(50);
        continue;
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
