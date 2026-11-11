import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IdeaCard } from '../src/idea/card.js';
import { CLI_BIN } from './helpers.js';

/**
 * Capability 5 (Phase 4.5): fresh-context independent reviewer → Review
 * artifact/Decision. Each round is a new harness task over the artifact
 * bundle only; reviewerModel is stamped from the harness result; ARIS STOP
 * (score ≥6 and ready/almost) gates experiments with an audited waiver.
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
  timeoutMs = 120_000,
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

interface ReviewPayload {
  ideaId: string;
  reused?: boolean;
  round: number;
  score: number;
  verdict: string;
  passing: boolean;
  reviewerModel: string | null;
  eventSeq?: number | null;
  blocked?: string;
}

describe('ideaseek idea review (ARIS auto-review-loop backend)', () => {
  const ideaId = 'calib-reweight';

  async function setupCheckedIdea(): Promise<string> {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-review-'));
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
    return project;
  }

  const roundFile = (project: string, round: number): string =>
    join(project, 'ideas', ideaId, 'reviews', `round-${round}.json`);

  it('runs a fresh-context round, stamps the reviewer and records the event', async () => {
    const project = await setupCheckedIdea();
    expect((await runCli(project, ['run', '--question', 'review', '--enqueue-only'])).code).toBe(0);

    const shown = await runCli(project, ['idea', 'review', ideaId, '--harness', 'fake', '--json']);
    expect(shown.code, shown.stderr).toBe(0);
    const payload = JSON.parse(shown.stdout) as ReviewPayload;
    expect(payload).toMatchObject({
      ideaId,
      round: 1,
      score: 7,
      verdict: 'ready',
      passing: true,
      reviewerModel: 'fake-model',
    });

    const round = JSON.parse(await readFile(roundFile(project, 1), 'utf8')) as {
      contract: string;
      evidenceDigest: string;
      weaknesses: unknown[];
      reviewerModel: string;
    };
    expect(round.contract).toBe('idea-review-v1');
    expect(round.evidenceDigest).toMatch(/^sha256:/);
    expect(round.weaknesses.length).toBeGreaterThan(0);
    expect(round.reviewerModel).toBe('fake-model');

    const events = await runCli(project, ['events', '--json']);
    expect(events.stdout).toContain('idea_review');
    expect(events.stdout).toContain('score 7/10');
  }, 180_000);

  it('reuses an unchanged-evidence round; --force starts a new independent round', async () => {
    const project = await setupCheckedIdea();
    const first = await runCli(project, ['idea', 'review', ideaId, '--harness', 'fake', '--json']);
    expect(first.code).toBe(0);

    const second = await runCli(project, ['idea', 'review', ideaId, '--harness', 'fake', '--json']);
    expect(second.code).toBe(0);
    const reused = JSON.parse(second.stdout) as ReviewPayload;
    expect(reused.reused).toBe(true);
    expect(reused.round).toBe(1);

    const forced = await runCli(project, [
      'idea',
      'review',
      ideaId,
      '--harness',
      'fake',
      '--force',
      '--json',
    ]);
    expect(forced.code).toBe(0);
    const round2 = JSON.parse(forced.stdout) as ReviewPayload;
    expect(round2.reused).toBe(false);
    expect(round2.round).toBe(2);
    await readFile(roundFile(project, 2), 'utf8');
  }, 180_000);

  it('blocks experiments on a failing review until waived with a reason', async () => {
    const project = await setupCheckedIdea();
    expect(
      (await runCli(project, ['run', '--question', 'review gate', '--enqueue-only'])).code,
    ).toBe(0);

    const failing = await runCli(
      project,
      ['idea', 'review', ideaId, '--harness', 'fake', '--json'],
      {
        IDEASEEK_FAKE_REVIEW_OUTPUT: JSON.stringify({
          ideaId,
          cardVersion: 1,
          round: 1,
          score: 3,
          verdict: 'not ready',
          summary: 'results do not support the mechanism claim',
          weaknesses: [{ severity: 'major', text: 'no baseline delta recorded' }],
          questions: [],
        }),
      },
    );
    expect(failing.code, failing.stderr).toBe(0);
    expect((JSON.parse(failing.stdout) as ReviewPayload).passing).toBe(false);

    const blocked = await runCli(project, ['idea', 'experiment', ideaId]);
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain('independent review round 1 is failing');
    expect(blocked.stderr).toContain('--waive-review');

    const waived = await runCli(project, [
      'idea',
      'experiment',
      ideaId,
      '--waive-review',
      'weakness tracked for the quick scale',
      '--json',
    ]);
    expect(waived.code, waived.stdout + waived.stderr).toBe(0);
    expect((JSON.parse(waived.stdout) as { waiverSeq: number }).waiverSeq).toBeGreaterThan(0);

    const events = await runCli(project, ['events', '--json']);
    expect(events.stdout).toContain('review-waived');
    expect(events.stdout).toContain('weakness tracked');
  }, 300_000);

  it('stale reviews neither block nor annotate', async () => {
    const project = await setupCheckedIdea();
    await mkdir(join(project, 'ideas', ideaId, 'reviews'), { recursive: true });
    await writeFile(
      roundFile(project, 1),
      JSON.stringify(
        {
          contract: 'idea-review-v1',
          ideaId,
          cardVersion: 99,
          round: 1,
          inputHash: 'sha256:x',
          skill: { name: 'auto-review-loop', sha256: 'x' },
          generatedAt: 1,
          harnessRuntime: 'fake',
          reviewerModel: 'fake-model',
          score: 1,
          verdict: 'not ready',
          summary: 'stale',
          weaknesses: [{ severity: 'major', text: 'stale' }],
          questions: [],
          evidenceDigest: 'sha256:x',
        },
        null,
        2,
      ),
      'utf8',
    );
    const experiment = await runCli(project, ['idea', 'experiment', ideaId, '--json']);
    expect(experiment.code, experiment.stdout + experiment.stderr).toBe(0);
    expect((JSON.parse(experiment.stdout) as { waiverSeq: number | null }).waiverSeq).toBeNull();
  }, 300_000);

  it('rejects malformed review output without writing the round', async () => {
    const project = await setupCheckedIdea();
    const failed = await runCli(project, ['idea', 'review', ideaId, '--harness', 'fake'], {
      IDEASEEK_FAKE_REVIEW_OUTPUT: JSON.stringify({
        ideaId,
        cardVersion: 1,
        round: 1,
        score: 9,
        verdict: 'ready',
        summary: 's',
        weaknesses: [],
        questions: [],
      }),
    });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('PARSE_FAILED');
    expect(failed.stderr).toContain('weaknesses');
    await expect(readFile(roundFile(project, 1), 'utf8')).rejects.toThrow();
  }, 180_000);

  it('maps quota blocks to exit 2 with nothing written, then recovers', async () => {
    const project = await setupCheckedIdea();
    const blocked = await runCli(project, ['idea', 'review', ideaId, '--harness', 'fake'], {
      IDEASEEK_FAKE_BLOCK: 'QUOTA_EXHAUSTED',
    });
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain('QUOTA_EXHAUSTED');
    expect(blocked.stderr).toContain('nothing was written');
    await expect(readFile(roundFile(project, 1), 'utf8')).rejects.toThrow();

    const recovered = await runCli(project, [
      'idea',
      'review',
      ideaId,
      '--harness',
      'fake',
      '--json',
    ]);
    expect(recovered.code, recovered.stderr).toBe(0);
    expect((JSON.parse(recovered.stdout) as ReviewPayload).passing).toBe(true);
  }, 180_000);
});
