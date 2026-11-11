import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, openRuntime } from './helpers.js';

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[], timeoutMs = 60_000): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
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
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** init + enqueue run + worker completes the demo pipeline. */
async function projectWithRun(): Promise<{ project: string; runId: string }> {
  const project = await mkdtemp(join(tmpdir(), 'ideaseek-maint-'));
  expect((await runCli(project, ['init'])).code).toBe(0);
  expect(
    (await runCli(project, ['run', '--question', 'maintenance e2e', '--enqueue-only'])).code,
  ).toBe(0);
  expect((await runCli(project, ['worker'])).code).toBe(0);
  const status = await runCli(project, ['status', '--json']);
  const runId = (JSON.parse(status.stdout) as { run: { runId: string } }).run.runId;
  return { project, runId };
}

describe('ideaseek cleanup', () => {
  it('previews platform-owned tmp files, deletes only those, never originals', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-clean-'));
    expect((await runCli(project, ['init'])).code).toBe(0);

    // Platform tmp garbage + an original paper that must never be touched.
    const tmpDir = join(project, '.research', 'artifacts', 'tmp');
    await mkdir(tmpDir, { recursive: true });
    const orphan = join(tmpDir, 'orphan-staged.tmp');
    await writeFile(orphan, 'x'.repeat(64), 'utf8');
    const paper = join(project, 'papers', 'keep-me.pdf');
    await mkdir(join(project, 'papers'), { recursive: true });
    await writeFile(paper, 'original paper bytes', 'utf8');

    // Dry-run lists but deletes nothing.
    const preview = await runCli(project, ['cleanup', '--json']);
    expect(preview.code, preview.stdout + preview.stderr).toBe(0);
    const previewPayload = JSON.parse(preview.stdout) as {
      mode: string;
      deletable: { path: string }[];
      rules: string[];
    };
    expect(previewPayload.mode).toBe('dry-run');
    expect(previewPayload.deletable.some((f) => f.path.includes('orphan-staged'))).toBe(true);
    expect(previewPayload.rules.join(' ')).toContain('never touched');
    expect(await exists(orphan)).toBe(true);

    // Staged temps are protected: a beginCommit row holds the temp path
    // until finalize (simulated interrupted commit).
    expect(
      (await runCli(project, ['run', '--question', 'cleanup protect', '--enqueue-only'])).code,
    ).toBe(0);
    const runtime = await openRuntime(project);
    let stagedTemp: string;
    try {
      const task = await runtime.db.claimNextTask(
        (await runtime.db.getLatestRun(runtime.project.id))!.runId,
        'cleanup-worker',
        { leaseMs: 60_000 },
      );
      expect(task).not.toBeNull();
      const staged = await runtime.store.stage('report', 'staged content');
      stagedTemp = staged.tempPath;
      await runtime.db.beginCommit({
        taskId: task!.taskId,
        workerId: 'cleanup-worker',
        attempt: task!.attempt,
        artifacts: [
          {
            kind: 'report',
            tempPath: staged.tempPath,
            contentHash: staged.contentHash,
            size: staged.size,
            meta: {},
          },
        ],
        result: { summary: 'staged for cleanup protection test', artifacts: [] },
      });
    } finally {
      await runtime.close();
    }
    expect(await exists(stagedTemp)).toBe(true);

    const deleted = await runCli(project, ['cleanup', '--cache', '--json']);
    expect(deleted.code, deleted.stdout + deleted.stderr).toBe(0);
    const deletePayload = JSON.parse(deleted.stdout) as {
      mode: string;
      deleted: number;
      kept: string[];
    };
    expect(deletePayload.mode).toBe('delete');
    expect(deletePayload.deleted).toBeGreaterThanOrEqual(1);
    // Orphan gone, staged temp kept, original paper untouched.
    expect(await exists(orphan)).toBe(false);
    expect(await exists(stagedTemp)).toBe(true);
    expect(await exists(paper)).toBe(true);
    expect(await readFile(paper, 'utf8')).toBe('original paper bytes');
  }, 60_000);
});

