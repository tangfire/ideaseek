import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IdeaCard } from '../src/idea/card.js';
import { CLI_BIN, implementIdeaSmoke } from './helpers.js';

/**
 * ADR-009 dedup conformance: the ARIS experiment-plan backend
 * (src/experiment/plan.ts + bridge, artifact-backed) is the SINGLE default.
 * The retired src/idea/plan.ts implementation left only historical
 * `ideas/<id>/experiments/plan.json` files — they must stay readable as
 * plain data and must never act as a runtime fallback (no second plan
 * source can influence spec seeds, guards or bridges).
 */

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[], timeoutMs = 120_000): Promise<CliResult> {
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

function makeCard(ideaId: string): IdeaCard {
  return {
    ideaId,
    version: 1,
    parentVersion: null,
    status: 'CANDIDATE',
    hypothesis: { statement: 'reweighting improves recall under skew', targetProblem: 'dilution' },
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
    budget: { maxRounds: 3, maxGpuMinutes: 120 },
    stopConditions: ['s'],
    createdAt: 1,
  } as IdeaCard;
}

const LEGACY_PLAN = {
  contract: 'experiment-plan-v1',
  ideaId: 'legacy-idea',
  cardVersion: 1,
  inputHash: 'sha256:deadbeef',
  skill: { name: 'experiment-plan', sha256: 'x' },
  generatedAt: 1,
  harnessRuntime: 'fake',
  primaryMetric: 'ghost-metric',
  claimMap: [{ claim: 'legacy claim', evidence: 'legacy evidence' }],
  blocks: [],
  runOrder: [],
  computeBudget: { gpuMinutes: 1 },
  risks: [],
  checklist: [],
};

describe('experiment-plan dedup (ADR-009 single default backend)', () => {
  async function setup(): Promise<string> {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-planmig-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    const cardPath = join(project, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard('legacy-idea')), 'utf8');
    expect(
      (await runCli(project, ['idea', 'create', 'legacy-idea', '--from-card', cardPath])).code,
    ).toBe(0);
    // Historical file from the retired src/idea/plan.ts implementation.
    await writeFile(
      join(project, 'ideas', 'legacy-idea', 'experiments', 'plan.json'),
      JSON.stringify(LEGACY_PLAN, null, 2),
      'utf8',
    );
    return project;
  }

  it('legacy plan.json stays readable but never becomes a runtime plan source', async () => {
    const project = await setup();

    // The retired file is still plain readable data (no destructive migration).
    const legacy = JSON.parse(
      await readFile(join(project, 'ideas', 'legacy-idea', 'experiments', 'plan.json'), 'utf8'),
    ) as { primaryMetric: string };
    expect(legacy.primaryMetric).toBe('ghost-metric');

    // The single backend plans normally and does not consult the legacy file:
    // no metric guard fires from its ghost metric, seeds come from the ARIS plan.
    const plan = await runCli(project, [
      'experiment',
      'plan',
      'legacy-idea',
      '--harness',
      'fake',
      '--json',
    ]);
    expect(plan.code, plan.stdout + plan.stderr).toBe(0);
    const payload = JSON.parse(plan.stdout) as { inputHash: string; seeds: number[] };
    expect(payload.inputHash).toMatch(/^sha256:/);
    expect(payload.inputHash).not.toBe('sha256:deadbeef');
    expect(payload.seeds).toEqual([42, 200, 201]);

    // Context reports the ARIS plan reference, not the legacy inputHash.
    const context = await runCli(project, ['context', '--json']);
    const ctx = JSON.parse(context.stdout) as {
      ideas: { ideaId: string; plan: string | null }[];
    };
    expect(ctx.ideas[0]!.plan).toMatch(/^sha256:/);
    expect(ctx.ideas[0]!.plan).not.toBe('sha256:deadbeef');

    // Direct experiment execution still works with the legacy file present
    // (it is inert data; the ARIS backend owns planning).
    expect(
      (await runCli(project, ['idea', 'set-status', 'legacy-idea', 'IMPLEMENTING'])).code,
    ).toBe(0);
    expect((await runCli(project, ['idea', 'scaffold', 'legacy-idea'])).code).toBe(0);
    // The scaffold's smoke declares itself synthetic, which `idea check`
    // now refuses; a fixture that needs a passed check must compute.
    await implementIdeaSmoke(project, 'legacy-idea');
    const check = await runCli(project, ['idea', 'check', 'legacy-idea', '--json']);
    expect(check.code, check.stdout + check.stderr).toBe(0);
    const experiment = await runCli(project, ['idea', 'experiment', 'legacy-idea', '--json']);
    expect(experiment.code, experiment.stdout + experiment.stderr).toBe(0);
    const doc = await runCli(project, ['experiment', 'show', 'idea-legacy-idea', '--json']);
    const parsed = JSON.parse(doc.stdout) as {
      spec: { seeds: number[]; environment: { notes: string[] } };
    };
    expect(parsed.spec.seeds).toEqual([42, 200, 201]); // ARIS plan seeds, not config/legacy
    expect(parsed.spec.environment.notes.join('\n')).not.toContain('deadbeef');
  }, 300_000);
});
