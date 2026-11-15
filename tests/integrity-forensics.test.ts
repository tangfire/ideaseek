import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IdeaCard } from '../src/idea/card.js';
import {
  computeForensicsPolicy,
  waiveFinding,
  type ForensicsFinding,
} from '../src/idea/forensics.js';
import { CLI_BIN, implementIdeaSmoke } from './helpers.js';

/**
 * Phase 4.5C integrity-forensics (ARIS integrity-forensics backend):
 * deterministic sweep over persisted evidence → typed policy gate
 * (BLOCK / WARN / NO_NEW_BLOCKER) wired into RunEvent, DECISION waivers and
 * the handoff delivery gate. Covers success, BLOCK, WARN, no-evidence,
 * malformed model output, quota/permission blocks with recovery, stale
 * fail-closed freshness and the append-only waiver ledger.
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

interface ForensicsPayload {
  ideaId: string;
  reused?: boolean;
  policy: string;
  findings: { id: string; family: string; severity: string; source?: string }[];
  coverage?: { checksRun: string[]; checksDeferred: string[]; modelPass: string };
  model?: string | null;
  blocked?: string;
  written?: boolean;
  alreadyWaived?: boolean;
  decisionSeq?: number | null;
  eventSeq?: number | null;
}

describe('ideaseek idea forensics (ARIS integrity-forensics backend)', () => {
  const ideaId = 'calib-reweight';

  /** init → create → IMPLEMENTING → scaffold → check → experiment → analyze. */
  async function setupSweptIdea(withRun = false): Promise<string> {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-forensics-'));
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
    const experiment = await runCli(project, ['idea', 'experiment', ideaId, '--json']);
    expect(experiment.code, experiment.stdout + experiment.stderr).toBe(0);
    const analyze = await runCli(project, ['idea', 'analyze', ideaId, '--json']);
    expect(analyze.code, analyze.stdout + analyze.stderr).toBe(0);
    if (withRun) {
      expect(
        (await runCli(project, ['run', '--question', 'forensics', '--enqueue-only'])).code,
      ).toBe(0);
    }
    return project;
  }

  const forensicsFile = (project: string): string =>
    join(project, 'ideas', ideaId, 'experiments', 'forensics.json');

  const analysisFile = (project: string): string =>
    join(project, 'ideas', ideaId, 'experiments', 'analysis.json');

  async function patchAnalysis(project: string, patch: Record<string, unknown>): Promise<void> {
    const raw = JSON.parse(await readFile(analysisFile(project), 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(analysisFile(project), JSON.stringify({ ...raw, ...patch }, null, 2), 'utf8');
  }

  it('sweeps the bundle, records the event, reuses and stays neutral at the gate', async () => {
    const project = await setupSweptIdea(true);

    const shown = await runCli(project, [
      'idea',
      'forensics',
      ideaId,
      '--harness',
      'fake',
      '--json',
    ]);
    expect(shown.code, shown.stderr).toBe(0);
    const payload = JSON.parse(shown.stdout) as ForensicsPayload;
    expect(payload).toMatchObject({ ideaId, reused: false, policy: 'NO_NEW_BLOCKER' });
    expect(payload.findings).toEqual([]);
    expect(payload.coverage?.modelPass).toBe('ran');
    expect(payload.coverage?.checksRun).toContain('result-selection:stale-analysis');
    expect(payload.coverage?.checksDeferred).toContain('drift:seed-contract');
    expect(payload.eventSeq).not.toBeNull();

    const file = JSON.parse(await readFile(forensicsFile(project), 'utf8')) as {
      contract: string;
      policy: string;
      stateDigest: string;
      findings: unknown[];
      waivers: unknown[];
    };
    expect(file.contract).toBe('integrity-forensics-v1');
    expect(file.policy).toBe('NO_NEW_BLOCKER');
    expect(file.stateDigest).toMatch(/^sha256:/);
    expect(file.waivers).toEqual([]);

    const events = await runCli(project, ['events', '--json']);
    expect(events.stdout).toContain('integrity_forensics');

    // Unchanged evidence → honest reuse (no second sweep, no second event).
    const second = await runCli(project, [
      'idea',
      'forensics',
      ideaId,
      '--harness',
      'fake',
      '--json',
    ]);
    expect(second.code).toBe(0);
    expect((JSON.parse(second.stdout) as ForensicsPayload).reused).toBe(true);

    // A clean sweep never blocks the handoff; it is recorded in the package.
    const handoff = await runCli(project, ['idea', 'handoff', ideaId, '--json']);
    expect(handoff.code, handoff.stderr).toBe(0);
    const gate = JSON.parse(handoff.stdout) as { blockers: string[] };
    expect(gate.blockers.join('\n')).not.toContain('integrity-forensics');
    const package_ = JSON.parse(
      await readFile(join(project, 'ideas', ideaId, 'handoff', 'handoff.json'), 'utf8'),
    ) as { integrityForensics: { policy: string; findings: number } | null };
    expect(package_.integrityForensics).toMatchObject({ policy: 'NO_NEW_BLOCKER', findings: 0 });
  }, 300_000);

  it('a critical finding produces BLOCK and stops the handoff delivery', async () => {
    const project = await setupSweptIdea();
    // Hand-edit the narrative: claim "supported" without coverage/delta —
    // the exact claim-evidence-outruns-evidence failure mode.
    await patchAnalysis(project, { verdict: 'supported', primaryDelta: null });

    const shown = await runCli(project, [
      'idea',
      'forensics',
      ideaId,
      '--harness',
      'fake',
      '--json',
    ]);
    expect(shown.code).toBe(2);
    const payload = JSON.parse(shown.stdout) as ForensicsPayload;
    expect(payload.policy).toBe('BLOCK');
    const critical = payload.findings.find((f) => f.id === 'claim-evidence:unsupported-verdict');
    expect(critical).toMatchObject({ severity: 'critical', source: 'deterministic' });

    const handoff = await runCli(project, ['idea', 'handoff', ideaId, '--json']);
    const gate = JSON.parse(handoff.stdout) as { blockers: string[] };
    const blockers = gate.blockers.join('\n');
    expect(blockers).toContain('integrity-forensics BLOCK');
    expect(blockers).toContain('claim-evidence:unsupported-verdict');
  }, 300_000);

  it('a WARN finding stays visible in the package without blocking', async () => {
    const project = await setupSweptIdea();
    // Scope language over actual coverage gaps (seeds=1, single scale).
    const cardPath = join(project, 'ideas', ideaId, 'idea.json');
    const card = JSON.parse(await readFile(cardPath, 'utf8')) as IdeaCard;
    card.hypothesis.statement += ' This proves comprehensive superiority.';
    await writeFile(cardPath, JSON.stringify(card, null, 2), 'utf8');

    const shown = await runCli(project, [
      'idea',
      'forensics',
      ideaId,
      '--harness',
      'fake',
      '--json',
    ]);
    expect(shown.code, shown.stderr).toBe(0);
    const payload = JSON.parse(shown.stdout) as ForensicsPayload;
    expect(payload.policy).toBe('WARN');
    expect(payload.findings.map((f) => f.id)).toContain('anomalous-narrative:overstated-scope');

    const handoff = await runCli(project, ['idea', 'handoff', ideaId, '--json']);
    const gate = JSON.parse(handoff.stdout) as { blockers: string[] };
    expect(gate.blockers.join('\n')).not.toContain('integrity-forensics');
    const package_ = JSON.parse(
      await readFile(join(project, 'ideas', ideaId, 'handoff', 'handoff.json'), 'utf8'),
    ) as { integrityForensics: { policy: string; openFindings: number } | null };
    expect(package_.integrityForensics).toMatchObject({ policy: 'WARN', openFindings: 1 });
  }, 300_000);

  it('a sweep whose inputs changed after it ran fails closed as stale', async () => {
    const project = await setupSweptIdea();
    const shown = await runCli(project, [
      'idea',
      'forensics',
      ideaId,
      '--harness',
      'fake',
      '--json',
    ]);
    expect(shown.code, shown.stderr).toBe(0);

    // Re-running the analysis rewrites analysis.json → the swept state moved.
    const analyze = await runCli(project, ['idea', 'analyze', ideaId, '--json']);
    expect(analyze.code, analyze.stderr).toBe(0);

    const handoff = await runCli(project, ['idea', 'handoff', ideaId, '--json']);
    const gate = JSON.parse(handoff.stdout) as { blockers: string[] };
    const blockers = gate.blockers.join('\n');
    expect(blockers).toContain('integrity-forensics stale');
    expect(blockers).toContain('rerun ideaseek idea forensics');
  }, 300_000);

  it('rejects malformed model output without writing anything', async () => {
    const project = await setupSweptIdea();
    const failed = await runCli(project, ['idea', 'forensics', ideaId, '--harness', 'fake'], {
      IDEASEEK_FAKE_FORENSICS_OUTPUT: JSON.stringify({
        ideaId,
        cardVersion: 1,
        findings: [
          {
            id: 'x',
            family: 'not-a-family',
            severity: 'critical',
            detail: 'bad family',
            evidence: 'experiments/analysis.json',
          },
        ],
        summary: 's',
      }),
    });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('PARSE_FAILED');
    expect(failed.stderr).toContain('family');
    await expect(readFile(forensicsFile(project), 'utf8')).rejects.toThrow();
  }, 180_000);

  it('maps quota and permission blocks to exit 2 with nothing written, then recovers', async () => {
    const project = await setupSweptIdea();

    const quota = await runCli(project, ['idea', 'forensics', ideaId, '--harness', 'fake'], {
      IDEASEEK_FAKE_BLOCK: 'QUOTA_EXHAUSTED',
    });
    expect(quota.code).toBe(2);
    expect(quota.stderr).toContain('QUOTA_EXHAUSTED');
    expect(quota.stderr).toContain('nothing was written');
    await expect(readFile(forensicsFile(project), 'utf8')).rejects.toThrow();

    const permission = await runCli(project, ['idea', 'forensics', ideaId, '--harness', 'fake'], {
      IDEASEEK_FAKE_BLOCK: 'AUTH_REQUIRED',
    });
    expect(permission.code).toBe(2);
    expect(permission.stderr).toContain('AUTH_REQUIRED');
    await expect(readFile(forensicsFile(project), 'utf8')).rejects.toThrow();

    const recovered = await runCli(project, [
      'idea',
      'forensics',
      ideaId,
      '--harness',
      'fake',
      '--json',
    ]);
    expect(recovered.code, recovered.stderr).toBe(0);
    expect((JSON.parse(recovered.stdout) as ForensicsPayload).policy).toBe('NO_NEW_BLOCKER');
  }, 300_000);

  it('waives a BLOCK finding via an append-only Decision and reopens the gate', async () => {
    const project = await setupSweptIdea(true);
    await patchAnalysis(project, { verdict: 'supported', primaryDelta: null });
    const blocked = await runCli(project, [
      'idea',
      'forensics',
      ideaId,
      '--harness',
      'fake',
      '--json',
    ]);
    expect(blocked.code).toBe(2);
    expect((JSON.parse(blocked.stdout) as ForensicsPayload).policy).toBe('BLOCK');

    const findingId = 'claim-evidence:unsupported-verdict';
    const waived = await runCli(project, [
      'idea',
      'forensics-waive',
      ideaId,
      findingId,
      '--reason',
      'post-hoc delta recomputed from the raw result file',
      '--json',
    ]);
    expect(waived.code, waived.stderr).toBe(0);
    const waiverPayload = JSON.parse(waived.stdout) as ForensicsPayload;
    expect(waiverPayload.policy).toBe('NO_NEW_BLOCKER');
    expect(waiverPayload.decisionSeq).not.toBeNull();

    // Original finding stays on the record; the waiver is append-only.
    const file = JSON.parse(await readFile(forensicsFile(project), 'utf8')) as {
      policy: string;
      findings: { id: string; severity: string }[];
      waivers: { findingId: string; reason: string }[];
    };
    expect(file.policy).toBe('NO_NEW_BLOCKER');
    expect(file.findings.some((f) => f.id === findingId && f.severity === 'critical')).toBe(true);
    expect(file.waivers).toHaveLength(1);

    const events = await runCli(project, ['events', '--json']);
    expect(events.stdout).toContain('forensics-waived');

    // Idempotent re-waive is a no-op; unknown findings are refused.
    const again = await runCli(project, [
      'idea',
      'forensics-waive',
      ideaId,
      findingId,
      '--reason',
      'dup',
      '--json',
    ]);
    expect(again.code).toBe(0);
    expect((JSON.parse(again.stdout) as ForensicsPayload).alreadyWaived).toBe(true);
    const unknown = await runCli(project, [
      'idea',
      'forensics-waive',
      ideaId,
      'no-such-finding',
      '--reason',
      'x',
      '--json',
    ]);
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain('no finding');

    // Gate reopened: the waived sweep no longer blocks delivery.
    const handoff = await runCli(project, ['idea', 'handoff', ideaId, '--json']);
    const gate = JSON.parse(handoff.stdout) as { blockers: string[] };
    expect(gate.blockers.join('\n')).not.toContain('integrity-forensics');
  }, 300_000);

  it('sweeps an idea with no experiment evidence honestly (model pass skipped)', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-forensics-empty-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    const cardPath = join(project, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard('bare-idea'), null, 2), 'utf8');
    expect(
      (await runCli(project, ['idea', 'create', 'bare-idea', '--from-card', cardPath])).code,
    ).toBe(0);

    const shown = await runCli(project, [
      'idea',
      'forensics',
      'bare-idea',
      '--harness',
      'fake',
      '--json',
    ]);
    expect(shown.code, shown.stderr).toBe(0);
    const payload = JSON.parse(shown.stdout) as ForensicsPayload;
    expect(payload.policy).toBe('WARN');
    expect(payload.findings.map((f) => f.id)).toContain('coverage:no-evidence');
    expect(payload.coverage?.modelPass).toBe('skipped-no-evidence');

    const file = JSON.parse(
      await readFile(join(project, 'ideas', 'bare-idea', 'experiments', 'forensics.json'), 'utf8'),
    ) as { model: string | null; harnessRuntime: string | null };
    expect(file.model).toBeNull();
    expect(file.harnessRuntime).toBeNull();
  }, 180_000);
});

