import { open, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { createGunzip, crc32, inflateRawSync } from 'node:zlib';
import { IdeaseekError } from '../core/errors.js';
import { sha256OfFile, type ContentHash } from '../core/hash.js';
import { extOf } from './scan.js';

/**
 * ArchiveInput (docs/DATA_CONTRACTS.md): archives are first-class inputs.
 * This module scans archive members without extracting, applies the safety
 * gates (absolute paths, `../` traversal, escaping symlinks, compression
 * bombs, oversized members, excessive nesting), and reports a status:
 * `ok | ARCHIVE_BLOCKED | corrupted | encrypted | unknown-format`.
 *
 * The original archive is opened read-only and never modified; extraction
 * lives in archive-extract.ts and only writes into an isolated directory.
 */

export const ARCHIVE_PARSER_VERSION = 'ideaseek-archive-1';

export type ArchiveFormat = 'zip' | 'tar' | 'tar.gz' | 'gzip' | 'unknown';

export type ArchiveStatus = 'ok' | 'ARCHIVE_BLOCKED' | 'corrupted' | 'encrypted' | 'unknown-format';

export type ArchiveBlockReason =
  | 'absolute-path'
  | 'path-traversal'
  | 'dangerous-symlink'
  | 'dangerous-hardlink'
  | 'compression-ratio'
  | 'total-size'
  | 'member-size'
  | 'member-count'
  | 'depth-exceeded'
  | 'special-file'
  | 'unsupported-member-type'
  | 'unsupported-compression'
  | 'invalid-name'
  | 'decompressed-size';

export interface ArchiveViolation {
  reason: ArchiveBlockReason;
  /** Normalized member path when the violation is member-specific. */
  member?: string;
  detail: string;
}

export interface ArchiveMember {
  /** Normalized in-archive path: forward slashes, no `./`, no trailing slash. */
  path: string;
  /** Exactly the bytes stored in the archive (before normalization). */
  rawPath: string;
  kind: 'file' | 'dir' | 'symlink' | 'hardlink' | 'other';
  /** Declared uncompressed size in bytes (files; 0 otherwise). */
  size: number;
  /** Bytes the member occupies in the archive (zip only; equals size for tar). */
  compressedSize: number;
  linkTarget?: string;
  encrypted: boolean;
  /** Zip compression method (0 stored, 8 deflate); absent for tar members. */
  method?: number;
  /** Tar typeflag when present (e.g. `3` chardev) — used for blocking. */
  typeFlag?: string;
  /** False when a member-specific violation references this member. */
  safe: boolean;
}

export interface ArchiveSafetyLimits {
  /** Hard cap on listed members; archives declaring more are blocked. */
  maxMembers: number;
  /** Cap on total uncompressed bytes (also bounds in-memory tar parsing). */
  maxTotalBytes: number;
  /** Cap on a single member's uncompressed bytes. */
  maxMemberBytes: number;
  /** Maximum path depth (number of segments) inside the archive. */
  maxDepth: number;
  /** totalUncompressed / archiveBytes above this ratio is a bomb suspect. */
  maxCompressionRatio: number;
  /** Ratio check only applies once total uncompressed exceeds this floor. */
  ratioFloorBytes: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveSafetyLimits = {
  maxMembers: 50_000,
  maxTotalBytes: 512 * 1024 * 1024,
  maxMemberBytes: 128 * 1024 * 1024,
  maxDepth: 24,
  maxCompressionRatio: 200,
  ratioFloorBytes: 32 * 1024 * 1024,
};

export function mergeArchiveLimits(
  overrides: Partial<ArchiveSafetyLimits> = {},
): ArchiveSafetyLimits {
  return { ...DEFAULT_ARCHIVE_LIMITS, ...overrides };
}

export interface ArchiveSafety {
  limits: ArchiveSafetyLimits;
  violations: ArchiveViolation[];
  /** totalUncompressed / max(archiveBytes, 1), rounded to 2 decimals. */
  ratio: number;
}

export interface ArchiveSource {
  /** Absolute path of the original archive — opened read-only, never written. */
  path: string;
  /** Project-relative path with forward slashes, when under projectRoot. */
  relPath: string | null;
  bytes: number;
  sha256: ContentHash;
  mtimeMs: number;
}

export interface ExtractionRecord {
  /** Isolated extraction directory (platform-managed, not user input). */
  dir: string;
  at: number;
  files: number;
  totalBytes: number;
  /** sha256 over sorted `path\tbytes\tsha256` lines of extracted files. */
  rootHash: ContentHash;
  /** True when an identical, verified extraction was reused. */
  reused: boolean;
  manifestPath: string;
  /** Symlinks/hardlinks recorded but not materialized (platform policy). */
  skippedLinks: { path: string; kind: string; target: string }[];
}

export interface ArchiveInput {
  /** Content-addressed id: `arc-<sha256 prefix>` — stable across scans. */
  archiveId: string;
  parserVersion: string;
  format: ArchiveFormat;
  status: ArchiveStatus;
  source: ArchiveSource;
  members: ArchiveMember[];
  memberCount: number;
  totalUncompressedBytes: number;
  safety: ArchiveSafety;
  /** Human-readable notes: detection basis, corruption reasons, quirks. */
  issues: string[];
  extraction: ExtractionRecord | null;
  scannedAt: number;
}

/** Structural damage inside an archive: maps to status `corrupted`. */
export class ArchiveCorruptError extends IdeaseekError {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super('PARSE_FAILED', message, { kind: 'archive-corrupt', reason });
    this.name = 'ArchiveCorruptError';
    this.reason = reason;
  }
}

/** Decompression bomb detected while reading: maps to status `ARCHIVE_BLOCKED`. */
export class ArchiveBombError extends IdeaseekError {
  readonly reason: ArchiveBlockReason;

  constructor(reason: ArchiveBlockReason, message: string) {
    super('INVALID_STATE', message, { kind: 'archive-bomb', reason });
    this.name = 'ArchiveBombError';
    this.reason = reason;
  }
}

export interface FormatDetection {
  format: ArchiveFormat;
  /** How the format was decided (goes into issues for auditability). */
  basis: string;
  /** Extra detail for unsupported/unknown cases. */
  detail?: string;
}

const ZIP_SIGNATURES = [0x04034b50, 0x06054b50, 0x08074b50];
const UNSUPPORTED_ARCHIVE_EXT = new Set([
  '.7z',
  '.rar',
  '.bz2',
  '.xz',
  '.tar.bz2',
  '.tar.xz',
  '.tar.lz4',
  '.tar.zst',
  '.lz4',
  '.zst',
  '.cab',
  '.iso',
]);

/**
 * Magic-first format detection with an extension fallback. Files whose magic
 * and extension both fail become `unknown-format` (never guessed as safe).
 */
export function detectArchiveFormat(head: Buffer, fileName: string): FormatDetection {
  if (head.length >= 4 && ZIP_SIGNATURES.includes(head.readUInt32LE(0))) {
    return { format: 'zip', basis: 'magic:zip' };
  }
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
    return { format: 'gzip', basis: 'magic:gzip' };
  }
  if (head.length >= 512 && tarChecksumValid(head.subarray(0, 512)).valid) {
    return { format: 'tar', basis: 'magic:tar-checksum' };
  }
  const ext = extOf(fileName.toLowerCase());
  switch (ext) {
    case '.zip':
      return { format: 'zip', basis: 'extension:.zip' };
    case '.tar':
      return { format: 'tar', basis: 'extension:.tar' };
    case '.tar.gz':
    case '.tgz':
    case '.gz':
      return { format: 'gzip', basis: `extension:${ext}` };
    default:
      if (UNSUPPORTED_ARCHIVE_EXT.has(ext)) {
        return {
          format: 'unknown',
          basis: 'extension-unsupported',
          detail: `format-unsupported:${ext} (no built-in parser; not treated as safe)`,
        };
      }
      return { format: 'unknown', basis: 'no-magic,no-archive-extension' };
  }
}

