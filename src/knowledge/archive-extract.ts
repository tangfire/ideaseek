import { randomUUID } from 'node:crypto';
import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { ensureDir, writeFileAtomic } from '../core/atomic.js';
import { sha256Of, sha256OfFile, type ContentHash } from '../core/hash.js';
import { RESEARCH_DIR } from '../config/paths.js';
import {
  ARCHIVE_PARSER_VERSION,
  ArchiveBombError,
  ArchiveCorruptError,
  openArchive,
  type ArchiveInput,
  type ExtractionRecord,
} from './archive.js';

/**
 * Safe extraction of `ok` archives into an isolated, platform-managed
 * directory. The original archive stays read-only (its hash is re-verified
 * before every extraction), extraction happens in a temp directory that is
 * atomically renamed into place, and a sibling manifest records per-file
 * hashes so crashes are detectable and recoverable. Blocked, corrupted,
 * encrypted and unknown archives are never extracted.
 */

export const EXTRACT_MANIFEST_VERSION = 1;

export interface ExtractionFileRecord {
  path: string;
  bytes: number;
  sha256: ContentHash;
}

export interface ExtractionManifest {
  manifestVersion: typeof EXTRACT_MANIFEST_VERSION;
  archiveId: string;
  sourceSha256: ContentHash;
  parserVersion: string;
  extractedAt: number;
  files: ExtractionFileRecord[];
  totalBytes: number;
  /** sha256 over sorted `path\tbytes\tsha256` lines — the snapshot identity. */
  rootHash: ContentHash;
  /** Links recorded from the archive but not materialized on disk. */
  skippedLinks: { path: string; kind: string; target: string }[];
}

export interface ExtractArchiveOptions {
  /** Isolated root for extractions (defaults under `<project>/.research/…`). */
  extractRoot: string;
  now?: number;
}

/** Default isolated extraction root for a project. */
export function defaultArchiveExtractRoot(projectRoot: string): string {
  return join(resolve(projectRoot), RESEARCH_DIR, 'archive-extracts');
}

function manifestPathFor(extractRoot: string, archiveId: string): string {
  return join(extractRoot, `${archiveId}.extract.json`);
}

function computeRootHash(files: readonly ExtractionFileRecord[]): ContentHash {
  const lines = files
    .map((file) => `${file.path}\t${file.bytes}\t${file.sha256}`)
    .sort()
    .join('\n');
  return sha256Of(lines);
}

function toRecord(
  manifest: ExtractionManifest,
  dir: string,
  manifestPath: string,
  reused: boolean,
): ExtractionRecord {
  return {
    dir,
    at: manifest.extractedAt,
    files: manifest.files.length,
    totalBytes: manifest.totalBytes,
    rootHash: manifest.rootHash,
    reused,
    manifestPath,
    skippedLinks: manifest.skippedLinks,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Defense in depth: every write target must stay inside the temp directory. */
function assertInsideDir(base: string, target: string): void {
  const baseResolved = resolve(base);
  const targetResolved = resolve(target);
  if (targetResolved !== baseResolved && !targetResolved.startsWith(baseResolved + sep)) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `extraction target escapes the extract root: ${target}`,
      {
        target,
      },
    );
  }
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  await visit(root);
  return out;
}

async function verifyExtraction(dir: string, manifest: ExtractionManifest): Promise<boolean> {
  try {
    const paths = await walkFiles(dir);
    if (paths.length !== manifest.files.length) return false;
    const byPath = new Map(manifest.files.map((file) => [file.path, file]));
    const seen = new Set<string>();
    for (const full of paths) {
      const rel = relative(dir, full).split(sep).join('/');
      const expected = byPath.get(rel);
      if (!expected) return false;
      const info = await stat(full);
      if (info.size !== expected.bytes) return false;
      if ((await sha256OfFile(full)) !== expected.sha256) return false;
      seen.add(rel);
    }
    if (seen.size !== manifest.files.length) return false;
    return computeRootHash([...byPath.values()]) === manifest.rootHash;
  } catch {
    return false;
  }
}

