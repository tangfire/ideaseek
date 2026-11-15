import { spawn } from 'node:child_process';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IdeaCard } from '../src/idea/card.js';
import { CLI_BIN, implementIdeaSmoke } from './helpers.js';

/**
 * `idea review` CLI over the SINGLE default backend (src/review, ADR-009):
 * fresh-context idea reviews with append-only versions, reuse, the
 * experiment gate (fail → --waive-review with a Decision/Event) and
 * quota-block recovery. Backend conformance lives in tests/review.test.ts.
 */

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

const FAILING_REVIEW = JSON.stringify({
  score: 3,
  verdict: 'not ready',
  summary: 'results do not support the mechanism claim',
  weaknesses: [
    { severity: 'major', detail: 'no baseline delta recorded', minimumFix: 'run the baseline' },
  ],
  questions: [],
});

interface ReviewPayload {
  ideaId: string;
  version: number;
  reused: boolean;
  score: number;
  verdict: string;
  passing: boolean;
  reviewerModel?: string | null;
  reviewer?: { model: string | null };
  eventSeq?: number | null;
}

describe('ideaseek idea review (ARIS auto-review-loop backend)', () => {
  const ideaId = 'calib-reweight';

  async function setupCheckedIdea(withExperiment = false): Promise<string> {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-ireview-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    const cardPath = join(project, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard(ideaId)), 'utf8');
    expect((await runCli(project, ['idea', 'create', ideaId, '--from-card', cardPath])).code).toBe(
      0,
    );
    expect((await runCli(project, ['idea', 'set-status', ideaId, 'IMPLEMENTING'])).code).toBe(0);
    expect((await runCli(project, ['idea', 'scaffold', ideaId])).code).toBe(0);
    // The scaffold's smoke declares itself synthetic, which `idea check`
    // now refuses; a fixture that needs a passed check must compute.
    await implementIdeaSmoke(project, ideaId);
    const check = await runCli(project, ['idea', 'check', ideaId, '--json']);
    expect(check.code, check.stdout + check.stderr).toBe(0);
    if (withExperiment) {
      const experiment = await runCli(project, ['idea', 'experiment', ideaId, '--json']);
      expect(experiment.code, experiment.stdout + experiment.stderr).toBe(0);
    }
    return project;
  }

  const reviewsDir = (project: string): string => join(project, 'knowledge', 'reviews', ideaId);

  it('runs a fresh-context review, reuses identical inputs and stamps the reviewer', async () => {
    const project = await setupCheckedIdea();
    expect((await runCli(project, ['run', '--question', 'review', '--enqueue-only'])).code).toBe(0);

    const first = await runCli(project, ['idea', 'review', ideaId, '--harness', 'fake', '--json']);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    const payload = JSON.parse(first.stdout) as ReviewPayload;
    expect(payload).toMatchObject({
      ideaId,
      version: 1,
      reused: false,
      score: 7,
      verdict: 'ready',
      passing: true,
    });
    expect(payload.reviewer?.model ?? payload.reviewerModel).toBeTruthy();

    const again = await runCli(project, ['idea', 'review', ideaId, '--harness', 'fake', '--json']);
    expect(again.code).toBe(0);
    const reused = JSON.parse(again.stdout) as ReviewPayload;
    expect(reused.reused).toBe(true);
    expect(reused.version).toBe(1);

    const files = await readdir(reviewsDir(project));
    expect(files.filter((name) => name.startsWith('idea-review-v')).length).toBe(1);

    const events = await runCli(project, ['events', '--json']);
    expect(events.stdout).toContain('idea-review idea');
  }, 180_000);

  it('--force appends a NEW independent version (append-only history)', async () => {
    const project = await setupCheckedIdea();
    const forced = await runCli(project, [
      'idea',
      'review',
      ideaId,
      '--harness',
      'fake',
      '--force',
      '--json',
    ]);
    expect(forced.code, forced.stderr).toBe(0);
    expect((JSON.parse(forced.stdout) as ReviewPayload).version).toBe(1);
    const forced2 = await runCli(project, [
      'idea',
      'review',
      ideaId,
      '--harness',
      'fake',
      '--force',
      '--json',
    ]);
    expect((JSON.parse(forced2.stdout) as ReviewPayload).version).toBe(2);
    const files = await readdir(reviewsDir(project));
    expect(files.filter((name) => name.startsWith('idea-review-v')).sort()).toEqual([
      'idea-review-v1.json',
      'idea-review-v2.json',
    ]);
  }, 180_000);

  it('a failing review blocks experiments until waived with a Decision', async () => {
    const project = await setupCheckedIdea();
    expect(
      (await runCli(project, ['run', '--question', 'review gate', '--enqueue-only'])).code,
    ).toBe(0);

    const failing = await runCli(
      project,
      ['idea', 'review', ideaId, '--harness', 'fake', '--json'],
      { IDEASEEK_FAKE_REVIEW_OUTPUT: FAILING_REVIEW },
    );
    expect(failing.code, failing.stdout + failing.stderr).toBe(0);
    expect((JSON.parse(failing.stdout) as ReviewPayload).passing).toBe(false);

    const blocked = await runCli(project, ['idea', 'experiment', ideaId]);
    expect(blocked.code, blocked.stderr).toBe(2);
    expect(blocked.stderr).toContain('independent review v1 is failing');
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

  it('rejects malformed review output without writing the artifact', async () => {
    const project = await setupCheckedIdea();
    const failed = await runCli(project, ['idea', 'review', ideaId, '--harness', 'fake'], {
      IDEASEEK_FAKE_REVIEW_OUTPUT: JSON.stringify({ score: 9, verdict: 'ready' }),
    });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('PARSE_FAILED');
    const files = await readdir(reviewsDir(project)).catch(() => [] as string[]);
    expect(files.filter((name) => name.startsWith('idea-review-v'))).toHaveLength(0);
  }, 180_000);

  it('maps quota blocks to exit 2 with nothing written, then recovers', async () => {
    const project = await setupCheckedIdea();
    const blocked = await runCli(project, ['idea', 'review', ideaId, '--harness', 'fake'], {
      IDEASEEK_FAKE_BLOCK: 'QUOTA_EXHAUSTED',
    });
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain('QUOTA_EXHAUSTED');
    expect(blocked.stderr).toContain('nothing was written');
    const files = await readdir(reviewsDir(project)).catch(() => [] as string[]);
    expect(files).toHaveLength(0);

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
