import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, createDemoRun, makeProjectDir, openRuntime } from './helpers.js';

/**
 * ResearchMaterialAssessment (PROGRESS 106, FULL_RESEARCH_MODE 研究材料
 * 缺口评估): deterministic gap report over persisted artifacts — every
 * gap has priority/reason/evidence/confidence/fill-in/cost/blocks; the
 * report answers whether protocol design and smoke/quick can start;
 * unchanged inputs reuse the stored report (contextHash, MODES.md 三模式
 * 协同). No model, no invented numbers.
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

function makeCard(ideaId: string): Record<string, unknown> {
  return {
    ideaId,
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
}

interface AssessmentPayload {
  verdict: string;
  reused: boolean;
  sufficientFor: { protocolDesign: boolean; smokeQuick: boolean };
  counts: { blocking: number; recommended: number; optional: number };
  assessment: {
    gaps: {
      id: string;
      priority: string;
      area: string;
      reason: string;
      evidence: string[];
      confidence: string;
      fillIn: string;
      cost: string;
      blocks: string[];
    }[];
    covered: { area: string; detail: string }[];
    stats: Record<string, unknown>;
    boundaries: string[];
  };
}

describe('ideaseek assessment (research material gaps)', () => {
  it('fresh project: blocking gaps with full metadata, exit 2, file written', async () => {
    const dir = await makeProjectDir();
    const cardPath = join(dir, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard('alpha')), 'utf8');
    expect((await runCli(dir, ['idea', 'create', 'alpha', '--from-card', cardPath])).code).toBe(0);

    const result = await runCli(dir, ['assessment', '--json']);
    expect(result.code, result.stdout + result.stderr).toBe(2);
    const payload = JSON.parse(result.stdout) as AssessmentPayload;
    expect(payload.verdict).toBe('gaps');
    expect(payload.sufficientFor.protocolDesign).toBe(false);
    expect(payload.counts.blocking).toBeGreaterThan(0);

    const ids = payload.assessment.gaps.map((g) => g.id);
    expect(ids).toContain('no-papers');
    expect(ids).toContain('no-dataset');
    for (const gap of payload.assessment.gaps) {
      expect(gap.reason.length).toBeGreaterThan(0);
      expect(gap.evidence.length).toBeGreaterThan(0);
      expect(gap.fillIn.length).toBeGreaterThan(0);
      expect(gap.cost.length).toBeGreaterThan(0);
      expect(['high', 'medium', 'low']).toContain(gap.confidence);
      expect(['blocking', 'recommended', 'optional']).toContain(gap.priority);
    }
    // Idea count is an observed input (covered, not a gap).
    expect(payload.assessment.stats.ideas).toBe(1);
    expect(payload.assessment.boundaries.join(' ')).toContain('no model output');

    const file = JSON.parse(
      await (
        await import('node:fs/promises')
      ).readFile(join(dir, 'knowledge', 'research-material-assessment.json'), 'utf8'),
    ) as { contract: string };
    expect(file.contract).toBe('research-material-assessment-v1');
  }, 180_000);

  it('reuses the stored report while inputs are unchanged; rebuilds after a change', async () => {
    const dir = await makeProjectDir();
    const first = await runCli(dir, ['assessment', '--json']);
    expect(first.code).toBe(2);
    const firstPayload = JSON.parse(first.stdout) as AssessmentPayload;
    expect(firstPayload.reused).toBe(false);

    const second = await runCli(dir, ['assessment', '--json']);
    const secondPayload = JSON.parse(second.stdout) as AssessmentPayload;
    expect(secondPayload.reused).toBe(true);
    expect(secondPayload.assessment.gaps.map((g) => g.id)).toEqual(
      firstPayload.assessment.gaps.map((g) => g.id),
    );

    // A new comparison changes the observed inputs → contextHash moves.
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
    const third = await runCli(dir, ['assessment', '--json']);
    const thirdPayload = JSON.parse(third.stdout) as AssessmentPayload;
    expect(thirdPayload.reused).toBe(false);
    expect(thirdPayload.assessment.stats.comparisons).toBe(1);
    // No-comparisons recommended gap disappears after registering.
    expect(thirdPayload.assessment.gaps.map((g) => g.id)).not.toContain('no-comparisons');
  }, 180_000);

  it('seeded materials → ready for protocol design (exit 0); missing slices still block smoke', async () => {
    const dir = await makeProjectDir();

    // Seed the full material set through the public db/artifact APIs.
    const rt = await openRuntime(dir, { recover: false });
    try {
      const stage = async (kind: string, payload: Record<string, unknown>) => {
        const staged = await rt.store.stage(kind, `${JSON.stringify(payload, null, 2)}\n`, {});
        const run = await createDemoRun(rt, `seed ${kind}`);
        const task = await rt.db.claimNextTask(run.runId, 'seed-worker', { leaseMs: 60_000 });
        await rt.db.beginCommit({
          taskId: task!.taskId,
          workerId: 'seed-worker',
          attempt: task!.attempt,
          artifacts: [
            {
              kind,
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
      };
      await stage('parsed-paper', {
        source: 'synth.pdf',
        sourceHash: 'sha256:' + 'a'.repeat(64),
        pages: [{ page: 1, text: 'federated learning on non-iid data' }],
      });
      await stage('papercard', {
        paper_id: 'paper-x',
        document_hash: 'sha256:' + 'b'.repeat(64),
        title: 'A synthetic segmentation paper',
        claims: [{ text: 'dice improves', evidence: [{ page: 1, quote: 'dice improves' }] }],
      });
      await rt.db.upsertSlice({
        sliceId: 'ds-quick',
        datasetSnapshotId: 'data-x',
        scale: 'quick',
        record: {
          sliceId: 'ds-quick',
          datasetSnapshotId: 'data-x',
          scale: 'quick',
          rule: 'take',
          ruleVersion: 1,
          inputHash: 'sha256:' + 'c'.repeat(64),
          outputHash: 'sha256:' + 'd'.repeat(64),
          stats: { totalRows: 100, selectedRows: 10 },
          seed: 7,
          boundaries: ['row-level'],
          generatedBy: 'test',
          generatedAt: 1,
          limits: [],
        },
        createdAt: 1,
      });
    } finally {
      await rt.close();
    }
    await mkdir(join(dir, 'knowledge'), { recursive: true });
    await writeFile(
      join(dir, 'knowledge', 'dataset-card.json'),
      JSON.stringify({
        profiles: [
          {
            source: { path: 'datasets/x.csv' },
            rows: 100,
            columns: { name: ['x', 'y'] },
            labelCandidates: [{ column: 'y' }],
          },
        ],
      }),
      'utf8',
    );

    const ready = await runCli(dir, [
      'assessment',
      '--question',
      'does boundary loss help?',
      '--json',
    ]);
    expect(ready.code, ready.stdout + ready.stderr).toBe(0);
    const payload = JSON.parse(ready.stdout) as AssessmentPayload;
    expect(payload.verdict).toBe('ready');
    expect(payload.sufficientFor.protocolDesign).toBe(true);
    expect(payload.sufficientFor.smokeQuick).toBe(true);
    expect(payload.counts.blocking).toBe(0);
    const covered = payload.assessment.covered.map((c) => c.area);
    expect(covered).toContain('papers');
    expect(covered).toContain('data');
    expect(covered).toContain('resources');

    // blocks semantics (slices missing → smoke only) is covered in the
    // dedicated dataset-card-without-slices test below.
  }, 180_000);

  it('dataset card without slices blocks smoke only (protocol design still possible)', async () => {
    const dir = await makeProjectDir();
    await mkdir(join(dir, 'knowledge'), { recursive: true });
    await writeFile(
      join(dir, 'knowledge', 'dataset-card.json'),
      JSON.stringify({
        profiles: [
          {
            source: { path: 'datasets/x.csv' },
            rows: 10,
            columns: { name: ['a'] },
            labelCandidates: [{ column: 'a' }],
          },
        ],
      }),
      'utf8',
    );
    // Papers present so the only blocking gap is slices.
    await mkdir(join(dir, 'papers'), { recursive: true });
    await writeFile(join(dir, 'papers', 'one.pdf'), '%PDF-1.4 fake', 'utf8');
    const rt = await openRuntime(dir, { recover: false });
    try {
      const staged = await rt.store.stage(
        'parsed-paper',
        `${JSON.stringify({
          source: 'one.pdf',
          sourceHash: 'sha256:' + 'e'.repeat(64),
          pages: [{ page: 1, text: 'text' }],
        })}\n`,
        {},
      );
      const run = await createDemoRun(rt, 'seed parsed');
      const task = await rt.db.claimNextTask(run.runId, 'seed-worker', { leaseMs: 60_000 });
      await rt.db.beginCommit({
        taskId: task!.taskId,
        workerId: 'seed-worker',
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
        result: { summary: 'seeded', artifacts: [] },
      });
      await rt.store.promote([staged]);
      await rt.db.finalizeCommit({ taskId: task!.taskId, workerId: 'seed-worker' });
      const cardStage = await rt.store.stage(
        'papercard',
        `${JSON.stringify({
          paper_id: 'paper-y',
          document_hash: 'sha256:' + 'f'.repeat(64),
          title: 'T',
          claims: [{ text: 'c', evidence: [{ page: 1, quote: 'c' }] }],
        })}\n`,
        {},
      );
      const run2 = await createDemoRun(rt, 'seed card');
      const task2 = await rt.db.claimNextTask(run2.runId, 'seed-worker', { leaseMs: 60_000 });
      await rt.db.beginCommit({
        taskId: task2!.taskId,
        workerId: 'seed-worker',
        attempt: task2!.attempt,
        artifacts: [
          {
            kind: 'papercard',
            tempPath: cardStage.tempPath,
            contentHash: cardStage.contentHash,
            size: cardStage.size,
            meta: cardStage.meta,
          },
        ],
        result: { summary: 'seeded', artifacts: [] },
      });
      await rt.store.promote([cardStage]);
      await rt.db.finalizeCommit({ taskId: task2!.taskId, workerId: 'seed-worker' });
    } finally {
      await rt.close();
    }

    const result = await runCli(dir, ['assessment', '--question', 'q?', '--json']);
    expect(result.code).toBe(2); // blocking (slices) exists
    const payload = JSON.parse(result.stdout) as AssessmentPayload;
    expect(payload.sufficientFor.protocolDesign).toBe(true);
    expect(payload.sufficientFor.smokeQuick).toBe(false);
    const slices = payload.assessment.gaps.find((g) => g.id === 'no-slices')!;
    expect(slices.priority).toBe('blocking');
    expect(slices.blocks).toEqual(['smokeQuick']);
    expect(slices.fillIn).toContain('data slices');
  }, 180_000);

  it('flags newly dropped unparsed papers and invalidates cache when knowledge files change', async () => {
    const dir = await makeProjectDir();
    await mkdir(join(dir, 'knowledge'), { recursive: true });
    await writeFile(
      join(dir, 'knowledge', 'dataset-card.json'),
      JSON.stringify({
        profiles: [
          {
            source: { path: 'datasets/x.csv' },
            rows: 10,
            columns: { name: ['a'] },
            labelCandidates: [{ column: 'a' }],
          },
        ],
      }),
      'utf8',
    );
    await mkdir(join(dir, 'papers'), { recursive: true });
    await writeFile(join(dir, 'papers', 'one.pdf'), '%PDF-1.4 one', 'utf8');
    const rt = await openRuntime(dir, { recover: false });
    try {
      const stage = async (kind: string, payload: Record<string, unknown>) => {
        const staged = await rt.store.stage(kind, `${JSON.stringify(payload, null, 2)}\n`, {});
        const run = await createDemoRun(rt, `seed ${kind}`);
        const task = await rt.db.claimNextTask(run.runId, 'seed-worker', { leaseMs: 60_000 });
        await rt.db.beginCommit({
          taskId: task!.taskId,
          workerId: 'seed-worker',
          attempt: task!.attempt,
          artifacts: [
            {
              kind,
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
      };
      await stage('parsed-paper', {
        source: 'papers/one.pdf',
        sourceHash: 'sha256:' + 'e'.repeat(64),
        pages: [{ page: 1, text: 'text' }],
      });
      await stage('papercard', {
        paper_id: 'paper-y',
        document_hash: 'sha256:' + 'f'.repeat(64),
        title: 'T',
        claims: [{ text: 'c', evidence: [{ page: 1, quote: 'c' }] }],
      });
    } finally {
      await rt.close();
    }

    const baseline = await runCli(dir, ['assessment', '--question', 'q?', '--json']);
    const basePayload = JSON.parse(baseline.stdout) as AssessmentPayload;
    expect(basePayload.assessment.gaps.map((g) => g.id)).not.toContain('papers-unparsed-new');

    // Coding/user edits dataset-card.json → assessment cache invalidates.
    await writeFile(
      join(dir, 'knowledge', 'dataset-card.json'),
      JSON.stringify({
        profiles: [
          {
            source: { path: 'datasets/x.csv' },
            rows: 20,
            columns: { name: ['a', 'b'] },
            labelCandidates: [{ column: 'b' }],
          },
        ],
      }),
      'utf8',
    );
    const afterDataEdit = await runCli(dir, ['assessment', '--question', 'q?', '--json']);
    expect((JSON.parse(afterDataEdit.stdout) as AssessmentPayload).reused).toBe(false);

    // Dropping a second PDF in papers/ surfaces papers-unparsed-new.
    await writeFile(join(dir, 'papers', 'two.pdf'), '%PDF-1.4 two', 'utf8');
    const afterPaperDrop = await runCli(dir, ['assessment', '--question', 'q?', '--json']);
    const dropPayload = JSON.parse(afterPaperDrop.stdout) as AssessmentPayload;
    expect(dropPayload.reused).toBe(false);
    expect(dropPayload.assessment.gaps.map((g) => g.id)).toContain('papers-unparsed-new');
  }, 180_000);
});
