import { homedir } from 'node:os';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';

/**
 * User-level project registry (PRODUCT_GAPS #5): a small JSON file under
 * ~/.ideaseek listing every project directory IdeaSeek has initialized.
 * Only paths and display metadata live here — never secrets, never state
 * that belongs to a project's own Workflow DB.
 */

export interface RegisteredProject {
  root: string;
  name: string;
  registeredAt: number;
  lastOpenedAt: number;
}

interface RegistryFile {
  version: 1;
  projects: RegisteredProject[];
}

export function registryPath(): string {
  // Tests (and sandboxed runs) redirect the registry; production default is
  // the user-level ~/.ideaseek/projects.json.
  const override = process.env.IDEASEEK_REGISTRY_PATH;
  if (override && override.trim()) return override.trim();
  return join(homedir(), '.ideaseek', 'projects.json');
}

async function readRegistry(): Promise<RegistryFile> {
  const path = registryPath();
  const { readFile } = await import('node:fs/promises');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, projects: [] };
    throw new IdeaseekError(
      'INVALID_STATE',
      `cannot read project registry ${path}: ${(error as Error).message} — move the file aside, then rerun`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Fail loud, never wipe: a corrupt registry (e.g. crash during an old
    // non-atomic write) must not be silently replaced with an empty one.
    throw new IdeaseekError(
      'INVALID_STATE',
      `project registry ${path} is not valid JSON — move the file aside to recover it, then rerun`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as RegistryFile).projects)) {
    throw new IdeaseekError(
      'INVALID_STATE',
      `project registry ${path} has an unexpected shape — move the file aside to recover it, then rerun`,
    );
  }
  return parsed as RegistryFile;
}

async function writeRegistry(registry: RegistryFile): Promise<void> {
  const { writeFileAtomic } = await import('../core/atomic.js');
  const path = registryPath();
  await writeFileAtomic(path, `${JSON.stringify(registry, null, 2)}\n`);
}

/** Idempotent upsert by root (init/start refresh lastOpenedAt). */
export async function registerProject(root: string, name: string): Promise<void> {
  const registry = await readRegistry();
  const normalized = root.replace(/[\\/]+$/, '');
  const now = Date.now();
  const existing = registry.projects.find((p) => p.root === normalized);
  if (existing) {
    existing.name = name;
    existing.lastOpenedAt = now;
  } else {
    registry.projects.push({
      root: normalized,
      name,
      registeredAt: now,
      lastOpenedAt: now,
    });
  }
  await writeRegistry(registry);
}

export async function listRegisteredProjects(): Promise<RegisteredProject[]> {
  const registry = await readRegistry();
  return [...registry.projects].sort((a, b) => a.root.localeCompare(b.root));
}
