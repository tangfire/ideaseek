import { mkdtemp, writeFile } from 'node:fs/promises';
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

/** init → enqueue-only run → worker executes the demo pipeline once. */
async function projectWithCompletedTask(): Promise<{
  project: string;
  taskId: string;
  artifactId: string;
  decisionSeq: number;
}> {
  const project = await mkdtemp(join(tmpdir(), 'ideaseek-explain-'));
  expect((await runCli(project, ['init'])).code).toBe(0);
  const run = await runCli(project, ['run', '--question', 'explain e2e', '--enqueue-only']);
  expect(run.code).toBe(0);
  const worker = await runCli(project, ['worker']);
  expect(worker.code).toBe(0);

  const eventsOut = await runCli(project, ['events', '--json']);
  const eventsPayload = JSON.parse(eventsOut.stdout) as {
    events: { seq: number; eventType: string; objectId: string | null }[];
  };
  const succeeded = eventsPayload.events.find((event) => event.eventType === 'task_succeeded');
  expect(succeeded, 'task_succeeded event must exist after a full worker run').toBeTruthy();
  const taskId = succeeded!.objectId!;
  expect(taskId).toBeTruthy();

  const taskJson = await runCli(project, ['explain', 'task', taskId, '--json']);
  expect(taskJson.code).toBe(0);
  const taskPayload = JSON.parse(taskJson.stdout) as {
    artifacts: { artifactId: string }[];
  };
  const artifactId = taskPayload.artifacts[0]!.artifactId;

  // A real decision via the guided exclusion flow (needs --confirm).
  const reg = await runCli(project, ['comparison', 'register', 'fedavg']);
  expect(reg.code).toBe(0);
  const excluded = await runCli(project, [
    'comparison',
    'set-status',
    'fedavg',
    'excluded',
    '--reason',
    'not needed for explain e2e',
    '--confirm',
    '--json',
  ]);
  expect(excluded.code, excluded.stderr).toBe(0);
  const decisionSeq = (JSON.parse(excluded.stdout) as { decisionSeq: number }).decisionSeq;
  expect(decisionSeq).toBeGreaterThan(0);

  return { project, taskId, artifactId, decisionSeq };
}

describe('ideaseek explain', () => {
  it('explains a task: run context, artifacts, events and provenance rules', async () => {
    const { project, taskId } = await projectWithCompletedTask();

    const plain = await runCli(project, ['explain', 'task', taskId]);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain(`task ${taskId}`);
    expect(plain.stdout).toContain('artifacts:');
    expect(plain.stdout).toContain('events:');
    expect(plain.stdout).toContain('produced by:');
    expect(plain.stdout).toContain('rule: task states');

    const json = await runCli(project, ['explain', 'task', taskId, '--json']);
    expect(json.code).toBe(0);
    const payload = JSON.parse(json.stdout) as {
      status: string;
      attempt: string;
      run: { runId: string } | null;
      artifacts: { contentHash: string }[];
      events: { type: string }[];
    };
    expect(payload.status).toBe('succeeded');
    expect(payload.attempt).toMatch(/^1\//);
    expect(payload.run?.runId).toBeTruthy();
    expect(payload.artifacts[0]!.contentHash).toMatch(/^sha256:/);
    expect(payload.events.length).toBeGreaterThan(0);

    const ghost = await runCli(project, ['explain', 'task', 'task-ghost']);
    expect(ghost.code).not.toBe(0);
    expect(ghost.stderr).toContain('not found');
  }, 120_000);

  it('explains a decision event with its run binding', async () => {
    const { project, decisionSeq } = await projectWithCompletedTask();

    const plain = await runCli(project, ['explain', 'decision', String(decisionSeq)]);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain(`decision #${decisionSeq}`);
    expect(plain.stdout).toContain('change-required-comparison: fedavg');
    expect(plain.stdout).toContain('role=user');
    expect(plain.stdout).toContain('cannot be silently rewritten');

    const json = await runCli(project, ['explain', 'decision', String(decisionSeq), '--json']);
    expect(json.code).toBe(0);
    const payload = JSON.parse(json.stdout) as {
      seq: number;
      status: string;
      summary: string;
      run: { status: string };
    };
    expect(payload.seq).toBe(decisionSeq);
    expect(payload.status).toBe('confirmed');
    expect(payload.run.status).toBeTruthy();

    const bad = await runCli(project, ['explain', 'decision', 'not-a-seq']);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain('event seq');

    const ghost = await runCli(project, ['explain', 'decision', '999999']);
    expect(ghost.code).not.toBe(0);
    expect(ghost.stderr).toContain('not found');
  }, 120_000);

  it('explains an artifact with verified integrity and detects tampering', async () => {
    const { project, artifactId } = await projectWithCompletedTask();

    const plain = await runCli(project, ['explain', 'artifact', artifactId]);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain('integrity: verified');
    expect(plain.stdout).toContain('provenance:');
    expect(plain.stdout).toContain('two-phase artifact store');

    const json = await runCli(project, ['explain', 'artifact', artifactId, '--json']);
    expect(json.code).toBe(0);
    const payload = JSON.parse(json.stdout) as {
      integrity: string;
      contentHash: string;
      task: { taskId: string } | null;
    };
    expect(payload.integrity).toBe('verified');
    expect(payload.contentHash).toMatch(/^sha256:/);
    expect(payload.task?.taskId).toBeTruthy();

    // Tamper with the content-addressed bytes → integrity must fail loudly.
    const runtime = await openRuntime(project);
    let tamperedPath: string;
    try {
      const artifact = await runtime.db.getArtifact(artifactId);
      tamperedPath = runtime.store.resolvePath(artifact!.contentHash);
    } finally {
      await runtime.close();
    }
    await writeFile(tamperedPath, 'tampered-bytes-for-explain-test', 'utf8');
    const broken = await runCli(project, ['explain', 'artifact', artifactId, '--json']);
    expect(broken.code).toBe(1);
    expect((JSON.parse(broken.stdout) as { integrity: string }).integrity).toBe('mismatch');

    const ghost = await runCli(project, ['explain', 'artifact', 'art-ghost']);
    expect(ghost.code).not.toBe(0);
    expect(ghost.stderr).toContain('not found');

    const usage = await runCli(project, ['explain', 'banana', 'x']);
    expect(usage.code).not.toBe(0);
    expect(usage.stderr).toContain('task|decision|artifact');
  }, 120_000);
});
