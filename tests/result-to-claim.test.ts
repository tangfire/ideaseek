import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, createDemoRun, makeProjectDir, openRuntime } from './helpers.js';
import { runResultToClaim } from '../src/idea/result-to-claim.js';
import { runClaimAudit } from '../src/idea/claim-audit.js';
import { collectReviewInputs } from '../src/review/inputs.js';

/**
 * result-to-claim + full-run audit/reviewer wiring (docs/FULL_RESEARCH_MODE
 * 图表与论文: 论文 claim 必须经过 result-to-claim、claim audit 和独立
 * reviewer): deterministic derivation from full-run registry results,
 * claim-audit integrity checks over the full-run report ↔ registry, and
 * reviewer inputs that include full-run evidence (comparison specs have
 * idea=null and never write workspace mirrors). Seeded registry only —
 * no model calls, no GPU.
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

interface SeedOptions {
  ideaValue?: number;
  baselineValue?: number;
  withReport?: boolean;
  /** When set, the report claims success for a spec the registry lacks. */
  ghostSpecId?: string;
}

/** Creates idea alpha + a seeded full-run registry state. */
async function seedFullRunState(dir: string, opts: SeedOptions = {}): Promise<void> {
  const ideaValue = opts.ideaValue ?? 0.5;
  const baselineValue = opts.baselineValue ?? 0.42;
  const cardPath = join(dir, 'card.json');
  await writeFile(cardPath, JSON.stringify(makeCard('alpha')), 'utf8');
  expect((await runCli(dir, ['idea', 'create', 'alpha', '--from-card', cardPath])).code).toBe(0);

  const rt = await openRuntime(dir, { recover: false });
  try {
    await rt.db.lockProtocol({
      protocolId: 'proto-rtc-v1',
      protocolHash: 'sha256:' + '1'.repeat(64),
      lockedAt: 1,
      confirmedBy: 'tester',
      record: {
        protocolId: 'proto-rtc-v1',
        primaryMetrics: [{ name: 'rare-class recall', direction: 'higher' }],
        supportCriteria: ['rare-class recall ≥ baseline + 0.02 on quick slice'],
      },
    });
    await rt.db.upsertComparison({
      methodId: 'fedavg',
      status: 'validated',
      required: true,
      record: { methodId: 'fedavg', paperRefs: [], required: true, sourceKind: 'user', notes: [] },
      updatedAt: 1,
    });

    const ideaSpec = {
      specId: 'idea-alpha',
      version: 2,
      idea: { ideaId: 'alpha', version: 1 },
      comparisonIds: ['fedavg'],
      codeCommit: null,
      dataSnapshotId: 'synthetic:full',
      sliceIds: [],
      environment: { python: 'v24', notes: ['scale:full'] },
      command: ['python', 'src/train.py', '--scale', 'full'],
      metrics: [{ name: 'rare-class recall', direction: 'higher' }],
      seeds: [42, 7],
      resources: {},
      budget: { maxRuns: 1, maxMinutes: 60 },
      protocolId: 'proto-rtc-v1',
      createdAt: 1,
    };
    await rt.db.upsertExperiment({
      specId: 'idea-alpha',
      version: 2,
      specHash: 'sha256:' + '2'.repeat(64),
      status: 'succeeded',
      spec: ideaSpec,
      result: {
        specId: 'idea-alpha',
        status: 'succeeded',
        logRefs: [],
        artifactRefs: [],
        metrics: [{ name: 'rare-class recall', value: ideaValue }],
        resourcesUsed: {},
        failure: null,
        startedAt: 1,
        finishedAt: 2,
      },
      updatedAt: 2,
    });
    await rt.db.upsertExperiment({
      specId: 'full-fedavg',
      version: 1,
      specHash: 'sha256:' + '3'.repeat(64),
      status: 'succeeded',
      spec: {
        ...ideaSpec,
        specId: 'full-fedavg',
        version: 1,
        idea: null,
        command: ['python', 'eval.py'],
        environment: { python: 'v24', notes: ['scale:full', 'method:fedavg'] },
      },
      result: {
        specId: 'full-fedavg',
        status: 'succeeded',
        logRefs: [],
        artifactRefs: [],
        metrics: [{ name: 'rare-class recall', value: baselineValue }],
        resourcesUsed: {},
        failure: null,
        startedAt: 1,
        finishedAt: 2,
      },
      updatedAt: 2,
    });

    if (opts.withReport !== false) {
      const run = await createDemoRun(rt, 'result-to-claim seed');
      const task = await rt.db.claimNextTask(run.runId, 'seed-worker', { leaseMs: 60_000 });
      const items = [
        { kind: 'comparison', id: 'fedavg', specId: 'full-fedavg', status: 'succeeded' },
        { kind: 'idea', id: 'alpha', specId: 'idea-alpha', status: 'succeeded' },
      ];
      if (opts.ghostSpecId) {
        items.push({
          kind: 'comparison',
          id: 'ghost',
          specId: opts.ghostSpecId,
          status: 'succeeded',
        });
      }
      const staged = await rt.store.stage(
        'full-run-report',
        `${JSON.stringify(
          {
            contract: 'full-run-report-v1',
            ideaId: 'alpha',
            planInputHash: 'sha256:' + '4'.repeat(64),
            finishedAt: 3,
            items,
          },
          null,
          2,
        )}\n`,
        { ideaId: 'alpha' },
      );
      await rt.db.beginCommit({
        taskId: task!.taskId,
        workerId: 'seed-worker',
        attempt: task!.attempt,
        artifacts: [
          {
            kind: 'full-run-report',
            tempPath: staged.tempPath,
            contentHash: staged.contentHash,
            size: staged.size,
            meta: staged.meta,
          },
        ],
        result: { summary: 'seeded', artifacts: [] },
      });
      await rt.store.promote([staged]);
      await rt.db.finalizeCommit({ taskId: task!.taskId, workerId: 'seed-worker' });
    }
  } finally {
    await rt.close();
  }
}