/**
 * Normalizes an in-archive member path for safety evaluation: backslashes to
 * slashes (Windows-created archives), collapse duplicate slashes, strip `./`
 * and trailing slashes. `..` segments are intentionally preserved so the
 * traversal check can see them, and leading `/` / drive letters are kept so
 * the absolute-path check can see them.
 */
export function normalizeMemberPath(raw: string): string {
  let path = raw.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  while (path.startsWith('./')) path = path.slice(2);
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (path === '.' || path === './') return '';
  return path;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:/.test(path);
}

/** Resolves `..` segments; false means the path escapes the archive root. */
function resolvesInsideRoot(path: string): boolean {
  const stack: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (stack.length === 0) return false;
      stack.pop();
    } else {
      stack.push(segment);
    }
  }
  return true;
}

/** True when a symlink/hardlink target escapes the archive root. */
function linkEscapesRoot(memberPath: string, target: string): boolean {
  const normalizedTarget = target.replace(/\\/g, '/');
  if (isAbsolutePath(normalizedTarget)) return true;
  const stack = memberPath
    .split('/')
    .slice(0, -1)
    .filter((s) => s && s !== '.');
  for (const segment of normalizedTarget.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (stack.length === 0) return true;
      stack.pop();
    } else {
      stack.push(segment);
    }
  }
  return false;
}

function pathDepth(path: string): number {
  return path.split('/').filter((s) => s && s !== '.').length;
}

export interface AssessOptions {
  /** True when the parser stopped early because of `maxMembers`. */
  memberCountCapped?: boolean;
}

/**
 * Safety scan over parsed members. Pure: no I/O, so tests can drive the full
 * violation matrix directly as well as through real archive fixtures.
 */
