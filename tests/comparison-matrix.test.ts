import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, makeProjectDir } from './helpers.js';
import { assertMatrixApprovable, type ComparisonMatrix } from '../src/comparison/matrix.js';

/**
 * Comparison Planner matrix (docs/FULL_RESEARCH_MODE.md 全量 comparison
 * 清单): deterministic classification from persisted evidence, editable
 * before --confirm, applying edits to the registry on confirm (required
 * flags drive the gate; excluded/blocked walk the state machine with the
 * rationale as reason). Paper-card candidates are listed, never
 * auto-registered. Nothing here launches runs.
 */

function runCli(
  cwd: string,
  args: string[],
  timeoutMs = 180_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
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
    paperEvidence: [{ paperRef: 'mcmahan17a', statement: 'FedAvg', evidence: 'p.1' }],
    contradictions: ['prior work disagrees'],
    novelty: { claim: 'drift term', uncertainty: 'thin', whyNotRestatement: 'adds a term' },
    mechanismChain: {
      designPrincipleLink: 'compensate drift',
      steps: [{ kind: 'observation', text: 'updates diverge' }],
    },
    nearestComparisons: [
      { methodId: 'fedavg', difference: 'adds term', evidence: 'table 2' },
      { methodId: 'moon', difference: 'adds drift term vs FedAvg', evidence: 'table 3' },
    ],
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

function baseMatrix(overrides: Partial<ComparisonMatrix> = {}): ComparisonMatrix {
  return {
    contract: 'comparison-matrix-v1',
    inputHash: 'sha256:' + 'a'.repeat(64),
    generatedAt: 1,
    context: { questions: [], venue: null, corpusPaperCards: 0, researchMapPresent: false },
    entries: [],
    blockers: [],
    ...overrides,
  };
}

async function setup(dir: string): Promise<void> {
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
  expect(
    (
      await runCli(dir, [
        'comparison',
        'register',
        'prox',
        '--repo',
        'https://example.org/prox.git',
        '--reference-only',
      ])
    ).code,
  ).toBe(0);
}

describe('assertMatrixApprovable (pure gates)', () => {
  it('accepts a fresh, blocker-free matrix', () => {
    const matrix = baseMatrix();
    expect(() => assertMatrixApprovable(matrix, matrix.inputHash)).not.toThrow();
  });

  it('refuses a stale matrix (state changed since review)', () => {
    const matrix = baseMatrix();
    expect(() => assertMatrixApprovable(matrix, 'sha256:' + 'f'.repeat(64))).toThrow(/stale/);
  });

  it('refuses a matrix with blockers and lists them', () => {
    const matrix = baseMatrix({ blockers: ['no comparison candidates — register a method'] });
    try {
      assertMatrixApprovable(matrix, matrix.inputHash);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as { code: string }).code).toBe('USER_INPUT_REQUIRED');
      expect((error as { message: string }).message).toContain('no comparison candidates');
    }
  });
});

