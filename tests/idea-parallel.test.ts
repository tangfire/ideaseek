import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import type { IdeaCard } from '../src/idea/card.js';
import { CLI_BIN, implementIdeaSmoke } from './helpers.js';

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

function runCli(cwd: string, args: string[], timeoutMs = 90_000): Promise<CliResult> {
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

describe('ideaseek idea run-ready (multi-idea parallel)', () => {
  let project: string;

  /** create → IMPLEMENTING → scaffold → check (→ SMOKE_TESTED). */
  async function makeReady(id: string, smokeSleepMs = 0): Promise<void> {
    const cardPath = join(project, `${id}.json`);
    await writeFile(cardPath, JSON.stringify(makeCard(id)), 'utf8');
    expect((await runCli(project, ['idea', 'create', id, '--from-card', cardPath])).code).toBe(0);
    expect((await runCli(project, ['idea', 'set-status', id, 'IMPLEMENTING'])).code).toBe(0);
    expect((await runCli(project, ['idea', 'scaffold', id])).code).toBe(0);
    // The scaffold's smoke declares itself synthetic, which `idea check`
    // now refuses; a fixture that needs a passed check must compute.
    await implementIdeaSmoke(project, id);
    if (smokeSleepMs > 0) {
      // The delay goes in BEFORE the check: the ladder binds the report to the
      // source hash, so editing the entry afterwards would (rightly) invalidate
      // the verification rather than just slow the run down.
      const path = join(project, 'ideas', id, 'src', 'smoke.py');
      const body = await readFile(path, 'utf8');
      await writeFile(
        path,
        body.replace(
          'import json',
          `import json\nimport time\n\ntime.sleep(${smokeSleepMs / 1000})`,
        ),
        'utf8',
      );
    }
    const check = await runCli(project, ['idea', 'check', id, '--json']);
    expect(check.code, check.stdout + check.stderr).toBe(0);
    // The scaffold's 1 GiB admission reservation assumes a real training
    // host; these fixtures are synthetic smoke prints needing ~nothing.
    // Under a full parallel gate the two reservations plus 1 GiB headroom
    // exceeded free memory at the probe instant — observed queued:
    // "insufficient free memory … 2.3GiB free" while the machine idles at
    // 4.2 — and the planner correctly withheld the second idea.
    // capacity.test.ts owns the admission math; this file owns parallel
    // execution, so the fixtures declare their true (~50 MB) need. The
    // probe rounds free memory to 0.1 GiB, so 0.05×2+1 puts this test on
    // the same admission floor as the single-idea fixtures (admit iff
    // rounded free ≥ 1.1), the lowest floor any observed gate dip stayed
    // above. The report binds src/smoke.py, not config, so patching after
    // check is safe (scaffold never overwrites existing files either).
    const trainPath = join(project, 'ideas', id, 'config', 'train.json');
    const train = JSON.parse(await readFile(trainPath, 'utf8')) as Record<string, unknown>;
    train.resources = { gpus: 0, memoryGiB: 0.05 };
    await writeFile(trainPath, `${JSON.stringify(train, null, 2)}\n`, 'utf8');
  }

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'ideaseek-par-'));
    const init = await runCli(project, ['init']);
    expect(init.code).toBe(0);
  }, 60_000);

  it('runs two ready ideas concurrently and records both results', async () => {
    await makeReady('alpha-idea');
    await makeReady('beta-idea');

    const run = await runCli(project, ['idea', 'run-ready', '--json']);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const payload = JSON.parse(run.stdout) as {
      admitted: string[];
      queued: { ideaId: string; reason: string }[];
      constraints: string[];
      allOk: boolean;
      outcomes: { ideaId: string; ok: boolean; resultStatus: string; statusAfter: string }[];
    };
    // The queued/constraints detail is the diagnosis: a capacity queue
    // (probe saw degraded free memory / GPU at the instant of admission)
    // and a vanished ready idea (status never reached SMOKE_TESTED) produce
    // the same admitted=[alpha] shape, and only the reasons tell them apart.
    expect(
      payload.admitted.sort(),
      `queued=${JSON.stringify(payload.queued)} constraints=${JSON.stringify(payload.constraints)}`,
    ).toEqual(['alpha-idea', 'beta-idea']);
    expect(payload.queued).toEqual([]);
    expect(payload.allOk).toBe(true);
    expect(payload.outcomes).toHaveLength(2);
    for (const outcome of payload.outcomes) {
      expect(outcome.ok).toBe(true);
      expect(outcome.resultStatus).toBe('succeeded');
      expect(outcome.statusAfter).toBe('ANALYZING');
    }

    // Both specs exist independently in the unified registry.
    for (const specId of ['idea-alpha-idea', 'idea-beta-idea']) {
      const shown = await runCli(project, ['experiment', 'show', specId, '--json']);
      expect(shown.code).toBe(0);
      expect((JSON.parse(shown.stdout) as { status: string }).status).toBe('succeeded');
    }

    // Workspaces did not cross-contaminate.
    const alpha = await readFile(
      join(project, 'ideas', 'alpha-idea', 'experiments', 'idea-alpha-idea-v1.json'),
      'utf8',
    );
    expect(JSON.parse(alpha)).toHaveProperty('spec');
    await expect(
      readFile(
        join(project, 'ideas', 'alpha-idea', 'experiments', 'idea-beta-idea-v1.json'),
        'utf8',
      ),
    ).rejects.toThrow();
  }, 180_000);

  it('queues excess ideas when max_parallel_ideas limits concurrency', async () => {
    await makeReady('alpha-idea');
    await makeReady('beta-idea');

    // Tighten the user ceiling in research.yaml.
    const configPath = join(project, 'research.yaml');
    const config = await readFile(configPath, 'utf8');
    await writeFile(
      configPath,
      config.replace('max_parallel_ideas: 2', 'max_parallel_ideas: 1'),
      'utf8',
    );

    const run = await runCli(project, ['idea', 'run-ready', '--json']);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const payload = JSON.parse(run.stdout) as {
      admitted: string[];
      queued: { ideaId: string; reason: string }[];
      allOk: boolean;
    };
    // Deterministic tie-break: equal createdAt → alphabetical → alpha first.
    expect(payload.admitted).toEqual(['alpha-idea']);
    expect(payload.queued).toHaveLength(1);
    expect(payload.queued[0]!.ideaId).toBe('beta-idea');
    expect(payload.queued[0]!.reason).toContain('max_parallel_ideas=1');
    expect(payload.allOk).toBe(true);

    // The queued idea never left SMOKE_TESTED.
    const beta = await runCli(project, ['idea', 'show', 'beta-idea', '--json']);
    expect((JSON.parse(beta.stdout) as { status: string }).status).toBe('SMOKE_TESTED');

    // The admitted one completed.
    const alpha = await runCli(project, ['idea', 'show', 'alpha-idea', '--json']);
    expect((JSON.parse(alpha.stdout) as { status: string }).status).toBe('ANALYZING');
  }, 180_000);

  it('is a clean no-op when nothing is ready', async () => {
    const run = await runCli(project, ['idea', 'run-ready', '--json']);
    expect(run.code).toBe(0);
    const payload = JSON.parse(run.stdout) as {
      admitted: string[];
      queued: unknown[];
      outcomes: unknown[];
    };
    expect(payload.admitted).toEqual([]);
    expect(payload.queued).toEqual([]);
    expect(payload.outcomes).toEqual([]);

    const plain = await runCli(project, ['idea', 'run-ready']);
    expect(plain.stdout).toContain('no SMOKE_TESTED ideas');
  }, 60_000);

  it('isolates a failing idea without blocking the parallel sibling', async () => {
    await makeReady('alpha-idea');
    await makeReady('beta-idea');

    // Sabotage beta AFTER its check passed → its experiment hits a stale
    // check report while alpha still runs.
    await writeFile(
      join(project, 'ideas', 'beta-idea', 'src', 'smoke.py'),
      'raise SystemExit("broken after check")\n',
      'utf8',
    );

    const run = await runCli(project, ['idea', 'run-ready', '--json']);
    expect(run.code).toBe(1); // beta failed, alpha unaffected
    const payload = JSON.parse(run.stdout) as {
      allOk: boolean;
      outcomes: { ideaId: string; ok: boolean; error?: string; resultStatus?: string }[];
    };
    expect(payload.allOk).toBe(false);
    const alpha = payload.outcomes.find((entry) => entry.ideaId === 'alpha-idea')!;
    const beta = payload.outcomes.find((entry) => entry.ideaId === 'beta-idea')!;
    expect(alpha.ok).toBe(true);
    expect(alpha.resultStatus).toBe('succeeded');
    expect(beta.ok).toBe(false);
    expect(beta.error).toContain('stale');

    // Alpha reached ANALYZING; beta is untouched (still SMOKE_TESTED).
    const alphaStatus = await runCli(project, ['idea', 'show', 'alpha-idea', '--json']);
    expect((JSON.parse(alphaStatus.stdout) as { status: string }).status).toBe('ANALYZING');
    const betaStatus = await runCli(project, ['idea', 'show', 'beta-idea', '--json']);
    expect((JSON.parse(betaStatus.stdout) as { status: string }).status).toBe('SMOKE_TESTED');
  }, 180_000);

  /**
   * "Parallel" has to be measured, not asserted by the admission list.
   *
   * The other tests in this file prove WHO was admitted and WHAT was queued,
   * which a `for` loop satisfies exactly as well as `Promise.all` — so the
   * capability this file is named for had no test that could fail if the runner
   * serialized. Each entry now sleeps, and the two recorded intervals must
   * actually overlap. Same "configured, green, inert" shape as the fairness,
   * duplicate-control and vendor-integrity cases, found by asking which claim
   * would still pass if the feature were removed.
   */
  it('records runs whose time windows genuinely overlap', async () => {
    const sleepMs = 1_500;
    await makeReady('alpha-idea', sleepMs);
    await makeReady('beta-idea', sleepMs);

    const dispatchStart = Date.now();
    const run = await runCli(project, ['idea', 'run-ready', '--json']);
    const dispatchMs = Date.now() - dispatchStart;
    expect(run.code, run.stdout + run.stderr).toBe(0);

    const windows: { ideaId: string; start: number; finish: number }[] = [];
    for (const id of ['alpha-idea', 'beta-idea']) {
      const artifact = JSON.parse(
        await readFile(join(project, 'ideas', id, 'experiments', `idea-${id}-v1.json`), 'utf8'),
      ) as { result?: { startedAt?: number; finishedAt?: number } };
      expect(artifact.result?.startedAt, id).toBeTypeOf('number');
      expect(artifact.result?.finishedAt, id).toBeTypeOf('number');
      windows.push({
        ideaId: id,
        start: artifact.result!.startedAt!,
        finish: artifact.result!.finishedAt!,
      });
    }

    const overlapMs =
      Math.min(windows[0]!.finish, windows[1]!.finish) -
      Math.max(windows[0]!.start, windows[1]!.start);
    // Most of a 1.5s window must be shared; serial execution gives a negative.
    expect(overlapMs, `windows ${JSON.stringify(windows)}`).toBeGreaterThan(sleepMs / 3);
    const totalWork = windows.reduce((sum, entry) => sum + (entry.finish - entry.start), 0);
    // Dispatch must be less than the SUM of both runs (serial would be >= sum).
    // Allow a small margin for CLI startup overhead (node boot, dist import).
    const serialEstimate = totalWork + 2000;
    expect(dispatchMs, `dispatch ${dispatchMs}ms vs serial ~${serialEstimate}ms`).toBeLessThan(
      serialEstimate,
    );
  }, 240_000);
});
