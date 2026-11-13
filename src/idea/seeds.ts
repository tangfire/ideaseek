import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { writeFileAtomic, ensureDir } from '../core/atomic.js';
import { IdeaseekError } from '../core/errors.js';
import { sha256Of, sha256OfFile, type ContentHash } from '../core/hash.js';

/**
 * Read-only idea-seed registration (docs/IDEA_IMPROVEMENT.md 原始版本保护):
 * `idea-seeds/<name>/` (or `incoming/ideas/<name>/`) is the USER's source —
 * it is never moved, copied, renamed or written. Import only records a
 * content snapshot (per-file hashes + a root hash) in a platform registry
 * so later improve/diagnosis flows can prove which bytes they analyzed.
 */

/** Paths larger than this are recorded but not hashed (hash = null). */
const MAX_HASH_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 20_000;

export interface SeedFileRecord {
  relPath: string;
  bytes: number;
  sha256: string | null;
}

export interface SeedSnapshot {
  fileCount: number;
  totalBytes: number;
  /** sha256 over sorted `path\tbytes\thash` lines (same convention as repo snapshots). */
  rootHash: ContentHash;
  files: SeedFileRecord[];
}

export interface SeedRegistration {
  /** Seed folder name (`hetero-distillation`). */
  name: string;
  /** Project-relative source path with forward slashes. */
  source: string;
  importedAt: number;
  updatedAt: number;
  snapshot: SeedSnapshot;
  /** Previous snapshots, oldest first — proves the source changed over time. */
  history: { at: number; rootHash: ContentHash }[];
}

export interface IdeaSeedRegistry {
  version: 1;
  seeds: SeedRegistration[];
}

/** Allowed delivery prefixes (CLI_SPEC: idea-seeds/ and incoming/ideas/). */
const ALLOWED_PREFIXES = ['idea-seeds/', 'incoming/ideas/'];

export function ideaSeedsRegistryPath(projectRoot: string): string {
  return join(resolve(projectRoot), 'knowledge', 'idea-seeds.json');
}

/** Validates and normalizes a seed source to a project-relative path. */
export function normalizeSeedSource(projectRoot: string, source: string): string {
  const root = resolve(projectRoot);
  const abs = resolve(root, source);
  const rel = relative(root, abs).split(sep).join('/');
  if (rel.startsWith('..') || rel === '' || rel.includes('/../')) {
    throw new IdeaseekError('INVALID_ARGUMENT', `--source must stay inside the project: ${source}`);
  }
  if (
    !ALLOWED_PREFIXES.some((prefix) => rel === prefix.replace(/\/$/, '') || rel.startsWith(prefix))
  ) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `--source must be under ${ALLOWED_PREFIXES.join(' or ')}: ${rel}`,
    );
  }
  return rel;
}

async function walkRegularFiles(dir: string, root: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    const abs = join(dir, entry.name);
    // Only regular files: symlinked dirs/files could point outside the
    // user's seed (or inside .research) and must not enter the snapshot.
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      await walkRegularFiles(abs, root, out);
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
}

export async function snapshotSeedDir(absDir: string, projectRoot: string): Promise<SeedSnapshot> {
  const root = resolve(projectRoot);
  const files: string[] = [];
  await walkRegularFiles(absDir, root, files);
  const records: SeedFileRecord[] = [];
  let totalBytes = 0;
  for (const abs of files) {
    const info = await stat(abs);
    totalBytes += info.size;
    const sha256 = info.size > MAX_HASH_BYTES ? null : await sha256OfFile(abs).catch(() => null);
    records.push({
      relPath: relative(root, abs).split(sep).join('/'),
      bytes: info.size,
      sha256,
    });
  }
  records.sort((a, b) => a.relPath.localeCompare(b.relPath));
  const lines = records
    .map((file) => `${file.relPath}\t${file.bytes}\t${file.sha256 ?? `unhashed:${file.bytes}`}`)
    .join('\n');
  return {
    fileCount: records.length,
    totalBytes,
    rootHash: sha256Of(lines),
    files: records,
  };
}

async function readRegistry(projectRoot: string): Promise<IdeaSeedRegistry> {
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = JSON.parse(
      await readFile(ideaSeedsRegistryPath(projectRoot), 'utf8'),
    ) as IdeaSeedRegistry;
    if (raw && raw.version === 1 && Array.isArray(raw.seeds)) return raw;
  } catch {
    // missing/corrupt registry → start fresh (write path recreates it)
  }
  return { version: 1, seeds: [] };
}