describe('ideaseek comparison matrix (e2e)', () => {
  it('reports blockers on an empty project and refuses confirm', async () => {
    const dir = await makeProjectDir();

    const draft = await runCli(dir, ['comparison', 'matrix', '--json']);
    expect(draft.code, draft.stdout + draft.stderr).toBe(0);
    const payload = JSON.parse(draft.stdout) as {
      matrix: { blockers: string[]; entries: unknown[] };
    };
    expect(payload.matrix.blockers.join(' ')).toContain('no comparison candidates');
    expect(payload.matrix.entries).toEqual([]);

    const blocked = await runCli(dir, ['comparison', 'matrix', '--confirm']);
    expect(blocked.code).not.toBe(0);
    expect(blocked.stderr).toContain('blockers');

    // Confirm without any draft → actionable error.
    const emptyDir = await makeProjectDir();
    const missing = await runCli(emptyDir, ['comparison', 'matrix', '--confirm']);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('ideaseek comparison matrix');
  }, 180_000);

  it('classifies persisted evidence, applies edits on confirm, never auto-registers cards', async () => {
    const dir = await makeProjectDir();
    await setup(dir);

    const draft = await runCli(dir, ['comparison', 'matrix', '--json']);
    expect(draft.code, draft.stdout + draft.stderr).toBe(0);
    const built = JSON.parse(draft.stdout) as {
      matrix: ComparisonMatrix;
    };
    const entries = new Map(built.matrix.entries.map((entry) => [entry.methodId, entry]));
    expect(entries.get('fedavg')?.classification).toBe('required');
    expect(entries.get('fedavg')?.origin).toBe('registered');
    expect(entries.get('prox')?.classification).toBe('reference-only');
    // Paper-card nearest comparison surfaces as a listed candidate only.
    const moon = entries.get('moon');
    expect(moon?.classification).toBe('reference-only');
    expect(moon?.origin).toBe('paper-card');
    expect(moon?.implementation.identity).toBe('paper-card-only');
    expect(moon?.rationale).toContain('adds drift term');
    expect(built.matrix.context.questions.join(' ')).toContain('Drift term');
    expect(built.matrix.blockers).toEqual([]);

    // A run exists so the confirm Decision/Event is recorded.
    expect(
      (await runCli(dir, ['run', '--question', 'matrix confirm run', '--enqueue-only'])).code,
    ).toBe(0);

    // User edit: demote fedavg to reference-only → confirm applies it.
    const matrixPath = join(dir, 'knowledge', 'comparison-matrix.json');
    const edited = JSON.parse(await readFile(matrixPath, 'utf8')) as ComparisonMatrix;
    const fedavgEntry = edited.entries.find((entry) => entry.methodId === 'fedavg')!;
    fedavgEntry.classification = 'reference-only';
    await writeFile(matrixPath, JSON.stringify(edited, null, 2), 'utf8');

    const confirmed = await runCli(dir, ['comparison', 'matrix', '--confirm', '--json']);
    expect(confirmed.code, confirmed.stdout + confirmed.stderr).toBe(0);
    const confirmedPayload = JSON.parse(confirmed.stdout) as {
      confirmed: boolean;
      decisionSeq: number | null;
      applied: string[];
    };
    expect(confirmedPayload.confirmed).toBe(true);
    expect(confirmedPayload.applied).toContain('fedavg:required=false');
    expect(confirmedPayload.decisionSeq).not.toBeNull();

    const list = await runCli(dir, ['comparison', 'list', '--json']);
    const methods = (
      JSON.parse(list.stdout) as { methods: { methodId: string; required: boolean }[] }
    ).methods;
    expect(methods.find((m) => m.methodId === 'fedavg')?.required).toBe(false);
    // Card-only candidates were NOT auto-registered by confirm.
    expect(methods.find((m) => m.methodId === 'moon')).toBeUndefined();

    // State changed → confirm refuses as stale until the matrix is rebuilt.
    expect(
      (
        await runCli(dir, [
          'comparison',
          'register',
          'newone',
          '--repo',
          'https://example.org/new.git',
        ])
      ).code,
    ).toBe(0);
    const stale = await runCli(dir, ['comparison', 'matrix', '--confirm']);
    expect(stale.code).not.toBe(0);
    expect(stale.stderr).toContain('stale');

    // Rebuild refreshes (previous edits are superseded — their effect on
    // fedavg is already registry state), then exclude prox via an edit.
    expect((await runCli(dir, ['comparison', 'matrix', '--json'])).code).toBe(0);
    const refreshed = JSON.parse(await readFile(matrixPath, 'utf8')) as ComparisonMatrix;
    expect(refreshed.entries.find((entry) => entry.methodId === 'fedavg')?.classification).toBe(
      'reference-only',
    );
    expect(refreshed.entries.find((entry) => entry.methodId === 'newone')).toBeDefined();
    const proxEntry = refreshed.entries.find((entry) => entry.methodId === 'prox')!;
    proxEntry.classification = 'excluded';
    proxEntry.rationale = 'not comparable on this task (user decision)';
    await writeFile(matrixPath, JSON.stringify(refreshed, null, 2), 'utf8');

    const excluded = await runCli(dir, ['comparison', 'matrix', '--confirm', '--json']);
    expect(excluded.code, excluded.stdout + excluded.stderr).toBe(0);
    const excludedPayload = JSON.parse(excluded.stdout) as { applied: string[] };
    expect(excludedPayload.applied).toContain('prox:status=excluded');

    const after = await runCli(dir, ['comparison', 'list', '--json']);
    const afterMethods = (
      JSON.parse(after.stdout) as { methods: { methodId: string; status: string }[] }
    ).methods;
    expect(afterMethods.find((m) => m.methodId === 'prox')?.status).toBe('excluded');
  }, 300_000);
});