export function assessArchiveMembers(
  members: readonly ArchiveMember[],
  totals: { totalUncompressedBytes: number; archiveBytes: number },
  limits: ArchiveSafetyLimits,
  opts: AssessOptions = {},
): ArchiveViolation[] {
  const violations: ArchiveViolation[] = [];
  const markUnsafe = new Set<string>();

  if (opts.memberCountCapped || members.length > limits.maxMembers) {
    violations.push({
      reason: 'member-count',
      detail: `archive declares more than ${limits.maxMembers} members`,
    });
  }

  for (const member of members) {
    const path = member.path;
    if (path === '' && member.kind === 'dir') continue;

    if (!path || path.includes('\0')) {
      violations.push({ reason: 'invalid-name', member: path, detail: 'empty or NUL member name' });
      markUnsafe.add(path);
      continue;
    }
    if (isAbsolutePath(path)) {
      violations.push({
        reason: 'absolute-path',
        member: path,
        detail: `absolute member path: ${member.rawPath}`,
      });
      markUnsafe.add(path);
      continue;
    }
    if (!resolvesInsideRoot(path)) {
      violations.push({
        reason: 'path-traversal',
        member: path,
        detail: `path escapes the archive root: ${member.rawPath}`,
      });
      markUnsafe.add(path);
      continue;
    }
    if (pathDepth(path) > limits.maxDepth) {
      violations.push({
        reason: 'depth-exceeded',
        member: path,
        detail: `nesting depth exceeds ${limits.maxDepth}`,
      });
      markUnsafe.add(path);
    }
    if (member.kind === 'other') {
      violations.push({
        reason:
          member.typeFlag && ['3', '4', '6'].includes(member.typeFlag)
            ? 'special-file'
            : 'unsupported-member-type',
        member: path,
        detail: `unsupported member type${member.typeFlag ? ` (${member.typeFlag})` : ''}`,
      });
      markUnsafe.add(path);
      continue;
    }
    if (member.kind === 'symlink' && member.linkTarget !== undefined) {
      if (linkEscapesRoot(path, member.linkTarget)) {
        violations.push({
          reason: 'dangerous-symlink',
          member: path,
          detail: `symlink target escapes the archive root: ${member.linkTarget}`,
        });
        markUnsafe.add(path);
      }
      continue;
    }
    if (member.kind === 'hardlink' && member.linkTarget !== undefined) {
      if (linkEscapesRoot(path, member.linkTarget)) {
        violations.push({
          reason: 'dangerous-hardlink',
          member: path,
          detail: `hardlink target escapes the archive root: ${member.linkTarget}`,
        });
        markUnsafe.add(path);
      }
      continue;
    }
    if (member.kind === 'file') {
      if (member.size > limits.maxMemberBytes) {
        violations.push({
          reason: 'member-size',
          member: path,
          detail: `member declares ${member.size} bytes (limit ${limits.maxMemberBytes})`,
        });
        markUnsafe.add(path);
      }
      if (
        member.method !== undefined &&
        member.method !== 0 &&
        member.method !== 8 &&
        !member.encrypted
      ) {
        // Encrypted entries surface as status `encrypted`; their method (often
        // 99/AES) must not mask that behind a blocking violation.
        violations.push({
          reason: 'unsupported-compression',
          member: path,
          detail: `zip compression method ${member.method} is not supported (only stored/deflate)`,
        });
        markUnsafe.add(path);
      }
    }
  }

  if (totals.totalUncompressedBytes > limits.maxTotalBytes) {
    violations.push({
      reason: 'total-size',
      detail: `declared uncompressed total ${totals.totalUncompressedBytes} exceeds limit ${limits.maxTotalBytes}`,
    });
  }
  const archiveBytes = Math.max(totals.archiveBytes, 1);
  if (
    totals.totalUncompressedBytes >= limits.ratioFloorBytes &&
    totals.totalUncompressedBytes / archiveBytes > limits.maxCompressionRatio
  ) {
    violations.push({
      reason: 'compression-ratio',
      detail: `compression ratio ${(totals.totalUncompressedBytes / archiveBytes).toFixed(
        1,
      )}x exceeds ${limits.maxCompressionRatio}x`,
    });
  }

  for (const member of members) {
    member.safe = !markUnsafe.has(member.path);
  }
  return violations;
}

export interface OpenArchiveHandle {
  /** Resolved format (`gzip` becomes `tar.gz` when the payload is a tar). */
  readonly format: ArchiveFormat;
  readonly members: readonly ArchiveMember[];
  readonly notes: readonly string[];
  readonly memberCountCapped: boolean;
  /** Reads one member's bytes; verifies size and CRC (zip). Read-only. */
  readMember(member: ArchiveMember): Promise<Buffer>;
  close(): Promise<void>;
}

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  externalAttrs: number;
  versionMadeBy: number;
}

interface TarDataSlice {
  offset: number;
  size: number;
}

/**
 * Opens an archive for member listing and (later) member reads. Throws
 * ArchiveCorruptError for structural damage and ArchiveBombError when a
 * decompression ceiling is hit — callers map those to statuses.
 */
export async function openArchive(
  archivePath: string,
  format: ArchiveFormat,
  limits: ArchiveSafetyLimits,
): Promise<OpenArchiveHandle> {
  switch (format) {
    case 'zip':
      return openZip(archivePath, limits);
    case 'tar':
      return openTar(archivePath, limits);
    case 'gzip':
      return openGzip(archivePath, limits);
    default:
      throw new IdeaseekError('INVALID_ARGUMENT', `cannot open archive format: ${format}`);
  }
}

async function readAt(
  handle: {
    read(
      buf: Buffer,
      offset: number,
      length: number,
      position: number,
    ): Promise<{ bytesRead: number }>;
  },
  fileSize: number,
  offset: number,
  length: number,
  what: string,
): Promise<Buffer> {
  if (offset < 0 || length < 0 || offset + length > fileSize) {
    throw new ArchiveCorruptError('read-out-of-bounds', `${what}: read beyond end of file`);
  }
  const buf = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buf, 0, length, offset);
  if (bytesRead !== length) {
    throw new ArchiveCorruptError(
      'truncated',
      `${what}: expected ${length} bytes, got ${bytesRead}`,
    );
  }
  return buf;
}

