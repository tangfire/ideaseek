import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IdeaCard } from '../src/idea/card.js';
import { CLI_BIN, openRuntime, implementIdeaSmoke } from './helpers.js';

/**
 * Phase 4.5B experiment-queue: dependency waves + waitingOn, stale
 * queued cleanup on terminal runs, the embedded capacity admission plan
 * (fair ordering, no second scheduler) and the one-shot resource(OOM)
 * auto-retry at the experiment level.
 */

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 180_000,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1', ...env },
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

interface QueuePayload {
  runId: string | null;
  runStatus: string | null;
  terminal: boolean;
  waves: {
    wave: number;
    tasks: { taskId: string; type: string; status: string; waitingOn: string[] }[];
  }[];
  staleQueued: { taskId: string }[];
  admission: {
    parallelLimit: number;
    admitted: unknown[];
    queued: unknown[];
    constraints: string[];
  } | null;
}

function makeCard(ideaId: string): IdeaCard {
  return {
    ideaId,
    version: 1,
    parentVersion: null,
    status: 'CANDIDATE',
    hypothesis: { statement: 's', targetProblem: 't' },
    paperEvidence: [{ paperRef: 'p', statement: 's', evidence: 'e' }],
    contradictions: ['c'],
    novelty: { claim: 'c', uncertainty: 'u', whyNotRestatement: 'w' },
    mechanismChain: {
      designPrincipleLink: 'l',
      steps: [
        { kind: 'observation', text: 'a' },
        { kind: 'hypothesis', text: 'b' },
        { kind: 'intervention', text: 'c' },
        { kind: 'expected-change', text: 'd' },
        { kind: 'baseline-difference', text: 'e' },
        { kind: 'falsifier', text: 'f' },
      ],
    },
    nearestComparisons: [{ methodId: 'm', difference: 'd', evidence: 'e' }],
    componentNecessity: [{ component: 'c', role: 'necessary-mechanism', removeEffect: 'r' }],
    competingExplanations: ['x'],
    boundaryConditions: ['x'],
    risks: ['x'],
    minimalExperiment: {
      code: 'src/train.py',
      data: 'd',
      baselines: ['b'],
      metrics: ['m'],
      ablations: ['a'],
    },
    falsification: { conditions: ['f'] },
    budget: { maxRounds: 1, maxGpuMinutes: 10 },
    stopConditions: ['s'],
    createdAt: 1,
  } as IdeaCard;
}

