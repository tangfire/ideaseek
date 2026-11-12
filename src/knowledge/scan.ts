import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
// Deferred cycle (safe in ESM): archive.ts imports `extOf` from here, this
// module calls `scanArchive` only inside functions, never at module init.
import {
  scanArchive,
  type ArchiveFormat,
  type ArchiveInput,
  type ArchiveStatus,
} from './archive.js';

/** Bumped whenever classification rules change: roles are recomputed, hashes are not. */
export const SCAN_PARSER_VERSION = 'ideaseek-scan-1';

/** Files larger than this are classified but not hashed (hash recorded as null). */
export const MAX_HASH_BYTES = 256 * 1024 * 1024;

export type FileRole = 'paper' | 'paper-source' | 'code' | 'data' | 'archive' | 'doc' | 'unknown';

export interface ManifestFile {
  /** Absolute source path (read-only; never moved or modified). */
  path: string;
  /** Project-relative path with forward slashes, stable across machines. */
  relPath: string;
  bytes: number;
  mtimeMs: number;
  ext: string;
  sha256: string | null;
  hashStatus: 'ok' | 'skipped-too-large' | 'error';
  role: FileRole;
  confidence: number;
  basis: string[];
  discoveredAt: number;
  /** Present for role `archive`: member manifest + safety status (see below). */
  archive?: ArchiveInspectionSummary;
}

/** Extraction state recorded for an archive (updated by `intake --extract`). */
export interface ArchiveExtractionSummary {
  dir: string;
  fileCount: number;
  rootHash: string;
  reused: boolean;
}

/**
 * Per-archive inspection persisted in the manifest (CLI_SPEC: scan/intake
 * 支持常见压缩包 — members are listed first, unsafe archives land in
 * ARCHIVE_BLOCKED with a concrete reason, never silently accepted).
 */
export interface ArchiveInspectionSummary {
  archiveId: string;
  format: ArchiveFormat;
  status: ArchiveStatus;
  memberCount: number;
  totalUncompressedBytes: number;
  /** First safety violation when blocked (path-traversal, compression-ratio, …). */
  blockReason: string | null;
  issues: string[];
  extraction: ArchiveExtractionSummary | null;
  inspectedAt: number;
}

export type GroupKind = 'paper' | 'comparison' | 'dataset' | 'idea' | 'unknown';

export interface CandidateGroup {
  groupId: string;
  kind: GroupKind;
  /** Project-relative member paths, sorted. */
  files: string[];
  confidence: number;
  basis: string[];
  /** True while the user has not confirmed the grouping (Phase 0: always). */
  needsConfirmation: boolean;
}

export interface DuplicateSet {
  sha256: string;
  paths: string[];
}

export interface InputManifest {
  manifestVersion: 1;
  parserVersion: string;
  generatedAt: number;
  /** Project-relative scan roots. */
  roots: string[];
  files: ManifestFile[];
  groups: CandidateGroup[];
  duplicateSets: DuplicateSet[];
}

const PAPER_EXT = new Set(['.pdf']);
const PAPER_SOURCE_EXT = new Set(['.tex', '.bib', '.bbl', '.sty']);
const DATA_EXT = new Set([
  '.csv',
  '.tsv',
  '.parquet',
  '.feather',
  '.arrow',
  '.npy',
  '.npz',
  '.h5',
  '.hdf5',
  '.pkl',
  '.pickle',
  '.mat',
  '.xlsx',
  '.xls',
  '.jsonl',
]);
const ARCHIVE_EXT = new Set([
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.tar.gz',
  '.tar.bz2',
  '.7z',
  '.rar',
  '.bz2',
  '.xz',
]);
const DOC_EXT = new Set(['.md', '.txt', '.rst']);
const CODE_EXT = new Set([
  '.py',
  '.js',
  '.mjs',
  '.ts',
  '.tsx',
  '.java',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.rs',
  '.go',
  '.sh',
  '.ipynb',
  '.r',
  '.m',
]);
const CODE_FILES = new Set([
  'requirements.txt',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'package.json',
  'cargo.toml',
  'makefile',
  'environment.yml',
  'environment.yaml',
  'pom.xml',
  'build.gradle',
]);

/** Directories never scanned, even inside an explicit --path root. */
const SKIP_DIRS = new Set(['.research', 'node_modules', '.git', '__pycache__', '.venv', 'venv']);

export interface ClassifyContext {
  /** First path segment under the project root ('papers', 'incoming', …). */
  rootName: string;
}

export interface Classification {
  role: FileRole;
  confidence: number;
  basis: string[];
}