async function openZip(path: string, limits: ArchiveSafetyLimits): Promise<OpenArchiveHandle> {
  const file = await open(path, 'r');
  try {
    const size = (await file.stat()).size;
    if (size < 22) {
      throw new ArchiveCorruptError(
        'too-small',
        'zip file is smaller than an end-of-central-directory record',
      );
    }
    const tailLength = Math.min(size, 65_557); // 22 + max comment (65535)
    const tail = await readAt(file, size, size - tailLength, tailLength, 'zip tail');
    let eocdIndex = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        const commentLength = tail.readUInt16LE(i + 20);
        if (i + 22 + commentLength === tail.length) {
          eocdIndex = i;
          break;
        }
      }
    }
    if (eocdIndex < 0) {
      throw new ArchiveCorruptError(
        'eocd-missing',
        'zip end-of-central-directory record not found',
      );
    }
    const diskNumber = tail.readUInt16LE(eocdIndex + 4);
    const cdDisk = tail.readUInt16LE(eocdIndex + 6);
    const entriesOnDisk = tail.readUInt16LE(eocdIndex + 8);
    let totalEntries = tail.readUInt16LE(eocdIndex + 10);
    let cdSize = tail.readUInt32LE(eocdIndex + 12);
    let cdOffset = tail.readUInt32LE(eocdIndex + 16);
    if (diskNumber !== 0 || cdDisk !== 0 || entriesOnDisk !== totalEntries) {
      throw new ArchiveCorruptError(
        'multi-disk-unsupported',
        'multi-disk zip archives are not supported',
      );
    }

    const needsZip64 = totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff;
    if (needsZip64) {
      const locatorOffset = size - tailLength + eocdIndex - 20;
      if (locatorOffset < 0) {
        throw new ArchiveCorruptError('zip64-required', 'zip64 EOCD locator not found');
      }
      const locator = await readAt(file, size, locatorOffset, 20, 'zip64 locator');
      if (locator.readUInt32LE(0) !== 0x07064b50) {
        throw new ArchiveCorruptError('zip64-required', 'zip64 EOCD locator signature missing');
      }
      const zip64Offset = Number(locator.readBigUInt64LE(8));
      const zip64 = await readAt(file, size, zip64Offset, 56, 'zip64 EOCD');
      if (zip64.readUInt32LE(0) !== 0x06064b50) {
        throw new ArchiveCorruptError('zip64-required', 'zip64 EOCD signature missing');
      }
      const entries64 = zip64.readBigUInt64LE(32);
      const cdSize64 = zip64.readBigUInt64LE(40);
      const cdOffset64 = zip64.readBigUInt64LE(48);
      if (
        entries64 > BigInt(Number.MAX_SAFE_INTEGER) ||
        cdSize64 > BigInt(Number.MAX_SAFE_INTEGER) ||
        cdOffset64 > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        throw new ArchiveCorruptError('zip64-too-large', 'zip64 values exceed safe integer range');
      }
      totalEntries = Number(entries64);
      cdSize = Number(cdSize64);
      cdOffset = Number(cdOffset64);
    }

    const capped = totalEntries > limits.maxMembers;
    const parseCount = capped ? limits.maxMembers : totalEntries;
    if (parseCount === 0 && cdSize !== 0) {
      throw new ArchiveCorruptError(
        'entry-count-mismatch',
        'zip declares zero entries but a non-empty central directory',
      );
    }
    if (parseCount > 0 && cdOffset + cdSize > size) {
      throw new ArchiveCorruptError(
        'central-directory-unreadable',
        'central directory extends past end of file',
      );
    }
    if (cdSize > 64 * 1024 * 1024) {
      throw new ArchiveCorruptError(
        'central-directory-too-large',
        'central directory exceeds 64 MiB parse cap',
      );
    }

    const entries: ZipEntry[] = [];
    if (parseCount > 0) {
      const cd = await readAt(file, size, cdOffset, cdSize, 'central directory');
      let pos = 0;
      while (entries.length < parseCount) {
        if (pos + 46 > cd.length) {
          throw new ArchiveCorruptError(
            'central-directory-truncated',
            'central directory entry header truncated',
          );
        }
        if (cd.readUInt32LE(pos) !== 0x02014b50) {
          throw new ArchiveCorruptError(
            'central-directory-signature',
            'bad central directory entry signature',
          );
        }
        const flags = cd.readUInt16LE(pos + 8);
        const method = cd.readUInt16LE(pos + 10);
        const crc = cd.readUInt32LE(pos + 16);
        let compressedSize = cd.readUInt32LE(pos + 20);
        let uncompressedSize = cd.readUInt32LE(pos + 24);
        const nameLength = cd.readUInt16LE(pos + 28);
        const extraLength = cd.readUInt16LE(pos + 30);
        const commentLength = cd.readUInt16LE(pos + 32);
        const externalAttrs = cd.readUInt32LE(pos + 38);
        let localHeaderOffset = cd.readUInt32LE(pos + 42);
        const versionMadeBy = cd.readUInt16LE(pos + 4);
        const end = pos + 46 + nameLength + extraLength + commentLength;
        if (end > cd.length) {
          throw new ArchiveCorruptError(
            'central-directory-truncated',
            'central directory entry fields truncated',
          );
        }
        const name = cd.subarray(pos + 46, pos + 46 + nameLength).toString('utf8');
        const extra = cd.subarray(pos + 46 + nameLength, pos + 46 + nameLength + extraLength);

        const zip64Sentinel =
          compressedSize === 0xffffffff ||
          uncompressedSize === 0xffffffff ||
          localHeaderOffset === 0xffffffff;
        if (zip64Sentinel) {
          const zip64Extra = findExtraField(extra, 0x0001);
          if (!zip64Extra) {
            throw new ArchiveCorruptError(
              'zip64-missing-extra',
              `entry ${name}: zip64 sizes without zip64 extra field`,
            );
          }
          let extraPos = 0;
          if (uncompressedSize === 0xffffffff) {
            if (extraPos + 8 > zip64Extra.length) {
              throw new ArchiveCorruptError(
                'zip64-missing-extra',
                `entry ${name}: zip64 extra truncated`,
              );
            }
            uncompressedSize = toSafeNumber(
              zip64Extra.readBigUInt64LE(extraPos),
              name,
              'uncompressed size',
            );
            extraPos += 8;
          }
          if (compressedSize === 0xffffffff) {
            if (extraPos + 8 > zip64Extra.length) {
              throw new ArchiveCorruptError(
                'zip64-missing-extra',
                `entry ${name}: zip64 extra truncated`,
              );
            }
            compressedSize = toSafeNumber(
              zip64Extra.readBigUInt64LE(extraPos),
              name,
              'compressed size',
            );
            extraPos += 8;
          }
          if (localHeaderOffset === 0xffffffff) {
            if (extraPos + 8 > zip64Extra.length) {
              throw new ArchiveCorruptError(
                'zip64-missing-extra',
                `entry ${name}: zip64 extra truncated`,
              );
            }
            localHeaderOffset = toSafeNumber(
              zip64Extra.readBigUInt64LE(extraPos),
              name,
              'local header offset',
            );
          }
        }

        entries.push({
          name,
          flags,
          method,
          crc,
          compressedSize,
          uncompressedSize,
          localHeaderOffset,
          externalAttrs,
          versionMadeBy,
        });
        pos = end;
      }
      if (!capped && pos !== cd.length) {
        throw new ArchiveCorruptError(
          'entry-count-mismatch',
          'central directory size does not match entry count',
        );
      }
    }

    const members: ArchiveMember[] = [];
    const entryByMember = new Map<ArchiveMember, ZipEntry>();
    for (const entry of entries) {
      const member = zipEntryToMember(entry);
      members.push(member);
      entryByMember.set(member, entry);
    }

    const readEntry = async (entry: ZipEntry, what: string): Promise<Buffer> => {
      if (entry.flags & 0x1) {
        throw new IdeaseekError('INVALID_ARGUMENT', 'refusing to read an encrypted zip entry', {
          member: what,
        });
      }
      const local = await readAt(
        file,
        size,
        entry.localHeaderOffset,
        30,
        `local header of ${what}`,
      );
      if (local.readUInt32LE(0) !== 0x04034b50) {
        throw new ArchiveCorruptError('local-header-signature', `bad local header for ${what}`);
      }
      const nameLength = local.readUInt16LE(26);
      const extraLength = local.readUInt16LE(28);
      const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
      const stored = await readAt(file, size, dataOffset, entry.compressedSize, `data of ${what}`);
      let data: Buffer;
      if (entry.method === 0) {
        data = stored;
      } else if (entry.method === 8) {
        try {
          data = inflateRawSync(stored, { maxOutputLength: Math.max(1, entry.uncompressedSize) });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ERR_BUFFER_TOO_LARGE') {
            throw new ArchiveBombError(
              'decompressed-size',
              `member ${what} inflates beyond its declared ${entry.uncompressedSize} bytes`,
            );
          }
          throw new ArchiveCorruptError(
            'inflate-failed',
            `inflate failed for ${what}: ${(error as Error).message}`,
          );
        }
      } else {
        throw new IdeaseekError('INVALID_ARGUMENT', `unsupported zip method ${entry.method}`, {
          member: what,
        });
      }
      if (data.length !== entry.uncompressedSize) {
        throw new ArchiveCorruptError(
          'size-mismatch',
          `member ${what}: inflated ${data.length} bytes, declared ${entry.uncompressedSize}`,
        );
      }
      if (crc32(data) >>> 0 !== entry.crc) {
        throw new ArchiveCorruptError('crc-mismatch', `member ${what}: CRC32 mismatch`);
      }
      return data;
    };

    // Symlink targets live in member data; resolve them now so the safety scan
    // can detect escaping targets before any extraction is attempted.
    for (const member of members) {
      if (member.kind !== 'symlink') continue;
      const entry = entryByMember.get(member)!;
      if (entry.flags & 0x1) continue; // encrypted: target unknowable, status will be `encrypted`
      try {
        member.linkTarget = (await readEntry(entry, member.path)).toString('utf8');
      } catch (error) {
        if (error instanceof ArchiveBombError || error instanceof ArchiveCorruptError) throw error;
        // Unreadable target (e.g. unsupported method): treat as escaping so the
        // archive is blocked rather than extracted with an unverifiable link.
        member.linkTarget = '/';
      }
    }

    return {
      format: 'zip',
      members,
      notes: capped ? [`member-count-capped:${limits.maxMembers}`] : [],
      memberCountCapped: capped,
      async readMember(member) {
        const entry = entryByMember.get(member);
        if (!entry) {
          throw new IdeaseekError(
            'INVALID_ARGUMENT',
            'member does not belong to this archive handle',
          );
        }
        return readEntry(entry, member.path);
      },
      async close() {
        await file.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await file.close().catch(() => undefined);
    throw error;
  }
}

