import { access, appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import type { IdeaCard } from '../src/idea/card.js';
import { loadWorkspaceMeta } from '../src/idea/workspace.js';
import { compareMetrics, formatReproduce, type ReproduceOutcome } from '../src/idea/reproduce.js';
import { CLI_BIN, implementIdeaSmoke, makeProjectDir, openRuntime } from './helpers.js';

/**
 * Result reproduction (design review #13): re-execute a RECORDED experiment
 * and compare metrics against the record. What these tests pin down is the
 * honesty contract — the recorded spec's command runs against inputs the
 * drift gate proved unchanged, verdicts are never coerced (missing metric =
 * incomplete, beyond tolerance = diverged), and verification writes NOTHING
 * to the registry or the idea lifecycle: the recorded result must be the
 * same object before and after a reproduce run.
 */

function makeCard(ideaId: string): IdeaCard {
  return {
    ideaId,
    version: 1,
    parentVersion: null,
    status: 'CANDIDATE',
    hypothesis: { statement: `hypothesis for ${ideaId}`, targetProblem: 't' },
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
    nearestComparisons: [{ methodId: 'fedavg', difference: 'd', evidence: 'e' }],
    componentNecessity: [{ component: 'c', role: 'necessary-mechanism', removeEffect: 'r' }],
    competingExplanations: ['x'],
    boundaryConditions: ['x'],
    risks: ['x'],
    minimalExperiment: {
      code: 'src/train.py',
      data: 'd',
      baselines: ['fedavg'],
      metrics: ['m'],
      ablations: ['a'],
    },
    falsification: { conditions: ['f'] },
    budget: { maxRounds: 1, maxGpuMinutes: 10 },
    stopConditions: ['s'],
    createdAt: 1,
  } as IdeaCard;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(
  cwd: string,
  args: string[],
  opts: { timeoutMs?: number; extraEnv?: Record<string, string> } = {},
): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1', ...opts.extraEnv },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli ${args.join(' ')} timed out; stderr=${stderr}`));
    }, opts.timeoutMs ?? 120_000);
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * The knob smoke reads a config key buildIdeaSpec never carries into the
 * spec (metrics/seeds/command stay identical), so changing it passes the
 * drift gate while changing what the entry prints — a divergence the
 * platform must detect rather than paper over.
 */
const KNOB_SMOKE = `import json
import os

CFG = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "config",
    "train.json",
)

def main():
    with open(CFG, encoding="utf-8") as fh:
        cfg = json.load(fh)
    print(json.dumps({"metrics": {"m": float(cfg.get("verify_knob", 0.5))}}))

if __name__ == "__main__":
    main()
`;

