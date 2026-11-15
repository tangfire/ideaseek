import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IdeaCard } from '../src/idea/card.js';
import { CLI_BIN, implementIdeaSmoke, openRuntime } from './helpers.js';

/**
 * Phase 4.5C claim/citation audit (ARIS paper-claim-audit +
 * citation-crosscheck, deterministic): card evidence must be locatable
 * in the indexed paper it cites; nearest comparisons must be registered;
 * a current FAIL blocks handoff delivery.
 */

const PAPER_TEXT =
  'Calibration-error reweighting beats sample-count weighting under label skew in federated learning.';

function makeCard(ideaId: string, evidence: string): IdeaCard {
  return {
    ideaId,
    version: 1,
    parentVersion: null,
    status: 'CANDIDATE',
    hypothesis: { statement: 'reweighting improves recall', targetProblem: 'dilution' },
    paperEvidence: [{ paperRef: 'audit.pdf', statement: 'uniform averaging', evidence }],
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
    budget: { maxRounds: 1, maxGpuMinutes: 10 },
    stopConditions: ['s'],
    createdAt: 1,
  } as IdeaCard;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[], timeoutMs = 120_000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1' },
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

interface ClaimAuditPayload {
  ideaId: string;
  cardVersion: number;
  verdict: string;
  stats: { found: number; missing: number; unverified: number };
  checks: { kind: string; ref: string; verdict: string; page: number | null }[];
  eventSeq?: number | null;
}

const seededKey = `sha256:${'e'.repeat(64)}`;

async function seedPaperAndComparison(project: string): Promise<void> {
  expect((await runCli(project, ['run', '--question', 'audit', '--enqueue-only'])).code).toBe(0);
  const rt = await openRuntime(project, { recover: false });
  try {
    const run = await rt.db.getLatestRun(rt.project.id);
    const task = await rt.db.claimNextTask(run!.runId, 'idx-worker', { leaseMs: 60_000 });
    const payload = JSON.stringify({
      source: 'incoming/audit.pdf',
      sourceHash: seededKey,
      pageCount: 1,
      pages: [{ page: 1, text: PAPER_TEXT }],
      parser: 'pypdf/7.0.0',
    });
    const staged = await rt.store.stage('parsed-paper', payload, { filename: 'parsed-paper.json' });
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

    await rt.db.upsertComparison({
      methodId: 'm',
      status: 'implemented',
      required: false,
      record: { methodId: 'm', status: 'implemented', updatedAt: Date.now() },
      updatedAt: Date.now(),
    });
  } finally {
    await rt.close();
  }
}

async function setupIdea(evidence: string): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), 'ideaseek-claim-'));
  expect((await runCli(project, ['init'])).code).toBe(0);
  const cardPath = join(project, 'card.json');
  await writeFile(cardPath, JSON.stringify(makeCard('claim-idea', evidence)), 'utf8');
  expect(
    (await runCli(project, ['idea', 'create', 'claim-idea', '--from-card', cardPath])).code,
  ).toBe(0);
  return project;
}

