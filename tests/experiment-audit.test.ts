import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IdeaCard } from '../src/idea/card.js';
import { CLI_BIN } from './helpers.js';

/**
 * Capability 6 (Phase 4.5): experiment-audit/integrity → result gate.
 * Cross-model audit over the artifact bundle with field-path evidence,
 * verdict consistency rules, and a FAIL that blocks the handoff delivery
 * while WARN stays visible but non-blocking.
 */

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

function runCli(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 180_000,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1', ...env },
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

interface AuditPayload {
  ideaId: string;
  reused?: boolean;
  overallVerdict: string;
  checks: { id: string; verdict: string }[];
  claims: number;
  reviewerModel: string | null;
  eventSeq?: number | null;
  blocked?: string;
}

describe('ideaseek idea audit (ARIS experiment-audit backend)', () => {
  const ideaId = 'calib-reweight';

  async function setupExperimentIdea(): Promise<string> {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-audit-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    const cardPath = join(project, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard(ideaId), null, 2), 'utf8');
    expect((await runCli(project, ['idea', 'create', ideaId, '--from-card', cardPath])).code).toBe(
      0,
    );
    expect((await runCli(project, ['idea', 'set-status', ideaId, 'IMPLEMENTING'])).code).toBe(0);
    expect((await runCli(project, ['idea', 'scaffold', ideaId])).code).toBe(0);
    const check = await runCli(project, ['idea', 'check', ideaId, '--json']);
    expect(check.code, check.stdout + check.stderr).toBe(0);
    const experiment = await runCli(project, ['idea', 'experiment', ideaId, '--json']);
    expect(experiment.code, experiment.stdout + experiment.stderr).toBe(0);
    return project;
  }

  const auditFile = (project: string): string =>
    join(project, 'ideas', ideaId, 'experiments', 'audit.json');

  async function writeAuditFile(project: string, patch: Record<string, unknown>): Promise<void> {
    await writeFile(
      auditFile(project),
      JSON.stringify(
        {
          contract: 'experiment-audit-v1',
          ideaId,
          cardVersion: 1,
          inputHash: 'sha256:test',
          skills: {
            audit: { name: 'experiment-audit', sha256: 'x' },
            analyze: { name: 'analyze-results', sha256: 'x' },
          },
          generatedAt: 1,
          harnessRuntime: 'fake',
          reviewerModel: 'fake-model',
          overallVerdict: 'PASS',
          checks: [],
          claims: [],
          summary: 'ok',
          evidenceDigest: 'sha256:x',
          ...patch,
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  it('runs the audit, records the event and reuses unchanged evidence', async () => {
    const project = await setupExperimentIdea();
    expect((await runCli(project, ['run', '--question', 'audit', '--enqueue-only'])).code).toBe(0);

    const shown = await runCli(project, ['idea', 'audit', ideaId, '--harness', 'fake', '--json']);
    expect(shown.code, shown.stderr).toBe(0);
    const payload = JSON.parse(shown.stdout) as AuditPayload;
    expect(payload).toMatchObject({
      ideaId,
      reused: false,
      overallVerdict: 'PASS',
      reviewerModel: 'fake-model',
    });
    expect(payload.checks.length).toBeGreaterThanOrEqual(2);

    const file = JSON.parse(await readFile(auditFile(project), 'utf8')) as {
      contract: string;
      evidenceDigest: string;
      checks: { evidence: string }[];
    };
    expect(file.contract).toBe('experiment-audit-v1');
    expect(file.evidenceDigest).toMatch(/^sha256:/);
    expect(file.checks[0]!.evidence.length).toBeGreaterThan(3);

    const events = await runCli(project, ['events', '--json']);
    expect(events.stdout).toContain('experiment_audit');

    const second = await runCli(project, ['idea', 'audit', ideaId, '--harness', 'fake', '--json']);
    expect(second.code).toBe(0);
    expect((JSON.parse(second.stdout) as AuditPayload).reused).toBe(true);
  }, 300_000);

  it('a FAIL audit blocks the handoff delivery gate', async () => {
    const project = await setupExperimentIdea();
    await writeAuditFile(project, {
      overallVerdict: 'FAIL',
      summary: 'metrics do not match the plan primary metric',
      checks: [
        {
          id: 'score-normalization',
          verdict: 'FAIL',
          detail: 'reported metric differs from plan',
          evidence: 'plan.primaryMetric',
        },
      ],
    });

    const handoff = await runCli(project, ['idea', 'handoff', ideaId, '--json']);
    const payload = JSON.parse(handoff.stdout) as {
      handoffReady: boolean;
      blockers: string[];
    };
    expect(payload.handoffReady).toBe(false);
    expect(payload.blockers.join('\n')).toContain('experiment-audit FAIL');
    expect(payload.blockers.join('\n')).toContain('metrics do not match');
  }, 300_000);

  it('WARN audits stay visible but never block the gate', async () => {
    const project = await setupExperimentIdea();
    await writeAuditFile(project, {
      overallVerdict: 'WARN',
      summary: 'single-seed coverage note',
      checks: [
        {
          id: 'scope',
          verdict: 'WARN',
          detail: 'narrow slice',
          evidence: 'experiment.spec.dataSnapshotId',
        },
      ],
    });

    const handoff = await runCli(project, ['idea', 'handoff', ideaId, '--json']);
    const payload = JSON.parse(handoff.stdout) as { blockers: string[] };
    expect(payload.blockers.join('\n')).not.toContain('experiment-audit');
  }, 300_000);

  it('stale audits are ignored by the gate', async () => {
    const project = await setupExperimentIdea();
    await writeAuditFile(project, { cardVersion: 99, overallVerdict: 'FAIL', summary: 'stale' });

    const handoff = await runCli(project, ['idea', 'handoff', ideaId, '--json']);
    const payload = JSON.parse(handoff.stdout) as { blockers: string[] };
    expect(payload.blockers.join('\n')).not.toContain('experiment-audit');
  }, 300_000);

  it('refuses an overall verdict that contradicts its own checks', async () => {
    const project = await setupExperimentIdea();
    const failed = await runCli(project, ['idea', 'audit', ideaId, '--harness', 'fake'], {
      IDEASEEK_FAKE_AUDIT_OUTPUT: JSON.stringify({
        ideaId,
        cardVersion: 1,
        overallVerdict: 'PASS',
        checks: [
          {
            id: 'dead-code',
            verdict: 'FAIL',
            detail: 'unexecuted path',
            evidence: 'experiment.spec.command',
          },
        ],
        claims: [],
        summary: 's',
      }),
    });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('PARSE_FAILED');
    expect(failed.stderr).toContain('contradicts');
    await expect(readFile(auditFile(project), 'utf8')).rejects.toThrow();
  }, 180_000);

  it('maps quota blocks to exit 2 with nothing written, then recovers', async () => {
    const project = await setupExperimentIdea();
    const blocked = await runCli(project, ['idea', 'audit', ideaId, '--harness', 'fake'], {
      IDEASEEK_FAKE_BLOCK: 'QUOTA_EXHAUSTED',
    });
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain('QUOTA_EXHAUSTED');
    expect(blocked.stderr).toContain('nothing was written');
    await expect(readFile(auditFile(project), 'utf8')).rejects.toThrow();

    const recovered = await runCli(project, [
      'idea',
      'audit',
      ideaId,
      '--harness',
      'fake',
      '--json',
    ]);
    expect(recovered.code, recovered.stderr).toBe(0);
    expect((JSON.parse(recovered.stdout) as AuditPayload).overallVerdict).toBe('PASS');
  }, 300_000);
});
