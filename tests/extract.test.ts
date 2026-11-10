import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { selectPendingExtracts } from '../src/commands/extract.js';
import { CLI_BIN } from './helpers.js';

function runCli(
  cwd: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli ${args.join(' ')} timed out; stderr=${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

describe('selectPendingExtracts (incremental map decision)', () => {
  it('skips extracted/busy sources, dedupes and sorts', () => {
    const pending = selectPendingExtracts(
      ['papers/c.pdf', 'papers/a.pdf', 'papers/b.pdf', 'papers/a.pdf', ''],
      new Set(['papers/b.pdf']),
    );
    expect(pending).toEqual(['papers/a.pdf', 'papers/c.pdf']);
  });

  it('returns everything on a cold start', () => {
    expect(selectPendingExtracts(['x.pdf', 'y.pdf'], new Set())).toEqual(['x.pdf', 'y.pdf']);
    expect(selectPendingExtracts([], new Set())).toEqual([]);
  });
});

async function prepareCorpus(dir: string): Promise<boolean> {
  const { makeFixturePdf } = await import('../src/knowledge/pdf.js');
  try {
    await makeFixturePdf(join(dir, 'papers', 'alpha.pdf'), 'Alpha');
    await makeFixturePdf(join(dir, 'papers', 'beta.pdf'), 'Beta');
  } catch {
    return false; // python/pypdf unavailable
  }
  expect((await runCli(dir, ['scan'])).code).toBe(0);
  expect((await runCli(dir, ['ingest', '--json'])).code).toBe(0);
  return true;
}

describe('ideaseek extract (parallel map stage)', () => {
  it('extracts and verifies all parsed papers, then becomes a no-op', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-extract-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    if (!(await prepareCorpus(dir))) return; // python/pypdf unavailable

    const first = await runCli(dir, ['extract', '--parallel', '2', '--json'], 120_000);
    expect(first.code).toBe(0);
    const payload = JSON.parse(first.stdout) as {
      parallel: number;
      pending: number;
      status: string;
      tasks: Record<string, number>;
      unfinished: number;
    };
    expect(payload.parallel).toBe(2);
    expect(payload.pending).toBe(2);
    expect(payload.status).toBe('COMPLETED');
    expect(payload.tasks.succeeded).toBe(4); // 2 extracts + 2 verifies
    expect(payload.unfinished).toBe(0);

    const events = await runCli(dir, ['events', '--json']);
    const stream = JSON.parse(events.stdout) as {
      events: { eventType: string; summary: string }[];
    };
    const verdicts = stream.events.filter((event) => event.eventType === 'evidence_verdict');
    expect(verdicts).toHaveLength(2);
    expect(verdicts.every((event) => event.summary.startsWith('pass'))).toBe(true);
    const extracts = stream.events.filter((event) =>
      event.summary.includes('extracted structured card'),
    );
    expect(extracts).toHaveLength(2);

    // Incremental: everything already extracted → no-op, no new run work.
    const second = await runCli(dir, ['extract', '--json'], 60_000);
    expect(second.code).toBe(0);
    const secondPayload = JSON.parse(second.stdout) as {
      pending: number;
      action?: string;
    };
    expect(secondPayload.pending).toBe(0);
    expect(secondPayload.action).toBe('nothing-to-do');
  }, 240_000);

  it('enqueues only (without executing) when requested', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-extract-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    if (!(await prepareCorpus(dir))) return;

    const enq = await runCli(dir, ['extract', '--enqueue-only', '--json'], 60_000);
    expect(enq.code).toBe(0);
    const payload = JSON.parse(enq.stdout) as { pending: number; enqueued: number; runId: string };
    expect(payload.pending).toBe(2);
    expect(payload.enqueued).toBe(2);

    const status = await runCli(dir, ['status', '--json']);
    const state = JSON.parse(status.stdout) as { tasks: Record<string, number> };
    expect(state.tasks.queued).toBe(4); // 2 extracts + 2 chained verifies
  }, 180_000);

  it('runs the real parallel map with the live model (keyed; skips without credentials)', async () => {
    if (!process.env.DEEPSEEK_API_KEY) return;
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-extract-keyed-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    if (!(await prepareCorpus(dir))) return;

    const run = await runCli(
      dir,
      ['extract', '--parallel', '2', '--harness', 'dsh', '--timeout', '300000', '--json'],
      330_000,
    );
    expect(run.code).toBe(0);
    const payload = JSON.parse(run.stdout) as {
      status: string;
      tasks: Record<string, number>;
    };
    expect(payload.status).toBe('COMPLETED');
    expect(payload.tasks.succeeded).toBe(4);

    const events = await runCli(dir, ['events', '--json'], 60_000);
    const stream = JSON.parse(events.stdout) as {
      events: { eventType: string }[];
    };
    expect(stream.events.filter((event) => event.eventType === 'evidence_verdict')).toHaveLength(2);
    // Real cards must exist for both sources.
    const status = await runCli(dir, ['status', '--json'], 60_000);
    const state = JSON.parse(status.stdout) as { failed: unknown[] };
    expect(state.failed).toHaveLength(0);
  }, 420_000);
});