describe('result-to-claim (deterministic derivation)', () => {
  it('derives a supported claim from full-run results with hashed evidence', async () => {
    const dir = await makeProjectDir();
    await seedFullRunState(dir);

    const claim = await runResultToClaim(dir, 'alpha');
    expect(claim.gaps).toEqual([]);
    expect(claim.planInputHash).toBe('sha256:' + '4'.repeat(64));
    expect(claim.claims).toHaveLength(1);
    const primary = claim.claims[0]!;
    expect(primary.metric).toBe('rare-class recall');
    expect(primary.support).toBe('supported');
    expect(primary.ideaValue).toBe(0.5);
    expect(primary.baselineValue).toBe(0.42);
    expect(primary.delta!).toBeCloseTo(0.08, 10);
    expect(primary.statement).toContain('Drift term lifts rare-class recall');
    expect(primary.protocolCriteria.join(' ')).toContain('baseline + 0.02');
    const specs = new Set(primary.evidence.map((e) => e.specId));
    expect(specs).toEqual(new Set(['idea-alpha', 'full-fedavg']));
    for (const evidence of primary.evidence) {
      expect(evidence.specHash).toMatch(/^sha256:/);
    }
  });

  it('derives not-supported when the idea loses to the baseline', async () => {
    const dir = await makeProjectDir();
    await seedFullRunState(dir, { ideaValue: 0.3, baselineValue: 0.42 });
    const claim = await runResultToClaim(dir, 'alpha');
    const primary = claim.claims[0]!;
    expect(primary.support).toBe('not-supported');
    expect(primary.delta!).toBeLessThan(0);
  });

  it('reports honest gaps when no full-run report exists', async () => {
    const dir = await makeProjectDir();
    await seedFullRunState(dir, { withReport: false });
    const claim = await runResultToClaim(dir, 'alpha');
    expect(claim.gaps.join(' ')).toContain('no full-run report');
    expect(claim.gaps.join(' ')).toContain('ideaseek full run');
    expect(claim.claims[0]!.support).toBe('insufficient');
    expect(claim.claims[0]!.evidence).toEqual([]);
  });

  it('refuses to ground a claim when the report and registry disagree', async () => {
    const dir = await makeProjectDir();
    await seedFullRunState(dir, { ghostSpecId: 'full-ghost' });
    const claim = await runResultToClaim(dir, 'alpha');
    expect(claim.gaps.join(' ')).toContain('full-ghost');
    expect(claim.gaps.join(' ')).toContain('registry');
    // The backed items still derive — the ghost is a gap, not evidence.
    expect(claim.claims[0]!.support).toBe('supported');
  });
});

