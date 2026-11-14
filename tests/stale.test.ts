import { spawn } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, makeProjectDir } from './helpers.js';
import { staleExitCode, type StaleRow } from '../src/commands/stale.js';

/**
 * Unified increment-update difference preview (PRODUCT_REQUIREMENTS:
 * 增量更新有差异预览，用户知道哪些下游结果会失效): `ideaseek stale`
 * re-derives every hash-pinned artifact against current inputs and lists
 * status + what it invalidates + recovery. Exit 2 only for STALE rows
 * (unconfirmed = next-step hint; missing = nothing built yet).
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
    child.stdin.end();
  });
}

function row(overrides: Partial<StaleRow> = {}): StaleRow {
  return {
    id: 'x',
    scope: 'project',
    status: 'current',
    detail: '',
    invalidates: [],
    recovery: 'next',
    ...overrides,
  };
}

describe('staleExitCode', () => {
  it('exits 2 only for stale rows (unconfirmed/missing are hints)', () => {
    expect(staleExitCode([row()])).toBe(0);
    expect(staleExitCode([row({ status: 'missing' })])).toBe(0);
    expect(staleExitCode([row({ status: 'unconfirmed' })])).toBe(0);
    expect(staleExitCode([row(), row({ status: 'stale' })])).toBe(2);
  });
});

describe('ideaseek stale (difference preview)', () => {
  it('fresh project: everything missing, exit 0, every row has recovery', async () => {
    const dir = await makeProjectDir();
    const cardPath = join(dir, 'card.json');
    await writeFile(
      cardPath,
      JSON.stringify({
        ideaId: 'alpha',
        version: 1,
        parentVersion: null,
        status: 'DRAFT_COMPOSITION',
        hypothesis: { statement: 'Drift lifts recall.', targetProblem: 'gap' },
        paperEvidence: [{ paperRef: 'p1', statement: 'fedavg', evidence: 'p.1' }],
        contradictions: ['prior work disagrees'],
        novelty: { claim: 'term', uncertainty: 'thin', whyNotRestatement: 'new' },
        mechanismChain: {
          designPrincipleLink: 'x',
          steps: [{ kind: 'observation', text: 'y' }],
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
          metrics: ['dice'],
          ablations: ['w/o term'],
        },
        falsification: { conditions: ['no gain'] },
        budget: { maxRounds: 3, maxGpuMinutes: 60 },
        stopConditions: ['budget'],
        createdAt: 1,
      }),
      'utf8',
    );
    expect((await runCli(dir, ['idea', 'create', 'alpha', '--from-card', cardPath])).code).toBe(0);

    const result = await runCli(dir, ['stale', '--idea', 'alpha', '--json']);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      rows: { id: string; status: string; recovery: string; invalidates: string[] }[];
      summary: { stale: number; missing: number; current: number };
    };
    expect(payload.summary.stale).toBe(0);
    const ids = payload.rows.map((r) => r.id);
    expect(ids).toContain('full-plan:alpha');
    expect(ids).toContain('fairness:alpha');
    expect(ids).toContain('comparison-matrix');
    expect(ids).toContain('check-report:alpha');
    expect(ids).toContain('novelty:alpha');
    expect(ids).toContain('claim-audit:alpha');
    for (const r of payload.rows) {
      expect(r.recovery.length).toBeGreaterThan(0);
      if (r.status !== 'current') expect(r.invalidates.length).toBeGreaterThan(0);
    }
  }, 180_000);

  it('detects a code change invalidating the passing check report (exit 2)', async () => {
    const dir = await makeProjectDir();
    const cardPath = join(dir, 'card.json');
    await writeFile(
      cardPath,
      JSON.stringify({
        ideaId: 'alpha',
        version: 1,
        parentVersion: null,
        status: 'DRAFT_COMPOSITION',
        hypothesis: { statement: 'Drift lifts recall.', targetProblem: 'gap' },
        paperEvidence: [{ paperRef: 'p1', statement: 'fedavg', evidence: 'p.1' }],
        contradictions: ['prior work disagrees'],
        novelty: { claim: 'term', uncertainty: 'thin', whyNotRestatement: 'new' },
        mechanismChain: {
          designPrincipleLink: 'x',
          steps: [{ kind: 'observation', text: 'y' }],
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
          metrics: ['dice'],
          ablations: ['w/o term'],
        },
        falsification: { conditions: ['no gain'] },
        budget: { maxRounds: 3, maxGpuMinutes: 60 },
        stopConditions: ['budget'],
        createdAt: 1,
      }),
      'utf8',
    );
    expect((await runCli(dir, ['idea', 'create', 'alpha', '--from-card', cardPath])).code).toBe(0);
    expect((await runCli(dir, ['idea', 'set-status', 'alpha', 'IMPLEMENTING'])).code).toBe(0);
    expect((await runCli(dir, ['idea', 'scaffold', 'alpha'])).code).toBe(0);
    const trainPath = join(dir, 'ideas', 'alpha', 'src', 'train.py');
    await writeFile(
      trainPath,
      'import json\nprint(json.dumps({"metrics": {"dice": 0.5}}))\n',
      'utf8',
    );
    const trainCfg = join(dir, 'ideas', 'alpha', 'config', 'train.json');
    const cfg = JSON.parse(await readFile(trainCfg, 'utf8')) as Record<string, unknown>;
    cfg.seeds = [42, 7];
    await writeFile(trainCfg, JSON.stringify(cfg), 'utf8');
    expect((await runCli(dir, ['idea', 'check', 'alpha'])).code).toBe(0);

    // Fresh check → current (exit 0 on the check row).
    const before = await runCli(dir, ['stale', '--idea', 'alpha', '--json']);
    const beforePayload = JSON.parse(before.stdout) as {
      rows: { id: string; status: string }[];
    };
    const checkBefore = beforePayload.rows.find((r) => r.id === 'check-report:alpha');
    expect(checkBefore?.status).toBe('current');
    expect(before.code).toBe(0);

    // Touch the code → the passing check is stale; preview exits 2 with
    // the exact downstream impact and recovery.
    await appendFile(trainPath, '# touched\n', 'utf8');
    const after = await runCli(dir, ['stale', '--idea', 'alpha', '--json']);
    expect(after.code).toBe(2);
    const afterPayload = JSON.parse(after.stdout) as {
      rows: {
        id: string;
        status: string;
        detail: string;
        invalidates: string[];
        recovery: string;
      }[];
    };
    const checkAfter = afterPayload.rows.find((r) => r.id === 'check-report:alpha')!;
    expect(checkAfter.status).toBe('stale');
    expect(checkAfter.detail).toContain('code changed');
    expect(checkAfter.invalidates.join(' ')).toContain('idea experiment');
    expect(checkAfter.recovery).toContain('idea check');
  }, 180_000);

  it('detects matrix staleness after a new comparison registers', async () => {
    const dir = await makeProjectDir();
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
    expect((await runCli(dir, ['comparison', 'matrix', '--json'])).code).toBe(0);

    const fresh = await runCli(dir, ['stale', '--json']);
    const freshPayload = JSON.parse(fresh.stdout) as { rows: { id: string; status: string }[] };
    expect(freshPayload.rows.find((r) => r.id === 'comparison-matrix')?.status).toBe('current');

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
    const stale = await runCli(dir, ['stale', '--json']);
    expect(stale.code).toBe(2);
    const payload = JSON.parse(stale.stdout) as {
      rows: { id: string; status: string; invalidates: string[]; recovery: string }[];
    };
    const matrix = payload.rows.find((r) => r.id === 'comparison-matrix')!;
    expect(matrix.status).toBe('stale');
    expect(matrix.invalidates.join(' ')).toContain('matrix --confirm');
    expect(matrix.recovery).toContain('comparison matrix');
  }, 180_000);

  it('detects worktree drift after passing smoke and blocks comparison gate', async () => {
    const dir = await makeProjectDir();
    const { mkdir } = await import('node:fs/promises');
    const { openRuntime } = await import('./helpers.js');
    const worktree = join(dir, 'comparisons', 'fedavg', 'worktree');
    await mkdir(worktree, { recursive: true });
    await writeFile(join(worktree, 'train.py'), 'print("ok")\n', 'utf8');

    const rt = await openRuntime(dir, { recover: false });
    try {
      await rt.db.upsertComparison({
        methodId: 'fedavg',
        status: 'implemented',
        required: true,
        record: {
          methodId: 'fedavg',
          paperRefs: ['p1'],
          required: true,
          sourceKind: 'user',
          entry: ['node', '-e', 'process.exit(0)'],
          notes: [],
          status: 'implemented',
          createdAt: 1,
          updatedAt: 1,
        },
        updatedAt: 1,
      });
    } finally {
      await rt.close();
    }

    const smoked = await runCli(dir, ['comparison', 'smoke', 'fedavg', '--json']);
    expect(smoked.code, smoked.stdout + smoked.stderr).toBe(0);
    expect((await runCli(dir, ['comparison', 'gate', '--json'])).code).toBe(0);

    // Coding turn modifies the worktree without re-smoking.
    await writeFile(join(worktree, 'train.py'), 'raise RuntimeError("broken")\n', 'utf8');
    const stale = await runCli(dir, ['stale', '--json']);
    expect(stale.code).toBe(2);
    const rows = (JSON.parse(stale.stdout) as { rows: { id: string; status: string }[] }).rows;
    expect(rows.find((r) => r.id === 'comparison-worktree:fedavg')?.status).toBe('stale');

    const gated = await runCli(dir, ['comparison', 'gate', '--json']);
    expect(gated.code).toBe(2);
  }, 180_000);

  it('detects unversioned idea.json edits as stale for claim-audit and novelty', async () => {
    const dir = await makeProjectDir();
    const cardPath = join(dir, 'card.json');
    const card = {
      ideaId: 'alpha',
      version: 1,
      parentVersion: null,
      status: 'DRAFT_COMPOSITION',
      hypothesis: { statement: 'Drift lifts recall.', targetProblem: 'gap' },
      paperEvidence: [{ paperRef: 'p1', statement: 'fedavg', evidence: 'p.1' }],
      contradictions: ['prior work disagrees'],
      novelty: { claim: 'term', uncertainty: 'thin', whyNotRestatement: 'new' },
      mechanismChain: {
        designPrincipleLink: 'x',
        steps: [{ kind: 'observation', text: 'y' }],
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
        metrics: ['dice'],
        ablations: ['w/o term'],
      },
      falsification: { conditions: ['no gain'] },
      budget: { maxRounds: 3, maxGpuMinutes: 60 },
      stopConditions: ['budget'],
      createdAt: 1,
    };
    await writeFile(cardPath, JSON.stringify(card), 'utf8');
    expect(
      (
        await runCli(dir, [
          'comparison',
          'register',
          'fedavg',
          '--repo',
          'https://example.org/f.git',
        ])
      ).code,
    ).toBe(0);
    expect((await runCli(dir, ['idea', 'create', 'alpha', '--from-card', cardPath])).code).toBe(0);
    expect((await runCli(dir, ['idea', 'claim-audit', 'alpha', '--json'])).code).toBe(0);
    expect(
      (await runCli(dir, ['idea', 'novelty', 'alpha', '--harness', 'fake', '--json'])).code,
    ).toBe(0);
    expect(
      (await runCli(dir, ['idea', 'review', 'alpha', '--harness', 'fake', '--json'])).code,
    ).toBe(0);

    // Edit idea.json directly (e.g. from Coding) without bumping currentVersion.
    const edited = {
      ...card,
      hypothesis: { statement: 'Completely different hypothesis.', targetProblem: 'gap' },
    };
    await writeFile(
      join(dir, 'ideas', 'alpha', 'idea.json'),
      JSON.stringify(edited, null, 2),
      'utf8',
    );

    const stale = await runCli(dir, ['stale', '--idea', 'alpha', '--json']);
    expect(stale.code).toBe(2);
    const rows = (JSON.parse(stale.stdout) as { rows: { id: string; status: string }[] }).rows;
    expect(rows.find((r) => r.id === 'claim-audit:alpha')?.status).toBe('stale');
    expect(rows.find((r) => r.id === 'novelty:alpha')?.status).toBe('stale');
    expect(rows.find((r) => r.id === 'review:alpha')?.status).toBe('stale');
  }, 180_000);
});