function findExtraField(extra: Buffer, headerId: number): Buffer | null {
  let pos = 0;
  while (pos + 4 <= extra.length) {
    const id = extra.readUInt16LE(pos);
    const length = extra.readUInt16LE(pos + 2);
    if (pos + 4 + length > extra.length) return null;
    if (id === headerId) return extra.subarray(pos + 4, pos + 4 + length);
    pos += 4 + length;
  }
  return null;
}

function toSafeNumber(value: bigint, entryName: string, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ArchiveCorruptError(
      'zip64-too-large',
      `entry ${entryName}: ${field} exceeds safe integer range`,
    );
  }
  return Number(value);
}

function zipEntryToMember(entry: ZipEntry): ArchiveMember {
  const madeByOs = entry.versionMadeBy >> 8;
  const unixMode = madeByOs === 3 || madeByOs === 19 ? (entry.externalAttrs >>> 16) & 0xffff : 0;
  const isSymlink = (unixMode & 0xf000) === 0xa000;
  const isDirFromMode = (unixMode & 0xf000) === 0x4000;
  const isDir = entry.name.endsWith('/') || isDirFromMode;
  const kind: ArchiveMember['kind'] = isSymlink ? 'symlink' : isDir ? 'dir' : 'file';
  return {
    path: normalizeMemberPath(entry.name),
    rawPath: entry.name,
    kind,
    size: kind === 'file' ? entry.uncompressedSize : 0,
    compressedSize: entry.compressedSize,
    encrypted: (entry.flags & 0x1) !== 0,
    method: entry.method,
    safe: true,
  };
}