/**
 * Content-blind classification for Phase 0 (no PDF parsing yet): extensions
 * plus root context. Every decision records its basis so `intake` can show why
 * a file was tagged the way it was.
 */
export function classifyFile(fileName: string, ctx: ClassifyContext): Classification {
  const lower = fileName.toLowerCase();
  const ext = extOf(lower);
  const basis: string[] = [];

  if (CODE_FILES.has(lower)) {
    return { role: 'code', confidence: 0.9, basis: ['known-code-filename'] };
  }
  if (PAPER_EXT.has(ext)) {
    basis.push('extension:.pdf');
    if (ctx.rootName === 'incoming') {
      return { role: 'paper', confidence: 0.7, basis: [...basis, 'root:incoming (needs review)'] };
    }
    return { role: 'paper', confidence: 0.95, basis };
  }
  if (PAPER_SOURCE_EXT.has(ext)) {
    return { role: 'paper-source', confidence: 0.85, basis: [`extension:${ext}`] };
  }
  if (DATA_EXT.has(ext)) {
    basis.push(`extension:${ext}`);
    if (ctx.rootName === 'datasets') {
      return { role: 'data', confidence: 0.95, basis: [...basis, 'root:datasets'] };
    }
    return { role: 'data', confidence: 0.7, basis };
  }
  if (ext === '.json') {
    if (ctx.rootName === 'datasets') {
      return { role: 'data', confidence: 0.8, basis: ['extension:.json', 'root:datasets'] };
    }
    return { role: 'doc', confidence: 0.5, basis: ['extension:.json', 'ambiguous-config-or-data'] };
  }
  if (ARCHIVE_EXT.has(ext)) {
    return { role: 'archive', confidence: 0.9, basis: [`extension:${ext}`] };
  }
  if (CODE_EXT.has(ext)) {
    return { role: 'code', confidence: 0.85, basis: [`extension:${ext}`] };
  }
  if (DOC_EXT.has(ext)) {
    return { role: 'doc', confidence: 0.6, basis: [`extension:${ext}`] };
  }
  return { role: 'unknown', confidence: 0.3, basis: ['no-known-extension'] };
}

export function extOf(lowerFileName: string): string {
  if (lowerFileName.endsWith('.tar.gz')) return '.tar.gz';
  if (lowerFileName.endsWith('.tar.bz2')) return '.tar.bz2';
  const dot = lowerFileName.lastIndexOf('.');
  return dot >= 0 ? lowerFileName.slice(dot) : '';
}

function normalizeStem(fileName: string): string {
  return fileName
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '');
}

async function hashFile(
  path: string,
  bytes: number,
): Promise<{ sha256: string | null; hashStatus: ManifestFile['hashStatus'] }> {
  if (bytes > MAX_HASH_BYTES) return { sha256: null, hashStatus: 'skipped-too-large' };
  try {
    const hash = await new Promise<string>((resolve, reject) => {
      const stream = createReadStream(path);
      const accumulator = createHash('sha256');
      stream.on('data', (chunk) => accumulator.update(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(`sha256:${accumulator.digest('hex')}`));
    });
    return { sha256: hash, hashStatus: 'ok' };
  } catch {
    return { sha256: null, hashStatus: 'error' };
  }
}

export interface ScanFileInput {
  absPath: string;
  rootName: string;
}

export interface ScanOptions {
  projectRoot: string;
  /** Project-relative roots to walk. */
  roots: string[];
  now: number;
  /** Previous manifest enabling hash reuse when (path, bytes, mtime) match. */
  previous?: InputManifest | null;
}

async function walk(rootAbs: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(rootAbs, { withFileTypes: true });
  } catch {
    return; // missing root: tolerated (users may not have created it yet)
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.isDirectory()) continue;
    const abs = join(rootAbs, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(abs, out);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      out.push(abs);
    }
  }
}

/**
 * Builds an InputManifest: recursive discovery under the given roots,
 * extension-based classification, streaming hashes (incrementally reused from
 * the previous manifest when path/size/mtime are unchanged), content-hash
 * duplicate detection and candidate grouping. Pure read of user inputs —
 * never writes, moves or deletes anything under the scanned roots.
 */
