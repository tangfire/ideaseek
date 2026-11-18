import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  computeAdmission,
  type CapacityProbe,
  type CapacityRequest,
} from '../src/runtime/capacity.js';
import type { IdeaCard } from '../src/idea/card.js';
import { CLI_BIN, implementIdeaSmoke } from './helpers.js';

function probe(overrides: Partial<CapacityProbe> = {}): CapacityProbe {
  return {
    gpus: [],
    cpuCores: 8,
    freeMemGiB: 32,
    diskFreeGiB: 500,
    nvidiaSmiAvailable: false,
    probedAt: 1,
    ...overrides,
  };
}

function request(id: string, gpus: number, memoryGiB: number, createdAt = 1): CapacityRequest {
  return { ideaId: id, gpus, memoryGiB, createdAt };
}

describe('computeAdmission', () => {
  it('admits CPU-only ideas up to the user limit with stable ordering', () => {
    const plan = computeAdmission(probe(), [request('b', 0, 2, 2), request('a', 0, 2, 1)], {
      maxParallelIdeas: 2,
    });
    expect(plan.effectiveN).toBe(2);
    expect(plan.admitted.map((entry) => entry.ideaId)).toEqual(['a', 'b']);
    expect(plan.queued).toEqual([]);
    expect(plan.parallelLimit).toBe(2);
  });

  it('queues excess demand by the user limit', () => {
    const plan = computeAdmission(
      probe(),
      [request('a', 0, 1, 1), request('b', 0, 1, 2), request('c', 0, 1, 3)],
      { maxParallelIdeas: 2 },
    );
    expect(plan.admitted).toHaveLength(2);
    expect(plan.queued).toHaveLength(1);
    expect(plan.queued[0]).toMatchObject({ ideaId: 'c' });
    expect(plan.queued[0]!.reason).toContain('max_parallel_ideas=2');
    expect(plan.constraints.join(' ')).toContain('user limit');
  });

  it('never over-assigns a single GPU across concurrent ideas', () => {
    const oneGpu = probe({
      gpus: [{ index: 0, memTotalMiB: 8192, memFreeMiB: 8000, utilizationPct: 10 }],
      nvidiaSmiAvailable: true,
    });
    const plan = computeAdmission(oneGpu, [request('gpu-a', 1, 4, 1), request('gpu-b', 1, 4, 2)], {
      maxParallelIdeas: 4,
    });
    expect(plan.admitted).toHaveLength(1);
    expect(plan.admitted[0]).toMatchObject({ ideaId: 'gpu-a', deviceIndices: [0] });
    expect(plan.queued[0]!.reason).toContain('insufficient free GPU');
    expect(plan.constraints.join(' ')).toContain('GPU free memory');
  });

  it('binds distinct devices when enough GPUs are free', () => {
    const twoGpu = probe({
      gpus: [
        { index: 0, memTotalMiB: 24576, memFreeMiB: 24000, utilizationPct: 0 },
        { index: 1, memTotalMiB: 24576, memFreeMiB: 24000, utilizationPct: 0 },
      ],
      nvidiaSmiAvailable: true,
    });
    const plan = computeAdmission(twoGpu, [request('a', 1, 8, 1), request('b', 1, 8, 2)], {
      maxParallelIdeas: 4,
    });
    expect(plan.admitted).toHaveLength(2);
    const indices = plan.admitted.flatMap((entry) => entry.deviceIndices);
    expect(new Set(indices).size).toBe(2); // no shared device
  });

  it('rejects GPU requests that exceed free memory even with spare slots', () => {
    const small = probe({
      gpus: [{ index: 0, memTotalMiB: 8192, memFreeMiB: 4000, utilizationPct: 50 }],
      nvidiaSmiAvailable: true,
    });
    const plan = computeAdmission(small, [request('hungry', 1, 8, 1)], {
      maxParallelIdeas: 4,
    });
    expect(plan.admitted).toHaveLength(0);
    expect(plan.queued[0]!.reason).toContain('insufficient free GPU');
  });

  it('respects host memory headroom for CPU-only ideas', () => {
    const tight = probe({ cpuCores: 8, freeMemGiB: 3 });
    const plan = computeAdmission(tight, [request('a', 0, 4, 1)], { maxParallelIdeas: 4 });
    expect(plan.admitted).toHaveLength(0);
    expect(plan.queued[0]!.reason).toContain('insufficient free memory');
  });

  it('reports an empty plan cleanly when nothing is ready', () => {
    const plan = computeAdmission(probe(), [], { maxParallelIdeas: 2 });
    expect(plan.effectiveN).toBe(0);
    expect(plan.queued).toEqual([]);
    expect(plan.constraints.join(' ')).toContain('demand');
  });

  /**
   * Multi-GPU admission with heterogeneous hardware: 4 GPUs of different sizes
   * and mixed utilization. The planner must bind each idea to a device that has
   * enough FREE memory (not total), respect the user limit, and queue what it
   * cannot fit — without over-assigning any single GPU.
   *
   * This mirrors a real workstation: a big GPU for training, small ones for
   * inference, some busy with other work. The bug this guards against is
   * admitting an idea to a GPU that has enough total memory but not enough
   * free memory after other workloads.
   */
  it('admits heterogeneous 4-GPU workstation without over-assigning or starving', () => {
    const workstation = probe({
      gpus: [
        { index: 0, memTotalMiB: 24576, memFreeMiB: 24000, utilizationPct: 0 }, // big, free
        { index: 1, memTotalMiB: 24576, memFreeMiB: 8000, utilizationPct: 75 }, // big, mostly used
        { index: 2, memTotalMiB: 8192, memFreeMiB: 7500, utilizationPct: 10 }, // small, free
        { index: 3, memTotalMiB: 8192, memFreeMiB: 2000, utilizationPct: 90 }, // small, busy
      ],
      nvidiaSmiAvailable: true,
      cpuCores: 16,
      freeMemGiB: 64,
    });
    // 5 ideas: two need 16GiB (only GPU 0 fits), two need 4GiB (GPU 2 fits one,
    // GPU 1 has 8GiB free but only after GPU 0 is taken), one needs 2GiB.
    const requests = [
      request('big-a', 1, 16, 1),
      request('big-b', 1, 16, 2),
      request('mid-a', 1, 4, 3),
      request('mid-b', 1, 4, 4),
      request('small', 1, 2, 5),
    ];
    const plan = computeAdmission(workstation, requests, { maxParallelIdeas: 5 });
    // At most one 16GiB idea fits (GPU 0). GPU 1 has 8GiB free but utilization
    // is 75% — the planner should still admit if memory is enough (utilization
    // is informational, not a hard gate).
    expect(plan.admitted.length).toBeGreaterThanOrEqual(1);
    expect(plan.admitted.length).toBeLessThanOrEqual(3);
    // No GPU is assigned to two ideas simultaneously.
    const allIndices = plan.admitted.flatMap((entry) => entry.deviceIndices);
    expect(new Set(allIndices).size).toBe(allIndices.length);
    // Ideas that need more than any single GPU's free memory are queued.
    const queuedIds = plan.queued.map((entry) => entry.ideaId);
    expect(queuedIds.length).toBeGreaterThanOrEqual(1);
    // The big-b idea (16GiB) cannot fit on any GPU after big-a takes GPU 0.
    expect(queuedIds).toContain('big-b');
  });
});

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