async function openTar(path: string, limits: ArchiveSafetyLimits): Promise<OpenArchiveHandle> {
  const info = await stat(path);
  if (info.size > limits.maxTotalBytes) {
    throw new ArchiveBombError(
      'total-size',
      `tar archive is ${info.size} bytes, exceeding limit ${limits.maxTotalBytes}`,
    );
  }
  const buf = await readFile(path);
  const { members, slices, capped, notes } = parseTarBuffer(buf, limits);
  return {
    format: 'tar',
    members,
    notes: capped ? [`member-count-capped:${limits.maxMembers}`, ...notes] : notes,
    memberCountCapped: capped,
    async readMember(member) {
      const slice = slices.get(member);
      if (!slice) {
        throw new IdeaseekError(
          'INVALID_ARGUMENT',
          'member does not belong to this archive handle',
        );
      }
      return buf.subarray(slice.offset, slice.offset + slice.size);
    },
    async close() {
      // Nothing to release: the tar buffer is garbage-collected with the handle.
    },
  };
}

interface TarParseResult {
  members: ArchiveMember[];
  slices: Map<ArchiveMember, TarDataSlice>;
  capped: boolean;
  notes: string[];
}

export function tarChecksumValid(header: Buffer): { valid: boolean; stored: number } {
  const storedText = header
    .subarray(148, 156)
    .toString('ascii')
    .replace(/[\0 ].*$/, '')
    .trim();
  const stored = parseInt(storedText, 8);
  let unsigned = 0;
  for (let i = 0; i < 512; i++) {
    const byte = i >= 148 && i < 156 ? 0x20 : header[i]!;
    unsigned += byte;
  }
  return { valid: !Number.isNaN(stored) && stored === unsigned, stored };
}

function parseTarSizeField(field: Buffer): number {
  if (field.length > 0 && (field[0]! & 0x80) !== 0) {
    let value = field[0]! & 0x7f;
    for (let i = 1; i < field.length; i++) {
      value = value * 256 + field[i]!;
      if (!Number.isSafeInteger(value)) {
        throw new ArchiveCorruptError('tar-size-overflow', 'tar size exceeds safe integer range');
      }
    }
    return value;
  }
  const text = field.toString('ascii').replace(/[\0\s]+$/, '');
  if (text === '') return 0;
  const value = parseInt(text, 8);
  if (Number.isNaN(value) || value < 0) {
    throw new ArchiveCorruptError(
      'tar-size-invalid',
      `invalid tar size field: ${JSON.stringify(text.slice(0, 16))}`,
    );
  }
  return value;
}

function parsePaxRecords(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  const text = data.toString('utf8');
  let pos = 0;
  while (pos < text.length) {
    const space = text.indexOf(' ', pos);
    if (space < 0) break;
    const length = parseInt(text.slice(pos, space), 10);
    if (!Number.isSafeInteger(length) || length <= 0) break;
    if (pos + length > text.length) break;
    const kv = text.slice(space + 1, pos + length);
    const eq = kv.indexOf('=');
    if (eq > 0) {
      const value = kv.endsWith('\n') ? kv.slice(eq + 1, -1) : kv.slice(eq + 1);
      out[kv.slice(0, eq)] = value;
    }
    pos += length;
  }
  return out;
}