async function loadManifest(manifestPath: string): Promise<ExtractionManifest | null> {
  try {
    const raw = await readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as ExtractionManifest;
    if (parsed.manifestVersion !== EXTRACT_MANIFEST_VERSION) return null;
    if (!Array.isArray(parsed.files)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Extracts a scanned archive into `extractRoot/<archiveId>/`.
 *
 * Guarantees:
 * - refuses any status other than `ok` (blocked/corrupted/encrypted/unknown);
 * - re-hashes the source archive first — a changed input is refused, never
 *   silently extracted (`OUTPUT_HASH_MISMATCH`);
 * - writes into a temp directory, verifies nothing escapes the root, then
 *   atomically renames and records a hash manifest;
 * - idempotent: an existing verified extraction is reused (`reused: true`),
 *   and a tampered/crashed one is discarded and rebuilt;
 * - symlinks/hardlinks are recorded but not materialized (platform policy).
 */
export async function extractArchive(
  input: ArchiveInput,
  opts: ExtractArchiveOptions,
): Promise<ArchiveInput> {
  if (input.status !== 'ok') {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `archive is not extractable (status=${input.status}); refusing to extract`,
      { status: input.status, archiveId: input.archiveId },
    );
  }

  const limits = input.safety.limits;
  const extractRoot = resolve(opts.extractRoot);
  const now = opts.now ?? Date.now();

  let currentSha: ContentHash;
  try {
    currentSha = await sha256OfFile(input.source.path);
  } catch {
    throw new IdeaseekError('FILE_NOT_FOUND', `archive source missing: ${input.source.path}`, {
      archiveId: input.archiveId,
    });
  }
  if (currentSha !== input.source.sha256) {
    throw new IdeaseekError(
      'OUTPUT_HASH_MISMATCH',
      'archive content changed since it was scanned; re-run scan before extracting',
      { archiveId: input.archiveId, kind: 'archive-source' },
    );
  }

  const finalDir = join(extractRoot, input.archiveId);
  const manifestPath = manifestPathFor(extractRoot, input.archiveId);

  const existing = await loadManifest(manifestPath);
  if (existing && existing.sourceSha256 === currentSha && (await pathExists(finalDir))) {
    if (await verifyExtraction(finalDir, existing)) {
      return { ...input, extraction: toRecord(existing, finalDir, manifestPath, true) };
    }
  }
  // Discard anything incomplete or tampered; extraction is rebuilt from scratch.
  await rm(finalDir, { recursive: true, force: true });
  await rm(manifestPath, { force: true });

  await ensureDir(extractRoot);
  const tempDir = join(extractRoot, `.tmp-${input.archiveId}-${randomUUID()}`);
  await ensureDir(tempDir);

  const handle = await openArchive(input.source.path, input.format, limits);
  try {
    const files: ExtractionFileRecord[] = [];
    const skippedLinks: ExtractionManifest['skippedLinks'] = [];
    let totalBytes = 0;

    for (const member of handle.members) {
      if (member.kind === 'dir') {
        if (member.path) {
          const target = join(tempDir, ...member.path.split('/'));
          assertInsideDir(tempDir, target);
          await ensureDir(target);
        }
        continue;
      }
      if (member.kind === 'symlink' || member.kind === 'hardlink') {
        skippedLinks.push({
          path: member.path,
          kind: member.kind,
          target: member.linkTarget ?? '',
        });
        continue;
      }
      if (member.kind === 'other') {
        // Unreachable for `ok` archives (assessArchiveMembers blocks these).
        throw new ArchiveCorruptError(
          'unsupported-member-type',
          `unexpected unsupported member during extraction: ${member.path}`,
        );
      }

      const data = await handle.readMember(member);
      if (data.length > limits.maxMemberBytes) {
        throw new ArchiveBombError(
          'member-size',
          `member ${member.path} produced ${data.length} bytes (limit ${limits.maxMemberBytes})`,
        );
      }
      totalBytes += data.length;
      if (totalBytes > limits.maxTotalBytes) {
        throw new ArchiveBombError(
          'total-size',
          `extraction total ${totalBytes} exceeds limit ${limits.maxTotalBytes}`,
        );
      }
      const target = join(tempDir, ...member.path.split('/'));
      assertInsideDir(tempDir, target);
      await ensureDir(dirname(target));
      await writeFile(target, data);
      files.push({ path: member.path, bytes: data.length, sha256: sha256Of(data) });
    }

    files.sort((a, b) => a.path.localeCompare(b.path));
    const manifest: ExtractionManifest = {
      manifestVersion: EXTRACT_MANIFEST_VERSION,
      archiveId: input.archiveId,
      sourceSha256: currentSha,
      parserVersion: ARCHIVE_PARSER_VERSION,
      extractedAt: now,
      files,
      totalBytes,
      rootHash: computeRootHash(files),
      skippedLinks,
    };

    try {
      await rename(tempDir, finalDir);
    } catch (error) {
      // A concurrent extractor may have won the rename; adopt its result if valid.
      const raced = await loadManifest(manifestPath);
      if (raced && raced.sourceSha256 === currentSha && (await pathExists(finalDir))) {
        await rm(tempDir, { recursive: true, force: true });
        if (await verifyExtraction(finalDir, raced)) {
          return { ...input, extraction: toRecord(raced, finalDir, manifestPath, true) };
        }
      }
      throw error;
    }
    await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return { ...input, extraction: toRecord(manifest, finalDir, manifestPath, false) };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
}

export interface ArchiveRecoveryResult {
  /** Stale `.tmp-*` directories/files left by a crashed extraction. */
  removedTemps: string[];
  /** Extraction directories missing their manifest (partial crash leftovers). */
  removedPartials: string[];
  /** Manifests whose extraction directory is gone. */
  removedOrphans: string[];
  /** Directories that still have their manifest (content not re-verified here). */
  intact: string[];
}

/**
 * Structural recovery for the extraction root: removes crash leftovers so the
 * next `extractArchive` starts clean, and reports intact extractions. Content
 * verification happens in extractArchive's reuse path — this function only
 * makes the directory layout consistent again.
 */
export async function recoverArchiveExtractions(
  extractRoot: string,
): Promise<ArchiveRecoveryResult> {
  const root = resolve(extractRoot);
  const result: ArchiveRecoveryResult = {
    removedTemps: [],
    removedPartials: [],
    removedOrphans: [],
    intact: [],
  };
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.name.startsWith('.tmp-')) {
      await rm(full, { recursive: true, force: true });
      result.removedTemps.push(full);
    } else if (entry.isDirectory()) {
      const manifestPath = manifestPathFor(root, entry.name);
      if (await pathExists(manifestPath)) {
        result.intact.push(full);
      } else {
        await rm(full, { recursive: true, force: true });
        result.removedPartials.push(full);
      }
    }
  }

  const after = await readdir(root, { withFileTypes: true });
  for (const entry of after) {
    if (!entry.isFile() || !entry.name.endsWith('.extract.json')) continue;
    const archiveId = entry.name.slice(0, -'.extract.json'.length);
    if (!(await pathExists(join(root, archiveId)))) {
      const orphan = join(root, entry.name);
      await rm(orphan, { force: true });
      result.removedOrphans.push(orphan);
    }
  }

  return result;
}
