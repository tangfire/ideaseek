import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_BIN } from './helpers.js';
import { HarnessBlockError, isHarnessBlockError } from '../src/dsh/adapter.js';
import { FakeHarnessAdapter } from '../src/dsh/fake-adapter.js';
import type { ProjectRuntime } from '../src/workflow/runtime.js';
import type { RunRecord } from '../src/workflow/types.js';
import { FakeWorker } from '../src/worker/worker.js';
import { buildHandlers } from '../src/commands/shared.js';
import { makeProjectDir, openRuntime } from './helpers.js';

const PAPER = `# Attention Is All You Need

We propose the Transformer, a network architecture based solely on
attention mechanisms, dispensing with recurrence and convolutions.
`;

describe('FakeHarnessAdapter contract', () => {
  it('refuses to run before initialize', async () => {
    const harness = new FakeHarnessAdapter();
    await expect(
      harness.runTask({
        runId: 'run-x',
        taskId: 'task-x',
        profile: 'paper-extractor',
        instruction: 'extract',
        inputs: [{ kind: 'text', name: 'a', content: 'x' }],
        outputSchema: 'papercard-lite-v1',
        budget: { timeoutMs: 1000 },
        idempotencyKey: 'k1',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('returns structured output, counts idempotent calls and reports health', async () => {
    const harness = new FakeHarnessAdapter();
    await harness.initialize();
    const events: string[] = [];
    const result = await harness.runTask(
      {
        runId: 'run-x',
        taskId: 'task-x',
        profile: 'paper-extractor',
        instruction: 'extract',
        inputs: [{ kind: 'text', name: 'a', content: 'hello' }],
        outputSchema: 'papercard-lite-v1',
        budget: { timeoutMs: 1000 },
        idempotencyKey: 'k1',
      },
      (event) => events.push(event.type),
    );
    expect(JSON.parse(result.output)).toMatchObject({ schema: 'papercard-lite-v1', call: 1 });
    expect(result.runtime.kind).toBe('fake');
    expect(events).toEqual(['started', 'completed']);
    expect(harness.callCount('k1')).toBe(1);

    const health = await harness.health();
    expect(health.reachable).toBe(true);
    expect(health.models[0]!.available).toBe(true);
    await harness.shutdown();
  });

  it('raises typed block errors for external conditions', async () => {
    const harness = new FakeHarnessAdapter({ block: 'QUOTA_EXHAUSTED', blockTimes: 1 });
    await harness.initialize();
    const request = {
      runId: 'run-x',
      taskId: 'task-x',
      profile: 'paper-extractor' as const,
      instruction: 'extract',
      inputs: [{ kind: 'text' as const, name: 'a', content: 'x' }],
      outputSchema: 'papercard-lite-v1',
      budget: { timeoutMs: 1000 },
      idempotencyKey: 'k2',
    };
    await expect(harness.runTask(request)).rejects.toBeInstanceOf(HarnessBlockError);
    // Second call with the same idempotency key succeeds after the block window.
    const result = await harness.runTask(request);
    expect(result.runId).toBe('run-x');
    expect(harness.callCount('k2')).toBe(2);
    try {
      const authHarness = new FakeHarnessAdapter({ block: 'AUTH_REQUIRED', blockTimes: 1 });
      await authHarness.initialize();
      await authHarness.runTask({ ...request, idempotencyKey: 'k3' });
      throw new Error('expected HarnessBlockError');
    } catch (error) {
      expect(isHarnessBlockError(error)).toBe(true);
      expect((error as HarnessBlockError).block).toBe('AUTH_REQUIRED');
    }
  });
});

describe('paper.extract workflow task (fake Paper Extractor end to end)', () => {
  let dir: string;
  let harness: FakeHarnessAdapter;

  beforeEach(async () => {
    dir = await makeProjectDir();
    harness = new FakeHarnessAdapter();
    await harness.initialize();
  });

  afterEach(async () => {
    await harness.shutdown();
  });

  async function openWithHarness(): Promise<ProjectRuntime> {
    return openRuntime(dir, { recover: false, harness });
  }

  async function enqueueExtract(runtime: ProjectRuntime): Promise<RunRecord> {
    const run = await runtime.db.createRun({
      projectId: runtime.project.id,
      question: 'extract test',
      config: runtime.config,
      strategy: 'starter',
    });
    await runtime.db.enqueueTask({
      runId: run.runId,
      type: 'paper.extract',
      phase: 'DEMO',
      payload: { paperName: 'attention.pdf', paperText: PAPER },
      idempotencyKey: 'paper.extract:v1',
      maxAttempts: 3,
    });
    return run;
  }

  it('executes the extractor and commits a structured papercard artifact', async () => {
    const runtime = await openWithHarness();
    const run = await enqueueExtract(runtime);

    const exit = await new FakeWorker({
      runtime,
      runId: run.runId,
      kind: 'test',
      handlers: buildHandlers(),
      leaseMs: 5_000,
      heartbeatMs: 100,
      pollMs: 10,
    }).run();
    expect(exit.reason).toBe('completed');

    const tasks = await runtime.db.listTasks(run.runId);
    const task = tasks.find((item) => item.type === 'paper.extract')!;
    expect(task.status).toBe('succeeded');
    expect(task.result?.summary).toContain('extracted structured card');

    const artifacts = await runtime.db.listArtifacts(task.taskId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.kind).toBe('papercard');
    const card = JSON.parse(await runtime.store.readFinalText(artifacts[0]!.contentHash)) as {
      source: { paperName: string; inputBytes: number };
      harness: { kind: string; version: string };
      model: string;
      card: { schema: string; profile: string };
    };
    expect(card.source.paperName).toBe('attention.pdf');
    expect(card.source.inputBytes).toBe(Buffer.byteLength(PAPER, 'utf8'));
    expect(card.harness.kind).toBe('fake');
    expect(card.card.schema).toBe('papercard-lite-v1');
    expect(card.card.profile).toBe('paper-extractor');
    await runtime.close();
  });

  it('quota block parks the run without burning attempts; continue resumes', async () => {
    const blocking = new FakeHarnessAdapter({ block: 'QUOTA_EXHAUSTED', blockTimes: 1 });
    await blocking.initialize();
    const runtime = await openRuntime(dir, { recover: false, harness: blocking });
    const run = await enqueueExtract(runtime);

    const first = await new FakeWorker({
      runtime,
      runId: run.runId,
      kind: 'test',
      handlers: buildHandlers(),
      leaseMs: 5_000,
      heartbeatMs: 100,
      pollMs: 10,
    }).run();
    expect(first.reason).toBe('blocked');
    const blockedRun = await runtime.db.getRun(run.runId);
    expect(blockedRun?.status).toBe('QUOTA_EXHAUSTED');
    const parked = (await runtime.db.listTasks(run.runId))[0]!;
    expect(parked.status).toBe('queued');
    expect(parked.attempt).toBe(0); // external block must not burn an attempt

    await runtime.db.continueRun(run.runId);
    const second = await new FakeWorker({
      runtime,
      runId: run.runId,
      kind: 'test',
      handlers: buildHandlers(),
      leaseMs: 5_000,
      heartbeatMs: 100,
      pollMs: 10,
    }).run();
    expect(second.reason).toBe('completed');
    expect(blocking.callCount('paper-extract:' + run.runId + ':' + parked.taskId)).toBe(2);

    // The successful artifact exists exactly once.
    const done = (await runtime.db.listTasks(run.runId))[0]!;
    expect(done.status).toBe('succeeded');
    expect(done.attempt).toBe(1);
    await runtime.close();
    await blocking.shutdown();
  });

  it('missing paperText fails permanently instead of retrying forever', async () => {
    const runtime = await openWithHarness();
    const run = await runtime.db.createRun({
      projectId: runtime.project.id,
      question: 'bad input',
      config: runtime.config,
    });
    await runtime.db.enqueueTask({
      runId: run.runId,
      type: 'paper.extract',
      phase: 'DEMO',
      payload: { paperName: 'empty.pdf', paperText: '   ' },
      idempotencyKey: 'paper.extract:v1',
      maxAttempts: 3,
    });
    const exit = await new FakeWorker({
      runtime,
      runId: run.runId,
      kind: 'test',
      handlers: buildHandlers(),
      leaseMs: 5_000,
      heartbeatMs: 100,
      pollMs: 10,
    }).run();
    expect(exit.reason).toBe('failed');
    const task = (await runtime.db.listTasks(run.runId))[0]!;
    expect(task.status).toBe('failed');
    expect(task.attempt).toBe(1); // permanent error: no retries burned
    expect(task.error?.code).toBe('USER_INPUT_REQUIRED');
    await runtime.close();
  });

  it('fails clearly when no harness adapter is configured', async () => {
    const runtime = await openRuntime(dir, { recover: false }); // no harness
    const run = await enqueueExtract(runtime);
    const exit = await new FakeWorker({
      runtime,
      runId: run.runId,
      kind: 'test',
      handlers: buildHandlers(),
      leaseMs: 5_000,
      heartbeatMs: 100,
      pollMs: 10,
    }).run();
    expect(exit.reason).toBe('failed');
    const task = (await runtime.db.listTasks(run.runId))[0]!;
    expect(task.error?.code).toBe('INVALID_STATE');
    await runtime.close();
  });
});

describe('CLI: run --paper (Phase 1 end to end)', () => {
  function runCli(
    cwd: string,
    args: string[],
    timeoutMs = 20_000,
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

  it('runs the demo pipeline plus a fake paper extraction to completion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-paper-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);
    const paperPath = join(dir, 'incoming', 'attention.txt');
    const { writeFile: wf, mkdir: md } = await import('node:fs/promises');
    await md(join(dir, 'incoming'), { recursive: true });
    await wf(paperPath, '# Attention Is All You Need\n\nA transformer uses attention only.\n');

    const run = await runCli(dir, [
      'run',
      '--question',
      'paper test',
      '--paper',
      paperPath,
      '--json',
    ]);
    expect(run.code).toBe(0);
    const payload = JSON.parse(run.stdout) as { status: string; tasks: Record<string, number> };
    expect(payload.status).toBe('COMPLETED');
    expect(payload.tasks.succeeded).toBe(4);

    const events = await runCli(dir, ['events', '--json']);
    const stream = JSON.parse(events.stdout) as {
      events: { eventType: string; summary: string }[];
    };
    expect(stream.events.some((event) => event.summary.includes('papercard committed'))).toBe(true);
    expect(stream.events.some((event) => event.summary.includes('paper.extract succeeded'))).toBe(
      true,
    );

    const status = await runCli(dir, ['status', '--detail']);
    expect(status.stdout).toContain('paper.extract');
    expect(status.stdout).toContain('策略：starter');
  }, 40_000);

  it('rejects a missing --paper file and an unwired dsh harness', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-paper-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);

    const missing = await runCli(dir, ['run', '--question', 'x', '--paper', 'nope.txt', '--json']);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('cannot read --paper file');

    const dsh = await runCli(dir, ['run', '--question', 'x', '--harness', 'dsh', '--json']);
    expect(dsh.code).toBe(2);
    expect(dsh.stderr).toContain('--harness fake');
  }, 30_000);
});