function parseTarBuffer(buf: Buffer, limits: ArchiveSafetyLimits): TarParseResult {
  const members: ArchiveMember[] = [];
  const slices = new Map<ArchiveMember, TarDataSlice>();
  const notes: string[] = [];
  let capped = false;
  let pos = 0;
  let pendingLongName: string | null = null;
  let pendingLongLink: string | null = null;
  let pendingPaxPath: string | null = null;
  let pendingPaxLink: string | null = null;
  let sawEof = false;

  while (pos + 512 <= buf.length) {
    const header = buf.subarray(pos, pos + 512);
    if (header.every((byte) => byte === 0)) {
      sawEof = true;
      break;
    }
    if (!tarChecksumValid(header).valid) {
      throw new ArchiveCorruptError(
        'tar-checksum',
        `tar header checksum mismatch at offset ${pos}`,
      );
    }
    const size = parseTarSizeField(header.subarray(124, 136));
    if (size < 0 || pos + 512 + size > buf.length) {
      throw new ArchiveCorruptError(
        'tar-truncated',
        `tar member data exceeds archive at offset ${pos}`,
      );
    }
    const dataOffset = pos + 512;
    const typeFlag = String.fromCharCode(header[156]!);
    const nameField = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefixField = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const linkField = header.subarray(157, 257).toString('utf8').replace(/\0.*$/, '');

    const consume = () => {
      pos = dataOffset + Math.ceil(size / 512) * 512;
    };

    if (typeFlag === 'x' || typeFlag === 'g') {
      if (typeFlag === 'x') {
        const pax = parsePaxRecords(buf.subarray(dataOffset, dataOffset + size));
        if (pax.path !== undefined) pendingPaxPath = pax.path;
        if (pax.linkpath !== undefined) pendingPaxLink = pax.linkpath;
      }
      consume();
      continue;
    }
    if (typeFlag === 'L' || typeFlag === 'K') {
      const value = buf
        .subarray(dataOffset, dataOffset + size)
        .toString('utf8')
        .replace(/\0[\n]*$/, '');
      if (typeFlag === 'L') pendingLongName = value;
      else pendingLongLink = value;
      consume();
      continue;
    }

    if (members.length >= limits.maxMembers) {
      capped = true;
      break;
    }

    const rawName =
      pendingPaxPath ??
      pendingLongName ??
      (prefixField ? `${prefixField}/${nameField}` : nameField);
    const rawLink = pendingPaxLink ?? pendingLongLink ?? linkField;
    pendingPaxPath = null;
    pendingLongName = null;
    pendingPaxLink = null;
    pendingLongLink = null;

    const kind: ArchiveMember['kind'] =
      typeFlag === '0' || typeFlag === '\0' || typeFlag === '7'
        ? 'file'
        : typeFlag === '5'
          ? 'dir'
          : typeFlag === '2'
            ? 'symlink'
            : typeFlag === '1'
              ? 'hardlink'
              : 'other';

    const path = normalizeMemberPath(rawName);
    const member: ArchiveMember = {
      path,
      rawPath: rawName,
      kind,
      size: kind === 'file' ? size : 0,
      compressedSize: kind === 'file' ? size : 0,
      encrypted: false,
      safe: true,
      typeFlag,
    };
    if (kind === 'symlink' || kind === 'hardlink') {
      member.linkTarget = rawLink;
    }
    members.push(member);
    if (kind === 'file') {
      slices.set(member, { offset: dataOffset, size });
    }
    consume();
  }

  if (!sawEof) {
    throw new ArchiveCorruptError(
      pos + 512 > buf.length && pos < buf.length ? 'tar-truncated' : 'tar-missing-eof',
      'tar archive is missing its end-of-archive marker (possible truncation)',
    );
  }
  return { members, slices, capped, notes };
}

async function openGzip(path: string, limits: ArchiveSafetyLimits): Promise<OpenArchiveHandle> {
  const info = await stat(path);
  if (info.size > limits.maxTotalBytes) {
    throw new ArchiveBombError(
      'total-size',
      `gzip archive is ${info.size} bytes, exceeding limit ${limits.maxTotalBytes}`,
    );
  }
  const raw = await readFile(path);
  const decompressed = await gunzipBounded(raw, limits.maxTotalBytes);
  const isTar = decompressed.length >= 512 && tarChecksumValid(decompressed.subarray(0, 512)).valid;

  if (isTar) {
    const { members, slices, capped, notes } = parseTarBuffer(decompressed, limits);
    return {
      format: 'tar.gz',
      members,
      notes: capped ? [`member-count-capped:${limits.maxMembers}`, ...notes] : notes,
      memberCountCapped: capped,
      async readMember(member) {
        const slice = slices.get(member);
        if (!slice) {
          throw new IdeaseekError(
            'INVALID_ARGUMENT',
            'member does not belong to this archive handle',
          );
        }
        return decompressed.subarray(slice.offset, slice.offset + slice.size);
      },
      async close() {
        // Buffer-only handle.
      },
    };
  }

  const name = basename(path).toLowerCase();
  if (name.endsWith('.tar.gz') || name.endsWith('.tgz')) {
    throw new ArchiveCorruptError('gzip-payload-not-tar', 'gzip payload is not a tar archive');
  }
  const singleName = normalizeMemberPath(basename(path).replace(/\.gz$/i, ''));
  const member: ArchiveMember = {
    path: singleName,
    rawPath: singleName,
    kind: 'file',
    size: decompressed.length,
    compressedSize: raw.length,
    encrypted: false,
    safe: true,
  };
  return {
    format: 'gzip',
    members: [member],
    notes: ['gzip-single-file'],
    memberCountCapped: false,
    async readMember(target) {
      if (target !== member) {
        throw new IdeaseekError(
          'INVALID_ARGUMENT',
          'member does not belong to this archive handle',
        );
      }
      return decompressed;
    },
    async close() {
      // Buffer-only handle.
    },
  };
}

function gunzipBounded(data: Buffer, cap: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const gz = createGunzip();
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      gz.destroy();
      reject(error);
    };
    gz.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > cap) {
        fail(
          new ArchiveBombError('decompressed-size', `gzip output exceeds limit of ${cap} bytes`),
        );
        return;
      }
      chunks.push(chunk);
    });
    gz.on('end', () => {
      if (settled) return;
      settled = true;
      resolvePromise(Buffer.concat(chunks));
    });
    gz.on('error', (error) => {
      fail(new ArchiveCorruptError('gunzip-failed', `gzip decompression failed: ${error.message}`));
    });
    gz.end(data);
  });
}

