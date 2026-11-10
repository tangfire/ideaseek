import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN } from './helpers.js';

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[], timeoutMs = 20_000): Promise<CliResult> {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCompletion(dir: string, timeoutMs = 20_000): Promise<CliResult> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await runCli(dir, ['status', '--json']);
    const payload = JSON.parse(status.stdout) as { run: { status: string } | null };
    if (payload.run?.status === 'COMPLETED') return status;
    if (['FAILED', 'CANCELED'].includes(payload.run?.status ?? '')) return status;
    if (Date.now() > deadline) {
      throw new Error(`run did not complete in time; last status=${status.stdout}`);
    }
    await sleep(300);
  }
}

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ideaseek-daemon-'));
  expect((await runCli(dir, ['init'])).code).toBe(0);
  return dir;
}

describe('background supervisor: run --detach / attach / watch', () => {
  it('detach runs the workflow in the background; attach replays the finished stream', async () => {
    const dir = await makeProject();

    const detached = await runCli(dir, [
      'run',
      '--question',
      'detach test',
      '--detach',
      '--fault',
      '{"demo.ingest":{"slowMs":800}}',
      '--json',
    ]);
    expect(detached.code).toBe(0);
    const payload = JSON.parse(detached.stdout) as {
      runId: string;
      detached: boolean;
      pid: number;
      logPath: string;
      tasks: Record<string, number>;
    };
    expect(payload.detached).toBe(true);
    expect(payload.pid).toBeGreaterThan(0);
    expect(payload.tasks.queued).toBe(3);

    // The parent returned immediately; the supervisor keeps working.
    const early = await runCli(dir, ['status', '--json']);
    const earlyPayload = JSON.parse(early.stdout) as {
      run: { status: string };
      daemon: { pid: number; state: string } | null;
    };
    expect(earlyPayload.run.status).toBe('RUNNING');
    expect(earlyPayload.daemon?.pid).toBe(payload.pid);

    const finished = await waitForCompletion(dir);
    expect((JSON.parse(finished.stdout) as { run: { status: string } }).run.status).toBe(
      'COMPLETED',
    );

    // The supervisor exits cleanly and records it in daemon.json.
    const daemonPath = join(dir, '.research', 'daemon.json');
    const deadline = Date.now() + 10_000;
    let daemon = JSON.parse(await readFile(daemonPath, 'utf8')) as {
      exitedAt?: number;
      reason?: string;
    };
    while (!daemon.exitedAt && Date.now() < deadline) {
      await sleep(200);
      daemon = JSON.parse(await readFile(daemonPath, 'utf8')) as typeof daemon;
    }
    expect(daemon.exitedAt).toBeGreaterThan(0);
    expect(daemon.reason).toBe('completed');

    // The log captured worker output.
    const log = await readFile(payload.logPath, 'utf8');
    expect(log).toContain('committed');

    // status now reports the exited supervisor.
    const statusText = await runCli(dir, ['status']);
    expect(statusText.stdout).toContain('daemon supervisor');
    expect(statusText.stdout).toContain('exited(');

    // attach replays the persisted stream and exits because the run is terminal.
    const attach = await runCli(dir, ['attach', '--run', payload.runId, '--json']);
    expect(attach.code).toBe(0);
    const attachLines = attach.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { seq?: number; stopReason?: string; runId?: string });
    const events = attachLines.filter((line) => typeof line.seq === 'number');
    expect(events.length).toBeGreaterThanOrEqual(17);
    expect(events[0]!.seq).toBe(1);
    const summary = attachLines.find((line) => line.stopReason);
    expect(summary?.stopReason).toBe('terminal');
    expect(summary?.runId).toBe(payload.runId);

    // events --since replays only the tail.
    const tail = await runCli(dir, ['events', '--since', '5', '--json']);
    const tailPayload = JSON.parse(tail.stdout) as { events: { seq: number }[] };
    expect(tailPayload.events.every((event) => event.seq > 5)).toBe(true);
    expect(tailPayload.events.length).toBeGreaterThanOrEqual(12);
  }, 60_000);

  it('watch exits with code 3 when a RUNNING run has no live worker', async () => {
    const dir = await makeProject();
    const enqueued = await runCli(dir, ['run', '--question', 'orphan run', '--enqueue-only']);
    expect(enqueued.code).toBe(0);

    const watch = await runCli(dir, ['watch', '--poll', '50', '--worker-timeout', '200']);
    expect(watch.code).toBe(3);
    expect(watch.stderr).toContain('no live worker');
  }, 30_000);

  it('watch exits 0 after observing a completed run', async () => {
    const dir = await makeProject();
    expect((await runCli(dir, ['run', '--question', 'quick', '--json'])).code).toBe(0);

    const watch = await runCli(dir, ['watch', '--poll', '50']);
    expect(watch.code).toBe(0);
    expect(watch.stdout).toContain('run_completed');
    expect(watch.stdout).toContain('watch stopped');
  }, 30_000);

  it('a detached supervisor honors pause: it stops claiming and exits', async () => {
    const dir = await makeProject();
    // Slow first task keeps the supervisor busy while we pause.
    const detached = await runCli(dir, [
      'run',
      '--question',
      'pause daemon',
      '--detach',
      '--fault',
      '{"demo.ingest":{"slowMs":1500}}',
      '--json',
    ]);
    expect(detached.code).toBe(0);
    await sleep(600); // supervisor claims the slow task

    const paused = await runCli(dir, ['pause']);
    expect(paused.code).toBe(0);

    // The in-flight task finishes, the supervisor notices PAUSED and exits.
    const deadline = Date.now() + 15_000;
    let daemon = JSON.parse(await readFile(join(dir, '.research', 'daemon.json'), 'utf8')) as {
      exitedAt?: number;
      reason?: string;
    };
    while (!daemon.exitedAt && Date.now() < deadline) {
      await sleep(250);
      daemon = JSON.parse(
        await readFile(join(dir, '.research', 'daemon.json'), 'utf8'),
      ) as typeof daemon;
    }
    expect(daemon.exitedAt).toBeGreaterThan(0);
    expect(['paused', 'stopped']).toContain(daemon.reason);

    const status = await runCli(dir, ['status', '--json']);
    const payload = JSON.parse(status.stdout) as {
      run: { status: string };
      tasks: Record<string, number>;
    };
    expect(payload.run.status).toBe('PAUSED');
    expect(payload.tasks.succeeded).toBe(1);

    // Resume via a fresh foreground worker finishes the rest.
    expect((await runCli(dir, ['resume'])).code).toBe(0);
    const worker = await runCli(dir, ['worker']);
    expect(worker.code).toBe(0);
    const finished = await waitForCompletion(dir);
    expect((JSON.parse(finished.stdout) as { run: { status: string } }).run.status).toBe(
      'COMPLETED',
    );
  }, 60_000);
});