describe('ideaseek idea reproduce', () => {
  let project: string;

  beforeEach(async () => {
    project = await makeProjectDir();
  });

  /** create → IMPLEMENTING → scaffold → smoke entry → check (→ SMOKE_TESTED). */
  async function makeReady(
    id: string,
    prepare?: (projectRoot: string) => Promise<void>,
  ): Promise<void> {
    const cardPath = join(project, `${id}.json`);
    await writeFile(cardPath, JSON.stringify(makeCard(id)), 'utf8');
    expect((await runCli(project, ['idea', 'create', id, '--from-card', cardPath])).code).toBe(0);
    expect((await runCli(project, ['idea', 'set-status', id, 'IMPLEMENTING'])).code).toBe(0);
    expect((await runCli(project, ['idea', 'scaffold', id])).code).toBe(0);
    if (prepare) {
      await prepare(project);
    } else {
      await implementIdeaSmoke(project, id);
    }
    const check = await runCli(project, ['idea', 'check', id, '--json']);
    expect(check.code, check.stdout + check.stderr).toBe(0);
  }

  async function record(id: string): Promise<void> {
    const run = await runCli(project, ['idea', 'experiment', id, '--json']);
    expect(run.code, run.stdout + run.stderr).toBe(0);
  }

  /** Registry doc + lifecycle meta, read without running recovery. */
  async function snapshot(id: string): Promise<{ doc: unknown; status: string; version: number }> {
    const runtime = await openRuntime(project, { recover: false });
    try {
      const doc = await runtime.db.getExperiment(`idea-${id}`);
      const meta = await loadWorkspaceMeta(project, id);
      return { doc, status: meta.status, version: meta.currentVersion };
    } finally {
      await runtime.close();
    }
  }

  async function exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  it('reproduces a recorded result exactly and records nothing', async () => {
    await makeReady('alpha-idea');
    await record('alpha-idea');
    const before = await snapshot('alpha-idea');

    const json = await runCli(project, ['idea', 'reproduce', 'alpha-idea', '--json']);
    expect(json.code, json.stdout + json.stderr).toBe(0);
    const payload = JSON.parse(json.stdout) as ReproduceOutcome;
    expect(payload).toMatchObject({
      ideaId: 'alpha-idea',
      specId: 'idea-alpha-idea',
      version: 1,
      scale: 'smoke', // readable only from environment.notes — proves specScaleOf
      verdict: 'stable',
      tolerance: 0,
      codeVerified: true,
      failure: null,
      logRef: '.research/logs/idea-alpha-idea-reproduce.log',
      reportPath: 'ideas/alpha-idea/experiments/reproduce-report.json',
    });
    expect(payload.recorded).toEqual([{ name: 'm', value: 0.87 }]);
    expect(payload.fresh).toEqual([{ name: 'm', value: 0.87 }]);
    expect(payload.comparisons).toEqual([
      { name: 'm', recorded: 0.87, fresh: 0.87, delta: 0, withinTolerance: true },
    ]);

    // Honesty: verification writes nothing to the registry or lifecycle.
    const after = await snapshot('alpha-idea');
    expect(after.doc).toEqual(before.doc);
    expect(after.status).toBe(before.status);
    expect(after.version).toBe(before.version);

    // Report + distinct log exist.
    const report = JSON.parse(
      await readFile(
        join(project, 'ideas', 'alpha-idea', 'experiments', 'reproduce-report.json'),
        'utf8',
      ),
    ) as { contract: string; verdict: string; logRef: string };
    expect(report.contract).toBe('idea-reproduce-report-v1');
    expect(report.verdict).toBe('stable');
    expect(report.logRef).toBe(payload.logRef);
    expect(await exists(join(project, '.research', 'logs', 'idea-alpha-idea-reproduce.log'))).toBe(
      true,
    );

    // Human output path.
    const human = await runCli(project, ['idea', 'reproduce', 'alpha-idea']);
    expect(human.code, human.stdout + human.stderr).toBe(0);
    expect(human.stdout).toContain('STABLE');
    expect(human.stdout).toContain('0.8700');
    expect(human.stdout).toContain('log: .research/logs/idea-alpha-idea-reproduce.log');
  }, 240_000);

  it('refuses before executing when the source changed after recording', async () => {
    await makeReady('drift-idea');
    await record('drift-idea');
    await appendFile(join(project, 'ideas', 'drift-idea', 'src', 'smoke.py'), '\n# drifted\n');

    const run = await runCli(project, ['idea', 'reproduce', 'drift-idea']);
    expect(run.code, run.stdout + run.stderr).toBe(1); // INVALID_STATE → task failed
    expect(run.stderr).toContain('[INVALID_STATE]');
    expect(run.stderr).toContain('code');
    // Refused BEFORE execution: no log, no report.
    expect(await exists(join(project, '.research', 'logs', 'idea-drift-idea-reproduce.log'))).toBe(
      false,
    );
    expect(
      await exists(join(project, 'ideas', 'drift-idea', 'experiments', 'reproduce-report.json')),
    ).toBe(false);
  }, 240_000);

  it('refuses when the seeds changed after recording', async () => {
    await makeReady('seeds-idea');
    await record('seeds-idea');
    const cfgPath = join(project, 'ideas', 'seeds-idea', 'config', 'train.json');
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as Record<string, unknown>;
    cfg.seeds = [43];
    await writeFile(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');

    const run = await runCli(project, ['idea', 'reproduce', 'seeds-idea']);
    expect(run.code, run.stdout + run.stderr).toBe(1);
    expect(run.stderr).toContain('[INVALID_STATE]');
    expect(run.stderr).toContain('seeds');
    expect(
      await exists(join(project, 'ideas', 'seeds-idea', 'experiments', 'reproduce-report.json')),
    ).toBe(false);
  }, 240_000);

  it('detects divergence through an out-of-spec knob; --tolerance recovers', async () => {
    await makeReady('knob-idea', async (root) => {
      await writeFile(join(root, 'ideas', 'knob-idea', 'src', 'smoke.py'), KNOB_SMOKE, 'utf8');
    });
    await record('knob-idea'); // knob absent → prints 0.5

    // The knob is not an input the spec carries: metrics/seeds/command/code
    // are untouched, so the drift gate passes and the divergence is real.
    const cfgPath = join(project, 'ideas', 'knob-idea', 'config', 'train.json');
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as Record<string, unknown>;
    cfg.verify_knob = 0.9;
    await writeFile(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');

    const diverged = await runCli(project, ['idea', 'reproduce', 'knob-idea', '--json']);
    expect(diverged.code, diverged.stdout + diverged.stderr).toBe(2);
    const payload = JSON.parse(diverged.stdout) as ReproduceOutcome;
    expect(payload.verdict).toBe('diverged');
    expect(payload.comparisons[0]).toMatchObject({
      recorded: 0.5,
      fresh: 0.9,
      withinTolerance: false,
    });
    expect(payload.comparisons[0]!.delta).toBeCloseTo(0.4, 10);

    const tolerant = await runCli(project, [
      'idea',
      'reproduce',
      'knob-idea',
      '--tolerance',
      '0.5',
      '--json',
    ]);
    expect(tolerant.code, tolerant.stdout + tolerant.stderr).toBe(0);
    expect((JSON.parse(tolerant.stdout) as ReproduceOutcome).verdict).toBe('stable');
  }, 240_000);

  it('reports a failed re-run as failed, never as agreement', async () => {
    await makeReady('fail-idea');
    await record('fail-idea');

    const run = await runCli(project, ['idea', 'reproduce', 'fail-idea', '--json'], {
      extraEnv: { IDEASEEK_FORCE_RUN_FAILURE: 'environment:1' },
    });
    expect(run.code, run.stdout + run.stderr).toBe(2);
    const payload = JSON.parse(run.stdout) as ReproduceOutcome;
    expect(payload.verdict).toBe('failed');
    expect(payload.failure).toContain('forced environment failure');
    expect(payload.comparisons).toEqual([]);
    // The failure still leaves its evidence behind.
    expect(
      await exists(join(project, 'ideas', 'fail-idea', 'experiments', 'reproduce-report.json')),
    ).toBe(true);
  }, 240_000);

  it('refuses without a recorded result and points at the recording command', async () => {
    await makeReady('fresh-idea');
    const run = await runCli(project, ['idea', 'reproduce', 'fresh-idea']);
    expect(run.code, run.stdout + run.stderr).toBe(1); // DEPENDENCY_NOT_MET
    expect(run.stderr).toContain('[DEPENDENCY_NOT_MET]');
    expect(run.stderr).toContain('ideaseek idea experiment fresh-idea');
  }, 240_000);
});

describe('compareMetrics', () => {
  it('exact match within tolerance 0 is stable', () => {
    const { verdict, comparisons } = compareMetrics(
      [{ name: 'm', value: 0.87 }],
      [{ name: 'm', value: 0.87 }],
      0,
    );
    expect(verdict).toBe('stable');
    expect(comparisons[0]).toEqual({
      name: 'm',
      recorded: 0.87,
      fresh: 0.87,
      delta: 0,
      withinTolerance: true,
    });
  });

  it('a delta inside the tolerance (inclusive) stays stable', () => {
    const { verdict } = compareMetrics(
      [{ name: 'acc', value: 1 }],
      [{ name: 'acc', value: 1.04 }],
      0.05,
    );
    expect(verdict).toBe('stable');
  });

  it('a beyond-tolerance delta diverges', () => {
    const { verdict, comparisons } = compareMetrics(
      [{ name: 'm', value: 0.5 }],
      [{ name: 'm', value: 0.9 }],
      0,
    );
    expect(verdict).toBe('diverged');
    expect(comparisons[0]!.withinTolerance).toBe(false);
  });

  it('a missing metric is incomplete even when the others diverge', () => {
    const { verdict, comparisons } = compareMetrics(
      [
        { name: 'acc', value: 0.9 },
        { name: 'f1', value: 0.8 },
      ],
      [{ name: 'acc', value: 0.99 }], // diverged AND f1 missing → incomplete wins
      0,
    );
    expect(verdict).toBe('incomplete');
    expect(comparisons.find((c) => c.name === 'f1')?.fresh).toBeNull();
    expect(comparisons.find((c) => c.name === 'acc')?.withinTolerance).toBe(false);
  });

  it('an empty recorded set is incomplete, never a vacuous pass', () => {
    expect(compareMetrics([], [], 0).verdict).toBe('incomplete');
  });
});

describe('formatReproduce', () => {
  const base: ReproduceOutcome = {
    ideaId: 'alpha-idea',
    specId: 'idea-alpha-idea',
    version: 1,
    scale: 'smoke',
    verdict: 'stable',
    tolerance: 0,
    codeVerified: true,
    recorded: [{ name: 'm', value: 0.87 }],
    fresh: [{ name: 'm', value: 0.87 }],
    comparisons: [{ name: 'm', recorded: 0.87, fresh: 0.87, delta: 0, withinTolerance: true }],
    failure: null,
    logRef: '.research/logs/idea-alpha-idea-reproduce.log',
    reportPath: 'ideas/alpha-idea/experiments/reproduce-report.json',
    at: 1,
  };

  it('stable format shows the verdict, delta mark, log and report, no next', () => {
    const text = formatReproduce(base);
    expect(text).toContain('STABLE');
    expect(text).toContain('Δ+0.0000 ✓');
    expect(text).toContain('log: .research/logs/idea-alpha-idea-reproduce.log');
    expect(text).toContain('report: ideas/alpha-idea/experiments/reproduce-report.json');
    expect(text).not.toContain('next:');
  });

  it('diverged format marks the outlier and offers the re-record step', () => {
    const text = formatReproduce({
      ...base,
      verdict: 'diverged',
      tolerance: 0.1,
      recorded: [{ name: 'm', value: 0.5 }],
      fresh: [{ name: 'm', value: 0.9 }],
      comparisons: [{ name: 'm', recorded: 0.5, fresh: 0.9, delta: 0.4, withinTolerance: false }],
    });
    expect(text).toContain('DIVERGED');
    expect(text).toContain('Δ+0.4000 ✗');
    expect(text).toContain(
      'next: inspect the log, then re-record: ideaseek idea experiment alpha-idea',
    );
  });

  it('incomplete format names the missing metric; failed shows the failure', () => {
    const incomplete = formatReproduce({
      ...base,
      verdict: 'incomplete',
      comparisons: [
        { name: 'f1', recorded: 0.8, fresh: null, delta: null, withinTolerance: false },
      ],
    });
    expect(incomplete).toContain('INCOMPLETE');
    expect(incomplete).toContain('not produced by the re-run: f1');

    const failed = formatReproduce({ ...base, verdict: 'failed', failure: 'cuda OOM' });
    expect(failed).toContain('FAILED — cuda OOM');
    expect(failed).toContain('next: fix the failure above, then retry');
  });

  it('warns when the recorded result carries no code provenance', () => {
    expect(formatReproduce({ ...base, codeVerified: false })).toContain('no code provenance');
  });
});
