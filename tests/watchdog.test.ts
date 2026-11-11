import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IdeaCard } from '../src/idea/card.js';
import { CLI_BIN, openRuntime } from './helpers.js';

/**
 * Phase 4.5B watchdog: one-shot stalled/dead/stale detection over
 * supervisor, worker heartbeats and experiment progress — detection
 * only, no quality verdicts (ARIS watchdog contract).
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

interface WatchdogPayload {
  checkedAt: number;
  healthy: boolean;
  findings: { scope: string; target: string; state: string; detail: string }[];
  checked: { workers: number; experiments: number; supervisor: boolean; lock: boolean };
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

async function deadPid(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    child.on('close', () => resolve(child.pid ?? 4194303));
  });
}

describe('ideaseek watchdog (stalled/dead/stale detection)', () => {
  it('reports healthy on a fresh project (exit 0)', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-wd-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    const shown = await runCli(project, ['watchdog', '--json']);
    expect(shown.code, shown.stderr).toBe(0);
    const payload = JSON.parse(shown.stdout) as WatchdogPayload;
    expect(payload.healthy).toBe(true);
    expect(payload.findings).toHaveLength(0);

    const human = await runCli(project, ['watchdog']);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('healthy');
  }, 120_000);

  it('flags an active worker whose heartbeat went stale (exit 2)', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-wd-worker-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    const yamlPath = join(project, 'research.yaml');
    const yaml = await readFile(yamlPath, 'utf8');
    await writeFile(
      yamlPath,
      yaml.replace('lease_ttl_seconds: 30', 'lease_ttl_seconds: 1'),
      'utf8',
    );

    expect((await runCli(project, ['run', '--question', 'wd', '--enqueue-only'])).code).toBe(0);
    const rt = await openRuntime(project, { recover: false });
    try {
      const run = await rt.db.getLatestRun(rt.project.id);
      await rt.db.registerWorker({
        workerId: 'wd-stale',
        runId: run!.runId,
        pid: 4194303,
        kind: 'test',
      });
    } finally {
      await rt.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 3_400)); // > 3× TTL (3s)

    const shown = await runCli(project, ['watchdog', '--json']);
    expect(shown.code).toBe(2);
    const payload = JSON.parse(shown.stdout) as WatchdogPayload;
    expect(payload.healthy).toBe(false);
    const finding = payload.findings.find((entry) => entry.scope === 'worker');
    expect(finding?.state).toBe('stale');
    expect(finding?.target).toContain('wd-stale');
    expect(payload.checked.workers).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('flags a supervisor whose pid is gone (dead)', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-wd-daemon-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    const pid = await deadPid();
    const { writeDaemonInfo } = await import('../src/runtime/daemon.js');
    writeDaemonInfo(join(project, '.research'), {
      runId: 'run-x',
      pid,
      startedAt: Date.now() - 60_000,
      heartbeatAt: Date.now() - 60_000,
      logPath: 'log',
      version: 'test',
    });

    const shown = await runCli(project, ['watchdog', '--json']);
    expect(shown.code).toBe(2);
    const payload = JSON.parse(shown.stdout) as WatchdogPayload;
    const finding = payload.findings.find((entry) => entry.scope === 'supervisor');
    expect(finding?.state).toBe('dead');
    expect(finding?.target).toContain(String(pid));
  }, 120_000);

  it('flags a stalled experiment progress heartbeat but ignores finished ones', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-wd-exp-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    const cardPath = join(project, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard('wd-idea'), null, 2), 'utf8');
    expect(
      (await runCli(project, ['idea', 'create', 'wd-idea', '--from-card', cardPath])).code,
    ).toBe(0);

    const rt = await openRuntime(project, { recover: false });
    try {
      const now = Date.now();
      const old = now - 30 * 60_000;
      const expDir = join(project, 'ideas', 'wd-idea', 'experiments');
      const writeProgress = async (specId: string): Promise<void> => {
        await writeFile(
          join(expDir, `progress-${specId}.json`),
          JSON.stringify({
            specId,
            recovery: 'task-level',
            policy: { kind: 'none' },
            heartbeat: { step: 1, epoch: null, checkpointId: null, at: old },
            checkpoints: [],
            resumeHint: null,
            interrupt: null,
            updatedAt: old,
          }),
          'utf8',
        );
      };
      await writeProgress('idea-wd-idea');
      await writeProgress('idea-wd-idea-finished');
      await rt.db.upsertExperiment({
        specId: 'idea-wd-idea',
        version: 1,
        specHash: 'sha256:1',
        status: 'planned',
        spec: { specId: 'idea-wd-idea' },
        result: null,
        updatedAt: old,
      });
      await rt.db.upsertExperiment({
        specId: 'idea-wd-idea-finished',
        version: 1,
        specHash: 'sha256:2',
        status: 'succeeded',
        spec: { specId: 'idea-wd-idea-finished' },
        result: { status: 'succeeded' },
        updatedAt: old,
      });
    } finally {
      await rt.close();
    }

    const shown = await runCli(project, ['watchdog', '--json']);
    expect(shown.code).toBe(2);
    const payload = JSON.parse(shown.stdout) as WatchdogPayload;
    const stalled = payload.findings.filter((entry) => entry.scope === 'experiment');
    expect(stalled).toHaveLength(1);
    expect(stalled[0]!.target).toBe('idea-wd-idea');
    expect(stalled[0]!.state).toBe('stalled');
    expect(payload.checked.experiments).toBe(2);
  }, 180_000);
});
