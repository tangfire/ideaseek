import { mkdir, readFile, rm, symlink, copyFile, lstat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { writeFileAtomic } from '../core/atomic.js';
import type { InputManifest } from './scan.js';

export interface IndexEntry {
  /** Project-relative path of the platform-managed index link/copy. */
  link: string;
  /** Project-relative path of the untouched original. */
  source: string;
  sha256: string | null;
  method: 'symlink' | 'copy';
  createdAt: number;
}

export interface IndexManifest {
  indexVersion: 1;
  createdAt: number;
  entries: IndexEntry[];
}

export interface OrganizePlanItem {
  source: string;
  link: string;
  role: string;
  action: 'link' | 'skip-existing' | 'skip-unhashable';
}

export interface OrganizeResult {
  planned: OrganizePlanItem[];
  applied: IndexEntry[];
  skipped: OrganizePlanItem[];
}

export const INDEX_DIR = 'knowledge/index';

function linkPathFor(file: { relPath: string; role: string }): string {
  // Flat, collision-free layout: knowledge/index/<role>/<flattened relPath>
  const flattened = file.relPath.replace(/[\\/]/g, '__');
  return `${INDEX_DIR}/${file.role}/${flattened}`;
}

/**
 * Builds the organize plan: every discovered file with a verified hash gets a
 * platform-managed link under `knowledge/index/<role>/`. Originals are never
 * moved, renamed or overwritten; an occupied link path is skipped, not
 * clobbered.
 */
export function planOrganize(manifest: InputManifest): OrganizePlanItem[] {
  const plan: OrganizePlanItem[] = [];
  for (const file of [...manifest.files].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
    const link = linkPathFor(file);
    if (!file.sha256) {
      plan.push({ source: file.relPath, link, role: file.role, action: 'skip-unhashable' });
    } else {
      plan.push({ source: file.relPath, link, role: file.role, action: 'link' });
    }
  }
  return plan;
}

/** True when anything (file or symlink) already occupies the index slot. */
async function slotOccupied(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Applies the plan. Prefers symlinks (Windows may require privileges), falls
 * back to byte copies; both record provenance in `knowledge/index/sources.json`.
 * Idempotent: existing index entries with the same source are left in place.
 */
export async function applyOrganize(
  projectRoot: string,
  manifest: InputManifest,
  now: number,
): Promise<OrganizeResult> {
  const plan = planOrganize(manifest);
  const applied: IndexEntry[] = [];
  const skipped: OrganizePlanItem[] = [];

  const indexManifestPath = join(projectRoot, INDEX_DIR, 'sources.json');
  let existing: IndexManifest | null = null;
  try {
    existing = JSON.parse(await readFile(indexManifestPath, 'utf8')) as IndexManifest;
  } catch {
    existing = null;
  }
  const entriesBySource = new Map((existing?.entries ?? []).map((entry) => [entry.source, entry]));

  for (const item of plan) {
    if (item.action === 'skip-unhashable') {
      skipped.push(item);
      continue;
    }
    const sourceAbs = join(projectRoot, ...item.source.split('/'));
    const linkAbs = join(projectRoot, ...item.link.split('/'));
    const already = entriesBySource.get(item.source);
    if (already && (await slotOccupied(join(projectRoot, ...already.link.split('/'))))) {
      skipped.push({ ...item, action: 'skip-existing' });
      continue;
    }
    if (await slotOccupied(linkAbs)) {
      // Never overwrite a file we did not create in a previous organize run.
      skipped.push({ ...item, action: 'skip-existing' });
      continue;
    }
    await mkdir(dirname(linkAbs), { recursive: true });
    const sha256 = manifest.files.find((file) => file.relPath === item.source)?.sha256 ?? null;
    let method: IndexEntry['method'] = 'symlink';
    try {
      const target = relative(dirname(linkAbs), sourceAbs).split(sep).join('/');
      await symlink(target, linkAbs);
    } catch {
      method = 'copy';
      try {
        await copyFile(sourceAbs, linkAbs);
      } catch (error) {
        skipped.push(item);
        throw new IdeaseekError(
          'INVALID_ARTIFACT',
          `failed to index ${item.source}: ${(error as Error).message}`,
          { source: item.source },
        );
      }
    }
    const entry: IndexEntry = {
      link: item.link,
      source: item.source,
      sha256,
      method,
      createdAt: now,
    };
    applied.push(entry);
    entriesBySource.set(item.source, entry);
  }

  const indexManifest: IndexManifest = {
    indexVersion: 1,
    createdAt: now,
    entries: [...entriesBySource.values()].sort((a, b) => a.source.localeCompare(b.source)),
  };
  if (applied.length > 0 || existing === null) {
    await mkdir(dirname(indexManifestPath), { recursive: true });
    await writeFileAtomic(indexManifestPath, `${JSON.stringify(indexManifest, null, 2)}\n`);
  }

  return { planned: plan, applied, skipped };
}

/** Removes the platform index only (never originals); used by tests/cleanup. */
export async function clearOrganizeIndex(projectRoot: string): Promise<void> {
  await rm(join(projectRoot, INDEX_DIR), { recursive: true, force: true });
}

export async function loadIndexManifest(projectRoot: string): Promise<IndexManifest | null> {
  try {
    return JSON.parse(await readFile(join(projectRoot, INDEX_DIR, 'sources.json'), 'utf8')) as IndexManifest;
  } catch {
    return null;
  }
}

export async function writeReview(path: string, content: string): Promise<void> {
  await writeFileAtomic(path, content);
}

export async function writeManifest(path: string, manifest: InputManifest): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function readManifest(path: string): Promise<InputManifest | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as InputManifest;
  } catch {
    return null;
  }
}
