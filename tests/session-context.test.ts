import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IdeaCard } from '../src/idea/card.js';
import { CLI_BIN } from './helpers.js';

/**
 * Phase 4.5B session recovery: cross-session context summary (previous
 * session fate, run state, last events, approvals, artifact/idea
 * references) rebuilt purely from persisted state (ADR-002).
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

function startRepl(cwd: string): {
  write(data: string): void;
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<string>;
  quit(): Promise<{ code: number; stdout: string }>;
} {
  const child = spawn(process.execPath, [CLI_BIN, 'interactive'], {
    cwd,
    env: { ...process.env, IDEASEEK_CLI: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += String(chunk)));
  child.stderr.on('data', (chunk) => (stdout += String(chunk)));
  child.stdin.on('error', () => {});
  const waitFor = (pattern: RegExp, timeoutMs = 20_000): Promise<string> =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (pattern.test(stdout)) {
          clearInterval(timer);
          resolve(stdout);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`timeout waiting for ${pattern}; output:\n${stdout}`));
        }
      }, 80);
    });
  const quit = (): Promise<{ code: number; stdout: string }> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('repl did not exit'));
      }, 20_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout });
      });
      child.stdin.write('/quit\n');
      setTimeout(() => child.stdin.end(), 1_500);
    });
  return { write: (d) => child.stdin.write(d), waitFor, quit };
}

interface ContextPayload {
  previousSession: {
    pid: number;
    startedAt: number;
    endedAt?: number;
    endedCleanly: boolean | null;
  } | null;
  sessionMode: string;
  run: { runId: string; status: string } | null;
  lastEvents: { seq: number; type: string; summary: string }[];
  pendingApprovals: number;
  artifacts: { kind: string; hash: string }[];
  ideas: { ideaId: string; plan: string | null; novelty: string | null; review: string | null }[];
}

function makeCard(ideaId: string): IdeaCard {
  return {
    ideaId,
    version: 1,
    parentVersion: null,
    status: 'CANDIDATE',
    hypothesis: { statement: 's statement that is long enough', targetProblem: 't' },
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

describe('ideaseek context (cross-session recovery)', () => {
  it('reports an empty context on a fresh project', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-ctx-'));
    expect((await runCli(project, ['init'])).code).toBe(0);

    const shown = await runCli(project, ['context', '--json']);
    expect(shown.code, shown.stderr).toBe(0);
    const payload = JSON.parse(shown.stdout) as ContextPayload;
    expect(payload.previousSession).toBeNull();
    expect(payload.sessionMode).toBe('research');
    expect(payload.run).toBeNull();
    expect(payload.pendingApprovals).toBe(0);

    const human = await runCli(project, ['context']);
    expect(human.stdout).toContain('no previous session recorded');
    expect(human.stdout).toContain('no run yet');
  }, 120_000);

  it('records a REPL session and reports it as cleanly ended next time', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-ctx-repl-'));
    expect((await runCli(project, ['init'])).code).toBe(0);

    const repl = startRepl(project);
    await repl.waitFor(/ideaseek ›/);
    const done = await repl.quit();
    expect(done.code).toBe(0);

    const shown = await runCli(project, ['context', '--json']);
    expect(shown.code).toBe(0);
    const payload = JSON.parse(shown.stdout) as ContextPayload;
    expect(payload.previousSession).not.toBeNull();
    expect(payload.previousSession!.endedCleanly).toBe(true);
    expect(payload.previousSession!.endedAt).toBeGreaterThan(0);

    // A second REPL start shows the marker line from the first session.
    const second = startRepl(project);
    await second.waitFor(/last session: pid \d+/);
    await second.waitFor(/clean exit/);
    const bye = await second.quit();
    expect(bye.code).toBe(0);
  }, 180_000);

  it('summarizes run, approvals, events and idea references', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-ctx-rich-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    expect((await runCli(project, ['run', '--question', 'ctx', '--enqueue-only'])).code).toBe(0);
    expect((await runCli(project, ['decision', 'propose', 'raise', 'budget'])).code).toBe(0);

    const cardPath = join(project, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard('ctx-idea')), 'utf8');
    expect(
      (await runCli(project, ['idea', 'create', 'ctx-idea', '--from-card', cardPath])).code,
    ).toBe(0);
    expect((await runCli(project, ['idea', 'plan', 'ctx-idea', '--harness', 'fake'])).code).toBe(0);

    const shown = await runCli(project, ['context', '--json']);
    expect(shown.code, shown.stderr).toBe(0);
    const payload = JSON.parse(shown.stdout) as ContextPayload;
    expect(payload.run?.status).toBeTruthy();
    expect(payload.pendingApprovals).toBe(1);
    expect(payload.lastEvents.some((event) => event.type === 'decision')).toBe(true);
    expect(payload.lastEvents[0]!.seq).toBeGreaterThan(0);
    expect(payload.ideas).toHaveLength(1);
    expect(payload.ideas[0]!.plan).toMatch(/^sha256:/);
  }, 180_000);

  it('flags a previous session that never ended as crashed', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-ctx-crash-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    await writeFile(
      join(project, '.research', 'last-session.json'),
      JSON.stringify({ pid: 4194303, startedAt: Date.now() - 60_000 }),
      'utf8',
    );

    const shown = await runCli(project, ['context', '--json']);
    expect(shown.code).toBe(0);
    const payload = JSON.parse(shown.stdout) as ContextPayload;
    expect(payload.previousSession!.endedCleanly).toBe(false);

    const human = await runCli(project, ['context']);
    expect(human.stdout).toContain('CRASHED/INTERRUPTED');
    expect(human.stdout).toContain('never ended');
  }, 120_000);
});
