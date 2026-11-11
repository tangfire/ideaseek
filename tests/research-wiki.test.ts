import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IdeaCard } from '../src/idea/card.js';
import { CLI_BIN, openRuntime } from './helpers.js';

/**
 * Phase 4.5B research-wiki: deterministic extraction of papers/ideas/
 * experiments/claims into the ARIS wiki layout with typed edges +
 * evidence, materialized by the vendored research_wiki.py helper
 * (honest degradation when disabled/missing).
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

interface WikiPayload {
  schema: string;
  root: string;
  nodes: number;
  edges: number;
  pages: number;
  helper: string;
  stats: string[];
}

describe('ideaseek wiki (ARIS research-wiki backend)', () => {
  const ideaId = 'calib-reweight';
  const seededKey = `sha256:${'f'.repeat(64)}`;

  async function setupRichProject(): Promise<string> {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-wiki-'));
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
    const plan = await runCli(project, ['idea', 'plan', ideaId, '--harness', 'fake', '--json']);
    expect(plan.code, plan.stderr).toBe(0);

    // One indexed paper for the paper node type.
    expect((await runCli(project, ['run', '--question', 'wiki', '--enqueue-only'])).code).toBe(0);
    const rt = await openRuntime(project, { recover: false });
    try {
      const run = await rt.db.getLatestRun(rt.project.id);
      const task = await rt.db.claimNextTask(run!.runId, 'idx-worker', { leaseMs: 60_000 });
      const payload = JSON.stringify({
        source: 'incoming/reweight.pdf',
        sourceHash: seededKey,
        pageCount: 1,
        pages: [{ page: 1, text: 'Calibration-error reweighting beats sample-count weighting.' }],
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
      expect((await refreshPaperIndex(rt.db, rt.store)).indexed).toBe(1);
    } finally {
      await rt.close();
    }
    return project;
  }

  it('builds typed edges with evidence and materializes derived files', async () => {
    const project = await setupRichProject();
    const built = await runCli(project, ['wiki', '--json']);
    expect(built.code, built.stderr).toBe(0);
    const payload = JSON.parse(built.stdout) as WikiPayload;
    expect(payload.schema).toBe('research-wiki-v1');
    expect(payload.nodes).toBeGreaterThanOrEqual(4); // paper + idea + experiment + claim
    expect(payload.edges).toBeGreaterThanOrEqual(2); // tested_by + states
    expect(payload.helper).toBe('ok');
    expect(payload.stats.length).toBeGreaterThan(0);

    const wikiRoot = join(project, 'knowledge', 'research-wiki');
    const edges = (await readFile(join(wikiRoot, 'graph', 'edges.jsonl'), 'utf8'))
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map(
        (line) => JSON.parse(line) as { from: string; to: string; type: string; evidence: string },
      );
    expect(edges.some((edge) => edge.type === 'tested_by' && edge.from === `idea:${ideaId}`)).toBe(
      true,
    );
    expect(edges.some((edge) => edge.type === 'states')).toBe(true);
    for (const edge of edges) expect(edge.evidence.length).toBeGreaterThan(3);

    await readFile(join(wikiRoot, 'ideas', `${ideaId}.md`), 'utf8');
    await readFile(join(wikiRoot, 'claims', `${ideaId}-c1.md`), 'utf8');
    // Helper materialized the ARIS derived files.
    await readFile(join(wikiRoot, 'index.md'), 'utf8');
    await readFile(join(wikiRoot, 'query_pack.md'), 'utf8');
  }, 300_000);

  it('rebuilds idempotently (overwrite, not append)', async () => {
    const project = await setupRichProject();
    const first = await runCli(project, ['wiki', '--json']);
    const firstPayload = JSON.parse(first.stdout) as WikiPayload;
    const second = await runCli(project, ['wiki', '--json']);
    const secondPayload = JSON.parse(second.stdout) as WikiPayload;
    expect(secondPayload.nodes).toBe(firstPayload.nodes);
    expect(secondPayload.edges).toBe(firstPayload.edges);

    const wikiRoot = join(project, 'knowledge', 'research-wiki');
    const edgeLines = (await readFile(join(wikiRoot, 'graph', 'edges.jsonl'), 'utf8'))
      .split(/\r?\n/)
      .filter((line) => line.trim());
    expect(edgeLines.length).toBe(firstPayload.edges);
    const log = await readFile(join(wikiRoot, 'log.md'), 'utf8');
    expect(log.split('wiki build:').length - 1).toBe(2);
  }, 300_000);

  it('builds an empty graph on a fresh project', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-wiki-empty-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    const built = await runCli(project, ['wiki', '--json']);
    expect(built.code, built.stderr).toBe(0);
    const payload = JSON.parse(built.stdout) as WikiPayload;
    expect(payload).toMatchObject({ nodes: 0, edges: 0 });
    expect(payload.helper).toBe('ok');
  }, 120_000);

  it('degrades honestly when the helper is disabled', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-wiki-skip-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    const built = await runCli(project, ['wiki', '--json'], { IDEASEEK_WIKI_SKIP_HELPER: '1' });
    expect(built.code, built.stderr).toBe(0);
    const payload = JSON.parse(built.stdout) as WikiPayload;
    expect(payload.helper).toContain('skipped');
    await readFile(join(project, 'knowledge', 'research-wiki', 'graph', 'edges.jsonl'), 'utf8');
  }, 120_000);
});