describe('ideaseek archive and export', () => {
  it('archives a run bundle while the run stays readable', async () => {
    const { project, runId } = await projectWithRun();

    const archived = await runCli(project, ['archive', '--run', runId, '--json']);
    expect(archived.code, archived.stdout + archived.stderr).toBe(0);
    const payload = JSON.parse(archived.stdout) as {
      archiveDir: string;
      counts: { tasks: number; events: number; artifacts: number };
      decisionSeq: number;
    };
    expect(payload.counts.tasks).toBeGreaterThan(0);
    expect(payload.counts.events).toBeGreaterThan(0);
    expect(payload.decisionSeq).toBeGreaterThan(0);

    for (const name of ['events.json', 'tasks.json', 'artifacts.json', 'archive.json']) {
      expect(await exists(join(payload.archiveDir, name)), name).toBe(true);
    }

    // Run remains fully readable after archiving.
    const status = await runCli(project, ['status', '--json']);
    const statusPayload = JSON.parse(status.stdout) as { run: { runId: string; status: string } };
    expect(statusPayload.run.runId).toBe(runId);
    expect(statusPayload.run.status).toBeTruthy();

    // The archive action itself is audited as a decision event.
    const events = await runCli(project, ['events', '--json']);
    const decision = (
      JSON.parse(events.stdout) as {
        events: { eventType: string; summary: string }[];
      }
    ).events.find((e) => e.summary.includes('archived run bundle'));
    expect(decision).toBeTruthy();
  }, 120_000);

  it('exports a run with a hash manifest, redacted events and no secrets', async () => {
    const { project, runId } = await projectWithRun();

    // Plant a secret in the project AND in a run event; neither may escape.
    await writeFile(
      join(project, '.env'),
      'DEEPSEEK_API_KEY=sk-exportsecret1234567890abcdef\n',
      'utf8',
    );
    const runtime = await openRuntime(project);
    try {
      await runtime.db.appendEvent({
        runId,
        phase: 'DEMO',
        objectId: null,
        role: 'tester',
        eventType: 'note',
        summary: 'leak check token=sk-eventsecret9876543210',
        status: null,
      });
    } finally {
      await runtime.close();
    }

    const target = join(await mkdtemp(join(tmpdir(), 'ideaseek-export-')), 'bundle');
    const exported = await runCli(project, ['export', '--run', runId, '--to', target, '--json']);
    expect(exported.code, exported.stdout + exported.stderr).toBe(0);
    const payload = JSON.parse(exported.stdout) as {
      runId: string;
      artifacts: number;
      manifest: string;
    };
    expect(payload.runId).toBe(runId);
    expect(await exists(join(target, 'events.json'))).toBe(true);
    expect(await exists(join(target, 'tasks.json'))).toBe(true);
    expect(await exists(join(target, 'run.json'))).toBe(true);
    expect(await exists(join(target, 'export-manifest.json'))).toBe(true);
    expect(await exists(join(target, '.env'))).toBe(false);

    // Manifest hashes verify against the actual files.
    const manifest = JSON.parse(await readFile(join(target, 'export-manifest.json'), 'utf8')) as {
      files: { path: string; sha256: string }[];
      exclusions: string[];
    };
    expect(manifest.exclusions.join(' ')).toContain('.env');
    const eventsEntry = manifest.files.find((f) => f.path.includes('events.json'))!;
    expect(eventsEntry.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);

    // No key-shaped values anywhere in the bundle; event token redacted.
    const eventsText = await readFile(join(target, 'events.json'), 'utf8');
    expect(eventsText).not.toMatch(/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/);
    expect(eventsText).toContain('token=***');
    expect(eventsText).not.toContain('sk-eventsecret9876543210');
  }, 120_000);
});
