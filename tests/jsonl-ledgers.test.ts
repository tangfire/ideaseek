import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { listNotifications } from '../src/runtime/notify.js';
import { listBackupRecords } from '../src/runtime/backup.js';

/**
 * Append-only JSONL ledgers: a truncated tail line is the normal crash
 * artifact of a crash mid-append. One bad line used to fail the whole
 * `.map`, collapsing the entire history into "never had any backups /
 * notifications" — missing and corrupt became indistinguishable.
 */

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(root);
  await mkdir(join(root, '.research'), { recursive: true });
  return root;
}

function notification(title: string, ts: number): string {
  return JSON.stringify({
    ts,
    kind: 'quota',
    title,
    summary: 's',
    project: 'p',
    delivery: 'recorded',
  });
}

describe('JSONL ledger resilience', () => {
  it('a truncated notification line does not erase the rest of the history', async () => {
    const root = await makeRoot('ideaseek-notify-');
    await writeFile(
      join(root, '.research', 'notifications.jsonl'),
      `${notification('first', 1)}\n${notification('second', 2).slice(0, 30)}\n${notification('third', 3)}\n`,
      'utf8',
    );
    const records = await listNotifications(root);
    expect(records.map((record) => record.title)).toEqual(['third', 'first']);
  });

  it('a truncated backup line keeps every readable outcome', async () => {
    const root = await makeRoot('ideaseek-backup-ledger-');
    const ok = JSON.stringify({ status: 'ok', at: 1, files: 3 });
    const failed = JSON.stringify({ status: 'failed', at: 3, error: 'disk full' });
    await writeFile(
      join(root, '.research', 'backups.jsonl'),
      `${ok}\n${failed.slice(0, 15)}\n${failed}\n`,
      'utf8',
    );
    const records = await listBackupRecords(root);
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.status)).toEqual(['ok', 'failed']);
    // The latest OUTCOME (the alert surface) is still the real last one.
    expect(records[records.length - 1]!.status).toBe('failed');
  });

  it('a missing ledger still reads as empty (missing ≠ corrupt)', async () => {
    const root = await makeRoot('ideaseek-ledger-empty-');
    expect(await listNotifications(root)).toEqual([]);
    expect(await listBackupRecords(root)).toEqual([]);
  });
});