/** One summary shape shared by the scan pass and `intake --extract`. */
export function summarizeArchiveInput(input: ArchiveInput): ArchiveInspectionSummary {
  return {
    archiveId: input.archiveId,
    format: input.format,
    status: input.status,
    memberCount: input.memberCount,
    totalUncompressedBytes: input.totalUncompressedBytes,
    blockReason: input.safety.violations[0]?.reason ?? null,
    issues: input.issues.slice(0, 5),
    extraction: input.extraction
      ? {
          dir: input.extraction.dir,
          fileCount: input.extraction.files,
          rootHash: input.extraction.rootHash,
          reused: input.extraction.reused,
        }
      : null,
    inspectedAt: input.scannedAt,
  };
}

/**
 * Inspects one archive during a scan. IO failures are recorded as a
 * `corrupted` summary instead of aborting the whole scan — an unreadable
 * archive must stay visibly refused, never silently absent.
 */
async function inspectArchiveForManifest(
  absPath: string,
  projectRoot: string,
  now: number,
): Promise<ArchiveInspectionSummary> {
  try {
    return summarizeArchiveInput(await scanArchive(absPath, { projectRoot }));
  } catch (error) {
    return {
      archiveId: 'arc-unreadable',
      format: 'unknown',
      status: 'corrupted',
      memberCount: 0,
      totalUncompressedBytes: 0,
      blockReason: null,
      issues: [`inspection failed: ${(error as Error).message}`],
      extraction: null,
      inspectedAt: now,
    };
  }
}

export async function scanProject(opts: ScanOptions): Promise<InputManifest> {
  const previousByPath = new Map<string, ManifestFile>();
  for (const file of opts.previous?.files ?? []) {
    previousByPath.set(file.path, file);
  }

  const absFiles: string[] = [];
  for (const rootName of opts.roots) {
    await walk(join(opts.projectRoot, rootName), absFiles);
  }
  absFiles.sort();

  const files: ManifestFile[] = [];
  for (const absPath of absFiles) {
    let info;
    try {
      info = await stat(absPath);
    } catch {
      continue; // vanished between readdir and stat
    }
    if (!info.isFile()) continue;
    const relPath = relative(opts.projectRoot, absPath).split(sep).join('/');
    const rootName = relPath.split('/')[0] ?? '';
    const previous = previousByPath.get(absPath);
    const unchanged =
      previous && previous.bytes === info.size && previous.mtimeMs === Math.floor(info.mtimeMs);
    const { sha256, hashStatus } = unchanged
      ? { sha256: previous!.sha256, hashStatus: previous!.hashStatus }
      : await hashFile(absPath, info.size);
    const classification = classifyFile(absPath.split(/[\\/]/).pop() ?? absPath, { rootName });
    // Archives get a member manifest + safety status; unchanged archives
    // reuse the previous inspection (the file hash already matched).
    let archive: ArchiveInspectionSummary | undefined;
    if (classification.role === 'archive') {
      archive =
        unchanged && previous?.archive
          ? previous.archive
          : await inspectArchiveForManifest(absPath, opts.projectRoot, opts.now);
    }
    files.push({
      path: absPath,
      relPath,
      bytes: info.size,
      mtimeMs: Math.floor(info.mtimeMs),
      ext: extOf((absPath.split(/[\\/]/).pop() ?? '').toLowerCase()),
      sha256,
      hashStatus,
      role: classification.role,
      confidence: classification.confidence,
      basis: classification.basis,
      discoveredAt: opts.now,
      ...(archive ? { archive } : {}),
    });
  }

  const groups = buildGroups(files);
  const duplicateSets = buildDuplicates(files);

  return {
    manifestVersion: 1,
    parserVersion: SCAN_PARSER_VERSION,
    generatedAt: opts.now,
    roots: opts.roots,
    files,
    groups,
    duplicateSets,
  };
}

