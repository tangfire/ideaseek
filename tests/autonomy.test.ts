import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  assertAutonomy,
  assertMetricsMatchProtocol,
  checkAutonomy,
  parseAutonomyMode,
} from '../src/workflow/autonomy.js';
import { defaultConfig, loadConfig } from '../src/config/config.js';
import { projectPaths } from '../src/config/paths.js';
import type { IdeaCard } from '../src/idea/card.js';
import { CLI_BIN, makeProjectDir } from './helpers.js';

describe('autonomy mode matrix (unit)', () => {
  it('parses valid modes and defaults garbage to guided', () => {
    expect(parseAutonomyMode('guided')).toBe('guided');
    expect(parseAutonomyMode('autonomous')).toBe('autonomous');
    expect(parseAutonomyMode('review-only')).toBe('review-only');
    expect(parseAutonomyMode('yolo')).toBe('guided');
    expect(parseAutonomyMode(undefined)).toBe('guided');
  });

  it('review-only refuses code writes, experiments and deliveries', () => {
    for (const action of ['write-code', 'start-experiment', 'finalize-handoff'] as const) {
      const check = checkAutonomy('review-only', action);
      expect(check.allowed).toBe(false);
      expect(check.reason).toContain('review-only');
      expect(() => assertAutonomy('review-only', action)).toThrow(/review-only/);
    }
  });

  it('guided confirms protected changes; mutations stay automatic', () => {
    const unconfirmed = checkAutonomy('guided', 'change-required-comparison');
    expect(unconfirmed.allowed).toBe(false);
    expect(unconfirmed.needsConfirm).toBe(true);
    expect(() => assertAutonomy('guided', 'change-hypothesis')).toThrow(/--confirm/);

    const confirmed = checkAutonomy('guided', 'change-required-comparison', { confirmed: true });
    expect(confirmed.allowed).toBe(true);
    expect(confirmed.needsDecision).toBe(true);

    const mutation = checkAutonomy('guided', 'start-experiment');
    expect(mutation.allowed).toBe(true);
    expect(mutation.needsDecision).toBe(false); // smoke/quick are low-risk per policy
  });

  it('autonomous allows everything but still demands decisions for protected actions', () => {
    const protectedCheck = checkAutonomy('autonomous', 'change-hypothesis');
    expect(protectedCheck.allowed).toBe(true);
    expect(protectedCheck.needsDecision).toBe(true);
    const mutation = checkAutonomy('autonomous', 'start-experiment');
    expect(mutation.allowed).toBe(true);
    expect(mutation.needsDecision).toBe(true); // audited, never silent
  });

  it('analysis sessionMode blocks scientific writes/locks/experiments even under autonomous policy', () => {
    for (const action of [
      'write-code',
      'start-experiment',
      'lock-protocol',
      'lock-fairness',
      'finalize-handoff',
      'full-research',
      'change-required-comparison',
      'change-hypothesis',
      'change-primary-metric',
      'change-data-usage',
    ] as const) {
      const check = checkAutonomy('autonomous', action, {
        confirmed: true,
        sessionMode: 'analysis',
      });
      expect(check.allowed, action).toBe(false);
      expect(check.reason).toContain('analysis mode');
      expect(() =>
        assertAutonomy('autonomous', action, { confirmed: true, sessionMode: 'analysis' }),
      ).toThrow(/analysis mode/);
    }
    expect(
      checkAutonomy('guided', 'change-model-route', { confirmed: true, sessionMode: 'analysis' })
        .allowed,
    ).toBe(true);
  });
});

describe('primary-metric protocol guard (unit)', () => {
  it('refuses specs that dropped a protocol metric', () => {
    expect(() =>
      assertMetricsMatchProtocol(
        [{ name: 'accuracy' }],
        [
          { name: 'accuracy' },
          { name: 'rare-class recall' }, // protocol metric missing from spec
        ],
      ),
    ).toThrow(/missing from the experiment spec/);
  });

  it('allows aligned specs, extra metrics and empty protocols', () => {
    expect(() =>
      assertMetricsMatchProtocol(
        [{ name: 'accuracy' }, { name: 'extra-ablation-metric' }],
        [{ name: 'accuracy' }],
      ),
    ).not.toThrow();
    expect(() => assertMetricsMatchProtocol([], [])).not.toThrow();
  });
});

