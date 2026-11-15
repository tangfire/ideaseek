import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { arisSkillsRoot } from '../src/aris/skill.js';
import { FakeHarnessAdapter } from '../src/dsh/fake-adapter.js';
import type { CapacityProbe } from '../src/runtime/capacity.js';
import type { IdeaCard } from '../src/idea/card.js';
import { buildHandlers } from '../src/commands/shared.js';
import { FakeWorker } from '../src/worker/worker.js';
import { runExperimentBridge } from '../src/experiment/bridge.js';
import { CLI_BIN, implementIdeaSmoke, makeProjectDir, openRuntime } from './helpers.js';

/**
 * Phase 4.5 capability 2 conformance (docs/ARIS_AUDIT §conformance 必测路径):
 * the ARIS experiment-plan / experiment-bridge skills mapped onto IdeaSeek's
 * ExperimentSpec, RunResult, Artifact, RunEvent and checkpoint — success,
 * invalid output, cancel, quota exhaustion, checkpoint recovery and permission
 * denial, with IdeaSeek's budget ceiling, comparison gate, capacity planner
 * and smoke/quick execution scales intact.
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
  timeoutMs = 60_000,
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

function makeCard(ideaId: string): IdeaCard {
  return {
    ideaId,
    version: 1,
    parentVersion: null,
    status: 'CANDIDATE',
    hypothesis: {
      statement: 'reweighting by calibration error improves rare-class recall',
      targetProblem: 'FedAvg dilutes minority classes',
    },
    paperEvidence: [{ paperRef: 'fedavg-paper', statement: 'uniform averaging', evidence: 'p.5' }],
    contradictions: ['paper B reports no gain where paper A does'],
    novelty: {
      claim: 'calibration-error reweighting',
      uncertainty: 'may collapse with balanced clients',
      whyNotRestatement: 'measurable calibration signal instead of sample counts',
    },
    mechanismChain: {
      designPrincipleLink: 'inverts FedAvg weighting assumption',
      steps: [
        { kind: 'observation', text: 'skewed clients show high calibration error' },
        { kind: 'hypothesis', text: 'down-weighting them reduces dilution' },
        { kind: 'intervention', text: 'server weights by exp(-calibration error)' },
        { kind: 'expected-change', text: 'rare-class recall rises' },
        { kind: 'baseline-difference', text: 'vs sample-count weighting' },
        { kind: 'falsifier', text: 'no recall gain on 3 seeds' },
      ],
    },
    nearestComparisons: [{ methodId: 'fedavg', difference: 'weighting rule', evidence: 'p.3' }],
    componentNecessity: [
      { component: 'probe', role: 'necessary-mechanism', removeEffect: 'gain disappears' },
    ],
    competingExplanations: ['lower effective lr'],
    boundaryConditions: ['no benefit without skew'],
    risks: ['extra pass per round'],
    minimalExperiment: {
      code: 'src/train.py',
      data: 'data/synthetic.csv',
      baselines: ['fedavg'],
      metrics: ['rare-class recall'],
      ablations: ['no reweighting'],
    },
    falsification: { conditions: ['recall delta < 0 on 3 seeds'] },
    budget: { maxRounds: 3, maxGpuMinutes: 120 },
    stopConditions: ['budget exhausted'],
    createdAt: 1,
  } as IdeaCard;
}

/** Minimal contract-valid plan used as the base for guard overrides. */
function planOverride(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    problem: 'p',
    thesis: 't',
    claims: [{ claimId: 'c1', statement: 's', linkedBlocks: ['b1'] }],
    blocks: [
      {
        blockId: 'b1',
        name: 'n',
        claimTested: 'c1',
        priority: 'MUST-RUN',
        scale: 'smoke',
        dataScale: 'quick',
        metrics: [{ name: 'rare-class recall', direction: 'higher' }],
        successCriterion: 'ok',
        failureInterpretation: 'no',
      },
    ],
    runOrder: ['b1'],
    seeds: [42],
    budgetMinutes: 30,
    risks: [],
    ...overrides,
  });
}

interface PlanPayload {
  ideaId: string;
  reused: boolean;
  reason: string;
  inputHash: string;
  skill: { name: string; sha256: string };
  harness: string;
  scale: string | null;
  spec: { specId: string; version: number; specHash: string; scale: string } | null;
  blocks: number;
  mustRun: number;
  seeds: number[];
  budgetMinutes: number | null;
  eventSeq: number | null;
}