export interface RegisterResult {
  registration: SeedRegistration;
  /** false when the snapshot is byte-identical to the stored one. */
  changed: boolean;
}

/**
 * Registers (or refreshes) a seed's read-only snapshot. Idempotent: an
 * unchanged source keeps its original importedAt and reports changed=false.
 */
export async function registerIdeaSeed(
  projectRoot: string,
  source: string,
  now = Date.now(),
): Promise<RegisterResult> {
  const root = resolve(projectRoot);
  const rel = normalizeSeedSource(root, source);
  const abs = join(root, ...rel.split('/'));
  let info;
  try {
    info = await stat(abs);
  } catch {
    throw new IdeaseekError('FILE_NOT_FOUND', `idea seed not found: ${rel} — run: ideaseek scan`);
  }
  if (!info.isDirectory()) {
    throw new IdeaseekError('INVALID_ARGUMENT', `idea seed must be a directory: ${rel}`);
  }

  const snapshot = await snapshotSeedDir(abs, root);
  const registry = await readRegistry(root);
  const existingIndex = registry.seeds.findIndex((seed) => seed.source === rel);
  const existing = existingIndex >= 0 ? registry.seeds[existingIndex]! : null;

  if (existing && existing.snapshot.rootHash === snapshot.rootHash) {
    return { registration: existing, changed: false };
  }

  const name = rel.split('/').filter(Boolean).pop() ?? rel;
  const registration: SeedRegistration = existing
    ? {
        ...existing,
        updatedAt: now,
        snapshot,
        history: [
          ...existing.history,
          { at: existing.updatedAt, rootHash: existing.snapshot.rootHash },
        ],
      }
    : { name, source: rel, importedAt: now, updatedAt: now, snapshot, history: [] };

  if (existing) registry.seeds[existingIndex] = registration;
  else registry.seeds.push(registration);
  registry.seeds.sort((a, b) => a.source.localeCompare(b.source));

  await ensureDir(join(root, 'knowledge'));
  await writeFileAtomic(ideaSeedsRegistryPath(root), `${JSON.stringify(registry, null, 2)}\n`);
  return { registration, changed: true };
}

/**
 * Intake confirmation gate (docs/IDEA_IMPROVEMENT.md 用户选择后才创建正式
 * Idea 对象): the source must be scanned and EVERY group touching it
 * confirmed against its CURRENT bytes before import/improve may proceed.
 * Shared by `idea import` and `idea improve`.
 */
export async function assertSeedIntakeConfirmed(
  projectRoot: string,
  sourceRel: string,
): Promise<void> {
  const { readManifest } = await import('../knowledge/organize.js');
  const { readConfirmRegistry, isGroupConfirmedWith } =
    await import('../knowledge/intake-confirm.js');
  const manifest = await readManifest(join(projectRoot, 'knowledge', 'input-manifest.json'));
  if (!manifest) {
    throw new IdeaseekError('USER_INPUT_REQUIRED', 'no input manifest yet; run: ideaseek scan');
  }
  const underSource = manifest.files.filter(
    (file) => file.relPath === sourceRel || file.relPath.startsWith(`${sourceRel}/`),
  );
  if (underSource.length === 0) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `nothing scanned under ${sourceRel} — run: ideaseek scan`,
    );
  }
  const confirmRegistry = await readConfirmRegistry(projectRoot);
  // Confirmation binds reviewed BYTES: hash the source's CURRENT content so
  // edits after the last confirm invalidate it (a stale manifest must never
  // wave through changed files).
  const current = await snapshotSeedDir(join(projectRoot, ...sourceRel.split('/')), projectRoot);
  const currentHashes = new Map(
    current.files.map((file) => [file.relPath, file.sha256 ?? `unhashed:${file.bytes}`]),
  );
  const unconfirmed = manifest.groups.filter(
    (group) =>
      group.files.some((file) => file === sourceRel || file.startsWith(`${sourceRel}/`)) &&
      !isGroupConfirmedWith(confirmRegistry, manifest, group, currentHashes),
  );
  if (unconfirmed.length > 0) {
    const hints = unconfirmed
      .map((group) => `ideaseek intake --confirm ${group.files[0] ?? group.groupId}`)
      .join(' ; ');
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `unconfirmed intake group(s) for ${sourceRel}: ` +
        unconfirmed.map((group) => `${group.groupId} (${group.kind})`).join(', ') +
        ` — confirm first: ${hints}`,
    );
  }
}

export async function readIdeaSeedRegistry(projectRoot: string): Promise<IdeaSeedRegistry> {
  return readRegistry(projectRoot);
}
