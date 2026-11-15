import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import type { IdeaCard } from '../src/idea/card.js';
import { hashIdeaSource } from '../src/idea/workspace.js';
import type { IdeaCheckReport } from '../src/idea/check.js';
import { CLI_BIN } from './helpers.js';

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

describe('ideaseek idea scaffold + check (CLI)', () => {
  let project: string;
  let cardPath: string;

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'ideaseek-check-'));
    const init = await runCli(project, ['init']);
    expect(init.code).toBe(0);
    cardPath = join(project, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard('calib-reweight'), null, 2), 'utf8');
    const created = await runCli(project, [
      'idea',
      'create',
      'calib-reweight',
      '--from-card',
      cardPath,
    ]);
    expect(created.code).toBe(0);
  }, 60_000);

  async function scaffold(): Promise<{ created: string[]; skipped: string[] }> {
    const result = await runCli(project, ['idea', 'scaffold', 'calib-reweight', '--json']);
    expect(result.code, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout) as { created: string[]; skipped: string[] };
    return payload;
  }

  async function setImplementing(): Promise<void> {
    const result = await runCli(project, ['idea', 'set-status', 'calib-reweight', 'IMPLEMENTING']);
    expect(result.code).toBe(0);
  }

  it('creates a workspace that is already checkable, and scaffolds idempotently', async () => {
    // `idea create` used to leave src/ empty, so the first `idea check` on a
    // brand-new idea reported FAILED static — a verdict about code that was
    // never written. The workspace now arrives with the starter skeleton.
    const otherCard = join(project, 'other.json');
    await writeFile(otherCard, JSON.stringify(makeCard('never-written-idea'), null, 2), 'utf8');
    const fresh = await runCli(project, [
      'idea',
      'create',
      'never-written-idea',
      '--from-card',
      otherCard,
      '--json',
    ]);
    expect(fresh.code, fresh.stderr).toBe(0);
    const createdNow = JSON.parse(fresh.stdout) as { scaffolded: string[] };
    expect(createdNow.scaffolded).toEqual(
      expect.arrayContaining([
        'src/train.py',
        'src/check_data.py',
        'src/check_metrics.py',
        'src/smoke.py',
        'src/tests/test_smoke.py',
        'config/train.json',
        'data/synthetic.csv',
      ]),
    );

    // An explicit scaffold afterwards must never overwrite agent/user code.
    await writeFile(join(project, 'ideas', 'calib-reweight', 'src', 'train.py'), '# mine\n');
    const second = await scaffold();
    expect(second.created).toEqual([]);
    expect(second.skipped).toContain('src/train.py');
    const train = await readFile(
      join(project, 'ideas', 'calib-reweight', 'src', 'train.py'),
      'utf8',
    );
    expect(train).toBe('# mine\n');
  }, 60_000);

  it('reports an empty src/ as not implemented rather than as a failing check', async () => {
    const dir = join(project, 'ideas', 'calib-reweight');
    const { rm } = await import('node:fs/promises');
    await rm(join(dir, 'src'), { recursive: true, force: true });
    const result = await runCli(project, ['idea', 'check', 'calib-reweight']);
    // Exit 2: the input is missing. Nothing was run, so there is no verdict
    // about the idea, and 1 would invite someone to debug absent files.
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('NOT-IMPLEMENTED');
    expect(result.stdout).toContain('idea scaffold calib-reweight');
    expect(result.stdout).not.toContain('FAIL static');
  }, 60_000);

  it('resolves scaffolded dataset_ref through IDEASEEK_DATASET_ROOTS (skips without python)', async () => {
    await scaffold();
    const dataRoot = await mkdtemp(join(tmpdir(), 'ideaseek-dsroot-'));
    await mkdir(join(dataRoot, 'pacs', 'photo'), { recursive: true });
    await writeFile(join(dataRoot, 'pacs', 'photo', '1.jpg'), 'x', 'utf8');

    const cfgPath = join(project, 'ideas', 'calib-reweight', 'config', 'train.json');
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as Record<string, unknown>;
    cfg.dataset_ref = 'pacs';
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

    const ideaDir = join(project, 'ideas', 'calib-reweight');
    const runCheck = (roots: string) =>
      new Promise<{ code: number | null; err: string }>((resolvePromise) => {
        const child = spawn('python', ['src/check_data.py'], {
          cwd: ideaDir,
          env: { ...process.env, IDEASEEK_DATASET_ROOTS: roots },
        });
        let err = '';
        child.stderr.on('data', (chunk) => (err += String(chunk)));
        child.on('error', () => resolvePromise({ code: null, err }));
        child.on('close', (code) => resolvePromise({ code, err }));
      });

    const resolved = await runCheck(dataRoot);
    if (resolved.code === null) return; // no python on PATH: environment guard, not a failure
    expect(resolved.code, resolved.err).toBe(0);

    // A host with no configured read-only roots must fail loudly, not silently
    // fall back to a path baked into the scaffold.
    const unconfigured = await runCheck('');
    expect(unconfigured.code).toBe(2);
    expect(unconfigured.err).toContain('inputs.readonly_datasets');
  }, 120_000);

  it('passes the full ladder and advances IMPLEMENTING → SMOKE_TESTED', async () => {
    await setImplementing();
    await scaffold();

    const check = await runCli(project, ['idea', 'check', 'calib-reweight', '--json']);
    expect(check.code, check.stdout + check.stderr).toBe(0);
    const payload = JSON.parse(check.stdout) as {
      outcome: string;
      status: string;
      version: number;
      codeHash: string | null;
      phases: { phase: string; ok: boolean; skipped: boolean }[];
    };
    expect(payload.outcome).toBe('passed');
    expect(payload.status).toBe('SMOKE_TESTED');
    expect(payload.version).toBe(1);
    expect(payload.codeHash).toMatch(/^sha256:/);

    const byPhase = Object.fromEntries(payload.phases.map((p) => [p.phase, p]));
    expect(byPhase.static).toMatchObject({ ok: true, skipped: false });
    expect(byPhase['unit-tests']).toMatchObject({ ok: true, skipped: false });
    expect(byPhase.data).toMatchObject({ ok: true, skipped: false });
    expect(byPhase.metrics).toMatchObject({ ok: true, skipped: false });
    expect(byPhase.smoke).toMatchObject({ ok: true, skipped: false });

    // Report persisted and bound to idea + version + code hash.
    const report = JSON.parse(
      await readFile(
        join(project, 'ideas', 'calib-reweight', 'experiments', 'check-report.json'),
        'utf8',
      ),
    ) as IdeaCheckReport;
    expect(report.ideaId).toBe('calib-reweight');
    expect(report.version).toBe(1);
    expect(report.codeHash).toBe(payload.codeHash);
    expect(report.codeHash).toBe(await hashIdeaSource(project, 'calib-reweight'));

    // Scaffold smoke is explicitly synthetic — never full training.
    const smokeLog = await readFile(
      join(project, '.research', 'logs', 'idea-calib-reweight-smoke.log'),
      'utf8',
    );
    expect(smokeLog).toContain('"synthetic": true');
  }, 120_000);

  it('fails the static phase on broken code and keeps IMPLEMENTING', async () => {
    await setImplementing();
    await scaffold();
    await writeFile(
      join(project, 'ideas', 'calib-reweight', 'src', 'broken.py'),
      'def oops(:\n',
      'utf8',
    );

    const check = await runCli(project, ['idea', 'check', 'calib-reweight', '--json']);
    expect(check.code).toBe(1);
    const payload = JSON.parse(check.stdout) as {
      outcome: string;
      status: string;
      phases: { phase: string; ok: boolean; failureKind: string | null }[];
    };
    expect(payload.outcome).toBe('failed');
    expect(payload.status).toBe('IMPLEMENTING'); // implementation errors are fixed, not hypothesized away
    const staticPhase = payload.phases.find((p) => p.phase === 'static')!;
    expect(staticPhase.ok).toBe(false);
    expect(staticPhase.failureKind).toBe('syntax-error');

    const plain = await runCli(project, ['idea', 'check', 'calib-reweight']);
    expect(plain.code).toBe(1);
    expect(plain.stdout).toContain('FAIL static');
    expect(plain.stdout).toContain('rerun');
  }, 120_000);

  it('classifies a dependency failure in the unit-test phase', async () => {
    await setImplementing();
    await scaffold();
    await writeFile(
      join(project, 'ideas', 'calib-reweight', 'src', 'tests', 'test_broken.py'),
      'import definitely_missing_package_xyz\n\nclass T:\n    pass\n',
      'utf8',
    );

    const check = await runCli(project, ['idea', 'check', 'calib-reweight', '--json']);
    expect(check.code).toBe(1);
    const payload = JSON.parse(check.stdout) as {
      outcome: string;
      phases: { phase: string; ok: boolean; failureKind: string | null }[];
    };
    expect(payload.outcome).toBe('failed');
    const unit = payload.phases.find((p) => p.phase === 'unit-tests')!;
    expect(unit.ok).toBe(false);
    expect(unit.failureKind).toBe('missing-dependency');
  }, 120_000);

  it('fails the data interface check when the bound file disappears', async () => {
    await setImplementing();
    await scaffold();
    await rm(join(project, 'ideas', 'calib-reweight', 'data', 'synthetic.csv'));

    const check = await runCli(project, ['idea', 'check', 'calib-reweight', '--json']);
    expect(check.code).toBe(1);
    const payload = JSON.parse(check.stdout) as {
      phases: { phase: string; ok: boolean; summary?: string }[];
    };
    const data = payload.phases.find((p) => p.phase === 'data')!;
    expect(data.ok).toBe(false);
    expect(data.summary).toContain('missing data file');
  }, 120_000);

  it('fails the metrics check when metrics become non-runnable', async () => {
    await setImplementing();
    await scaffold();
    await writeFile(
      join(project, 'ideas', 'calib-reweight', 'src', 'check_metrics.py'),
      [
        'def compute_metrics():',
        '    return {"rare-class recall": 0.5}',
        '',
        'def main():',
        '    return 1',
        '',
        'if __name__ == "__main__":',
        '    raise SystemExit(main())',
        '',
      ].join('\n'),
      'utf8',
    );

    const check = await runCli(project, ['idea', 'check', 'calib-reweight', '--json']);
    expect(check.code).toBe(1);
    const payload = JSON.parse(check.stdout) as {
      phases: { phase: string; ok: boolean }[];
    };
    expect(payload.phases.find((p) => p.phase === 'metrics')!.ok).toBe(false);
  }, 120_000);

  it('reports smoke-missing without advancing the status', async () => {
    await setImplementing();
    await scaffold();
    await rm(join(project, 'ideas', 'calib-reweight', 'src', 'smoke.py'));

    const check = await runCli(project, ['idea', 'check', 'calib-reweight', '--json']);
    expect(check.code).toBe(0);
    const payload = JSON.parse(check.stdout) as {
      outcome: string;
      status: string;
      phases: { phase: string; skipped: boolean }[];
    };
    expect(payload.outcome).toBe('smoke-missing');
    expect(payload.status).toBe('IMPLEMENTING');
    expect(payload.phases.find((p) => p.phase === 'smoke')!.skipped).toBe(true);

    const plain = await runCli(project, ['idea', 'check', 'calib-reweight']);
    expect(plain.stdout).toContain('src/smoke.py');
  }, 120_000);

  it('binds check reports to the current idea version', async () => {
    await setImplementing();
    await scaffold();

    const revised = await runCli(project, [
      'idea',
      'revise',
      'calib-reweight',
      '--kind',
      'engineering',
      '--summary',
      'metric tweak',
      '--json',
    ]);
    expect(revised.code).toBe(0);

    const check = await runCli(project, ['idea', 'check', 'calib-reweight', '--json']);
    expect(check.code).toBe(0);
    const payload = JSON.parse(check.stdout) as { version: number; outcome: string };
    expect(payload.version).toBe(2);
    expect(payload.outcome).toBe('passed');

    // Re-check after the version bump still reflects v2 (idempotent overwrite).
    const again = await runCli(project, ['idea', 'check', 'calib-reweight', '--json']);
    expect(again.code).toBe(0);
    const report = JSON.parse(
      await readFile(
        join(project, 'ideas', 'calib-reweight', 'experiments', 'check-report.json'),
        'utf8',
      ),
    ) as IdeaCheckReport;
    expect(report.version).toBe(2);
  }, 120_000);

  it('rejects checks on unknown ideas and invalid config JSON fails static', async () => {
    const ghost = await runCli(project, ['idea', 'check', 'ghost-idea']);
    expect(ghost.code).not.toBe(0);
    expect(ghost.stderr).toContain('not found');

    await scaffold();
    await writeFile(
      join(project, 'ideas', 'calib-reweight', 'config', 'bad.json'),
      '{oops',
      'utf8',
    );
    const check = await runCli(project, ['idea', 'check', 'calib-reweight', '--json']);
    expect(check.code).toBe(1);
    const payload = JSON.parse(check.stdout) as {
      phases: { phase: string; ok: boolean; summary?: string }[];
    };
    const staticPhase = payload.phases.find((p) => p.phase === 'static')!;
    expect(staticPhase.ok).toBe(false);
    expect(staticPhase.summary).toContain('bad.json');
  }, 120_000);
});
