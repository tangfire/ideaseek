import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN } from './helpers.js';

/**
 * Phase 4.5B monitor-experiment: one-shot snapshot of heartbeats, recent
 * logs, resources and waiting reasons (ARIS monitor-experiment
 * capability over IdeaSeek's own state). Advisory — exit 0 always.
 */

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[], timeoutMs = 60_000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli ${args.join(' ')} timed out`));
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

interface MonitorPayload {
  checkedAt: number;
  run: { runId: string; status: string; phase: string; blockReason: string | null } | null;
  workers: { workerId: string; ageSeconds: number }[];
  experiments: { specId: string; ageSeconds: number; step: number | null }[];
  logs: { path: string; ageSeconds: number; bytes: number }[];
  resources: { gpus: number } | null;
  waiting: { scope: string; reason: string }[];
}

describe('ideaseek monitor (heartbeat/log/resource/waiting snapshot)', () => {
  it('snapshots a fresh project without failing (exit 0)', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-mon-'));
    expect((await runCli(project, ['init'])).code).toBe(0);

    const shown = await runCli(project, ['monitor', '--json']);
    expect(shown.code, shown.stderr).toBe(0);
    const payload = JSON.parse(shown.stdout) as MonitorPayload;
    expect(payload.run).toBeNull();
    expect(payload.workers).toEqual([]);
    expect(payload.experiments).toEqual([]);
    expect(payload.waiting).toEqual([]);
    expect(Array.isArray(payload.logs)).toBe(true);

    const human = await runCli(project, ['monitor']);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('no run yet');
    expect(human.stdout).toContain('nothing waiting');
    expect(human.stdout).toContain('ideaseek watchdog');
  }, 120_000);

  it('reports waiting reasons, log paths and in-flight heartbeats', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-mon-rich-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    expect((await runCli(project, ['run', '--question', 'mon', '--enqueue-only'])).code).toBe(0);
    // pause → the run becomes a waiting reason (exit 0 for pause).
    expect((await runCli(project, ['pause'])).code).toBe(0);

    // A recent log file (paths only — contents stay behind `ideaseek logs`).
    await mkdir(join(project, '.research', 'logs'), { recursive: true });
    await writeFile(join(project, '.research', 'logs', 'idea-check-x.log'), 'log line\n', 'utf8');

    // An in-flight experiment heartbeat (registry still planned).
    const { openRuntime } = await import('./helpers.js');
    const rt = await openRuntime(project, { recover: false });
    try {
      const now = Date.now();
      await rt.db.upsertExperiment({
        specId: 'idea-mon-idea',
        version: 1,
        specHash: 'sha256:m',
        status: 'planned',
        spec: { specId: 'idea-mon-idea' },
        result: null,
        updatedAt: now,
      });
    } finally {
      await rt.close();
    }
    await mkdir(join(project, 'ideas', 'mon-idea', 'experiments'), { recursive: true });
    await writeFile(
      join(project, 'ideas', 'mon-idea', 'experiments', 'progress-idea-mon-idea.json'),
      JSON.stringify({
        specId: 'idea-mon-idea',
        recovery: 'task-level',
        policy: { kind: 'none' },
        heartbeat: { step: 42, epoch: 3, checkpointId: null, at: Date.now() },
        checkpoints: [],
        resumeHint: null,
        interrupt: null,
        updatedAt: Date.now(),
      }),
      'utf8',
    );

    const shown = await runCli(project, ['monitor', '--json']);
    expect(shown.code, shown.stderr).toBe(0);
    const payload = JSON.parse(shown.stdout) as MonitorPayload;
    expect(payload.run?.status).toBe('PAUSED');
    expect(
      payload.waiting.some((entry) => entry.scope === 'run' && entry.reason.includes('PAUSED')),
    ).toBe(true);
    expect(payload.logs.some((log) => log.path.includes('idea-check-x.log'))).toBe(true);
    const inFlight = payload.experiments.find((entry) => entry.specId === 'idea-mon-idea');
    expect(inFlight).toBeDefined();
    expect(inFlight!.step).toBe(42);
    expect(inFlight!.ageSeconds).toBeLessThan(60);

    const human = await runCli(project, ['monitor']);
    expect(human.stdout).toContain('waiting:');
    expect(human.stdout).toContain('PAUSED');
    expect(human.stdout).toContain('step 42');
  }, 180_000);
});
