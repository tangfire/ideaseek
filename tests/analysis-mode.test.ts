import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, makeProjectDir } from './helpers.js';
import {
  parseSessionMode,
  SESSION_MODES,
  MODE_PERMISSIONS,
  readSessionMode,
  writeSessionMode,
} from '../src/session/mode.js';

/**
 * Analysis mode (PROGRESS 84, docs/MODES.md): read-only preparation mode
 * with the ResearchMaterialAssessment gap report as its NL flow, and the
 * Analysis→Research preparation gate (blocking material gaps refuse the
 * switch; --force is the auditable override). Session mode is persisted
 * per project; every switcher funnels through writeSessionMode.
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

describe('session tier store (analysis)', () => {
  it('parses, persists and carries read-only permissions for analysis', async () => {
    expect(SESSION_MODES).toEqual(['research', 'analysis']);
    expect(parseSessionMode('analysis')).toBe('analysis');
    // The retired tier spelling is not a tier any more.
    expect(parseSessionMode('agent')).toBeNull();
    expect(parseSessionMode('nope')).toBeNull();
    expect(MODE_PERMISSIONS.analysis.join(' ')).toContain('read-only');
    expect(MODE_PERMISSIONS.analysis.join(' ')).toContain('cannot lock protocols');

    const dir = await makeProjectDir();
    expect(await readSessionMode(dir)).toBe('research');
    await writeSessionMode(dir, 'analysis');
    expect(await readSessionMode(dir)).toBe('analysis');
    // A session file written before agent stopped being a tier still reads:
    // the marker falls back to the science tier, the coding history lives in
    // knowledge/agent-sessions.json instead.
    await writeFile(join(dir, '.research', 'session.json'), '{"mode":"agent"}\n', 'utf8');
    expect(await readSessionMode(dir)).toBe('research');
  }, 60_000);
});

describe('ideaseek mode switch + Analysis→Research gate', () => {
  it('switches to analysis, shows permissions, and refuses research while blocking gaps exist', async () => {
    const dir = await makeProjectDir();
    const cardPath = join(dir, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard('alpha')), 'utf8');
    expect((await runCli(dir, ['idea', 'create', 'alpha', '--from-card', cardPath])).code).toBe(0);

    // research → analysis: ungated (preparation direction).
    const toAnalysis = await runCli(dir, ['mode', 'analysis']);
    expect(toAnalysis.code, toAnalysis.stdout + toAnalysis.stderr).toBe(0);
    expect(toAnalysis.stdout).toContain('research → analysis');

    // mode show lists analysis permissions.
    const show = await runCli(dir, ['mode']);
    expect(show.stdout).toContain('session mode : analysis');
    expect(show.stdout).toContain('read-only preparation');

    // analysis → research: blocked by fresh-project material gaps.
    const blocked = await runCli(dir, ['mode', 'research']);
    expect(blocked.code, blocked.stdout + blocked.stderr).not.toBe(0);
    expect(blocked.stderr).toContain('Analysis → Research blocked');
    expect(blocked.stderr).toContain('no-papers');
    expect(blocked.stderr).toContain('--force');
    // The refused switch still produced the assessment artifact (gate input).
    expect(existsSync(join(dir, 'knowledge', 'research-material-assessment.json'))).toBe(true);

    // Auditable override.
    const forced = await runCli(dir, ['mode', 'research', '--force']);
    expect(forced.code, forced.stdout + forced.stderr).toBe(0);
    expect(forced.stdout).toContain('analysis → research');
    const after = await runCli(dir, ['mode', '--json']);
    const payload = JSON.parse(after.stdout) as { sessionMode: string };
    expect(payload.sessionMode).toBe('research');
  }, 180_000);

  it('invalid mode target lists the two tiers, and `agent` routes to the entry', async () => {
    const dir = await makeProjectDir();
    const bad = await runCli(dir, ['mode', 'banana']);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain('research | analysis');
    expect(bad.stderr).not.toContain('agent');

    const retired = await runCli(dir, ['mode', 'agent']);
    expect(retired.code).not.toBe(0);
    expect(retired.stderr).toContain('ideaseek agent');
  }, 60_000);
});

describe('ask in analysis mode (deterministic assessment flow)', () => {
  it('answers material questions from state — no model, no Decision, exit 2 on blocking gaps', async () => {
    const dir = await makeProjectDir();
    const cardPath = join(dir, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard('alpha')), 'utf8');
    expect((await runCli(dir, ['idea', 'create', 'alpha', '--from-card', cardPath])).code).toBe(0);
    expect((await runCli(dir, ['mode', 'analysis'])).code).toBe(0);

    const human = await runCli(dir, ['ask', 'what materials am I missing?']);
    expect(human.code).toBe(2); // blocking gaps on a fresh project
    expect(human.stdout).toContain('analysis mode');
    expect(human.stdout).toContain('no-papers');
    expect(human.stdout).toContain('next:');
    // Never fell through to the supervisor/model path.
    expect(human.stdout).not.toContain('supervisor classified');

    const json = await runCli(dir, ['ask', 'am I ready for research?', '--json']);
    expect(json.code).toBe(2);
    const payload = JSON.parse(json.stdout) as {
      source: string;
      verdict: string;
      sufficientFor: { protocolDesign: boolean };
      gaps: { id: string }[];
    };
    expect(payload.source).toBe('analysis-assessment');
    expect(payload.verdict).toBe('gaps');
    expect(payload.sufficientFor.protocolDesign).toBe(false);
    expect(payload.gaps.length).toBeGreaterThan(0);

    // Greetings still work in analysis mode (orientation is mode-agnostic).
    const greeting = await runCli(dir, ['ask', 'hello']);
    expect(greeting.code).toBe(0);

    // In research mode the same question takes the normal path (not the
    // assessment shortcut) — mode routing is what differs.
    expect((await runCli(dir, ['mode', 'research', '--force'])).code).toBe(0);
    const researchAsk = await runCli(dir, ['ask', 'what materials am I missing?', '--json']);
    const researchPayload = JSON.parse(researchAsk.stdout) as { source: string };
    expect(researchPayload.source).not.toBe('analysis-assessment');
  }, 180_000);

  it('enforces read-only preparation across scaffold/experiment/repair/confirm while in analysis mode', async () => {
    const dir = await makeProjectDir();
    const cardPath = join(dir, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard('alpha')), 'utf8');
    expect((await runCli(dir, ['idea', 'create', 'alpha', '--from-card', cardPath])).code).toBe(0);
    expect((await runCli(dir, ['mode', 'analysis'])).code).toBe(0);

    const scaffold = await runCli(dir, ['idea', 'scaffold', 'alpha']);
    expect(scaffold.code).toBe(2);
    expect(scaffold.stderr).toContain('analysis mode');

    const experiment = await runCli(dir, ['idea', 'experiment', 'alpha']);
    expect(experiment.code).toBe(2);
    expect(experiment.stderr).toContain('analysis mode');

    const repair = await runCli(dir, ['baseline', 'repair', '--method', 'fedavg']);
    expect(repair.code).toBe(2);
    expect(repair.stderr).toContain('analysis mode');

    const confirm = await runCli(dir, ['confirm', 'protocol']);
    expect(confirm.code).toBe(2);
    expect(confirm.stderr).toContain('analysis mode');

    // Read-only commands still work cleanly in analysis mode.
    expect((await runCli(dir, ['status'])).code).toBe(0);
    expect((await runCli(dir, ['assessment', '--json'])).code).toBe(2); // gaps exit 2, not error
  }, 180_000);

  it('preserves pending-action Decisions, answers analytical Q&A, and runs prepare pipeline in analysis mode', async () => {
    const dir = await makeProjectDir();
    const { mkdir } = await import('node:fs/promises');
    expect((await runCli(dir, ['run', '--question', 'prep test', '--enqueue-only'])).code).toBe(0);
    expect((await runCli(dir, ['mode', 'analysis'])).code).toBe(0);

    // High-impact request in analysis mode still becomes a pending-approval Decision.
    const budget = await runCli(dir, ['ask', '把本轮预算限制在 5 个 GPU 小时']);
    expect(budget.code, budget.stdout + budget.stderr).toBe(0);
    expect(budget.stdout).toContain('pending-approval');

    // Open-ended analytical question with harness override gets a grounded answer (not gap dump).
    const override = JSON.stringify({
      kind: 'answer',
      answer: 'Paper A compares FedAvg and FedProx on CIFAR-10.',
      cliArgs: null,
    });
    const qa = await new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [CLI_BIN, 'ask', 'which baselines appear in Paper A?', '--harness', 'fake', '--json'],
          {
            cwd: dir,
            env: {
              ...process.env,
              IDEASEEK_CLI: '1',
              IDEASEEK_FAKE_SUPERVISOR_OUTPUT: override,
            },
          },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => (stdout += String(c)));
        child.stderr.on('data', (c) => (stderr += String(c)));
        child.on('error', reject);
        child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
      },
    );
    expect(qa.code, qa.stderr).toBe(0);
    const qaPayload = JSON.parse(qa.stdout) as { source: string; answer: string };
    expect(qaPayload.source).toBe('analysis-qa');
    expect(qaPayload.answer).toContain('FedProx');

    // `ideaseek prepare --skip-model` runs scan → ingest → data describe → assessment cleanly.
    await mkdir(join(dir, 'datasets'), { recursive: true });
    await writeFile(join(dir, 'datasets', 'toy.csv'), 'feat,label\n1,0\n2,1\n3,0\n4,1\n', 'utf8');
    const prep = await runCli(dir, ['prepare', '--skip-model', '--json']);
    expect(prep.code, prep.stdout + prep.stderr).toBe(2); // still missing papers
    const prepPayload = JSON.parse(prep.stdout) as {
      steps: { step: string; status: string }[];
      assessment: { stats: { datasetCard: boolean } };
    };
    expect(prepPayload.steps.find((s) => s.step === 'scan')?.status).toBe('ran');
    expect(prepPayload.steps.find((s) => s.step === 'data-describe')?.status).toBe('ran');
    expect(prepPayload.assessment.stats.datasetCard).toBe(true);
  }, 180_000);
});
