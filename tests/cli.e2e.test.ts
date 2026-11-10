import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

function spawnCli(cwd: string, args: string[]) {
  return spawn(process.execPath, [CLI_BIN, ...args], {
    cwd,
    env: { ...process.env, IDEASEEK_CLI: '1' },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function makeE2eProject(fastLease = false): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ideaseek-e2e-'));
  const init = await runCli(dir, ['init']);
  expect(init.code).toBe(0);
  if (fastLease) {
    const configPath = join(dir, 'research.yaml');
    const config = await readFile(configPath, 'utf8');
    await writeFile(
      configPath,
      config
        .replace('lease_ttl_seconds: 30', 'lease_ttl_seconds: 1')
        .replace('heartbeat_interval_seconds: 8', 'heartbeat_interval_seconds: 0.3'),
      'utf8',
    );
  }
  return dir;
}

describe('ideaseek CLI end-to-end', () => {
  it('init → run → status → next → events chain', async () => {
    const dir = await makeE2eProject();

    const again = await runCli(dir, ['init']);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('already initialized');

    const run = await runCli(dir, ['run', '--question', 'e2e question', '--json']);
    expect(run.code).toBe(0);
    const runPayload = JSON.parse(run.stdout) as {
      status: string;
      tasks: Record<string, number>;
    };
    expect(runPayload.status).toBe('COMPLETED');
    expect(runPayload.tasks.succeeded).toBe(3);

    const status = await runCli(dir, ['status', '--json']);
    expect(status.code).toBe(0);
    const statusPayload = JSON.parse(status.stdout) as {
      run: { status: string };
      tasks: Record<string, number>;
      events: { seq: number }[];
    };
    expect(statusPayload.run.status).toBe('COMPLETED');
    expect(statusPayload.tasks.succeeded).toBe(3);
    expect(statusPayload.events.length).toBeGreaterThan(0);

    const next = await runCli(dir, ['next']);
    expect(next.code).toBe(0);
    expect(next.stdout).toContain('下一条命令：ideaseek status --detail');

    const events = await runCli(dir, ['events', '--json']);
    expect(events.code).toBe(0);
    const eventsPayload = JSON.parse(events.stdout) as {
      events: { seq: number; eventType: string }[];
    };
    const seqs = eventsPayload.events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(eventsPayload.events.some((event) => event.eventType === 'run_completed')).toBe(true);

    const textStatus = await runCli(dir, ['status']);
    expect(textStatus.stdout).toContain('状态：COMPLETED');
  }, 40_000);

  it('worker crash → lease recovery → resume completes after process restart', async () => {
    const dir = await makeE2eProject(true);

    // Process 1 crashes mid-task (fault injection exits before any commit).
    const crash = await runCli(dir, [
      'run',
      '--question',
      'crash test',
      '--fault',
      '{"demo.ingest":{"crash":true}}',
    ]);
    expect(crash.code).toBe(7);

    // Right after the crash the lease may still be held; recovery happens on open.
    const immediate = await runCli(dir, ['status', '--json']);
    const immediatePayload = JSON.parse(immediate.stdout) as {
      run: { status: string };
      tasks: Record<string, number>;
      recovery: { reclaimedLeases: string[] };
    };
    expect(immediatePayload.run.status).toBe('RUNNING');

    // After the 1s lease expires, the task is back in the queue with no owner.
    await sleep(1300);
    const reclaimed = await runCli(dir, ['status', '--json']);
    expect(reclaimed.code).toBe(3); // still running
    const reclaimedPayload = JSON.parse(reclaimed.stdout) as {
      tasks: Record<string, number>;
      recovery: { reclaimedLeases: string[] };
    };
    expect(reclaimedPayload.recovery.reclaimedLeases).toHaveLength(1);
    // Reclaimed ingest + its two not-yet-run dependents are all queued.
    expect(reclaimedPayload.tasks.queued).toBe(3);
    expect(reclaimedPayload.tasks.succeeded).toBe(0);

    // Wait for the ghost worker row to go stale (3× lease TTL) so `run` attaches.
    await sleep(2200);
    const resume = await runCli(dir, ['run']);
    expect(resume.code).toBe(0);
    expect(resume.stdout).toContain('COMPLETED');

    const status = await runCli(dir, ['status', '--json']);
    expect(status.code).toBe(0);
    const statusPayload = JSON.parse(status.stdout) as {
      run: { status: string };
      tasks: Record<string, number>;
    };
    expect(statusPayload.run.status).toBe('COMPLETED');
    expect(statusPayload.tasks.succeeded).toBe(3);

    // Recovery and lease lifecycle are visible in the replayable event stream.
    const events = await runCli(dir, ['events', '--json']);
    const payload = JSON.parse(events.stdout) as { events: { eventType: string }[] };
    const types = payload.events.map((event) => event.eventType);
    expect(types).toContain('task_reclaimed');
    expect(types).toContain('recovery');
    expect(types).toContain('run_completed');
  }, 40_000);

  it('quota block → status/next guidance → continue → worker finishes', async () => {
    const dir = await makeE2eProject();

    const blocked = await runCli(dir, [
      'run',
      '--question',
      'quota test',
      '--fault',
      '{"demo.analyze":{"blockCode":"QUOTA_EXHAUSTED","blockOnce":true}}',
    ]);
    expect(blocked.code).toBe(2);
    expect(blocked.stdout).toContain('ideaseek continue');

    const status = await runCli(dir, ['status', '--json']);
    expect(status.code).toBe(2);
    const payload = JSON.parse(status.stdout) as {
      run: { status: string; blockReason: string | null };
      tasks: Record<string, number>;
    };
    expect(payload.run.status).toBe('QUOTA_EXHAUSTED');
    expect(payload.tasks.succeeded).toBe(1); // ingest kept
    // analyze is parked by the block; report waits on analyze.
    expect(payload.tasks.queued).toBe(2);

    const next = await runCli(dir, ['next']);
    expect(next.code).toBe(2);
    expect(next.stdout).toContain('ideaseek continue');

    const cont = await runCli(dir, ['continue']);
    expect(cont.code).toBe(0);

    const worker = await runCli(dir, ['worker']);
    expect(worker.code).toBe(0);
    expect(worker.stdout).toContain('completed');

    const done = await runCli(dir, ['status']);
    expect(done.code).toBe(0);
    expect(done.stdout).toContain('状态：COMPLETED');
  }, 40_000);

  it('enqueue-only → worker partial → pause → resume → complete; terminal guards', async () => {
    const dir = await makeE2eProject();

    const enqueued = await runCli(dir, ['run', '--question', 'pause test', '--enqueue-only']);
    expect(enqueued.code).toBe(0);
    expect(enqueued.stdout).toContain('3 tasks queued');

    const partial = await runCli(dir, ['worker', '--max-tasks', '1']);
    expect(partial.code).toBe(3); // one task done, run still RUNNING

    const paused = await runCli(dir, ['pause']);
    expect(paused.code).toBe(0);

    const whilePaused = await runCli(dir, ['worker']);
    expect(whilePaused.code).toBe(2); // needs resume
    expect(whilePaused.stderr).toContain('ideaseek resume');

    const resumed = await runCli(dir, ['resume']);
    expect(resumed.code).toBe(0);

    const finished = await runCli(dir, ['worker']);
    expect(finished.code).toBe(0);

    const canceled = await runCli(dir, ['cancel']);
    expect(canceled.code).toBe(1); // RUN_TERMINAL: nothing to cancel
    expect(canceled.stderr).toContain('RUN_TERMINAL');
  }, 40_000);

  it('rejects a second run while a live worker holds the run', async () => {
    const dir = await makeE2eProject();

    // Create the run with a slow ingest task so a worker stays busy for a while.
    const enqueued = await runCli(dir, [
      'run',
      '--question',
      'guard test',
      '--enqueue-only',
      '--fault',
      '{"demo.ingest":{"slowMs":3000}}',
    ]);
    expect(enqueued.code).toBe(0);

    const worker = spawnCli(dir, ['worker']);
    await sleep(800); // worker claims and starts the slow ingest

    const rejected = await runCli(dir, ['run']);
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain('INVALID_STATE');
    expect(rejected.stderr).toContain('live worker');

    // Let the worker finish; the background process must not leak.
    await new Promise<void>((resolve) => worker.on('close', () => resolve()));
  }, 40_000);
});
