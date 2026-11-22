import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readDiagramRenderRecord } from '../src/commands/paper.js';

/**
 * The diagram render record is append-only history. A corrupt file must
 * never be read as "first render" (that silently overwrites the history it
 * exists to keep), and a non-array `renders` must not crash the command.
 */

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function recordPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ideaseek-diagram-'));
  dirs.push(dir);
  return join(dir, 'diagram-render.json');
}

describe('readDiagramRenderRecord', () => {
  it('returns a fresh record when the file does not exist', async () => {
    const record = await readDiagramRenderRecord(await recordPath());
    expect(record.contract).toBe('diagram-render-v1');
    expect(record.renders).toEqual([]);
  });

  it('refuses corrupt JSON loudly instead of restarting the history', async () => {
    const path = await recordPath();
    await writeFile(path, '{"contract":"diagram-render-v1","renders":[{"trunc', 'utf8');
    await expect(readDiagramRenderRecord(path)).rejects.toThrow(/not valid JSON/);
  });

  it('refuses a wrong-shaped record (renders not an array)', async () => {
    const path = await recordPath();
    await writeFile(path, '{"contract":"diagram-render-v1","renders":"oops"}', 'utf8');
    await expect(readDiagramRenderRecord(path)).rejects.toThrow(/unexpected shape/);
  });

  it('round-trips a valid record', async () => {
    const path = await recordPath();
    await writeFile(
      path,
      JSON.stringify({ contract: 'diagram-render-v1', renders: [{ outputPath: 'figures/a.png' }] }),
      'utf8',
    );
    const record = await readDiagramRenderRecord(path);
    expect(record.renders).toHaveLength(1);
    expect((record.renders[0] as { outputPath: string }).outputPath).toBe('figures/a.png');
  });
});