describe('full-run wiring: claim audit + reviewer inputs + CLI', () => {
  it('claim audit cross-checks the full-run report against the registry', async () => {
    const dir = await makeProjectDir();
    await seedFullRunState(dir);

    const audit = await runClaimAudit(dir, 'alpha');
    const fullChecks = audit.checks.filter((check) => check.kind === 'full-run-result');
    expect(fullChecks.length).toBeGreaterThanOrEqual(2);
    expect(fullChecks.every((check) => check.verdict === 'found')).toBe(true);

    // Corrupt the registry → the audit must FAIL (integrity, not vibes).
    const rt = await openRuntime(dir, { recover: false });
    try {
      const doc = await rt.db.getExperiment('full-fedavg');
      await rt.db.upsertExperiment({
        specId: 'full-fedavg',
        // A different hash is required: same-hash upserts only refresh the
        // timestamp (idempotent re-record) and would not corrupt anything.
        version: doc!.version + 1,
        specHash: 'sha256:' + '9'.repeat(64),
        status: 'failed',
        spec: doc!.spec,
        result: null,
        updatedAt: 9,
      });
    } finally {
      await rt.close();
    }
    const corrupted = await runClaimAudit(dir, 'alpha');
    expect(corrupted.verdict).toBe('fail');
    const bad = corrupted.checks.find((check) => check.ref === 'full-fedavg');
    expect(bad?.verdict).toBe('missing');
  });

  it('reviewer inputs include the full-run report and registry results', async () => {
    const dir = await makeProjectDir();
    await seedFullRunState(dir);
    const rt = await openRuntime(dir, { recover: false });
    try {
      const collected = await collectReviewInputs(rt, 'alpha', 'idea-review');
      const refs = collected.inputs.map((input) => input.ref);
      expect(refs.some((ref) => ref.startsWith('artifact:full-run-report/'))).toBe(true);
      expect(refs).toContain('registry:full-fedavg');
      expect(refs).toContain('registry:idea-alpha');
      for (const input of collected.inputs) {
        expect(input.sha256).toMatch(/^sha256:/);
        expect(input.content.length).toBeGreaterThan(0);
      }
    } finally {
      await rt.close();
    }
  });

  it('idea result-to-claim CLI writes the artifact and reports gaps honestly', async () => {
    const dir = await makeProjectDir();
    await seedFullRunState(dir);

    const ok = await runCli(dir, ['idea', 'result-to-claim', 'alpha', '--json']);
    expect(ok.code, ok.stdout + ok.stderr).toBe(0);
    const payload = JSON.parse(ok.stdout) as {
      claims: { support: string }[];
      gaps: string[];
    };
    expect(payload.claims[0]!.support).toBe('supported');
    expect(payload.gaps).toEqual([]);
    expect(existsSync(join(dir, 'ideas', 'alpha', 'experiments', 'result-to-claim.json'))).toBe(
      true,
    );

    // Fresh idea without a full-run → exit 2 with recovery gaps.
    const cardPath = join(dir, 'card2.json');
    await writeFile(cardPath, JSON.stringify(makeCard('beta')), 'utf8');
    expect((await runCli(dir, ['idea', 'create', 'beta', '--from-card', cardPath])).code).toBe(0);
    const gaps = await runCli(dir, ['idea', 'result-to-claim', 'beta', '--json']);
    expect(gaps.code).toBe(2);
    const gapPayload = JSON.parse(gaps.stdout) as { gaps: string[] };
    expect(gapPayload.gaps.join(' ')).toContain('no full-run report');
  }, 180_000);
});
