import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IdeaCard } from '../src/idea/card.js';
import { CLI_BIN, implementIdeaSmoke } from './helpers.js';

/**
 * Capability 4 (Phase 4.5): novelty-check/prior-art-search → PaperCard and
 * evidence. Verdicts bind closestPaperRef to the local FTS candidates,
 * ABANDON must name papers, prior-art degradation is explicit, a current
 * ABANDON blocks experiments unless waived with an audited reason.
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

interface NoveltyPayload {
  ideaId: string;
  reused: boolean;
  inputHash: string;
  verdict: string;
  score: number;
  candidates: number;
  priorArtDegraded: boolean;
  eventSeq?: number | null;
  blocked?: string;
}

describe('ideaseek idea novelty (ARIS novelty-check backend)', () => {
  const ideaId = 'calib-reweight';
  const seededKey = `sha256:${'f'.repeat(64)}`;

  async function setupCheckedIdea(): Promise<string> {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-novelty-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    const cardPath = join(project, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard(ideaId), null, 2), 'utf8');
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
    return project;
  }

  const noveltyFile = (project: string): string => join(project, 'ideas', ideaId, 'novelty.json');

  async function seedPaperIndex(project: string): Promise<void> {
    expect(
      (await runCli(project, ['run', '--question', 'novelty seed', '--enqueue-only'])).code,
    ).toBe(0);
    const { openRuntime } = await import('./helpers.js');
    const rt = await openRuntime(project, { recover: false });
    try {
      const run = await rt.db.getLatestRun(rt.project.id);
      const task = await rt.db.claimNextTask(run!.runId, 'idx-worker', { leaseMs: 60_000 });
      const payload = JSON.stringify({
        source: 'incoming/reweight.pdf',
        sourceHash: seededKey,
        pageCount: 1,
        pages: [
          {
            page: 1,
            text: 'Calibration-error reweighting of clients beats sample-count weighting under label skew.',
          },
        ],
        parser: 'pypdf/7.0.0',
      });
      const staged = await rt.store.stage('parsed-paper', payload, {
        filename: 'parsed-paper.json',
      });
      await rt.db.beginCommit({
        taskId: task!.taskId,
        workerId: 'idx-worker',
        attempt: task!.attempt,
        artifacts: [
          {
            kind: 'parsed-paper',
            tempPath: staged.tempPath,
            contentHash: staged.contentHash,
            size: staged.size,
            meta: staged.meta,
          },
        ],
        result: { summary: 'seeded paper', artifacts: [] },
      });
      await rt.store.promote([staged]);
      await rt.db.finalizeCommit({ taskId: task!.taskId, workerId: 'idx-worker' });
      const { refreshPaperIndex } = await import('../src/knowledge/search.js');
      const refreshed = await refreshPaperIndex(rt.db, rt.store);
      expect(refreshed.indexed).toBe(1);
    } finally {
      await rt.close();
    }
  }

  it('produces a degraded local-only verdict and records the event', async () => {
    const project = await setupCheckedIdea();
    expect((await runCli(project, ['run', '--question', 'novelty', '--enqueue-only'])).code).toBe(
      0,
    );

    const shown = await runCli(project, ['idea', 'novelty', ideaId, '--harness', 'fake', '--json']);
    expect(shown.code, shown.stderr).toBe(0);
    const payload = JSON.parse(shown.stdout) as NoveltyPayload;
    expect(payload).toMatchObject({
      ideaId,
      reused: false,
      verdict: 'PROCEED',
      priorArtDegraded: true,
      candidates: 0,
    });

    const report = JSON.parse(await readFile(noveltyFile(project), 'utf8')) as {
      contract: string;
      claims: { closestPaperRef: string | null }[];
      skills: { novelty: { name: string }; priorArt: { name: string } };
    };
    expect(report.contract).toBe('novelty-check-v1');
    expect(report.skills.novelty.name).toBe('novelty-check');
    expect(report.skills.priorArt.name).toBe('prior-art-search');
    expect(report.claims[0]!.closestPaperRef).toBeNull();

    const events = await runCli(project, ['events', '--json']);
    expect(events.stdout).toContain('novelty_verdict');
  }, 180_000);

  it('binds closestPaperRef to a real indexed paper', async () => {
    const project = await setupCheckedIdea();
    await seedPaperIndex(project);

    const shown = await runCli(project, ['idea', 'novelty', ideaId, '--harness', 'fake', '--json']);
    expect(shown.code, shown.stderr).toBe(0);
    const payload = JSON.parse(shown.stdout) as NoveltyPayload;
    expect(payload.verdict).toBe('PROCEED_WITH_CAUTION');
    expect(payload.candidates).toBe(1);

    const report = JSON.parse(await readFile(noveltyFile(project), 'utf8')) as {
      claims: { closestPaperRef: string | null }[];
      candidateRefs: string[];
    };
    expect(report.candidateRefs).toContain(seededKey);
    expect(report.claims[0]!.closestPaperRef).toBe(seededKey);
  }, 180_000);

  it('rejects invented paper references (anti-hallucination)', async () => {
    const project = await setupCheckedIdea();
    await seedPaperIndex(project);
    const failed = await runCli(project, ['idea', 'novelty', ideaId, '--harness', 'fake'], {
      IDEASEEK_FAKE_NOVELTY_OUTPUT: JSON.stringify({
        ideaId,
        cardVersion: 1,
        verdict: 'PROCEED',
        score: 9,
        positioning: 'p',
        claims: [{ claim: 'c', closestPaperRef: 'ghost-paper', overlap: 'o', delta: 'd' }],
        patents: [],
        priorArtDegraded: true,
        notes: [],
      }),
    });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('PARSE_FAILED');
    expect(failed.stderr).toContain('never invent');
    await expect(readFile(noveltyFile(project), 'utf8')).rejects.toThrow();
  }, 180_000);

  it('requires ABANDON to name specific papers', async () => {
    const project = await setupCheckedIdea();
    const failed = await runCli(project, ['idea', 'novelty', ideaId, '--harness', 'fake'], {
      IDEASEEK_FAKE_NOVELTY_OUTPUT: JSON.stringify({
        ideaId,
        cardVersion: 1,
        verdict: 'ABANDON',
        score: 2,
        positioning: 'p',
        claims: [{ claim: 'c', closestPaperRef: null, overlap: 'o', delta: 'd' }],
        patents: [],
        priorArtDegraded: true,
        notes: [],
      }),
    });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('must name a specific candidate paper for ABANDON');
    await expect(readFile(noveltyFile(project), 'utf8')).rejects.toThrow();
  }, 180_000);

  it('blocks experiments on a current ABANDON verdict until waived with a reason', async () => {
    const project = await setupCheckedIdea();
    expect(
      (await runCli(project, ['run', '--question', 'novelty gate', '--enqueue-only'])).code,
    ).toBe(0);
    // Simulate a completed ABANDON report (guard reads persisted state).
    await writeFile(
      noveltyFile(project),
      JSON.stringify(
        {
          contract: 'novelty-check-v1',
          ideaId,
          cardVersion: 1,
          inputHash: 'sha256:test',
          verdict: 'ABANDON',
          score: 2,
          positioning: 'overlaps a local paper',
          claims: [],
          patents: [],
          priorArtDegraded: true,
          notes: [],
          candidateRefs: [],
        },
        null,
        2,
      ),
      'utf8',
    );

    const blocked = await runCli(project, ['idea', 'experiment', ideaId]);
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain('ABANDON');
    expect(blocked.stderr).toContain('--waive-novelty');

    const waived = await runCli(project, [
      'idea',
      'experiment',
      ideaId,
      '--waive-novelty',
      'reviewed the overlap; delta still defensible',
      '--json',
    ]);
    expect(waived.code, waived.stdout + waived.stderr).toBe(0);
    expect((JSON.parse(waived.stdout) as { waiverSeq?: number }).waiverSeq).toBeGreaterThan(0);

    const events = await runCli(project, ['events', '--json']);
    expect(events.stdout).toContain('novelty-waived');
    expect(events.stdout).toContain('delta still defensible');
  }, 300_000);

  it('stale novelty reports neither block nor annotate', async () => {
    const project = await setupCheckedIdea();
    await writeFile(
      noveltyFile(project),
      JSON.stringify(
        {
          contract: 'novelty-check-v1',
          ideaId,
          cardVersion: 99,
          verdict: 'ABANDON',
          score: 1,
          positioning: 'stale',
          claims: [],
          patents: [],
          priorArtDegraded: true,
          notes: [],
          candidateRefs: [],
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

  it('reuses an identical report and maps quota blocks to exit 2', async () => {
    const project = await setupCheckedIdea();
    expect(
      (await runCli(project, ['run', '--question', 'novelty reuse', '--enqueue-only'])).code,
    ).toBe(0);

    const first = await runCli(project, ['idea', 'novelty', ideaId, '--harness', 'fake', '--json']);
    expect(first.code).toBe(0);
    const second = await runCli(project, [
      'idea',
      'novelty',
      ideaId,
      '--harness',
      'fake',
      '--json',
    ]);
    expect(second.code).toBe(0);
    const payload = JSON.parse(second.stdout) as NoveltyPayload;
    expect(payload.reused).toBe(true);
    expect(payload.inputHash).toBe((JSON.parse(first.stdout) as NoveltyPayload).inputHash);

    const events = await runCli(project, ['events', '--json']);
    expect(events.stdout.split('novelty_verdict').length - 1).toBe(1);

    const blocked = await runCli(
      project,
      ['idea', 'novelty', ideaId, '--harness', 'fake', '--force'],
      { IDEASEEK_FAKE_BLOCK: 'QUOTA_EXHAUSTED' },
    );
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain('nothing was written');
    await readFile(noveltyFile(project), 'utf8'); // previous report untouched
  }, 300_000);
});
