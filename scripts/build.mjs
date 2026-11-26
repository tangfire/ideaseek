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
 *
 * Freshness (scripts/build-fingerprint.mjs): dist/.build-fingerprint holds
 * digests of the compile inputs and of the emitted products. When both
 * still match, this script skips tsc entirely (~0.2s instead of ~25s) —
 * the path setup.sh and every vitest run take when nothing changed. The
 * record is deleted before tsc and written only after exit 0, so a killed
 * or failed build can never leave a skip behind; `--force` bypasses the
 * check and drops .tsbuildinfo for a clean full rebuild (vitest's
 * boot-failure retry uses it: a torn dist is exactly what a fingerprint
 * would otherwise wave through). IDEASEEK_BUILD_OUT never reads or writes
 * the dist fingerprint and keeps its own .tsbuildinfo inside the
 * throwaway dir — a shared one would let an out-of-tree emit mark dist
 * files "emitted" and hollow out the next real build.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inputDigest,
  outputDigest,
  fingerprintPath,
  readFingerprint,
  writeFingerprint,
  planBuild,
} from './build-fingerprint.mjs';

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

const force = process.argv.slice(2).includes('--force');
const outDir = process.env.IDEASEEK_BUILD_OUT;

await acquire();
process.on('exit', release);
try {
  const tscArgs = ['-p', 'tsconfig.build.json'];
  let skip = false;
  let inputs = null;

  if (outDir) {
    // Throwaway emit: always a real build, never touches the dist
    // fingerprint, and keeps its .tsbuildinfo inside the throwaway dir.
    tscArgs.push('--outDir', outDir, '--tsBuildInfoFile', join(outDir, '.tsbuildinfo'));
  } else {
    inputs = inputDigest(root);
    const plan = planBuild({
      force,
      fingerprint: readFingerprint(root),
      inputs,
      outputs: outputDigest(root),
    });
    if (plan.mode === 'skip') {
      skip = true;
      console.log('build: up to date — skipped tsc (fingerprint match)');
    } else {
      // Journal: only a finished build leaves a fingerprint behind.
      rmSync(fingerprintPath(root), { force: true });
      if (plan.mode === 'full') rmSync(join(root, 'dist', '.tsbuildinfo'), { force: true });
      console.log(`build: ${plan.reason} — ${plan.mode} tsc`);
    }
  }

  if (!skip) {
    const result = spawnSync(
      process.execPath,
      [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), ...tscArgs],
      { cwd: root, stdio: 'inherit' },
    );
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    if (!outDir && process.exitCode === 0) {
      writeFingerprint(root, { inputs, outputs: outputDigest(root) });
    }
  }
} finally {
  release();
}
