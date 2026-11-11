import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { computeHandoffLevel } from '../src/idea/handoff.js';
import type { IdeaCard } from '../src/idea/card.js';
import { CLI_BIN } from './helpers.js';

describe('computeHandoffLevel (unit)', () => {
  it('grants HANDOFF_READY only with supported verdict, coverage and a passing gate', () => {
    expect(
      computeHandoffLevel({
        analysisVerdict: 'supported',
        scalesRun: ['quick', 'smoke'],
        seedsCount: 3,
        comparisonGateOk: true,
      }),
    ).toEqual({ level: 'HANDOFF_READY', handoffReady: true, blockers: [] });
  });

  it('downgrades to PROMISING with explicit blockers', () => {
    const noGate = computeHandoffLevel({
      analysisVerdict: 'supported',
      scalesRun: ['quick', 'smoke'],
      seedsCount: 3,
      comparisonGateOk: false,
    });
    expect(noGate.level).toBe('PROMISING');
    expect(noGate.handoffReady).toBe(false);
    expect(noGate.blockers.join(' ')).toContain('comparison gate');

    const singleSeed = computeHandoffLevel({
      analysisVerdict: 'supported',
      scalesRun: ['quick', 'smoke'],
      seedsCount: 1,
      comparisonGateOk: true,
    });
    expect(singleSeed.level).toBe('PROMISING');
    expect(singleSeed.blockers.join(' ')).toContain('seeds 1 < 2');

    const inconclusive = computeHandoffLevel({
      analysisVerdict: 'inconclusive',
      scalesRun: ['smoke'],
      seedsCount: 1,
      comparisonGateOk: true,
    });
    expect(inconclusive.level).toBe('PROMISING');
    expect(inconclusive.blockers.length).toBeGreaterThanOrEqual(3);
  });

  it('never packages rejected or invalid-run ideas', () => {
    for (const verdict of ['rejected', 'invalid-run'] as const) {
      const gate = computeHandoffLevel({
        analysisVerdict: verdict,
        scalesRun: ['quick', 'smoke'],
        seedsCount: 5,
        comparisonGateOk: true,
      });
      expect(gate.level).toBe('EXPLORATORY');
      expect(gate.handoffReady).toBe(false);
      expect(gate.blockers.join(' ')).toContain('no handoff package');
    }
  });
});

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
    componentNecessity: [
      { component: 'probe', role: 'necessary-mechanism', removeEffect: 'gain gone' },
    ],
    competingExplanations: ['x'],
    boundaryConditions: ['no benefit without skew'],
    risks: ['extra pass per round'],
    minimalExperiment: {
      code: 'src/train.py',
      data: 'd',
      baselines: ['fedavg'],
      metrics: ['rare-class recall'],
      ablations: ['no reweighting'],
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

describe('ideaseek idea handoff (CLI)', () => {
  let project: string;

  /** create → IMPLEMENTING → scaffold → check → experiment → ANALYZING. */
  async function setupToAnalyzing(id = 'calib-reweight'): Promise<void> {
    const cardPath = join(project, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard(id)), 'utf8');
    expect((await runCli(project, ['idea', 'create', id, '--from-card', cardPath])).code).toBe(0);
    expect((await runCli(project, ['idea', 'set-status', id, 'IMPLEMENTING'])).code).toBe(0);
    expect((await runCli(project, ['idea', 'scaffold', id])).code).toBe(0);
    expect((await runCli(project, ['idea', 'check', id])).code).toBe(0);
    const exp = await runCli(project, ['idea', 'experiment', id, '--json']);
    expect(exp.code, exp.stdout + exp.stderr).toBe(0);
    expect((await runCli(project, ['idea', 'analyze', id])).code).toBe(0);
  }

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'ideaseek-ho-'));
    const init = await runCli(project, ['init']);
    expect(init.code).toBe(0);
  }, 60_000);

  it('builds the full package with the gate recorded (PROMISING at single seed)', async () => {
    await setupToAnalyzing();

    const handoff = await runCli(project, ['idea', 'handoff', 'calib-reweight', '--json']);
    expect(handoff.code, handoff.stdout + handoff.stderr).toBe(0);
    const payload = JSON.parse(handoff.stdout) as {
      level: string;
      handoffReady: boolean;
      blockers: string[];
      files: string[];
    };
    expect(payload.level).toBe('PROMISING'); // honest: single seed, smoke scale only
    expect(payload.handoffReady).toBe(false);
    expect(payload.blockers.join(' ')).toContain('seeds 1 < 2');

    const dir = join(project, 'ideas', 'calib-reweight', 'handoff');
    for (const file of [
      'full-data-config.yaml',
      'full-split-manifest.json',
      'environment.lock.txt',
      'commands.txt',
      'resources.json',
      'provenance.json',
      'known-risks.md',
      'reproducibility.md',
      'handoff.json',
    ]) {
      await expect(readFile(join(dir, file), 'utf8'), `missing ${file}`).resolves.toBeTruthy();
    }

    // yaml config is parseable and bound to the idea.
    const config = parseYaml(await readFile(join(dir, 'full-data-config.yaml'), 'utf8')) as {
      project: { ideaId: string; ideaVersion: number };
      scale: string;
    };
    expect(config.project.ideaId).toBe('calib-reweight');
    expect(config.scale).toBe('full');

    // provenance binds code hash + protocol + analysis verdict.
    const provenance = JSON.parse(await readFile(join(dir, 'provenance.json'), 'utf8')) as {
      codeHash: string | null;
      analysis: { verdict: string };
    };
    expect(provenance.codeHash).toMatch(/^sha256:/);
    expect(provenance.analysis.verdict).toBe('inconclusive');

    // reproducibility states the boundary; risks file keeps declared risks.
    const repro = await readFile(join(dir, 'reproducibility.md'), 'utf8');
    expect(repro).toContain('Did NOT run: full-scale training');
    expect(repro).toContain('HANDOFF_READY'); // the ladder is documented
    expect(repro).toContain('level: **PROMISING**'); // honest current level
    const risks = await readFile(join(dir, 'known-risks.md'), 'utf8');
    expect(risks).toContain('extra pass per round');

    // environment lock has the interpreter header (freeze best-effort).
    const lock = await readFile(join(dir, 'environment.lock.txt'), 'utf8');
    expect(lock).toContain('# environment lock');

    // commands.txt is explicitly user-run.
    const commands = await readFile(join(dir, 'commands.txt'), 'utf8');
    expect(commands).toContain('run these YOURSELF');
  }, 240_000);

  it('refuses without a passing check report', async () => {
    const cardPath = join(project, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard('calib-reweight')), 'utf8');
    await runCli(project, ['idea', 'create', 'calib-reweight', '--from-card', cardPath]);
    const early = await runCli(project, ['idea', 'handoff', 'calib-reweight']);
    expect(early.code).not.toBe(0);
    expect(early.stderr).toContain('idea check');
  }, 60_000);

  it('refuses to package a rejected idea (no favorable-result laundering)', async () => {
    await setupToAnalyzing();

    // Register a STRONGER baseline covering fedavg → idea loses → rejected.
    const baselineSpec = {
      specId: 'base-fedavg',
      version: 1,
      idea: null,
      comparisonIds: ['fedavg'],
      codeCommit: null,
      dataSnapshotId: 'synthetic:baseline',
      sliceIds: [],
      environment: { python: 'v24', notes: ['scale:smoke'] },
      command: ['python', '-c', 'pass'],
      metrics: [{ name: 'rare-class recall', direction: 'higher' }],
      seeds: [42, 43],
      resources: {},
      budget: { maxRuns: 1, maxMinutes: 1 },
      protocolId: null,
      createdAt: 1,
    };
    const specPath = join(project, 'baseline-spec.json');
    await writeFile(specPath, JSON.stringify(baselineSpec), 'utf8');
    expect((await runCli(project, ['experiment', 'spec', specPath])).code).toBe(0);
    const baselineResult = {
      specId: 'base-fedavg',
      status: 'succeeded',
      logRefs: [],
      artifactRefs: [],
      metrics: [{ name: 'rare-class recall', value: 0.9 }],
      resourcesUsed: {},
      failure: null,
      startedAt: 1,
      finishedAt: 2,
    };
    const resultPath = join(project, 'baseline-result.json');
    await writeFile(resultPath, JSON.stringify(baselineResult), 'utf8');
    expect((await runCli(project, ['experiment', 'result', resultPath])).code).toBe(0);

    // Re-analyze against the new control → rejected (0.5 < 0.9).
    const analyze = await runCli(project, ['idea', 'analyze', 'calib-reweight', '--json']);
    expect(analyze.code).toBe(0);
    const analysis = JSON.parse(analyze.stdout) as {
      analysis: { verdict: string; failureClass: string };
    };
    expect(analysis.analysis.verdict).toBe('rejected');
    expect(analysis.analysis.failureClass).toBe('effect-insufficient');

    const handoff = await runCli(project, ['idea', 'handoff', 'calib-reweight']);
    expect(handoff.code).not.toBe(0);
    expect(handoff.stderr).toContain('rejected');
    await expect(
      readFile(join(project, 'ideas', 'calib-reweight', 'handoff', 'handoff.json'), 'utf8'),
    ).rejects.toThrow();
  }, 240_000);
});