describe('ideaseek idea claim-audit (deterministic citation checks)', () => {
  it('passes when evidence is locatable and comparisons are registered', async () => {
    const project = await setupIdea('Calibration-error reweighting beats sample-count');
    await seedPaperAndComparison(project);

    const shown = await runCli(project, ['idea', 'claim-audit', 'claim-idea', '--json']);
    expect(shown.code, shown.stdout + shown.stderr).toBe(0);
    const payload = JSON.parse(shown.stdout) as ClaimAuditPayload;
    expect(payload.verdict).toBe('pass');
    expect(payload.stats).toMatchObject({ found: 2, missing: 0, unverified: 0 });
    expect(payload.checks.find((check) => check.kind === 'paper-evidence')?.page).toBe(1);
    expect(payload.eventSeq).toBeGreaterThan(0);

    const events = await runCli(project, ['events', '--json']);
    expect(events.stdout).toContain('claim_audit');
  }, 180_000);

  it('fails when the card cites text the paper does not contain, and blocks handoff', async () => {
    const project = await setupIdea('this sentence exists nowhere in any indexed paper');
    await seedPaperAndComparison(project);
    // Passing check report is required before handoff reads the gate.
    expect((await runCli(project, ['idea', 'set-status', 'claim-idea', 'IMPLEMENTING'])).code).toBe(
      0,
    );
    expect((await runCli(project, ['idea', 'scaffold', 'claim-idea'])).code).toBe(0);
    // The scaffold's smoke declares itself synthetic, which `idea check`
    // now refuses; a fixture that needs a passed check must compute.
    await implementIdeaSmoke(project, 'claim-idea', 'm');
    const check = await runCli(project, ['idea', 'check', 'claim-idea', '--json']);
    expect(check.code, check.stdout + check.stderr).toBe(0);

    const shown = await runCli(project, ['idea', 'claim-audit', 'claim-idea', '--json']);
    expect(shown.code).toBe(2);
    const payload = JSON.parse(shown.stdout) as ClaimAuditPayload;
    expect(payload.verdict).toBe('fail');
    expect(payload.stats.missing).toBe(1);

    const handoff = await runCli(project, ['idea', 'handoff', 'claim-idea', '--json']);
    const gate = JSON.parse(handoff.stdout) as { blockers: string[] };
    expect(gate.blockers.join('\n')).toContain('evidence audit FAIL');
  }, 300_000);

  it('warns (never fails) when the cited source is not indexed yet', async () => {
    const project = await setupIdea('Calibration-error reweighting beats sample-count');
    // Register the comparison (so only the paper side is unresolved).
    const rt = await openRuntime(project, { recover: false });
    try {
      await rt.db.upsertComparison({
        methodId: 'm',
        status: 'implemented',
        required: false,
        record: { methodId: 'm', status: 'implemented', updatedAt: Date.now() },
        updatedAt: Date.now(),
      });
    } finally {
      await rt.close();
    }
    // No paper indexed → unverified.
    const shown = await runCli(project, ['idea', 'claim-audit', 'claim-idea', '--json']);
    expect(shown.code, shown.stderr).toBe(0);
    const payload = JSON.parse(shown.stdout) as ClaimAuditPayload;
    expect(payload.verdict).toBe('warn');
    expect(payload.stats.unverified).toBeGreaterThanOrEqual(1);
    expect(payload.stats.missing).toBe(0);
  }, 120_000);

  it('ignores a stale evidence audit at the handoff gate', async () => {
    const project = await setupIdea('Calibration-error reweighting beats sample-count');
    await seedPaperAndComparison(project);
    expect((await runCli(project, ['idea', 'set-status', 'claim-idea', 'IMPLEMENTING'])).code).toBe(
      0,
    );
    expect((await runCli(project, ['idea', 'scaffold', 'claim-idea'])).code).toBe(0);
    // The scaffold's smoke declares itself synthetic, which `idea check`
    // now refuses; a fixture that needs a passed check must compute.
    await implementIdeaSmoke(project, 'claim-idea', 'm');
    const check = await runCli(project, ['idea', 'check', 'claim-idea', '--json']);
    expect(check.code, check.stdout + check.stderr).toBe(0);
    // Simulate a stale FAIL (card was revised after the audit).
    await writeFile(
      join(project, 'ideas', 'claim-idea', 'evidence-audit.json'),
      JSON.stringify({
        contract: 'evidence-audit-v1',
        ideaId: 'claim-idea',
        cardVersion: 99,
        generatedAt: 1,
        verdict: 'fail',
        checks: [],
        stats: { found: 0, missing: 1, unverified: 0 },
      }),
      'utf8',
    );

    const handoff = await runCli(project, ['idea', 'handoff', 'claim-idea', '--json']);
    const gate = JSON.parse(handoff.stdout) as { blockers: string[] };
    expect(gate.blockers.join('\n')).not.toContain('evidence audit');
  }, 300_000);
});