function buildGroups(files: ManifestFile[]): CandidateGroup[] {
  const buckets = new Map<string, { kind: GroupKind; members: ManifestFile[]; basis: string[] }>();

  const push = (key: string, kind: GroupKind, file: ManifestFile, basis: string) => {
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.members.push(file);
      if (!bucket.basis.includes(basis)) bucket.basis.push(basis);
    } else {
      buckets.set(key, { kind, members: [file], basis: [basis] });
    }
  };

  for (const file of files) {
    const segments = file.relPath.split('/');
    const rootName = segments[0] ?? '';
    const dirKey = segments.slice(0, -1).join('/');
    const stem = normalizeStem(segments[segments.length - 1] ?? file.relPath);

    if (rootName === 'papers') {
      // Same-stem siblings (paper.pdf + paper.zip + paper.tex) are one candidate.
      push(`paper:${dirKey}:${stem}`, 'paper', file, 'same-filename-stem');
    } else if (rootName === 'datasets') {
      // A dataset is a directory; loose files group by stem.
      if (segments.length >= 3) {
        push(`dataset:${segments[0]}/${segments[1]}`, 'dataset', file, 'same-dataset-directory');
      } else {
        push(`dataset:${dirKey}:${stem}`, 'dataset', file, 'loose-file-same-stem');
      }
    } else if (rootName === 'comparisons') {
      const method = segments[1] && segments[1] !== '_candidates' ? segments[1] : '_candidates';
      push(`comparison:${method}`, 'comparison', file, `method-directory:${method}`);
    } else if (rootName === 'idea-seeds') {
      // One seed = one top-level folder (docs/IDEA_IMPROVEMENT.md); loose
      // files are their own single-file seed candidate.
      if (segments.length >= 3) {
        push(
          `idea:${segments[0]}/${segments[1]}`,
          'idea',
          file,
          `idea-seed-directory:${segments[1]}`,
        );
      } else {
        push(`idea:${dirKey}:${stem}`, 'idea', file, 'loose-idea-seed-file');
      }
    } else if (rootName === 'incoming') {
      push(`incoming:${dirKey}`, 'unknown', file, 'same-directory');
    } else {
      push(`other:${dirKey}:${stem}`, 'unknown', file, 'same-filename-stem');
    }
  }

  const groups: CandidateGroup[] = [];
  for (const [key, bucket] of buckets) {
    const members = [...bucket.members].sort((a, b) => a.relPath.localeCompare(b.relPath));
    const confidence =
      bucket.kind === 'unknown'
        ? 0.5
        : Math.round(
            (members.reduce((sum, file) => sum + file.confidence, 0) / members.length) * 100,
          ) / 100;
    groups.push({
      // Hash the FULL bucket key: key prefixes are shared across siblings
      // (`idea:idea-seeds/…`), so truncating raw hex collided group ids.
      groupId: `grp-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`,
      kind: bucket.kind,
      files: members.map((file) => file.relPath),
      confidence,
      basis: bucket.basis,
      needsConfirmation: true, // Phase 0 has no confirmation flow yet
    });
  }
  groups.sort((a, b) => a.groupId.localeCompare(b.groupId));
  return groups;
}

function buildDuplicates(files: ManifestFile[]): DuplicateSet[] {
  const byHash = new Map<string, string[]>();
  for (const file of files) {
    if (!file.sha256) continue;
    const list = byHash.get(file.sha256) ?? [];
    list.push(file.relPath);
    byHash.set(file.sha256, list);
  }
  const sets: DuplicateSet[] = [];
  for (const [sha256, paths] of byHash) {
    if (paths.length > 1) sets.push({ sha256, paths: [...paths].sort() });
  }
  sets.sort((a, b) => a.sha256.localeCompare(b.sha256));
  return sets;
}

/** Renders the human-readable review companion to the manifest. */
export function renderReview(manifest: InputManifest): string {
  const byRole = new Map<FileRole, number>();
  for (const file of manifest.files) {
    byRole.set(file.role, (byRole.get(file.role) ?? 0) + 1);
  }
  const lines: string[] = [
    '# Input Review',
    '',
    `Generated by \`${manifest.parserVersion}\` at ${new Date(manifest.generatedAt).toISOString()}.`,
    `Roots: ${manifest.roots.map((root) => `\`${root}/\``).join(', ')}.`,
    '',
    '## Totals',
    '',
    `- files: ${manifest.files.length}`,
    ...[...byRole.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([role, count]) => `- ${role}: ${count}`),
    `- duplicate content sets: ${manifest.duplicateSets.length}`,
    `- candidate groups: ${manifest.groups.length} (all pending confirmation)`,
    '',
    '## Files',
    '',
    '| path | role | confidence | bytes | sha256 |',
    '| --- | --- | --- | --- | --- |',
    ...manifest.files.map(
      (file) =>
        `| \`${file.relPath}\` | ${file.role} | ${file.confidence} | ${file.bytes} | ${
          file.sha256 ? `\`${file.sha256.slice(0, 19)}…\`` : file.hashStatus
        } |`,
    ),
    '',
    '## Candidate groups',
    '',
    '| group | kind | confidence | files | basis |',
    '| --- | --- | --- | --- | --- |',
    ...manifest.groups.map(
      (group) =>
        `| \`${group.groupId}\` | ${group.kind} | ${group.confidence} | ${group.files.length} | ${group.basis.join(', ')} |`,
    ),
    '',
    'Originals are read-only; `ideaseek organize --apply` only creates platform-managed index links.',
    '',
  ];
  return lines.join('\n');
}
