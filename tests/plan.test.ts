import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CLI_BIN } from './helpers.js';

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

describe('ideaseek plan (dry-run)', () => {
  it('reports inputs, gate, ideas, resources, estimates and approvals without starting anything', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-plan-'));
    const init = await runCli(project, ['init']);
    expect(init.code).toBe(0);

    const plan = await runCli(project, ['plan', '--question', 'soak the plan command', '--json']);
    expect(plan.code, plan.stdout + plan.stderr).toBe(0);
    const payload = JSON.parse(plan.stdout) as {
      question: string;
      questionPersisted: boolean;
      startedNothing: boolean;
      inputs: { manifestFiles: number; indexedPapers: number };
      comparisons: { gateOk: boolean; blocking: unknown[] };
      ideas: { total: number; readyForExperiment: number; limit: number };
      slices: { total: number };
      model: { route: string; credentialsPresent: boolean };
      resources: { cpuCores: number; maxParallelIdeas: number };
      estimates: { label: string; estimate: boolean; basis: string }[];
      approvalNodes: { node: string; state: string }[];
      blockers: string[];
      run: unknown;
    };

    expect(payload.startedNothing).toBe(true);
    expect(payload.question).toBe('soak the plan command');
    expect(payload.questionPersisted).toBe(false);
    expect(payload.run).toBeNull();
    expect(payload.ideas).toMatchObject({ total: 0, readyForExperiment: 0, limit: 1 });
    expect(payload.comparisons.gateOk).toBe(true); // no required methods yet
    expect(payload.model.route).toBeTruthy();
    expect(payload.resources.cpuCores).toBeGreaterThan(0);

    // Estimates are labeled with their basis; ceilings are not estimates.
    const tokenEstimate = payload.estimates.find((e) => e.label === 'paper-extraction-tokens')!;
    expect(tokenEstimate.estimate).toBe(true);
    expect(tokenEstimate.basis).toContain('heuristic');
    const ceiling = payload.estimates.find((e) => e.label === 'model-cost-ceiling')!;
    expect(ceiling.estimate).toBe(false);

    // Guided approval nodes are listed; protocol is the first pending gate.
    const nodes = payload.approvalNodes.map((n) => n.node);
    expect(nodes).toContain('protocol-lock');
    expect(nodes).toContain('handoff-delivery');
    expect(payload.blockers.join(' ')).toContain('protocol');

    // Dry-run guarantee: no run was created by planning.
    const status = await runCli(project, ['status', '--json']);
    const statusPayload = JSON.parse(status.stdout) as { run: unknown };
    expect(statusPayload.run).toBeNull();
  }, 60_000);

  it('includes existing-run progress with --run without starting a second run', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-plan-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    const enqueued = await runCli(project, ['run', '--question', 'plan run', '--enqueue-only']);
    expect(enqueued.code).toBe(0);
    // enqueue-only output is plain text; read the run id from status instead.
    const statusBefore = await runCli(project, ['status', '--json']);
    const before = JSON.parse(statusBefore.stdout) as { run: { runId: string } };

    const plan = await runCli(project, ['plan', '--run', before.run.runId, '--json']);
    expect(plan.code, plan.stdout + plan.stderr).toBe(0);
    const payload = JSON.parse(plan.stdout) as {
      run: { runId: string; remaining: number; status: string } | null;
      startedNothing: boolean;
    };
    expect(payload.startedNothing).toBe(true);
    expect(payload.run?.runId).toBe(before.run.runId);
    expect(payload.run!.remaining).toBeGreaterThan(0);

    // Same single run afterwards — plan never starts or duplicates runs.
    const statusAfter = await runCli(project, ['status', '--json']);
    const after = JSON.parse(statusAfter.stdout) as { run: { runId: string } };
    expect(after.run.runId).toBe(before.run.runId);
  }, 60_000);

  it('refuses outside a project', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'ideaseek-plan-out-'));
    const plan = await runCli(outside, ['plan']);
    expect(plan.code).not.toBe(0);
    expect(plan.stderr).toContain('NOT_INITIALIZED');
  }, 30_000);
});
