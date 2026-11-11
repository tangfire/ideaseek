import { homedir } from 'node:os';
import { join } from 'node:path';

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
  try {
    const { readFile } = await import('node:fs/promises');
    const parsed = JSON.parse(await readFile(registryPath(), 'utf8')) as RegistryFile;
    if (!parsed || !Array.isArray(parsed.projects)) return { version: 1, projects: [] };
    return parsed;
  } catch {
    return { version: 1, projects: [] };
  }
}

async function writeRegistry(registry: RegistryFile): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const path = registryPath();
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
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