describe('autonomy config plumbing', () => {
  it('defaults to guided and validates the enum', async () => {
    const dir = await makeProjectDir();
    const paths = projectPaths(dir);
    const fresh = await loadConfig(paths);
    expect(fresh.resolved.policy.autonomyMode).toBe('guided');
    expect(fresh.errors).toEqual([]);

    const yamlPath = paths.configFile;
    const raw = await readFile(yamlPath, 'utf8');
    expect(raw).toContain('autonomy_mode: guided');
    await writeFile(yamlPath, raw.replace('autonomy_mode: guided', 'autonomy_mode: bogus'), 'utf8');
    const bad = await loadConfig(paths);
    expect(bad.errors.join(' ')).toContain('policy.autonomy_mode');

    await writeFile(
      yamlPath,
      raw.replace('autonomy_mode: guided', 'autonomy_mode: review-only'),
      'utf8',
    );
    const review = await loadConfig(paths);
    expect(review.resolved.policy.autonomyMode).toBe('review-only');
    expect(review.errors).toEqual([]);
  });

  it('defaultConfig carries guided without any file', () => {
    expect(defaultConfig('x').policy.autonomyMode).toBe('guided');
  });
});

function makeCard(ideaId: string): IdeaCard {
  return {
    ideaId,
    version: 1,
    parentVersion: null,
    status: 'CANDIDATE',
    hypothesis: { statement: 's', targetProblem: 't' },
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
    nearestComparisons: [{ methodId: 'fedavg', difference: 'd', evidence: 'e' }],
    componentNecessity: [
      { component: 'probe', role: 'necessary-mechanism', removeEffect: 'gain gone' },
    ],
    competingExplanations: ['x'],
    boundaryConditions: ['x'],
    risks: ['x'],
    minimalExperiment: {
      code: 'src/train.py',
      data: 'd',
      baselines: ['fedavg'],
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

function runCli(cwd: string, args: string[], timeoutMs = 60_000): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
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
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function setMode(dir: string, mode: string): Promise<void> {
  const configPath = join(dir, 'research.yaml');
  const raw = await readFile(configPath, 'utf8');
  if (raw.includes('autonomy_mode:')) {
    await writeFile(
      configPath,
      raw.replace(/autonomy_mode: \w[\w-]*/, `autonomy_mode: ${mode}`),
      'utf8',
    );
  } else {
    await writeFile(configPath, `${raw}autonomy_mode: ${mode}\n`, 'utf8');
  }
}

describe('autonomy enforcement (CLI)', () => {
  let project: string;

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'ideaseek-auto-'));
    const init = await runCli(project, ['init']);
    expect(init.code).toBe(0);
  }, 60_000);

  it('guided: excluding a required comparison demands --confirm and records a Decision', async () => {
    // A run must exist for the decision event to bind to.
    const run = await runCli(project, ['run', '--question', 'decision run', '--enqueue-only']);
    expect(run.code).toBe(0);

    const reg = await runCli(project, ['comparison', 'register', 'fedavg']);
    expect(reg.code).toBe(0);

    const unconfirmed = await runCli(project, [
      'comparison',
      'set-status',
      'fedavg',
      'excluded',
      '--reason',
      'not needed',
    ]);
    expect(unconfirmed.code).toBe(2);
    expect(unconfirmed.stderr).toContain('--confirm');

    const confirmed = await runCli(project, [
      'comparison',
      'set-status',
      'fedavg',
      'excluded',
      '--reason',
      'not needed',
      '--confirm',
    ]);
    expect(confirmed.code, confirmed.stderr).toBe(0);
    expect(confirmed.stdout).toContain('decision recorded');

    const events = await runCli(project, ['events', '--json']);
    const payload = JSON.parse(events.stdout) as {
      events: { eventType: string; summary: string; status: string | null }[];
    };
    const decision = payload.events.find((event) => event.eventType === 'decision');
    expect(decision).toBeTruthy();
    expect(decision!.summary).toContain('change-required-comparison: fedavg');
    expect(decision!.summary).toContain('[guided]');
    expect(decision!.status).toBe('confirmed');
  }, 120_000);

  it('autonomous: the same exclusion proceeds without --confirm but is still audited', async () => {
    const run = await runCli(project, ['run', '--question', 'auto run', '--enqueue-only']);
    expect(run.code).toBe(0);
    await setMode(project, 'autonomous');
    const reg = await runCli(project, ['comparison', 'register', 'fedavg']);
    expect(reg.code).toBe(0);

    const excluded = await runCli(project, [
      'comparison',
      'set-status',
      'fedavg',
      'excluded',
      '--reason',
      'auto policy',
    ]);
    expect(excluded.code, excluded.stderr).toBe(0);
    expect(excluded.stdout).toContain('decision recorded');

    const events = await runCli(project, ['events', '--json']);
    const payload = JSON.parse(events.stdout) as {
      events: { eventType: string; summary: string; status: string | null }[];
    };
    const decision = payload.events.find((event) => event.eventType === 'decision')!;
    expect(decision.summary).toContain('[autonomous]');
    expect(decision.status).toBe('auto'); // never silent, marked as system decision
  }, 120_000);

  it('review-only: mutations are refused while read commands still work', async () => {
    await setMode(project, 'review-only');

    const cardPath = join(project, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard('calib-reweight')), 'utf8');
    const created = await runCli(project, [
      'idea',
      'create',
      'calib-reweight',
      '--from-card',
      cardPath,
    ]);
    expect(created.code).toBe(0);

    const scaffold = await runCli(project, ['idea', 'scaffold', 'calib-reweight']);
    expect(scaffold.code).toBe(2);
    expect(scaffold.stderr).toContain('review-only');

    const experiment = await runCli(project, ['idea', 'experiment', 'calib-reweight']);
    expect(experiment.code).toBe(2);
    expect(experiment.stderr).toContain('review-only');

    const repair = await runCli(project, ['baseline', 'repair', '--method', 'ghost']);
    expect(repair.code).toBe(2);
    expect(repair.stderr).toContain('review-only');

    // Read-only analysis still works.
    const status = await runCli(project, ['status']);
    expect(status.code).toBe(0);
    const list = await runCli(project, ['idea', 'list']);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain('calib-reweight');
  }, 120_000);

  it('guided: branching to a new hypothesis demands --confirm', async () => {
    const cardPath = join(project, 'parent.json');
    await writeFile(cardPath, JSON.stringify(makeCard('parent-idea')), 'utf8');
    expect(
      (await runCli(project, ['idea', 'create', 'parent-idea', '--from-card', cardPath])).code,
    ).toBe(0);
    const childCardPath = join(project, 'child.json');
    await writeFile(childCardPath, JSON.stringify(makeCard('child-idea')), 'utf8');

    const unconfirmed = await runCli(project, [
      'idea',
      'branch',
      'parent-idea',
      'child-idea',
      '--from-card',
      childCardPath,
    ]);
    expect(unconfirmed.code).toBe(2);
    expect(unconfirmed.stderr).toContain('--confirm');
    // No side effects before confirmation.
    await expect(
      readFile(join(project, 'ideas', 'child-idea', 'workspace.json'), 'utf8'),
    ).rejects.toThrow();

    const confirmed = await runCli(project, [
      'idea',
      'branch',
      'parent-idea',
      'child-idea',
      '--from-card',
      childCardPath,
      '--confirm',
      '--json',
    ]);
    expect(confirmed.code, confirmed.stderr).toBe(0);
    expect((JSON.parse(confirmed.stdout) as { decisionSeq: number | null }).decisionSeq).toBeNull(); // no run yet
    const workspace = JSON.parse(
      await readFile(join(project, 'ideas', 'child-idea', 'workspace.json'), 'utf8'),
    ) as { parentIdeaId: string };
    expect(workspace.parentIdeaId).toBe('parent-idea');
  }, 120_000);
});
