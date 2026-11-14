import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { ensureDir, writeFileAtomic } from '../core/atomic.js';
import { sha256Of, sha256OfFile } from '../core/hash.js';
import { stableJson } from '../experiment/spec.js';
import {
  evaluateComparisonGate,
  type ComparisonGateDb,
  type ComparisonGateResult,
} from './gate.js';

/**
 * Worktree hash stamps for comparison methods (cross-mode collaboration):
 * when `comparison smoke` passes, we stamp `.research/worktree-stamps/<id>.json`
 * with a deterministic hash of `comparisons/<id>/worktree` (ignoring VCS/venv/cache
 * artifacts). If a general coding turn later modifies that worktree, `stale` and
 * `comparison gate` detect that the passing smoke no longer backs the code on
 * disk without touching upstream/ or requiring the user to rerun everything else.
 */

const IGNORE_DIRS = new Set([
  '.git',
  '.venv',
  'venv',
  'node_modules',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
]);

export interface WorktreeStamp {
  methodId: string;
  worktreeHash: string;
  smokeAt: number;
  recordedAt: number;
}

export type WorktreeStaleOutcome =
  | { state: 'no-stamp' }
  | { state: 'current'; hash: string }
  | { state: 'stale'; recordedHash: string; currentHash: string | null };

async function walkWorktree(baseDir: string, currentDir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      await walkWorktree(baseDir, join(currentDir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(join(currentDir, entry.name));
    }
  }
}

/** Deterministic content hash of all non-ignored files in a comparison worktree. */
export async function hashWorktreeDir(worktreeDir: string): Promise<string | null> {
  const files: string[] = [];
  await walkWorktree(worktreeDir, worktreeDir, files);
  if (files.length === 0) return null;
  const entries: { path: string; sha256: string }[] = [];
  for (const abs of files) {
    const rel = relative(worktreeDir, abs).split(sep).join('/');
    entries.push({ path: rel, sha256: await sha256OfFile(abs) });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256Of(stableJson(entries));
}

export function worktreeStampPath(projectRoot: string, methodId: string): string {
  return join(projectRoot, '.research', 'worktree-stamps', `${methodId}.json`);
}

export async function writeSmokeWorktreeStamp(
  projectRoot: string,
  methodId: string,
  worktreeHash: string,
  smokeAt: number,
): Promise<void> {
  const path = worktreeStampPath(projectRoot, methodId);
  await ensureDir(join(projectRoot, '.research', 'worktree-stamps'));
  const stamp: WorktreeStamp = {
    methodId,
    worktreeHash,
    smokeAt,
    recordedAt: Date.now(),
  };
  await writeFileAtomic(path, `${JSON.stringify(stamp, null, 2)}\n`);
}

export async function readSmokeWorktreeStamp(
  projectRoot: string,
  methodId: string,
): Promise<WorktreeStamp | null> {
  try {
    const raw = await readFile(worktreeStampPath(projectRoot, methodId), 'utf8');
    const parsed = JSON.parse(raw) as Partial<WorktreeStamp>;
    if (
      parsed.methodId === methodId &&
      typeof parsed.worktreeHash === 'string' &&
      parsed.worktreeHash
    ) {
      return parsed as WorktreeStamp;
    }
    return null;
  } catch {
    return null;
  }
}

export async function checkWorktreeStaleness(
  projectRoot: string,
  methodId: string,
): Promise<WorktreeStaleOutcome> {
  const stamp = await readSmokeWorktreeStamp(projectRoot, methodId);
  if (!stamp) return { state: 'no-stamp' };
  const worktreeDir = join(projectRoot, 'comparisons', methodId, 'worktree');
  const currentHash = await hashWorktreeDir(worktreeDir);
  if (currentHash === stamp.worktreeHash) {
    return { state: 'current', hash: stamp.worktreeHash };
  }
  return {
    state: 'stale',
    recordedHash: stamp.worktreeHash,
    currentHash,
  };
}

/** Collects methodIds whose worktree drifted since their last passing smoke stamp. */
export async function collectStaleWorktrees(
  projectRoot: string,
  methodIds: Iterable<string>,
): Promise<Set<string>> {
  const stale = new Set<string>();
  for (const methodId of methodIds) {
    const outcome = await checkWorktreeStaleness(projectRoot, methodId);
    if (outcome.state === 'stale') stale.add(methodId);
  }
  return stale;
}

/** Shared project-aware wrapper around the pure comparison gate. */
export async function evaluateComparisonGateForProject(
  projectRoot: string,
  db: ComparisonGateDb,
): Promise<ComparisonGateResult> {
  const required = await db.listComparisons({ required: true });
  const staleWorktrees = await collectStaleWorktrees(
    projectRoot,
    required.map((method) => method.methodId),
  );
  return evaluateComparisonGate(db, { staleWorktrees });
}
