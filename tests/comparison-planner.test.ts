import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, makeProjectDir } from './helpers.js';
import { validateMatrixProposal, type PlannerContext } from '../src/comparison/planner.js';

/**
 * Comparison Planner agent stage (docs/FULL_RESEARCH_MODE.md 全量 comparison
 * 清单): bounded context → harness proposal → hard validation (no invented
 * citations / unknown methods) → `comparison matrix` merges it as the
 * reviewable default. The registry only changes via matrix --confirm.
 * Fake harness only — no network, no credentials.
 */

function runCli(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  timeoutMs = 180_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1', ...extraEnv },
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

function makeCard(ideaId: string): Record<string, unknown> {
  return {
    ideaId,
    version: 1,
    parentVersion: null,
    status: 'DRAFT_COMPOSITION',
    hypothesis: {
      statement: 'Drift term lifts rare-class recall.',
      targetProblem: 'rare-class gap',
    },
    paperEvidence: [{ paperRef: 'synth-1', statement: 'drift matters', evidence: 'p.1' }],
    contradictions: ['prior work disagrees'],
    novelty: { claim: 'drift term', uncertainty: 'thin', whyNotRestatement: 'adds a term' },
    mechanismChain: {
      designPrincipleLink: 'compensate drift',
      steps: [{ kind: 'observation', text: 'updates diverge' }],
    },
    nearestComparisons: [{ methodId: 'fedavg', difference: 'adds term', evidence: 'table 2' }],
    componentNecessity: [],
    competingExplanations: ['lr explains it'],
    boundaryConditions: ['label-skew only'],
    risks: ['noise'],
    minimalExperiment: {
      code: 'src/train.py',
      data: 'smoke',
      baselines: ['fedavg'],
      metrics: ['rare-class recall'],
      ablations: ['w/o term'],
    },
    falsification: { conditions: ['no gain'] },
    budget: { maxRounds: 3, maxGpuMinutes: 60 },
    stopConditions: ['budget'],
    createdAt: 1,
  };
}

function baseContext(overrides: Partial<PlannerContext> = {}): PlannerContext {
  return {
    generator: 'comparison-planner-v1',
    questions: ['Drift term lifts rare-class recall.'],
    venue: null,
    subfield: null,
    candidates: [
      {
        methodId: 'fedavg',
        currentClassification: 'required',
        origin: 'registered',
        currentRationale: 'registered as required',
      },
    ],
    literature: [
      {
        sourceId: 'paper-card:paper-test123',
        title: 'Recent Advances in Drift Compensation',
        year: 2024,
        kind: 'paper-card',
      },
    ],
    researchMap: null,
    benchmarkEvidence: [{ methodId: 'fedavg', status: 'candidate', required: true }],
    indexNote: 'external_search off',
    ...overrides,
  };
}

async function setupProject(dir: string): Promise<void> {
  const cardPath = join(dir, 'card.json');
  await writeFile(cardPath, JSON.stringify(makeCard('alpha')), 'utf8');
  expect((await runCli(dir, ['idea', 'create', 'alpha', '--from-card', cardPath])).code).toBe(0);
  expect(
    (
      await runCli(dir, [
        'comparison',
        'register',
        'fedavg',
        '--repo',
        'https://example.org/fedavg.git',
      ])
    ).code,
  ).toBe(0);
  await mkdir(join(dir, 'knowledge', 'paper-cards'), { recursive: true });
  await writeFile(
    join(dir, 'knowledge', 'paper-cards', 'paper-test123.json'),
    JSON.stringify({
      artifactId: 'paper-test123',
      source: 'synth-1.pdf',
      card: { title: 'Recent Advances in Drift Compensation', paper_id: 'synth-1' },
    }),
    'utf8',
  );
}

describe('validateMatrixProposal (no invented evidence)', () => {
  it('accepts a proposal grounded in the provided context', () => {
    const result = validateMatrixProposal(
      {
        contract: 'comparison-matrix-proposal-v1',
        entries: [
          {
            methodId: 'fedavg',
            classification: 'required',
            rationale: 'classic baseline for the drift question',
            sources: ['paper-card:paper-test123'],
            relevanceNote: '2024 literature still cites FedAvg',
          },
        ],
      },
      baseContext(),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects unknown methods, bad classifications, empty rationales and invented sources', () => {
    const context = baseContext();
    const cases: unknown[] = [
      { contract: 'comparison-matrix-proposal-v1', entries: [] },
      {
        contract: 'comparison-matrix-proposal-v1',
        entries: [
          {
            methodId: 'not-registered',
            classification: 'required',
            rationale: 'x',
            sources: [],
          },
        ],
      },
      {
        contract: 'comparison-matrix-proposal-v1',
        entries: [{ methodId: 'fedavg', classification: 'must-have', rationale: 'x', sources: [] }],
      },
      {
        contract: 'comparison-matrix-proposal-v1',
        entries: [{ methodId: 'fedavg', classification: 'required', rationale: '  ', sources: [] }],
      },
      {
        contract: 'comparison-matrix-proposal-v1',
        entries: [
          {
            methodId: 'fedavg',
            classification: 'required',
            rationale: 'x',
            sources: ['invented-paper-does-not-exist'],
          },
        ],
      },
    ];
    for (const proposal of cases) {
      const result = validateMatrixProposal(proposal, context);
      expect(result.ok, JSON.stringify(proposal)).toBe(false);
    }
    const bad = validateMatrixProposal(cases[4], context) as { errors: string[] };
    expect(bad.errors.join(' ')).toContain('NOT in the provided literature');
  });
});

describe('ideaseek comparison plan (agent stage, fake harness)', () => {
  it('produces a current proposal, merges it into the matrix, and stays idempotent', async () => {
    const dir = await makeProjectDir();
    await setupProject(dir);

    const planned = await runCli(dir, ['comparison', 'plan', '--json']);
    expect(planned.code, planned.stdout + planned.stderr).toBe(0);
    const planPayload = JSON.parse(planned.stdout) as {
      exitReason: string;
      contextHash: string;
      candidates: number;
      literature: number;
    };
    expect(planPayload.exitReason).toBe('completed');
    expect(planPayload.candidates).toBeGreaterThanOrEqual(1);
    expect(planPayload.literature).toBeGreaterThanOrEqual(1);
    expect(planPayload.contextHash.startsWith('sha256:')).toBe(true);

    // Same context → proposal-current short-circuit (no second agent call).
    const again = await runCli(dir, ['comparison', 'plan', '--json']);
    expect(again.code, again.stdout + again.stderr).toBe(0);
    const againPayload = JSON.parse(again.stdout) as { action?: string };
    expect(againPayload.action).toBe('proposal-current');

    // The matrix merges the agent proposal as the reviewable default.
    const matrix = await runCli(dir, ['comparison', 'matrix', '--json']);
    expect(matrix.code, matrix.stdout + matrix.stderr).toBe(0);
    const matrixPayload = JSON.parse(matrix.stdout) as {
      matrix: {
        agentProposal?: { applied: boolean; contextHash: string };
        entries: {
          methodId: string;
          classification: string;
          rationale: string;
          sources: { source: string }[];
          plannerNote?: string;
        }[];
      };
    };
    expect(matrixPayload.matrix.agentProposal?.applied).toBe(true);
    expect(matrixPayload.matrix.agentProposal?.contextHash).toBe(planPayload.contextHash);
    const fedavg = matrixPayload.matrix.entries.find((e) => e.methodId === 'fedavg')!;
    expect(fedavg.rationale).toContain('planner review:');
    expect(fedavg.sources.map((s) => s.source)).toContain('paper-card:paper-test123');
    expect(fedavg.plannerNote).toBe('fake planner (deterministic provider)');

    // A context change (new candidate) invalidates the current proposal.
    expect(
      (
        await runCli(dir, [
          'comparison',
          'register',
          'newbase',
          '--repo',
          'https://example.org/new.git',
        ])
      ).code,
    ).toBe(0);
    const stalePlan = await runCli(dir, ['comparison', 'plan', '--json']);
    expect(stalePlan.code, stalePlan.stdout + staleLine(stalePlan)).toBe(0);
    const stalePayload = JSON.parse(stalePlan.stdout) as { action?: string; contextHash: string };
    expect(stalePayload.action).toBeUndefined(); // not current → re-planned
    expect(stalePayload.contextHash).not.toBe(planPayload.contextHash);
  }, 300_000);

  it('fails loud when the agent invents a citation', async () => {
    const dir = await makeProjectDir();
    await setupProject(dir);
    const fake = JSON.stringify({
      contract: 'comparison-matrix-proposal-v1',
      entries: [
        {
          methodId: 'fedavg',
          classification: 'required',
          rationale: 'cites a paper that was never provided',
          sources: ['paper-card:totally-made-up'],
        },
      ],
    });
    const failed = await runCli(
      dir,
      ['comparison', 'plan', '--json'],
      { IDEASEEK_FAKE_MATRIX_PLAN_OUTPUT: fake },
      300_000,
    );
    expect(failed.code, failed.stdout + failed.stderr).not.toBe(0);
    // The failure is the validation itself — no proposal artifact lands.
    const matrix = await runCli(dir, ['comparison', 'matrix', '--json']);
    const matrixPayload = JSON.parse(matrix.stdout) as {
      matrix: { agentProposal?: { applied: boolean } };
    };
    expect(matrixPayload.matrix.agentProposal?.applied ?? false).toBe(false);
  }, 300_000);
});

function staleLine(result: { stdout: string; stderr: string }): string {
  return result.stdout + result.stderr;
}
