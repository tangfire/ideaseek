import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/**
 * Durable write for small files: temp file in the same directory, fsync, then
 * atomic rename. Used for config templates and other metadata, never for user
 * input files (which are read-only).
 */
export async function writeFileAtomic(path: string, data: string | Buffer): Promise<void> {
  const dir = dirname(path);
  await ensureDir(dir);
  const temp = join(dir, `.tmp-${randomUUID()}`);
  const handle = await open(temp, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}