export interface ScanArchiveOptions {
  /** When given, records a project-relative source path. */
  projectRoot?: string;
  now?: number;
  limits?: Partial<ArchiveSafetyLimits>;
}

function tryRelative(projectRoot: string, absPath: string): string | null {
  const rel = relative(resolve(projectRoot), absPath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

function archiveIdFor(sha256: ContentHash): string {
  return `arc-${sha256.replace('sha256:', '').slice(0, 16)}`;
}

function sumFileSizes(members: readonly ArchiveMember[]): number {
  let total = 0;
  for (const member of members) {
    if (member.kind === 'file') total += member.size;
  }
  return total;
}

function ratioOf(totalUncompressed: number, archiveBytes: number): number {
  return Math.round((totalUncompressed / Math.max(archiveBytes, 1)) * 100) / 100;
}

function buildInput(args: {
  archiveId: string;
  format: ArchiveFormat;
  status: ArchiveStatus;
  source: ArchiveSource;
  members: ArchiveMember[];
  totalUncompressedBytes: number;
  violations: ArchiveViolation[];
  issues: string[];
  limits: ArchiveSafetyLimits;
  now: number;
}): ArchiveInput {
  return {
    archiveId: args.archiveId,
    parserVersion: ARCHIVE_PARSER_VERSION,
    format: args.format,
    status: args.status,
    source: args.source,
    members: args.members,
    memberCount: args.members.length,
    totalUncompressedBytes: args.totalUncompressedBytes,
    safety: {
      limits: args.limits,
      violations: args.violations,
      ratio: ratioOf(args.totalUncompressedBytes, args.source.bytes),
    },
    issues: args.issues,
    extraction: null,
    scannedAt: args.now,
  };
}

async function readHead(path: string, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const file = await open(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await file.read(buf, 0, length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

/**
 * Scans an archive read-only: detects format, lists members, runs the safety
 * gates and reports a status. Never writes anywhere and never extracts;
 * blocked/corrupted/encrypted/unknown archives are reported as statuses, not
 * thrown, because they are legitimate (if unusable) inputs.
 */
export async function scanArchive(
  archivePath: string,
  opts: ScanArchiveOptions = {},
): Promise<ArchiveInput> {
  const abs = resolve(archivePath);
  let info;
  try {
    info = await stat(abs);
  } catch {
    throw new IdeaseekError('FILE_NOT_FOUND', `archive not found: ${archivePath}`);
  }
  if (!info.isFile()) {
    throw new IdeaseekError('INVALID_ARGUMENT', `not a regular file: ${archivePath}`);
  }

  const now = opts.now ?? Date.now();
  const limits = mergeArchiveLimits(opts.limits);
  const head = await readHead(abs, Math.min(info.size, 1024));
  const sha256 = await sha256OfFile(abs);
  const source: ArchiveSource = {
    path: abs,
    relPath: opts.projectRoot ? tryRelative(opts.projectRoot, abs) : null,
    bytes: info.size,
    sha256,
    mtimeMs: Math.floor(info.mtimeMs),
  };
  const archiveId = archiveIdFor(sha256);

  const detection = detectArchiveFormat(head, basename(abs));
  const detectionNote = `format-detection: ${detection.basis}`;
  if (detection.format === 'unknown') {
    return buildInput({
      archiveId,
      format: 'unknown',
      status: 'unknown-format',
      source,
      members: [],
      totalUncompressedBytes: 0,
      violations: [],
      issues: [detectionNote, ...(detection.detail ? [detection.detail] : [])],
      limits,
      now,
    });
  }

  let handle: OpenArchiveHandle | null = null;
  try {
    handle = await openArchive(abs, detection.format, limits);
    const members = [...handle.members];
    const totalUncompressedBytes = sumFileSizes(members);
    const violations = assessArchiveMembers(
      members,
      { totalUncompressedBytes, archiveBytes: source.bytes },
      limits,
      { memberCountCapped: handle.memberCountCapped },
    );
    let status: ArchiveStatus;
    if (violations.length > 0) {
      status = 'ARCHIVE_BLOCKED';
    } else if (members.some((member) => member.encrypted)) {
      status = 'encrypted';
    } else {
      status = 'ok';
    }
    return buildInput({
      archiveId,
      format: handle.format,
      status,
      source,
      members,
      totalUncompressedBytes,
      violations,
      issues: [detectionNote, ...handle.notes],
      limits,
      now,
    });
  } catch (error) {
    if (error instanceof ArchiveBombError) {
      return buildInput({
        archiveId,
        format: detection.format,
        status: 'ARCHIVE_BLOCKED',
        source,
        members: [],
        totalUncompressedBytes: 0,
        violations: [{ reason: error.reason, detail: error.message }],
        issues: [detectionNote, `bomb: ${error.message}`],
        limits,
        now,
      });
    }
    if (error instanceof ArchiveCorruptError) {
      return buildInput({
        archiveId,
        format: detection.format,
        status: 'corrupted',
        source,
        members: [],
        totalUncompressedBytes: 0,
        violations: [],
        issues: [detectionNote, `corrupt:${error.reason}: ${error.message}`],
        limits,
        now,
      });
    }
    throw error;
  } finally {
    await handle?.close();
  }
}