describe('computeForensicsPolicy / waiveFinding (unit)', () => {
  const finding = (over: Partial<ForensicsFinding> = {}): ForensicsFinding => ({
    id: 'drift:card-version',
    family: 'drift',
    severity: 'major',
    source: 'deterministic',
    detail: 'd',
    evidence: 'e',
    ...over,
  });

  it('maps open findings to the ARIS policy vocabulary', () => {
    expect(computeForensicsPolicy([], [])).toBe('NO_NEW_BLOCKER');
    expect(computeForensicsPolicy([finding()], [])).toBe('WARN');
    expect(computeForensicsPolicy([finding({ severity: 'critical' })], [])).toBe('BLOCK');
    // The stored token is display only: an empty ledger can never BLOCK.
    expect(
      computeForensicsPolicy([], [{ findingId: 'x', reason: 'r', waivedAt: 1, decisionSeq: 1 }]),
    ).toBe('NO_NEW_BLOCKER');
  });

  it('waivers close findings without mutating them, and are append-only', () => {
    const critical = finding({ id: 'claim-evidence:unsupported-verdict', severity: 'critical' });
    const base = {
      contract: 'integrity-forensics-v1' as const,
      ideaId: 'x',
      cardVersion: 1,
      inputHash: 'h',
      skill: { name: 'integrity-forensics', sha256: 's' },
      generatedAt: 1,
      harnessRuntime: null,
      model: null,
      evidenceDigest: 'e',
      stateDigest: 's',
      findings: [critical],
      waivers: [],
      policy: 'BLOCK' as const,
      summary: 's',
      coverage: { checksRun: [], checksDeferred: [], modelPass: 'ran' as const },
    };
    const waived = waiveFinding(base, 'claim-evidence:unsupported-verdict', 'human ok', 7);
    expect(waived.policy).toBe('NO_NEW_BLOCKER');
    expect(waived.findings[0]).toEqual(critical); // immutable snapshot
    expect(waived.waivers).toHaveLength(1);
    expect(() => waiveFinding(waived, 'claim-evidence:unsupported-verdict', 'dup', null)).toThrow(
      /already waived/,
    );
    expect(() => waiveFinding(waived, 'no-such', 'r', null)).toThrow(/no finding/);
  });
});