describe('ideaseek queue (waves, stale cleanup, admission, resource retry)', () => {
  it('layers queued tasks into dependency waves with waitingOn', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-queue-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    expect((await runCli(project, ['run', '--question', 'queue', '--enqueue-only'])).code).toBe(0);

    const rt = await openRuntime(project, { recover: false });
    try {
      const run = await rt.db.getLatestRun(rt.project.id);
      const tasks = await rt.db.listTasks(run!.runId);
      const root = tasks.find((task) => task.status === 'queued')!;
      await rt.db.enqueueTask({
        runId: run!.runId,
        type: 'demo.dependent',
        idempotencyKey: 'queue-dep-1',
        payload: {},
        dependsOn: [root.taskId],
      });
    } finally {
      await rt.close();
    }

    const shown = await runCli(project, ['queue', '--json']);
    expect(shown.code, shown.stderr).toBe(0);
    const payload = JSON.parse(shown.stdout) as QueuePayload;
    expect(payload.waves.length).toBeGreaterThanOrEqual(2);
    const wave1 = payload.waves.find((wave) => wave.wave === 0)!;
    const wave2 = payload.waves.find((wave) => wave.wave === 1)!;
    expect(wave2.tasks.some((task) => task.type === 'demo.dependent')).toBe(true);
    const dependent = wave2.tasks.find((task) => task.type === 'demo.dependent')!;
    expect(dependent.waitingOn.length).toBeGreaterThan(0);
    expect(wave1.tasks.every((task) => task.waitingOn.length === 0)).toBe(true);
    // Fairness preview is embedded (advisory; may be empty on a fresh project).
    expect(payload.admission).not.toBeNull();
    expect(payload.admission!.parallelLimit).toBeGreaterThanOrEqual(1);

    const human = await runCli(project, ['queue']);
    expect(human.stdout).toContain('wave 1');
    expect(human.stdout).toContain('waiting on:');
  }, 180_000);

  it('detects and cleans stale queued tasks on a terminal run', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-queue-stale-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    expect((await runCli(project, ['run', '--question', 'stale', '--enqueue-only'])).code).toBe(0);
    // cancel intentionally exits 4 (CLI_SPEC canceled code).
    expect((await runCli(project, ['cancel'])).code).toBe(4);

    // Re-queue AFTER the terminal state — the leftover stale scenario.
    const rt = await openRuntime(project, { recover: false });
    try {
      const run = await rt.db.getLatestRun(rt.project.id);
      await rt.db.enqueueTask({
        runId: run!.runId,
        type: 'demo.stale',
        idempotencyKey: 'stale-1',
        payload: {},
      });
    } finally {
      await rt.close();
    }

    const shown = await runCli(project, ['queue', '--json']);
    expect(shown.code).toBe(2);
    const payload = JSON.parse(shown.stdout) as QueuePayload;
    expect(payload.terminal).toBe(true);
    expect(payload.staleQueued).toHaveLength(1);

    const cleaned = await runCli(project, ['queue', '--cleanup', '--json']);
    expect(cleaned.code, cleaned.stderr).toBe(0);
    expect((JSON.parse(cleaned.stdout) as { cleaned: number }).cleaned).toBe(1);

    const after = await runCli(project, ['queue', '--json']);
    expect(after.code).toBe(0);
    expect((JSON.parse(after.stdout) as QueuePayload).staleQueued).toHaveLength(0);

    const events = await runCli(project, ['events', '--json']);
    expect(events.stdout).toContain('cleaned up from terminal run');

    // Non-terminal runs refuse cleanup (cancel first).
    const fresh = await mkdtemp(join(tmpdir(), 'ideaseek-queue-active-'));
    expect((await runCli(fresh, ['init'])).code).toBe(0);
    expect((await runCli(fresh, ['run', '--question', 'x', '--enqueue-only'])).code).toBe(0);
    const refused = await runCli(fresh, ['queue', '--cleanup']);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('cancel it instead');
  }, 240_000);

  it('auto-retries a resource failure once through the normal path', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-queue-oom-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    const cardPath = join(project, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard('oom-idea'), null, 2), 'utf8');
    expect(
      (await runCli(project, ['idea', 'create', 'oom-idea', '--from-card', cardPath])).code,
    ).toBe(0);
    expect((await runCli(project, ['idea', 'set-status', 'oom-idea', 'IMPLEMENTING'])).code).toBe(
      0,
    );
    expect((await runCli(project, ['idea', 'scaffold', 'oom-idea'])).code).toBe(0);
    // The scaffold's smoke declares itself synthetic, which `idea check`
    // now refuses; a fixture that needs a passed check must compute.
    await implementIdeaSmoke(project, 'oom-idea');
    const check = await runCli(project, ['idea', 'check', 'oom-idea', '--json']);
    expect(check.code, check.stdout + check.stderr).toBe(0);

    // Force a resource failure on attempt 1 only; the retry runs for real.
    const retried = await runCli(project, ['idea', 'experiment', 'oom-idea', '--json'], {
      IDEASEEK_FORCE_RUN_FAILURE: 'resource:1',
    });
    expect(retried.code, retried.stdout + retried.stderr).toBe(0);
    const payload = JSON.parse(retried.stdout) as {
      attempt: number;
      resultStatus: string;
      failure: { category: string } | null;
    };
    expect(payload.attempt).toBe(2);
    expect(payload.resultStatus).toBe('succeeded');

    // History keeps BOTH versions: v1 failed resource, v2 succeeded.
    const doc = await runCli(project, ['experiment', 'show', 'idea-oom-idea', '--json']);
    const parsed = JSON.parse(doc.stdout) as {
      version: number;
      result: { status: string } | null;
    };
    expect(parsed.version).toBe(2);
    expect(parsed.result?.status).toBe('succeeded');
    const v1 = JSON.parse(
      await readFile(
        join(project, 'ideas', 'oom-idea', 'experiments', 'idea-oom-idea-v1.json'),
        'utf8',
      ),
    ) as { result: { status: string; failure?: { category: string } } | null };
    expect(v1.result?.status).toBe('failed');
    expect(v1.result?.failure?.category).toBe('resource');
  }, 300_000);

  it('caps the resource retry at one attempt', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-queue-oom2-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    const cardPath = join(project, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard('oom2-idea'), null, 2), 'utf8');
    expect(
      (await runCli(project, ['idea', 'create', 'oom2-idea', '--from-card', cardPath])).code,
    ).toBe(0);
    expect((await runCli(project, ['idea', 'set-status', 'oom2-idea', 'IMPLEMENTING'])).code).toBe(
      0,
    );
    expect((await runCli(project, ['idea', 'scaffold', 'oom2-idea'])).code).toBe(0);
    // The scaffold's smoke declares itself synthetic, which `idea check`
    // now refuses; a fixture that needs a passed check must compute.
    await implementIdeaSmoke(project, 'oom2-idea');
    const check = await runCli(project, ['idea', 'check', 'oom2-idea', '--json']);
    expect(check.code, check.stdout + check.stderr).toBe(0);

    // Force resource failures on BOTH attempts → exactly one retry, then stop.
    const failed = await runCli(project, ['idea', 'experiment', 'oom2-idea', '--json'], {
      IDEASEEK_FORCE_RUN_FAILURE: 'resource:99',
    });
    expect(failed.code).toBe(1); // recorded failure, no infinite loop
    const payload = JSON.parse(failed.stdout) as {
      attempt: number;
      resultStatus: string;
      failure: { category: string } | null;
    };
    expect(payload.attempt).toBe(2);
    expect(payload.resultStatus).toBe('failed');
    expect(payload.failure?.category).toBe('resource');
  }, 300_000);
});