describe('ideaseek capacity (CLI)', () => {
  let project: string;

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'ideaseek-cap-'));
    const init = await runCli(project, ['init']);
    expect(init.code).toBe(0);
  }, 60_000);

  it('probes the host and writes the plan file', async () => {
    const plan = await runCli(project, ['capacity', '--json']);
    expect(plan.code, plan.stdout + plan.stderr).toBe(0);
    const payload = JSON.parse(plan.stdout) as {
      probe: { cpuCores: number; freeMemGiB: number; gpus: unknown[]; nvidiaSmiAvailable: boolean };
      plan: { parallelLimit: number; effectiveN: number; admitted: unknown[]; queued: unknown[] };
      running: string[];
    };
    expect(payload.probe.cpuCores).toBeGreaterThan(0);
    expect(payload.probe.freeMemGiB).toBeGreaterThan(0);
    expect(Array.isArray(payload.probe.gpus)).toBe(true);
    expect(payload.plan.parallelLimit).toBe(2); // config default max_parallel_ideas
    expect(payload.plan.effectiveN).toBe(0); // no ready ideas yet
    expect(payload.running).toEqual([]);

    const written = JSON.parse(
      await readFile(join(project, 'knowledge', 'capacity-plan.json'), 'utf8'),
    ) as { plan: { parallelLimit: number } };
    expect(written.plan.parallelLimit).toBe(2);

    const plain = await runCli(project, ['capacity']);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain('plan: N=0');
    expect(plain.stdout).toContain('capacity-plan.json');
  }, 60_000);

  it('only counts ideas ready for experiments (SMOKE_TESTED) as requests', async () => {
    // Idea parked at PROPOSED: must NOT appear as a request.
    const idleCard = join(project, 'idle.json');
    await writeFile(idleCard, JSON.stringify(makeCard('idle-idea')), 'utf8');
    expect(
      (await runCli(project, ['idea', 'create', 'idle-idea', '--from-card', idleCard])).code,
    ).toBe(0);

    // Ready idea: walk to SMOKE_TESTED via scaffold + check.
    const readyCard = join(project, 'ready.json');
    await writeFile(readyCard, JSON.stringify(makeCard('ready-idea')), 'utf8');
    expect(
      (await runCli(project, ['idea', 'create', 'ready-idea', '--from-card', readyCard])).code,
    ).toBe(0);
    expect((await runCli(project, ['idea', 'set-status', 'ready-idea', 'IMPLEMENTING'])).code).toBe(
      0,
    );
    expect((await runCli(project, ['idea', 'scaffold', 'ready-idea'])).code).toBe(0);
    // Scaffold contract first, while it still holds: a fresh scaffold declares
    // the conservative 1 GiB admission reservation.
    const scaffoldCfg = JSON.parse(
      await readFile(join(project, 'ideas', 'ready-idea', 'config', 'train.json'), 'utf8'),
    ) as { resources: { gpus: number; memoryGiB: number } };
    expect(scaffoldCfg.resources).toEqual({ gpus: 0, memoryGiB: 1 });
    // The admission probe reads LIVE host memory: two reservations plus the
    // 1 GiB headroom meant this test needed 2 GiB free at the probe instant,
    // and the full parallel gate dips below that (observed: queued
    // "insufficient free memory"). computeAdmission's math is pinned by the
    // unit tests above with synthetic probes; this CLI test owns discovery
    // and config wiring, so the fixture declares its true (~100 MB) need.
    scaffoldCfg.resources = { gpus: 0, memoryGiB: 0.1 };
    await writeFile(
      join(project, 'ideas', 'ready-idea', 'config', 'train.json'),
      `${JSON.stringify(scaffoldCfg, null, 2)}\n`,
      'utf8',
    );
    // A ready idea has to earn SMOKE_TESTED with real code: the scaffold's
    // smoke declares itself synthetic and is refused.
    await implementIdeaSmoke(project, 'ready-idea', 'm');
    const check = await runCli(project, ['idea', 'check', 'ready-idea', '--json']);
    expect(check.code, check.stdout + check.stderr).toBe(0);

    const plan = await runCli(project, ['capacity', '--json']);
    expect(plan.code).toBe(0);
    const payload = JSON.parse(plan.stdout) as {
      plan: {
        effectiveN: number;
        admitted: { ideaId: string; gpus: number; memoryGiB: number }[];
        queued: { ideaId: string }[];
      };
    };
    expect(payload.plan.admitted.map((entry) => entry.ideaId)).toEqual(['ready-idea']);
    expect(payload.plan.queued.map((entry) => entry.ideaId)).not.toContain('idle-idea');
    // Admission read the patched config, not the default: wiring proven.
    expect(payload.plan.admitted[0]).toMatchObject({ gpus: 0, memoryGiB: 0.1 });

    // The spec side carries the same resource request (wiring check).
    const cfg = JSON.parse(
      await readFile(join(project, 'ideas', 'ready-idea', 'config', 'train.json'), 'utf8'),
    ) as { resources: { gpus: number; memoryGiB: number } };
    expect(cfg.resources).toEqual({ gpus: 0, memoryGiB: 0.1 });
  }, 180_000);
});
