import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writeFileAtomic } from '../src/core/atomic.js';

/**
 * Secret-bearing writes must create the file with the requested mode from
 * the first byte — between create and rename there must be no window where
 * the key exists world-readable (POSIX only; Windows has no mode bits).
 */

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe('writeFileAtomic mode option', () => {
  it('creates the final file with mode 0600 when requested', async () => {
    if (process.platform === 'win32') return;
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-atomic-'));
    dirs.push(dir);
    const path = join(dir, 'credentials.env');
    await writeFileAtomic(path, 'MY_KEY=sk-value\n', { mode: 0o600 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('still works without a mode option (default behavior unchanged)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-atomic-'));
    dirs.push(dir);
    const path = join(dir, 'plain.json');
    await writeFileAtomic(path, '{"ok":true}\n');
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(path, 'utf8')).toBe('{"ok":true}\n');
  });
});
