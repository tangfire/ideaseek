import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IdeaCard } from '../src/idea/card.js';
import { CLI_BIN } from './helpers.js';

/**
 * `idea audit` CLI over the SINGLE default backend (src/review, ADR-009):
 * cross-model experiment audits with the ARIS check family, FAIL blocking
 * the handoff gate, WARN/stale neutrality and quota-block recovery.
 * Backend conformance lives in tests/review.test.ts.
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

function auditOutput(overall: string): string {
  const statusFor = (id: string): string => {
    if (id === 'gt_provenance') {
      if (overall === 'FAIL') return 'FAIL';
      if (overall === 'WARN') return 'WARN';
    }
    return 'PASS';
  };
  const detailFor = (id: string): string => {
    if (id === 'gt_provenance') {
      return overall === 'FAIL' ? 'metrics are not grounded' : 'metrics use recorded ground truth';
    }
    if (id === 'score_normalization') return 'raw scores are not self-normalized';
    if (id === 'result_existence') return 'result metrics exist in the bundle';
    if (id === 'dead_code') return 'configured metrics are exercised';
    return 'quick-scale scope is stated honestly';
  };
  const evidenceFor = (id: string): string =>
    id === 'dead_code'
      ? 'experiment.spec.metrics'
      : id === 'scope'
        ? 'experiment.spec.dataSnapshotId'
        : 'experiment.result.metrics';
  const ids = ['gt_provenance', 'score_normalization', 'result_existence', 'dead_code', 'scope'];
  return JSON.stringify({
    overall,
    evalType: 'real_gt',
    checks: ids.map((id) => ({
      id,
      status: statusFor(id),
      details: detailFor(id),
      evidence: evidenceFor(id),
    })),
    claims: [],
    summary:
      overall === 'FAIL'
        ? 'results are not trustworthy'
        : overall === 'WARN'
          ? 'scope warnings need review'
          : 'results are internally consistent',
  });
}

interface AuditPayload {
  ideaId: string;
  version: number;
  reused: boolean;
  overall: string;
  evalType: string;
  checks: { id: string; status: string; evidence: string }[];
  eventSeq?: number | null;
  blocked?: string;
}

describe('ideaseek idea audit (ARIS experiment-audit backend)', () => {
  const ideaId = 'calib-reweight';

  async function setupAuditableIdea(): Promise<string> {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-iaudit-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    const cardPath = join(project, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard(ideaId)), 'utf8');
    expect((await runCli(project, ['idea', 'create', ideaId, '--from-card', cardPath])).code).toBe(
      0,
    );
    expect((await runCli(project, ['idea', 'set-status', ideaId, 'IMPLEMENTING'])).code).toBe(0);
    expect((await runCli(project, ['idea', 'scaffold', ideaId])).code).toBe(0);
    const check = await runCli(project, ['idea', 'check', ideaId, '--json']);
    expect(check.code, check.stdout + check.stderr).toBe(0);
    const experiment = await runCli(project, ['idea', 'experiment', ideaId, '--json']);
    expect(experiment.code, experiment.stdout + experiment.stderr).toBe(0);
    expect((await runCli(project, ['run', '--question', 'audit', '--enqueue-only'])).code).toBe(0);
    return project;
  }

  const writeAuditFile = async (project: string, patch: Record<string, unknown>): Promise<void> => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(project, 'knowledge', 'reviews', ideaId), { recursive: true });
    await writeFile(
      join(project, 'knowledge', 'reviews', ideaId, 'experiment-audit-v99.json'),
      JSON.stringify(
        {
          reviewId: 'rv-experiment-audit-idea-v99',
          version: 99,
          target: { kind: 'idea', ideaId, cardVersion: 1 },
          scope: { refs: [], unavailable: [], unmatchedPaperRefs: [] },
          reviewer: {
            identity: { model: 'fake-model', sessionId: 's', runtime: 'fake' },
            route: {
              skill: 'experiment-audit',
              skillSha256: 'x',
              profile: 'reviewer',
              harness: 'fake',
            },
            freshContext: true,
          },
          inputs: [],
          inputHash: 'sha256:x',
          raw: '{}',
          generatedAt: 1,
          contract: 'experiment-audit-v1',
          kind: 'experiment-audit',
          checks: [],
          evalType: 'real_gt',
          overall: 'FAIL',
          summary: 'stale',
          ...patch,
        },
        null,
        2,
      ),
      'utf8',
    );
  };

  it('runs the audit, records the event and reuses identical inputs', async () => {
    const project = await setupAuditableIdea();

    const first = await runCli(project, ['idea', 'audit', ideaId, '--harness', 'fake', '--json']);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    const payload = JSON.parse(first.stdout) as AuditPayload;
    expect(payload).toMatchObject({
      ideaId,
      version: 1,
      reused: false,
      overall: 'PASS',
      evalType: 'real_gt',
    });
    expect(payload.checks.length).toBeGreaterThanOrEqual(2);
    expect(payload.checks[0]!.evidence).toBeTruthy();

    const again = await runCli(project, ['idea', 'audit', ideaId, '--harness', 'fake', '--json']);
    expect(again.code).toBe(0);
    expect((JSON.parse(again.stdout) as AuditPayload).reused).toBe(true);

    const events = await runCli(project, ['events', '--json']);
    expect(events.stdout).toContain('experiment-audit idea');
  }, 300_000);

  it('a FAIL audit blocks the handoff gate; WARN and stale stay neutral', async () => {
    const project = await setupAuditableIdea();

    const failing = await runCli(
      project,
      ['idea', 'audit', ideaId, '--harness', 'fake', '--json'],
      { IDEASEEK_FAKE_AUDIT_OUTPUT: auditOutput('FAIL') },
    );
    expect(failing.code).toBe(2);
    expect((JSON.parse(failing.stdout) as AuditPayload).overall).toBe('FAIL');

    const blocked = await runCli(project, ['idea', 'handoff', ideaId, '--json']);
    const gate = JSON.parse(blocked.stdout) as { blockers: string[] };
    expect(gate.blockers.join('\n')).toContain('experiment-audit FAIL');
    expect(gate.blockers.join('\n')).toContain('results are not trustworthy');

    // A WARN version replaces the FAIL (force re-audit with same inputs
    // goes through --force so the version appends).
    const warned = await runCli(
      project,
      ['idea', 'audit', ideaId, '--harness', 'fake', '--force', '--json'],
      { IDEASEEK_FAKE_AUDIT_OUTPUT: auditOutput('WARN') },
    );
    expect(warned.code, warned.stdout + warned.stderr).toBe(0);
    expect((JSON.parse(warned.stdout) as AuditPayload).overall).toBe('WARN');
    const afterWarn = await runCli(project, ['idea', 'handoff', ideaId, '--json']);
    const warnGate = JSON.parse(afterWarn.stdout) as { blockers: string[] };
    expect(warnGate.blockers.join('\n')).not.toContain('experiment-audit');

    // Stale artifact (v99, different inputs) never influences the gate.
    await writeAuditFile(project, {
      target: { kind: 'idea', ideaId, cardVersion: 99 },
    });
    const afterStale = await runCli(project, ['idea', 'handoff', ideaId, '--json']);
    const staleGate = JSON.parse(afterStale.stdout) as { blockers: string[] };
    expect(staleGate.blockers.join('\n')).not.toContain('experiment-audit');
  }, 300_000);

  it('refuses to audit an idea without experiment outputs', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-iaudit-empty-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    const cardPath = join(project, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard('plain-idea')), 'utf8');
    expect(
      (await runCli(project, ['idea', 'create', 'plain-idea', '--from-card', cardPath])).code,
    ).toBe(0);
    const failed = await runCli(project, ['idea', 'audit', 'plain-idea', '--harness', 'fake']);
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('no experiment outputs to audit');
  }, 180_000);

  it('maps quota blocks to exit 2 with nothing written, then recovers', async () => {
    const project = await setupAuditableIdea();
    const blocked = await runCli(project, ['idea', 'audit', ideaId, '--harness', 'fake'], {
      IDEASEEK_FAKE_BLOCK: 'QUOTA_EXHAUSTED',
    });
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain('QUOTA_EXHAUSTED');
    expect(blocked.stderr).toContain('nothing was written');

    const recovered = await runCli(project, [
      'idea',
      'audit',
      ideaId,
      '--harness',
      'fake',
      '--json',
    ]);
    expect(recovered.code, recovered.stderr).toBe(0);
    expect((JSON.parse(recovered.stdout) as AuditPayload).overall).toBe('PASS');
  }, 300_000);
});
