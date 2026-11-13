import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, createDemoRun, makeProjectDir, openRuntime } from './helpers.js';

/**
 * Three-mode coordination contract (PROGRESS 85, docs/MODES.md 三种模式
 * 如何协同): one project, one artifact store, one hash space —
 * 1. same inputs → same artifacts (no duplicate parse/extract versions);
 * 2. mode switches change only the session marker — no second run, no
 *    knowledge reset, no copied context;
 * 3. a code change invalidates ONLY its downstream (check/analysis) while
 *    papers/PaperCards and the assessment of them stay untouched.
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

async function seedParsedPaper(dir: string): Promise<void> {
  // extract reads the source file (byte provenance) AND the committed
  // parsed artifact (text) — both must exist, path must end in .pdf.
  await mkdir(join(dir, 'papers'), { recursive: true });
  await writeFile(join(dir, 'papers', 'synth.pdf'), '%PDF-1.4 seed\n', 'utf8');
  const rt = await openRuntime(dir, { recover: false });
  try {
    const staged = await rt.store.stage(
      'parsed-paper',
      `${JSON.stringify({
        source: 'papers/synth.pdf',
        sourceHash: 'sha256:' + 'a'.repeat(64),
        pageCount: 1,
        parser: 'seed',
        pages: [{ page: 1, text: 'federated learning under non-iid drift' }],
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
  } finally {
    await rt.close();
  }
}

async function artifactCount(dir: string, kind: string): Promise<number> {
  const rt = await openRuntime(dir, { recover: false });
  try {
    return (await rt.db.listArtifactsByKind(kind)).length;
  } finally {
    await rt.close();
  }
}

describe('contract 1: same inputs → same artifacts (no duplicate versions)', () => {
  it('running extract twice keeps exactly one PaperCard for the same parsed paper', async () => {
    const dir = await makeProjectDir();
    await seedParsedPaper(dir);

    const first = await runCli(dir, ['extract', '--json']);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    expect(await artifactCount(dir, 'papercard')).toBe(1);

    // Second run over the SAME parsed input must reuse, not duplicate.
    const second = await runCli(dir, ['extract', '--json']);
    expect(second.code, second.stdout + second.stderr).toBe(0);
    expect(await artifactCount(dir, 'papercard')).toBe(1);

    // Assessment of those materials is likewise content-addressed:
    // two runs over unchanged inputs → the second reuses the report.
    const a1 = await runCli(dir, ['assessment', '--question', 'q?', '--json']);
    const a2 = await runCli(dir, ['assessment', '--question', 'q?', '--json']);
    expect(a1.code).toBe(2); // fresh project still has blocking gaps
    const payload2 = JSON.parse(a2.stdout) as { reused: boolean };
    expect(payload2.reused).toBe(true);
  }, 300_000);
});

describe('contract 2: mode switches never reset project context', () => {
  it('research → agent → research keeps runs, knowledge bytes and assessment identical', async () => {
    const dir = await makeProjectDir();
    const cardPath = join(dir, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard('alpha')), 'utf8');
    expect((await runCli(dir, ['idea', 'create', 'alpha', '--from-card', cardPath])).code).toBe(0);
    expect((await runCli(dir, ['run', '--question', 'ctx', '--enqueue-only'])).code).toBe(0);
    expect((await runCli(dir, ['assessment', '--question', 'q?', '--json'])).code).toBe(2);

    const knowledgeBefore = await readFile(
      join(dir, 'knowledge', 'research-material-assessment.json'),
      'utf8',
    );
    const rtBefore = await openRuntime(dir, { recover: false });
    let latestRunBefore: string;
    let taskCountBefore: number;
    let knowledgeCountBefore: number;
    try {
      const latest = await rtBefore.db.getLatestRun(rtBefore.project.id);
      latestRunBefore = latest!.runId;
      taskCountBefore = (await rtBefore.db.listTasks(latestRunBefore)).length;
      knowledgeCountBefore = (await rtBefore.db.listArtifactsByKind('papercard')).length;
    } finally {
      await rtBefore.close();
    }

    // Mode churn: only .research/session.json may change.
    expect((await runCli(dir, ['mode', 'agent'])).code).toBe(0);
    expect((await runCli(dir, ['mode', 'analysis'])).code).toBe(0);
    expect((await runCli(dir, ['mode', 'research', '--force'])).code).toBe(0);

    const knowledgeAfter = await readFile(
      join(dir, 'knowledge', 'research-material-assessment.json'),
      'utf8',
    );
    expect(knowledgeAfter).toBe(knowledgeBefore); // byte-identical, no rebuild/copy

    const rtAfter = await openRuntime(dir, { recover: false });
    try {
      // Same latest run + same task count = no second run was started.
      const latestAfter = await rtAfter.db.getLatestRun(rtAfter.project.id);
      expect(latestAfter!.runId).toBe(latestRunBefore);
      expect((await rtAfter.db.listTasks(latestAfter!.runId)).length).toBe(taskCountBefore);
      expect((await rtAfter.db.listArtifactsByKind('papercard')).length).toBe(knowledgeCountBefore);
    } finally {
      await rtAfter.close();
    }

    // The assessment itself still reports reuse after all the churn.
    const again = await runCli(dir, ['assessment', '--question', 'q?', '--json']);
    const payload = JSON.parse(again.stdout) as { reused: boolean };
    expect(payload.reused).toBe(true);
  }, 300_000);
});

describe('contract 3: a code change invalidates only its downstream', () => {
  it('check-report goes stale while papers/PaperCards and their assessment stay current', async () => {
    const dir = await makeProjectDir();
    const cardPath = join(dir, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard('alpha')), 'utf8');
    expect((await runCli(dir, ['idea', 'create', 'alpha', '--from-card', cardPath])).code).toBe(0);
    await seedParsedPaper(dir);
    expect((await runCli(dir, ['extract', '--json'])).code).toBe(0);
    expect((await runCli(dir, ['assessment', '--question', 'q?', '--json'])).code).toBe(2);

    // Build a passing check report, then touch the idea code.
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

    const paperBytesBefore = await readFirstPapercard(dir);

    // Agent-style code change: append to the idea source.
    await appendFile(trainPath, '# touched by agent\n', 'utf8');

    // Downstream of the code IS invalidated…
    const stale = await runCli(dir, ['stale', '--idea', 'alpha', '--json']);
    expect(stale.code).toBe(2);
    const stalePayload = JSON.parse(stale.stdout) as {
      rows: { id: string; status: string }[];
    };
    const checkRow = stalePayload.rows.find((row) => row.id === 'check-report:alpha');
    expect(checkRow?.status).toBe('stale');

    // …while paper knowledge and its assessment are untouched:
    const paperBytesAfter = await readFirstPapercard(dir);
    expect(paperBytesAfter).toBe(paperBytesBefore);
    expect(await artifactCount(dir, 'papercard')).toBe(1); // no re-extract
    const assessment = await runCli(dir, ['assessment', '--question', 'q?', '--json']);
    const payload = JSON.parse(assessment.stdout) as { reused: boolean };
    expect(payload.reused).toBe(true); // cards unchanged → report reused
  }, 300_000);
});

/** First committed PaperCard's exact bytes (DB is authoritative; the
 * knowledge/paper-cards export dir is written by `synthesize`, not extract). */
async function readFirstPapercard(dir: string): Promise<string> {
  const rt = await openRuntime(dir, { recover: false });
  try {
    const cards = await rt.db.listArtifactsByKind('papercard');
    expect(cards.length).toBeGreaterThan(0);
    return await rt.store.readFinalText(cards[0]!.contentHash);
  } finally {
    await rt.close();
  }
}
