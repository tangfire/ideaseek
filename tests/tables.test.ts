import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractTables } from '../src/knowledge/pdf.js';
import { paperTables } from '../src/worker/paper-handlers.js';
import { CLI_BIN, createDemoRun, makeProjectDir, openRuntime } from './helpers.js';
import type { TaskContext } from '../src/worker/types.js';

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

describe('extractTables bridge', () => {
  it('returns an empty-but-valid result for fixture PDFs (skips without python)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-tables-'));
    const { makeFixturePdf } = await import('../src/knowledge/pdf.js');
    try {
      await makeFixturePdf(join(dir, 'plain.pdf'), 'Plain');
    } catch {
      return;
    }
    const result = await extractTables(join(dir, 'plain.pdf'));
    expect(result.tableCount).toBe(result.tables.length);
    expect(result.parser).toMatch(/^pdfplumber\//);
  }, 120_000);

  it('maps missing files to FILE_NOT_FOUND', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-tables-'));
    try {
      const { makeFixturePdf } = await import('../src/knowledge/pdf.js');
      await makeFixturePdf(join(dir, 'probe.pdf'), 'probe');
    } catch {
      return;
    }
    try {
      await extractTables(join(dir, 'missing.pdf'));
      expect.unreachable('should fail');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('FILE_NOT_FOUND');
    }
  }, 120_000);
});

describe('paper.tables handler (committed artifact)', () => {
  it('extracts real tables from a corpus PDF into a paper-tables artifact (skips without python)', async () => {
    const dir = await makeProjectDir();
    const runtime = await openRuntime(dir, { recover: false });
    try {
      const { copyFile } = await import('node:fs/promises');
      const { readFile: rf } = await import('node:fs/promises');
      let realPdf: string;
      try {
        realPdf = join(dir, 'incoming', 'fl-paper.pdf');
        await copyFile(join(process.cwd(), 'papers', '2101.11296v3.pdf'), realPdf);
      } catch {
        return; // corpus not present (CI) or python missing
      }
      const run = await createDemoRun(runtime, 'tables test');
      const task = await runtime.db.claimNextTask(run.runId, 'w1', { leaseMs: 60_000 });
      const ctx: TaskContext = {
        task: task!,
        run,
        payload: { pdfPath: 'incoming/fl-paper.pdf', nonBlocking: true },
        signal: new AbortController().signal,
        runtime,
        log: () => undefined,
      };
      let output;
      try {
        output = await paperTables(ctx);
      } catch (error) {
        if (
          (error as { code?: string }).code === 'ENV_UNSUPPORTED' ||
          (error as { code?: string }).code === 'PARSER_MISSING'
        ) {
          return; // pdfplumber unavailable in this environment
        }
        throw error;
      }
      expect(output.summary).toContain('extracted');
      expect(output.artifacts[0]!.kind).toBe('paper-tables');

      const staged = await runtime.store.stage(
        'paper-tables',
        output.artifacts[0]!.data,
        output.artifacts[0]!.meta ?? {},
      );
      await runtime.db.beginCommit({
        taskId: task!.taskId,
        workerId: 'w1',
        attempt: task!.attempt,
        artifacts: [
          {
            kind: 'paper-tables',
            tempPath: staged.tempPath,
            contentHash: staged.contentHash,
            size: staged.size,
            meta: staged.meta,
          },
        ],
        result: { summary: output.summary, artifacts: [] },
      });
      await runtime.store.promote([staged]);
      await runtime.db.finalizeCommit({ taskId: task!.taskId, workerId: 'w1' });

      const rows = await runtime.db.listArtifacts(task!.taskId);
      expect(rows[0]!.kind).toBe('paper-tables');
      const payload = JSON.parse(await runtime.store.readFinalText(rows[0]!.contentHash)) as {
        tableCount: number;
        tables: { page: number; rows: string[][] }[];
        sourceHash: string;
      };
      expect(payload.tableCount).toBeGreaterThan(0);
      expect(payload.tables[0]!.rows.length).toBeGreaterThan(0);
      expect(payload.sourceHash).toMatch(/^sha256:/);
      void rf;
    } finally {
      await runtime.close();
    }
  }, 180_000);
});

describe('CLI: ingest --tables', () => {
  it('enqueues opt-in table tasks, is incremental, and flags cleanly (fixtures)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-ingest-tables-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    const { makeFixturePdf } = await import('../src/knowledge/pdf.js');
    try {
      await makeFixturePdf(join(dir, 'papers', 'alpha.pdf'), 'Alpha');
    } catch {
      return;
    }
    expect((await runCli(dir, ['scan'])).code).toBe(0);

    const first = await runCli(dir, ['ingest', '--tables', '--json'], 180_000);
    expect(first.code).toBe(0);
    const payload = JSON.parse(first.stdout) as {
      enqueued: number;
      tablesEnqueued: number;
      status: string;
    };
    expect(payload.enqueued).toBe(1);
    expect(payload.tablesEnqueued).toBe(1);
    expect(payload.status).toBe('COMPLETED');

    // Second run: both parse and tables are incremental no-ops.
    const second = await runCli(dir, ['ingest', '--tables', '--json'], 180_000);
    expect(second.code).toBe(0);
    const secondPayload = JSON.parse(second.stdout) as { action?: string };
    expect(secondPayload.action).toBe('nothing-to-do');

    // Without the flag, table extraction is not requested at all.
    const status = await runCli(dir, ['status', '--json']);
    const state = JSON.parse(status.stdout) as { tasks: Record<string, number> };
    expect(state.tasks.succeeded).toBe(2); // parse + tables
  }, 300_000);
});
