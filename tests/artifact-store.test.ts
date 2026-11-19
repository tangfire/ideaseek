import { mkdir, mkdtemp, readdir, readFile, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../src/artifact/store.js';
import { sha256Of } from '../src/core/hash.js';

let root: string;
let store: ArtifactStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ideaseek-artifacts-'));
  store = new ArtifactStore({
    artifactsDir: join(root, 'artifacts'),
    tmpDir: join(root, 'artifacts', 'tmp'),
    staleTempMs: 60_000,
  });
});

afterEach(async () => {
  // best-effort cleanup; tmp dirs are OS-temp anyway
});

describe('artifact store', () => {
  it('stages to a temp file and promotes atomically to the content address', async () => {
    const staged = await store.stage('report', 'hello world', { filename: 'report.md' });
    expect(staged.contentHash).toBe(sha256Of('hello world'));
    expect(staged.tempPath).toContain('tmp');
    expect(await readFile(staged.tempPath, 'utf8')).toBe('hello world');

    await store.promote([staged]);
    const finalPath = store.resolvePath(staged.contentHash);
    expect(await readFile(finalPath, 'utf8')).toBe('hello world');
    // Temp is gone after promotion.
    await expect(readdir(join(root, 'artifacts', 'tmp'))).resolves.toEqual([]);
  });

  it('rejects a corrupted temp file before touching the destination', async () => {
    const staged = await store.stage('report', 'original content');
    await writeFile(staged.tempPath, 'tampered content', 'utf8'); // hash mismatch

    await expect(store.promote([staged])).rejects.toMatchObject({
      code: 'OUTPUT_HASH_MISMATCH',
    });
    // Destination was never created.
    await expect(readdir(join(root, 'artifacts', 'sha256'))).rejects.toThrow();
  });

  it('deduplicates identical content across stages', async () => {
    const a = await store.stage('report', 'same bytes');
    const b = await store.stage('report', 'same bytes');
    expect(a.contentHash).toBe(b.contentHash);

    await store.promote([a]);
    await store.promote([b]); // adopts existing destination, removes temp
    const finalPath = store.resolvePath(a.contentHash);
    expect(await readFile(finalPath, 'utf8')).toBe('same bytes');
    await expect(readdir(join(root, 'artifacts', 'tmp'))).resolves.toEqual([]);
  });

  it('repairs a corrupt destination file using the verified temp', async () => {
    const staged = await store.stage('report', 'good content');
    const dest = store.resolvePath(staged.contentHash);
    await mkdir(join(dest, '..'), { recursive: true });
    await writeFile(dest, 'bitrot', 'utf8'); // corrupt existing destination

    await store.promote([staged]);
    expect(await readFile(dest, 'utf8')).toBe('good content');
  });

  it('removes only stale temp files during crash cleanup', async () => {
    const stale = await store.stage('report', 'stale bytes');
    const fresh = await store.stage('report', 'fresh bytes');
    const old = new Date(Date.now() - 120_000);
    await utimes(stale.tempPath, old, old);

    const removed = await store.cleanupStaleTemps(Date.now());
    expect(removed).toEqual([stale.tempPath]);
    await expect(readFile(fresh.tempPath, 'utf8')).resolves.toBe('fresh bytes');
  });

  it('never sweeps a temp a live staged row still owns, however old', async () => {
    // Design review #11: age alone is not ownership. Promoting a multi-GB
    // temp legitimately outlives the staleness window; another CLI opening
    // the project used to sweep it mid-promote → OUTPUT_HASH_MISMATCH →
    // requeue loop. The staged row is the ownership signal.
    const owned = await store.stage('report', 'owned bytes');
    const orphan = await store.stage('report', 'orphan bytes');
    const old = new Date(Date.now() - 120_000);
    await utimes(owned.tempPath, old, old);
    await utimes(orphan.tempPath, old, old);

    const removed = await store.cleanupStaleTemps(Date.now(), [owned.tempPath, null]);
    expect(removed).toEqual([orphan.tempPath]);
    await expect(readFile(owned.tempPath, 'utf8')).resolves.toBe('owned bytes');
    // …and the survivor still promotes normally afterwards.
    await store.promote([owned]);
    await expect(readFile(store.resolvePath(owned.contentHash), 'utf8')).resolves.toBe(
      'owned bytes',
    );
  });

  it('ensureCommittedFile classifies present / promoted / missing', async () => {
    const staged = await store.stage('report', 'recovery bytes');
    const hash = staged.contentHash;

    // missing: neither temp nor final exists.
    const missing = await store.ensureCommittedFile(join(root, 'nope.tmp'), hash);
    expect(missing).toBe('missing');

    // promoted: temp exists, final does not yet.
    const promoted = await store.ensureCommittedFile(staged.tempPath, hash);
    expect(promoted).toBe('promoted');
    expect(await readFile(store.resolvePath(hash), 'utf8')).toBe('recovery bytes');

    // present: already at final location (temp now gone).
    const present = await store.ensureCommittedFile(staged.tempPath, hash);
    expect(present).toBe('present');
  });

  it('treats a final file written without a DB row as adoptable cache', async () => {
    const staged = await store.stage('report', 'orphan content');
    // Simulate crash after rename but before DB commit: file at final path.
    const dest = store.resolvePath(staged.contentHash);
    await mkdir(join(dest, '..'), { recursive: true });
    await writeFile(dest, 'orphan content', 'utf8');
    await writeFile(staged.tempPath, 'orphan content', 'utf8'); // temp also survived

    const outcome = await store.ensureCommittedFile(staged.tempPath, staged.contentHash);
    expect(outcome).toBe('present');
    expect(await readFile(dest, 'utf8')).toBe('orphan content');
  });
});
