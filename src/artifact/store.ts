import { open, readdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { IdeaseekError } from '../core/errors.js';
import { ensureDir } from '../core/atomic.js';
import { sha256Of, sha256OfFile, type ContentHash } from '../core/hash.js';
import { relPathForHash } from '../workflow/sqlite.js';

export interface StagedArtifact {
  kind: string;
  /** Absolute path of the temp file; survives crashes so recovery can finish. */
  tempPath: string;
  contentHash: ContentHash;
  size: number;
  meta: Record<string, unknown>;
}

export interface ArtifactStoreOptions {
  artifactsDir: string;
  tmpDir: string;
  /** Temps older than this are deleted by `cleanupStaleTemps` (crash leftovers). */
  staleTempMs?: number;
}

export type EnsureFileOutcome = 'present' | 'promoted' | 'missing';

/**
 * Content-addressed artifact store. Writers only ever touch `tmpDir` first;
 * `promote` re-hashes the temp file, then atomically renames it to its final
 * `sha256/<aa>/<bb>/<hex>` location (same filesystem), which makes a crash at
 * any point recoverable: temp leftovers are cleaned by age, and a file that
 * reached its final location without a DB row is a harmless cache entry that
 * the next identical commit adopts.
 */
export class ArtifactStore {
  readonly artifactsDir: string;
  readonly tmpDir: string;
  private readonly staleTempMs: number;

  constructor(opts: ArtifactStoreOptions) {
    this.artifactsDir = opts.artifactsDir;
    this.tmpDir = opts.tmpDir;
    this.staleTempMs = opts.staleTempMs ?? 60_000;
  }

  resolvePath(hash: ContentHash): string {
    return join(this.artifactsDir, relPathForHash(hash));
  }

  async stage(
    kind: string,
    data: Buffer | string,
    meta: Record<string, unknown> = {},
  ): Promise<StagedArtifact> {
    await ensureDir(this.tmpDir);
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const contentHash = sha256Of(bytes);
    const tempPath = join(this.tmpDir, `stage-${randomUUID()}.tmp`);
    const handle = await open(tempPath, 'w');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { kind, tempPath, contentHash, size: bytes.byteLength, meta };
  }

  /**
   * Verifies each staged temp file against its declared hash and atomically
   * moves it to the final content-addressed path. Duplicate content already at
   * the destination is adopted; a corrupted destination is replaced by the
   * verified temp file.
   */
  async promote(staged: StagedArtifact[]): Promise<void> {
    // Verify everything first so a corrupt temp never partially promotes.
    for (const artifact of staged) {
      const ok = await this.verifyTemp(artifact);
      if (!ok) {
        throw new IdeaseekError(
          'OUTPUT_HASH_MISMATCH',
          `staged artifact ${artifact.kind} failed hash verification at ${artifact.tempPath}`,
          { kind: artifact.kind },
        );
      }
    }
    for (const artifact of staged) {
      await this.promoteOne(artifact.tempPath, artifact.contentHash);
    }
  }

  /**
   * Recovery helper: decides whether a staged row's bytes are safely at their
   * final location. `missing` means the content is gone and the attempt must
   * be requeued.
   */
  async ensureCommittedFile(tempPath: string, hash: ContentHash): Promise<EnsureFileOutcome> {
    if (await this.verifyPath(this.resolvePath(hash), hash)) return 'present';
    if (await this.verifyPath(tempPath, hash)) {
      await this.promoteOne(tempPath, hash);
      return 'promoted';
    }
    return 'missing';
  }

  async discard(staged: StagedArtifact[]): Promise<void> {
    for (const artifact of staged) {
      await unlink(artifact.tempPath).catch(() => undefined);
    }
  }

  async readFinalText(hash: ContentHash): Promise<string> {
    const { readFile } = await import('node:fs/promises');
    return readFile(this.resolvePath(hash), 'utf8');
  }

  /**
   * Removes crash leftovers from `tmpDir`; returns the deleted paths.
   *
   * `keep` is the set of temp paths that live `staged` artifact rows still
   * reference (db.listStagedTempPaths): age alone must never sweep a temp a
   * commit is about to promote. Promoting a multi-GB artifact legitimately
   * takes longer than the staleness window, and another CLI opening the
   * project mid-promote used to delete the in-flight temp → promote failed
   * with OUTPUT_HASH_MISMATCH → the task requeued → the same race again
   * (design review #11). The staged row is the ownership signal; only
   * unreferenced files age out.
   */
  async cleanupStaleTemps(now: number, keep: Iterable<string | null> = []): Promise<string[]> {
    const keepSet = new Set<string>();
    for (const path of keep) {
      if (path) keepSet.add(normalize(path));
    }
    let entries: string[];
    try {
      entries = await readdir(this.tmpDir);
    } catch {
      return [];
    }
    const removed: string[] = [];
    for (const entry of entries) {
      const path = join(this.tmpDir, entry);
      if (keepSet.has(normalize(path))) continue;
      try {
        const info = await stat(path);
        if (now - info.mtimeMs >= this.staleTempMs) {
          await unlink(path);
          removed.push(path);
        }
      } catch {
        // Raced with another cleaner or the owning worker; skip.
      }
    }
    return removed;
  }

  private async verifyTemp(artifact: StagedArtifact): Promise<boolean> {
    return this.verifyPath(artifact.tempPath, artifact.contentHash);
  }

  private async verifyPath(path: string, expected: ContentHash): Promise<boolean> {
    try {
      return (await sha256OfFile(path)) === expected;
    } catch {
      return false;
    }
  }

  private async promoteOne(tempPath: string, hash: ContentHash): Promise<void> {
    const dest = this.resolvePath(hash);
    await ensureDir(dirname(dest));
    if (await this.verifyPath(dest, hash)) {
      // Content already stored: adopt it and drop our duplicate temp.
      await unlink(tempPath).catch(() => undefined);
      return;
    }
    try {
      const destInfo = await stat(dest).catch(() => null);
      if (destInfo) {
        // Destination exists but is corrupt: replace with verified temp.
        await unlink(dest);
      }
      await rename(tempPath, dest);
    } catch (error) {
      // Concurrent promoter may have won the rename; accept if dest is valid.
      if (await this.verifyPath(dest, hash)) {
        await unlink(tempPath).catch(() => undefined);
        return;
      }
      throw new IdeaseekError(
        'INVALID_ARTIFACT',
        `failed to promote artifact to ${dest}: ${(error as Error).message}`,
      );
    }
  }
}
