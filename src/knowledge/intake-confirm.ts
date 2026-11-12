import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir, writeFileAtomic } from '../core/atomic.js';
import { IdeaseekError } from '../core/errors.js';
import { sha256Of, sha256OfFile } from '../core/hash.js';
import type { InputManifest, ManifestFile } from './scan.js';

/**
 * Intake confirmation (docs/IDEA_IMPROVEMENT.md 用户选择后才创建正式 Idea
 * 对象): a confirmation records the EXACT file set that was reviewed.
 * Group ids are directory-derived (stable across scans), so membership
 * changes invalidate the confirmation — re-confirming after the source
 * changes is required, not optional.
 */

export interface ConfirmedGroup {
  groupId: string;
  kind: string;
  /** Sorted member relPaths at confirmation time. */
  files: string[];
  /** sha256 over sorted `path	content-hash` lines — binds the reviewed BYTES. */
  contentHash: string;
  confirmedAt: number;
}

export interface IntakeConfirmRegistry {
  version: 1;
  groups: ConfirmedGroup[];
}

export function intakeConfirmRegistryPath(projectRoot: string): string {
  return join(projectRoot, 'knowledge', 'intake-confirmed.json');
}

export async function readConfirmRegistry(projectRoot: string): Promise<IntakeConfirmRegistry> {
  try {
    const raw = JSON.parse(
      await readFile(intakeConfirmRegistryPath(projectRoot), 'utf8'),
    ) as IntakeConfirmRegistry;
    if (raw && raw.version === 1 && Array.isArray(raw.groups)) return raw;
  } catch {
    // missing/corrupt → empty (confirm flow recreates it)
  }
  return { version: 1, groups: [] };
}

/**
 * Content hash over the group's members (path + per-file hash).
 *
 * `overrides` supplies CURRENT byte hashes (e.g. a fresh snapshot of the
 * user's source) so callers detect edits made after the last scan; files
 * absent from the override fall back to the manifest's recorded hash
 * (symlinked members the snapshot walker skips stay consistent).
 */
export function contentHashForGroup(
  manifest: InputManifest,
  group: { groupId: string; files: readonly string[] },
  overrides: ReadonlyMap<string, string> = new Map(),
): string {
  const byPath = new Map(manifest.files.map((file) => [file.relPath, file]));
  const lines = [...group.files].sort().map((relPath) => {
    const overridden = overrides.get(relPath);
    if (overridden !== undefined) return `${relPath}\t${overridden}`;
    const file: ManifestFile | undefined = byPath.get(relPath);
    const hash = file ? (file.sha256 ?? `unhashed:${file.bytes}`) : `missing:${relPath}`;
    return `${relPath}\t${hash}`;
  });
  return sha256Of(lines.join('\n'));
}

/** isGroupConfirmed with current-byte overrides (see contentHashForGroup). */
export function isGroupConfirmedWith(
  registry: IntakeConfirmRegistry,
  manifest: InputManifest,
  group: { groupId: string; files: readonly string[] },
  overrides: ReadonlyMap<string, string>,
): boolean {
  const entry = registry.groups.find((candidate) => candidate.groupId === group.groupId);
  if (!entry) return false;
  if (entry.files.length !== group.files.length) return false;
  const sorted = [...group.files].sort();
  if (!entry.files.every((file, index) => file === sorted[index])) return false;
  return entry.contentHash === contentHashForGroup(manifest, group, overrides);
}

/**
 * A stored confirmation counts only for the identical membership AND the
 * identical bytes: editing a confirmed file invalidates the confirmation
 * (you reviewed different content — re-confirm).
 */
export function isGroupConfirmed(
  registry: IntakeConfirmRegistry,
  manifest: InputManifest,
  group: { groupId: string; files: readonly string[] },
): boolean {
  const entry = registry.groups.find((candidate) => candidate.groupId === group.groupId);
  if (!entry) return false;
  if (entry.files.length !== group.files.length) return false;
  const sorted = [...group.files].sort();
  if (!entry.files.every((file, index) => file === sorted[index])) return false;
  return entry.contentHash === contentHashForGroup(manifest, group);
}

/** Resolves a groupId OR any member file path to a manifest group. */
export function resolveGroupSelector(
  manifest: InputManifest,
  selector: string,
): { groupId: string; kind: string; files: string[] } {
  const byId = manifest.groups.find((group) => group.groupId === selector);
  if (byId) {
    return { groupId: byId.groupId, kind: byId.kind, files: [...byId.files] };
  }
  const byFile = manifest.groups.find((group) => group.files.includes(selector));
  if (byFile) {
    return { groupId: byFile.groupId, kind: byFile.kind, files: [...byFile.files] };
  }
  const candidates = manifest.groups
    .map((group) => `${group.groupId} (${group.files[0] ?? 'empty'})`)
    .slice(0, 8);
  throw new IdeaseekError(
    'INVALID_ARGUMENT',
    `no intake group matches "${selector}" — pass a group id or a scanned file path` +
      (candidates.length > 0 ? `; candidates: ${candidates.join(', ')}` : '; run: ideaseek scan'),
  );
}

/** Records (or refreshes) a confirmation for the group's CURRENT members. */
export async function confirmGroup(
  projectRoot: string,
  manifest: InputManifest,
  selector: string,
  now = Date.now(),
): Promise<ConfirmedGroup> {
  const resolved = resolveGroupSelector(manifest, selector);
  const registry = await readConfirmRegistry(projectRoot);
  const group = manifest.groups.find((candidate) => candidate.groupId === resolved.groupId)!;
  // Bind the confirmation to the bytes ON DISK right now — the manifest may
  // be stale (edited since the last scan), and confirming must mean "I
  // reviewed THIS content", not "I reviewed whatever scan last saw".
  const currentHashes = new Map<string, string>();
  for (const relPath of resolved.files) {
    try {
      const info = await stat(join(projectRoot, ...relPath.split('/')));
      if (!info.isFile()) continue;
      currentHashes.set(
        relPath,
        info.size > 256 * 1024 * 1024
          ? `unhashed:${info.size}`
          : ((await sha256OfFile(join(projectRoot, ...relPath.split('/'))).catch(() => null)) ??
              `unhashed:${info.size}`),
      );
    } catch {
      // unreadable member → fall back to the manifest's recorded hash
    }
  }
  const entry: ConfirmedGroup = {
    groupId: resolved.groupId,
    kind: resolved.kind,
    files: [...resolved.files].sort(),
    contentHash: contentHashForGroup(manifest, group, currentHashes),
    confirmedAt: now,
  };
  const index = registry.groups.findIndex((group) => group.groupId === entry.groupId);
  if (index >= 0) registry.groups[index] = entry;
  else registry.groups.push(entry);
  registry.groups.sort((a, b) => a.groupId.localeCompare(b.groupId));
  await ensureDir(join(projectRoot, 'knowledge'));
  await writeFileAtomic(
    intakeConfirmRegistryPath(projectRoot),
    `${JSON.stringify(registry, null, 2)}\n`,
  );
  return entry;
}