interface BridgePayload {
  ideaId: string;
  plan: {
    inputHash: string;
    ideaVersion: number;
    scale: string;
    specId: string;
    specVersion: number;
  };
  gate: { ok: boolean; blocking: { methodId: string }[] };
  admitted: boolean;
  queuedReason: string | null;
  specId: string | null;
  version: number | null;
  attempt: number | null;
  alreadyRecorded: boolean;
  resultStatus: string | null;
  metrics: { name: string; value: number }[];
  failure: { category: string; summary: string } | null;
  statusAfter: string | null;
  eventSeq: number | null;
}

async function countEvents(dir: string, eventType: string): Promise<number> {
  const events = await runCli(dir, ['events', '--json']);
  return events.stdout.split(`"${eventType}"`).length - 1;
}

async function setMode(dir: string, mode: string): Promise<void> {
  const yamlPath = join(dir, 'research.yaml');
  const raw = await readFile(yamlPath, 'utf8');
  await writeFile(
    yamlPath,
    raw.includes('autonomy_mode:')
      ? raw.replace(/autonomy_mode: \w[\w-]*/, `autonomy_mode: ${mode}`)
      : `${raw}autonomy_mode: ${mode}\n`,
    'utf8',
  );
}

describe('ARIS experiment-plan / experiment-bridge conformance (Phase 4.5)', () => {
  let dir: string;

  /** create → IMPLEMENTING → scaffold → check (passes → SMOKE_TESTED). */
  async function setupCheckedIdea(id = 'calib-reweight'): Promise<void> {
    const cardPath = join(dir, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard(id), null, 2), 'utf8');
    expect((await runCli(dir, ['idea', 'create', id, '--from-card', cardPath])).code).toBe(0);
    expect((await runCli(dir, ['idea', 'set-status', id, 'IMPLEMENTING'])).code).toBe(0);
    expect((await runCli(dir, ['idea', 'scaffold', id])).code).toBe(0);
    // A passed check needs code that computes something: the scaffold's own
    // smoke declares itself synthetic and is now refused, which is the point.
    await implementIdeaSmoke(dir, id, 'rare-class recall');
    const check = await runCli(dir, ['idea', 'check', id, '--json']);
    expect(check.code, check.stdout + check.stderr).toBe(0);
    expect((JSON.parse(check.stdout) as { outcome: string }).outcome).toBe('passed');
  }

  async function plan(id = 'calib-reweight', env: Record<string, string> = {}): Promise<CliResult> {
    return runCli(dir, ['experiment', 'plan', id, '--harness', 'fake', '--json'], env);
  }

  beforeEach(async () => {
    dir = await makeProjectDir();
    const init = await runCli(dir, ['init']);
    expect(init.code).toBe(0);
  }, 60_000);

  it('success: plan maps to a planned ExperimentSpec + Artifact + RunEvent', async () => {
    await setupCheckedIdea();
    const planned = await plan();
    expect(planned.code, planned.stdout + planned.stderr).toBe(0);
    const payload = JSON.parse(planned.stdout) as PlanPayload;
    expect(payload).toMatchObject({
      ideaId: 'calib-reweight',
      reused: false,
      reason: 'completed',
      scale: 'smoke',
      blocks: 2,
      mustRun: 1,
      budgetMinutes: 90,
      harness: 'fake',
      skill: { name: 'experiment-plan' },
    });
    expect(payload.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // ARIS DEFAULT_SEEDS flow into the spec contract.
    expect(payload.seeds).toEqual([42, 200, 201]);
    expect(payload.spec).toMatchObject({
      specId: 'idea-calib-reweight',
      version: 1,
      scale: 'smoke',
    });
    expect(payload.eventSeq).toBeGreaterThan(0);

    const shown = await runCli(dir, ['experiment', 'show', 'idea-calib-reweight', '--json']);
    expect(shown.code).toBe(0);
    const doc = JSON.parse(shown.stdout) as {
      status: string;
      result: unknown;
      spec: {
        idea: { ideaId: string; version: number };
        seeds: number[];
        environment: { notes: string[] };
        comparisonIds: string[];
      };
    };
    expect(doc.status).toBe('planned');
    expect(doc.result).toBeNull();
    expect(doc.spec.idea).toEqual({ ideaId: 'calib-reweight', version: 1 });
    expect(doc.spec.seeds).toEqual([42, 200, 201]);
    expect(doc.spec.environment.notes.join(' ')).toContain('scale:smoke');
    expect(doc.spec.comparisonIds).toEqual(['fedavg']);

    const events = await runCli(dir, ['events', '--json']);
    expect(events.stdout).toContain('"experiment_plan"');
    expect(events.stdout).toContain('ARIS experiment-plan');
  }, 120_000);

  it('idempotent: an unchanged plan is reused without a second event', async () => {
    await setupCheckedIdea();
    const first = await plan();
    expect(first.code).toBe(0);
    const firstPayload = JSON.parse(first.stdout) as PlanPayload;

    const second = await plan();
    expect(second.code).toBe(0);
    const secondPayload = JSON.parse(second.stdout) as PlanPayload;
    expect(secondPayload.reused).toBe(true);
    expect(secondPayload.inputHash).toBe(firstPayload.inputHash);
    expect(await countEvents(dir, 'experiment_plan')).toBe(1);
  }, 120_000);

  it('success: bridge executes the plan into a RunResult on the same spec version', async () => {
    await setupCheckedIdea();
    expect((await plan()).code).toBe(0);

    const bridged = await runCli(dir, ['experiment', 'bridge', 'calib-reweight', '--json']);
    expect(bridged.code, bridged.stdout + bridged.stderr).toBe(0);
    const payload = JSON.parse(bridged.stdout) as BridgePayload;
    expect(payload).toMatchObject({
      admitted: true,
      resultStatus: 'succeeded',
      statusAfter: 'ANALYZING',
      // Plan and execution hash the same spec — no version churn.
      version: 1,
      attempt: 1,
      alreadyRecorded: false,
      plan: { scale: 'smoke', ideaVersion: 1, specId: 'idea-calib-reweight' },
    });
    expect(payload.gate.ok).toBe(true);
    // 0.5 was the scaffold template's constant; the bridge now carries the
    // value the implemented smoke computed. Asserting the range keeps this
    // from becoming a second magic number to maintain.
    expect(payload.metrics).toHaveLength(1);
    expect(payload.metrics[0]!.name).toBe('rare-class recall');
    expect(payload.metrics[0]!.value).toBeGreaterThanOrEqual(0);
    expect(payload.metrics[0]!.value).toBeLessThanOrEqual(1);
    expect(payload.eventSeq).toBeGreaterThan(0);

    const shown = await runCli(dir, ['experiment', 'show', 'idea-calib-reweight', '--json']);
    const doc = JSON.parse(shown.stdout) as {
      status: string;
      result: { status: string; metrics: { name: string; value: number }[] } | null;
      spec: { seeds: number[] };
    };
    expect(doc.status).toBe('succeeded');
    expect(doc.result?.status).toBe('succeeded');
    expect(doc.spec.seeds).toEqual([42, 200, 201]);

    const status = await runCli(dir, ['idea', 'show', 'calib-reweight', '--json']);
    expect((JSON.parse(status.stdout) as { status: string }).status).toBe('ANALYZING');

    const events = await runCli(dir, ['events', '--json']);
    expect(events.stdout).toContain('"experiment_bridge"');
    expect(events.stdout).toContain('ARIS experiment-bridge');
  }, 180_000);

  it('failure: non-JSON or contract-violating plan output writes nothing', async () => {
    await setupCheckedIdea();

    const nonJson = await plan('calib-reweight', {
      IDEASEEK_FAKE_PLAN_OUTPUT: 'definitely not json',
    });
    expect(nonJson.code).toBe(1);
    expect(nonJson.stderr).toMatch(/PARSE_FAILED|non-JSON/);

    const invalid = await plan('calib-reweight', {
      IDEASEEK_FAKE_PLAN_OUTPUT: '{"blocks":[]}',
    });
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain('experiment plan invalid');

    const shown = await runCli(dir, ['experiment', 'show', 'idea-calib-reweight', '--json']);
    expect(shown.code).not.toBe(0); // spec never recorded
    expect(await countEvents(dir, 'experiment_plan')).toBe(0);
  }, 120_000);

  it('guards: budget ceiling and IdeaSeek scale vocabulary reject plan output', async () => {
    await setupCheckedIdea();

    const overBudget = await plan('calib-reweight', {
      IDEASEEK_FAKE_PLAN_OUTPUT: planOverride({ budgetMinutes: 99_999 }),
    });
    expect(overBudget.code).toBe(1);
    expect(overBudget.stderr).toContain('exceeds the idea card ceiling');

    const badScale = await plan('calib-reweight', {
      IDEASEEK_FAKE_PLAN_OUTPUT: planOverride({
        blocks: [
          {
            blockId: 'b1',
            name: 'n',
            claimTested: 'c1',
            priority: 'MUST-RUN',
            scale: 'full',
            dataScale: 'standard',
            metrics: [{ name: 'rare-class recall', direction: 'higher' }],
            successCriterion: 'ok',
            failureInterpretation: 'no',
          },
        ],
      }),
    });
    expect(badScale.code).toBe(1);
    expect(badScale.stderr).toContain('scale must be smoke | quick');

    const badDataScale = await plan('calib-reweight', {
      IDEASEEK_FAKE_PLAN_OUTPUT: planOverride({
        blocks: [
          {
            blockId: 'b1',
            name: 'n',
            claimTested: 'c1',
            priority: 'MUST-RUN',
            scale: 'smoke',
            dataScale: 'full',
            metrics: [{ name: 'rare-class recall', direction: 'higher' }],
            successCriterion: 'ok',
            failureInterpretation: 'no',
          },
        ],
      }),
    });
    expect(badDataScale.code).toBe(1);
    expect(badDataScale.stderr).toContain('dataScale must be smoke | quick | standard');

    const shown = await runCli(dir, ['experiment', 'show', 'idea-calib-reweight', '--json']);
    expect(shown.code).not.toBe(0);
    expect(await countEvents(dir, 'experiment_plan')).toBe(0);
  }, 120_000);

  it('quota: harness block parks the plan at exit 2, then the same command recovers', async () => {
    await setupCheckedIdea();

    // Text mode surfaces the recovery hint on stderr.
    const blocked = await runCli(
      dir,
      ['experiment', 'plan', 'calib-reweight', '--harness', 'fake'],
      { IDEASEEK_FAKE_BLOCK: 'QUOTA_EXHAUSTED' },
    );
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain('QUOTA_EXHAUSTED');
    expect(blocked.stderr).toContain('rerun');

    const status = await runCli(dir, ['status', '--json']);
    expect(status.stdout).toContain('QUOTA_EXHAUSTED');

    // No plan landed while blocked.
    const shownBlocked = await runCli(dir, ['experiment', 'show', 'idea-calib-reweight', '--json']);
    expect(shownBlocked.code).not.toBe(0);

    // Quota restored → the identical command plans successfully.
    const recovered = await plan();
    expect(recovered.code, recovered.stdout + recovered.stderr).toBe(0);
    const payload = JSON.parse(recovered.stdout) as PlanPayload;
    expect(payload).toMatchObject({ reused: false, reason: 'completed', scale: 'smoke' });
    expect(payload.seeds).toEqual([42, 200, 201]);
    expect(await countEvents(dir, 'experiment_plan')).toBe(1);
  }, 120_000);

  it('cancel: an in-flight plan task finalizes canceled with nothing written, then re-plans', async () => {
    const id = 'cancel-idea';
    const cardPath = join(dir, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard(id), null, 2), 'utf8');
    expect((await runCli(dir, ['idea', 'create', id, '--from-card', cardPath])).code).toBe(0);

    const harness = new FakeHarnessAdapter({ latencyMs: 800 });
    await harness.initialize();
    const runtime = await openRuntime(dir, { recover: false, harness });
    const run = await runtime.db.createRun({
      projectId: runtime.project.id,
      question: 'cancel test',
      config: runtime.config,
      strategy: 'starter',
    });
    await runtime.db.enqueueTask({
      runId: run.runId,
      type: 'experiment.plan',
      phase: 'DEMO',
      payload: { ideaId: id },
      idempotencyKey: 'experiment-plan:cancel-test',
      maxAttempts: 3,
    });

    const workerPromise = new FakeWorker({
      runtime,
      runId: run.runId,
      kind: 'test',
      handlers: buildHandlers(),
      leaseMs: 5_000,
      heartbeatMs: 100,
      pollMs: 10,
    }).run();

    // Wait until the handler is actually inside the slow harness call.
    const deadline = Date.now() + 5_000;
    for (;;) {
      const tasks = await runtime.db.listTasks(run.runId);
      if (tasks[0]?.status === 'running' || Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await runtime.db.cancelRun(run.runId);
    const exit = await workerPromise;
    expect(exit.reason).toBe('canceled');

    const task = (await runtime.db.listTasks(run.runId))[0]!;
    expect(task.status).toBe('canceled');
    expect(await runtime.db.listArtifactsByKind('experiment-plan')).toHaveLength(0);
    expect(await runtime.db.getExperiment(`idea-${id}`)).toBeNull();

    // Re-plan on a fresh run succeeds (cancel left no partial state).
    const run2 = await runtime.db.createRun({
      projectId: runtime.project.id,
      question: 'cancel test retry',
      config: runtime.config,
      strategy: 'starter',
    });
    await runtime.db.enqueueTask({
      runId: run2.runId,
      type: 'experiment.plan',
      phase: 'DEMO',
      payload: { ideaId: id },
      idempotencyKey: 'experiment-plan:cancel-test',
      maxAttempts: 3,
    });
    const retry = await new FakeWorker({
      runtime,
      runId: run2.runId,
      kind: 'test',
      handlers: buildHandlers(),
      leaseMs: 5_000,
      heartbeatMs: 100,
      pollMs: 10,
    }).run();
    expect(retry.reason).toBe('completed');
    expect(await runtime.db.listArtifactsByKind('experiment-plan')).toHaveLength(1);
    expect(await runtime.db.getExperiment(`idea-${id}`)).not.toBeNull();

    await runtime.close();
    await harness.shutdown();
  }, 120_000);

  it('checkpoint: bridge fails leaving a checkpoint, then --resume completes it', async () => {
    const id = 'ckpt-bridge';
    const cardPath = join(dir, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard(id), null, 2), 'utf8');
    expect((await runCli(dir, ['idea', 'create', id, '--from-card', cardPath])).code).toBe(0);
    expect((await runCli(dir, ['idea', 'set-status', id, 'IMPLEMENTING'])).code).toBe(0);
    expect((await runCli(dir, ['idea', 'scaffold', id])).code).toBe(0);

    // Checkpoint-aware entry: first experiment run saves a checkpoint then
    // crashes; a --resume-from run succeeds (same contract as checkpoint.test).
    const checkpointSmoke = `import json
import os
import sys

STATE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "state.txt")
ARGV_LOG = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "argv.log")

def main():
    with open(ARGV_LOG, "a", encoding="utf-8") as fh:
        fh.write(" ".join(sys.argv[1:]) + "\\n")
    state = ""
    if os.path.exists(STATE):
        with open(STATE, "r", encoding="utf-8") as fh:
            state = fh.read().strip()
    if "--resume-from" in sys.argv:
        print(json.dumps({"metrics": {"rare-class recall": 0.75}, "resumed": True}))
        return 0
    if state == "":
        with open(STATE, "w", encoding="utf-8") as fh:
            fh.write("checked")
        print(json.dumps({"metrics": {"rare-class recall": 0.5}}))
        return 0
    if state == "checked":
        print(json.dumps({"progress": {"step": 2, "checkpoint": "ckpt-1"}}))
        print(json.dumps({"checkpoint_saved": {"checkpointId": "ckpt-1", "step": 2, "files": [{"path": "model.pt"}]}}))
        sys.stderr.write("simulated crash after checkpoint\\n")
        return 1
    print(json.dumps({"metrics": {"rare-class recall": 0.6}}))
    return 0

if __name__ == "__main__":
    sys.exit(main())
`;
    const worktree = join(dir, 'ideas', id);
    await writeFile(join(worktree, 'src', 'smoke.py'), checkpointSmoke, 'utf8');
    const configPath = join(worktree, 'config', 'train.json');
    const cfg = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    cfg.checkpoint = { kind: 'steps', every: 5 };
    await writeFile(configPath, JSON.stringify(cfg, null, 2), 'utf8');

    const check = await runCli(dir, ['idea', 'check', id, '--json']);
    expect(check.code, check.stdout + check.stderr).toBe(0);
    expect((await plan(id)).code).toBe(0);

    const failed = await runCli(dir, ['experiment', 'bridge', id, '--json']);
    expect(failed.code).toBe(1);
    const failedPayload = JSON.parse(failed.stdout) as BridgePayload;
    expect(failedPayload).toMatchObject({ resultStatus: 'failed', statusAfter: 'RUNNING' });
    // Generic non-zero exit with no known signal — honestly 'unknown', not a
    // scientific hypothesis failure.
    expect(failedPayload.failure?.category).toBe('unknown');

    const progress = JSON.parse(
      await readFile(join(worktree, 'experiments', `progress-idea-${id}.json`), 'utf8'),
    ) as { recovery: string; resumeHint: { checkpointId: string; compatible: boolean } | null };
    expect(progress.recovery).toBe('checkpoint');
    expect(progress.resumeHint).toMatchObject({ checkpointId: 'ckpt-1', compatible: true });

    const resumed = await runCli(dir, ['experiment', 'bridge', id, '--resume', '--json']);
    expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
    const resumePayload = JSON.parse(resumed.stdout) as BridgePayload;
    expect(resumePayload).toMatchObject({
      resultStatus: 'succeeded',
      statusAfter: 'ANALYZING',
      version: 2, // retry attempt bumps the spec version
    });
    const argvLog = await readFile(join(worktree, 'argv.log'), 'utf8');
    expect(argvLog).toContain('--resume-from ckpt-1');

    // The plan was not regenerated by the bridge.
    expect(await countEvents(dir, 'experiment_plan')).toBe(1);
  }, 240_000);

  it('permission: review-only refuses the bridge while planning stays analysis', async () => {
    await setupCheckedIdea();
    await setMode(dir, 'review-only');

    // Planning is analysis: allowed under review-only.
    const planned = await plan();
    expect(planned.code, planned.stdout + planned.stderr).toBe(0);

    const bridged = await runCli(dir, ['experiment', 'bridge', 'calib-reweight', '--json']);
    expect(bridged.code).toBe(2);
    expect(bridged.stderr).toContain('review-only');
    expect(bridged.stderr).toContain('start-experiment');

    const shown = await runCli(dir, ['experiment', 'show', 'idea-calib-reweight', '--json']);
    expect((JSON.parse(shown.stdout) as { status: string }).status).toBe('planned');
    expect(await countEvents(dir, 'experiment_bridge')).toBe(0);
  }, 120_000);

  it('integrity: a tampered experiment-plan skill is refused before any run or task', async () => {
    await setupCheckedIdea();
    const copyRoot = await mkdtemp(join(tmpdir(), 'aris-plan-tamper-'));
    await cp(arisSkillsRoot(), copyRoot, { recursive: true });
    const skillFile = join(copyRoot, 'skills', 'experiment-plan', 'SKILL.md');
    await writeFile(skillFile, `${await readFile(skillFile, 'utf8')}\n<!-- tampered -->\n`, 'utf8');

    const failed = await plan('calib-reweight', { IDEASEEK_ARIS_SKILLS: copyRoot });
    expect(failed.code).toBe(2);
    expect(failed.stderr).toContain('SKILL_TAMPERED');

    const shown = await runCli(dir, ['experiment', 'show', 'idea-calib-reweight', '--json']);
    expect(shown.code).not.toBe(0);
    expect(await countEvents(dir, 'experiment_plan')).toBe(0);
  }, 120_000);

  it('gates: bridge refuses without a plan and when the comparison gate blocks', async () => {
    await setupCheckedIdea();

    // No plan yet → the bridge refuses and points at the plan command.
    const noPlan = await runCli(dir, ['experiment', 'bridge', 'calib-reweight', '--json']);
    expect(noPlan.code).not.toBe(0);
    expect(noPlan.stderr).toContain('experiment plan');

    expect((await plan()).code).toBe(0);

    // A required comparison without a runnable result blocks the bridge
    // (the skill path cannot bypass the required-comparison gate).
    const blocking = await openRuntime(dir, { recover: false });
    await blocking.db.upsertComparison({
      methodId: 'fedavg',
      status: 'implemented',
      required: true,
      record: {},
      updatedAt: Date.now(),
    });
    await blocking.close();

    const gated = await runCli(dir, ['experiment', 'bridge', 'calib-reweight', '--json']);
    expect(gated.code).toBe(2);
    expect(gated.stderr).toContain('comparison gate');
    expect(gated.stderr).toContain('fedavg');
    const gatedShown = await runCli(dir, ['experiment', 'show', 'idea-calib-reweight', '--json']);
    expect((JSON.parse(gatedShown.stdout) as { status: string }).status).toBe('planned');

    // Once the method is runnable, the bridge proceeds.
    const fixed = await openRuntime(dir, { recover: false });
    await fixed.db.upsertComparison({
      methodId: 'fedavg',
      status: 'smoke-tested',
      required: true,
      record: {},
      updatedAt: Date.now(),
    });
    await fixed.close();

    const bridged = await runCli(dir, ['experiment', 'bridge', 'calib-reweight', '--json']);
    expect(bridged.code, bridged.stdout + bridged.stderr).toBe(0);
    const payload = JSON.parse(bridged.stdout) as BridgePayload;
    expect(payload).toMatchObject({
      admitted: true,
      resultStatus: 'succeeded',
      gate: { ok: true },
    });
  }, 180_000);

  it('staleness: a revised idea must re-plan before the bridge runs again', async () => {
    await setupCheckedIdea();
    expect((await plan()).code).toBe(0);

    expect(
      (
        await runCli(dir, [
          'idea',
          'set-status',
          'calib-reweight',
          'NEEDS_REVISION',
          '--reason',
          'stronger estimator',
        ])
      ).code,
    ).toBe(0);
    expect((await runCli(dir, ['idea', 'set-status', 'calib-reweight', 'IMPLEMENTING'])).code).toBe(
      0,
    );
    const revised = await runCli(dir, [
      'idea',
      'revise',
      'calib-reweight',
      '--kind',
      'engineering',
      '--summary',
      'stronger estimator',
      '--json',
    ]);
    expect(revised.code).toBe(0);

    const stale = await runCli(dir, ['experiment', 'bridge', 'calib-reweight', '--json']);
    expect(stale.code).not.toBe(0);
    expect(stale.stderr).toContain('stale');

    // Re-check + re-plan at v2 unblocks the bridge.
    const recheck = await runCli(dir, ['idea', 'check', 'calib-reweight', '--json']);
    expect(recheck.code, recheck.stdout + recheck.stderr).toBe(0);
    const replanned = await plan();
    expect(replanned.code, replanned.stdout + replanned.stderr).toBe(0);
    const replannedPayload = JSON.parse(replanned.stdout) as PlanPayload;
    expect(replannedPayload.spec?.version).toBe(2);

    const bridged = await runCli(dir, ['experiment', 'bridge', 'calib-reweight', '--json']);
    expect(bridged.code, bridged.stdout + bridged.stderr).toBe(0);
    const payload = JSON.parse(bridged.stdout) as BridgePayload;
    expect(payload).toMatchObject({
      resultStatus: 'succeeded',
      version: 2,
      plan: { ideaVersion: 2, specVersion: 2 },
    });
  }, 240_000);

  it('capacity: a GPU request with no visible GPU is queued, never executed', async () => {
    const id = 'gpu-queue';
    const cardPath = join(dir, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard(id), null, 2), 'utf8');
    expect((await runCli(dir, ['idea', 'create', id, '--from-card', cardPath])).code).toBe(0);
    expect((await runCli(dir, ['idea', 'scaffold', id])).code).toBe(0);
    expect((await plan(id)).code).toBe(0);

    // Ask for a GPU the probe cannot see → admission must queue, not run.
    const configPath = join(dir, 'ideas', id, 'config', 'train.json');
    const cfg = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    cfg.resources = { gpus: 1, memoryGiB: 4 };
    await writeFile(configPath, JSON.stringify(cfg, null, 2), 'utf8');

    const probe: CapacityProbe = {
      gpus: [],
      cpuCores: 8,
      freeMemGiB: 32,
      diskFreeGiB: 100,
      nvidiaSmiAvailable: false,
      probedAt: Date.now(),
    };
    const runtime = await openRuntime(dir, { recover: false });
    try {
      const result = await runExperimentBridge(
        dir,
        id,
        { timeoutMs: 120_000, probeOverride: probe },
        runtime,
      );
      expect(result.admitted).toBe(false);
      expect(result.queuedReason).toContain('GPU');
      expect(result.outcome).toBeNull();
      expect(result.eventSeq).toBeNull();
      // Nothing executed: the spec is still planned.
      const doc = await runtime.db.getExperiment(`idea-${id}`);
      expect(doc?.status).toBe('planned');
      expect(doc?.result).toBeNull();
    } finally {
      await runtime.close();
    }
  }, 120_000);
});
