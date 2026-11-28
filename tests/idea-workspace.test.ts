import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import type { IdeaCard } from '../src/idea/card.js';
import {
  IDEA_TRANSITIONS,
  assertIdeaTransition,
  assertIdeaWorkspacePath,
  createWorkspace,
  loadVersionRecords,
  loadWorkspaceMeta,
  reviseEngineering,
  setIdeaStatus,
  verifyWorkspace,
} from '../src/idea/workspace.js';
import { CLI_BIN } from './helpers.js';

function makeCard(ideaId: string, overrides: Record<string, unknown> = {}): IdeaCard {
  return {
    ideaId,
    version: 1,
    parentVersion: null,
    status: 'CANDIDATE',
    hypothesis: {
      statement: 'reweighting by calibration error improves rare-class recall',
      targetProblem: 'FedAvg dilutes minority classes under non-IID clients',
    },
    paperEvidence: [
      { paperRef: 'fedavg-paper', statement: 'uniform averaging', evidence: 'p.5 §4.2' },
    ],
    contradictions: ['paper B reports no gain where paper A does'],
    novelty: {
      claim: 'calibration-error reweighting on the server',
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
        { kind: 'baseline-difference', text: 'vs sample-count weighting of FedAvg' },
        { kind: 'falsifier', text: 'no recall gain on 3 seeds' },
      ],
    },
    nearestComparisons: [
      { methodId: 'fedavg', difference: 'weighting rule', evidence: 'p.3 Algorithm 1' },
    ],
    componentNecessity: [
      {
        component: 'calibration probe',
        role: 'necessary-mechanism',
        removeEffect: 'gain disappears',
      },
    ],
    competingExplanations: ['lower effective learning rate'],
    boundaryConditions: ['no benefit without label skew'],
    risks: ['extra held-out pass per round'],
    minimalExperiment: {
      code: 'src/train.py',
      data: 'slice smoke-1',
      baselines: ['fedavg'],
      metrics: ['rare-class recall'],
      ablations: ['no reweighting'],
    },
    falsification: { conditions: ['recall delta < 0 on 3 seeds'] },
    budget: { maxRounds: 3, maxGpuMinutes: 120 },
    stopConditions: ['budget exhausted'],
    createdAt: 1,
    ...overrides,
  } as IdeaCard;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[], timeoutMs = 30_000): Promise<CliResult> {
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

async function writeCard(dir: string, name: string, card: IdeaCard): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(card, null, 2), 'utf8');
  return path;
}

describe('idea lifecycle state machine (unit)', () => {
  it('walks the documented graph and rejects skips', () => {
    expect(() => assertIdeaTransition('PROPOSED', 'IMPLEMENTING', undefined)).not.toThrow();
    expect(() => assertIdeaTransition('IMPLEMENTING', 'SMOKE_TESTED', undefined)).not.toThrow();
    expect(() => assertIdeaTransition('SMOKE_TESTED', 'RUNNING', undefined)).not.toThrow();
    expect(() => assertIdeaTransition('RUNNING', 'ANALYZING', undefined)).not.toThrow();
    expect(() => assertIdeaTransition('ANALYZING', 'SUPPORTED', undefined)).not.toThrow();

    expect(() => assertIdeaTransition('PROPOSED', 'SUPPORTED', undefined)).toThrow(
      /illegal idea transition/,
    );
    expect(() => assertIdeaTransition('SUPPORTED', 'REJECTED', 'x')).toThrow(
      /illegal idea transition/,
    );
    expect(() => assertIdeaTransition('NEEDS_REVISION', 'IMPLEMENTING', undefined)).not.toThrow();
  });

  it('requires a reason to reject an idea', () => {
    expect(() => assertIdeaTransition('PROPOSED', 'REJECTED', undefined)).toThrow(
      /requires --reason/,
    );
    expect(() =>
      assertIdeaTransition('PROPOSED', 'REJECTED', 'duplicate of known work'),
    ).not.toThrow();
    expect(IDEA_TRANSITIONS.SUPPORTED).toEqual([]);
    expect(IDEA_TRANSITIONS.REJECTED).toEqual([]);
  });
});

describe('terminal reopen via revision', () => {
  it('a revised version of a SUPPORTED idea restarts at PROPOSED', async () => {
    // Observed: reviseEngineering bumped the version but kept the terminal
    // status, so a citation-only card repair at v5 still reported SUPPORTED
    // while its fresh analysis was inconclusive — the inherited verdict
    // outranked the evidence. IDEA_TRANSITIONS documents the reopen path
    // ("a new version … starts at PROPOSED"); the code must implement it.
    const dir = await mkdtemp(join(tmpdir(), 'idea-reopen-'));
    await createWorkspace(dir, { ideaId: 'reopen-idea', card: makeCard('reopen-idea') });
    for (const to of [
      'IMPLEMENTING',
      'SMOKE_TESTED',
      'RUNNING',
      'ANALYZING',
      'SUPPORTED',
    ] as const) {
      if (to === 'SUPPORTED') {
        // SUPPORTED requires a recorded analysis verdict (contract); this
        // fixture only needs the terminal state to test the reopen path.
        await writeFile(
          join(dir, 'ideas', 'reopen-idea', 'analysis.json'),
          JSON.stringify({ verdict: 'supported', reasons: [] }),
          'utf8',
        );
      }
      await setIdeaStatus(dir, 'reopen-idea', to);
    }
    const before = await loadWorkspaceMeta(dir, 'reopen-idea');
    expect(before.status).toBe('SUPPORTED');

    const { meta } = await reviseEngineering(dir, 'reopen-idea', 'citation repair');
    expect(meta.status).toBe('PROPOSED');
    expect(meta.currentVersion).toBe(before.currentVersion + 1);
    expect(meta.history.at(-1)).toMatchObject({ from: 'SUPPORTED', to: 'PROPOSED' });

    // A non-terminal status survives a revision unchanged — only an
    // inherited terminal verdict has to be earned again.
    await setIdeaStatus(dir, 'reopen-idea', 'IMPLEMENTING');
    const second = await reviseEngineering(dir, 'reopen-idea', 'mechanism tweak');
    expect(second.meta.status).toBe('IMPLEMENTING');
  });
});

describe('assertIdeaWorkspacePath (unit)', () => {
  const root = resolve('/tmp/project');

  it('allows writes inside the own workspace only', () => {
    expect(() =>
      assertIdeaWorkspacePath(root, 'idea-a', join(root, 'ideas', 'idea-a', 'src', 'train.py')),
    ).not.toThrow();
    expect(() =>
      assertIdeaWorkspacePath(root, 'idea-a', join(root, 'ideas', 'idea-a')),
    ).not.toThrow();
  });

  it('refuses other ideas, upstream inputs and traversal', () => {
    expect(() =>
      assertIdeaWorkspacePath(root, 'idea-a', join(root, 'ideas', 'idea-b', 'src', 'x.py')),
    ).toThrow(/cross-idea or read-only write refused/);
    expect(() =>
      assertIdeaWorkspacePath(root, 'idea-a', join(root, 'papers', 'paper.pdf')),
    ).toThrow(/read-only write refused/);
    expect(() =>
      assertIdeaWorkspacePath(
        root,
        'idea-a',
        join(root, 'comparisons', 'fedavg', 'upstream', 'a.py'),
      ),
    ).toThrow(/read-only write refused/);
    expect(() =>
      assertIdeaWorkspacePath(root, 'idea-a', join(root, 'datasets', 'mnist', 'train.csv')),
    ).toThrow(/read-only write refused/);
    // Path traversal resolving outside the workspace.
    expect(() =>
      assertIdeaWorkspacePath(root, 'idea-a', 'ideas/idea-a/../../idea-b/src/x.py'),
    ).toThrow(/refused/);
  });
});

describe('ideaseek idea workspace (CLI)', () => {
  let project: string;

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'ideaseek-ws-'));
    const init = await runCli(project, ['init']);
    expect(init.code).toBe(0);
  }, 60_000);

  it('creates the full workspace structure with README and idea.md', async () => {
    const cardPath = await writeCard(project, 'card.json', makeCard('calib-reweight'));
    const created = await runCli(project, [
      'idea',
      'create',
      'calib-reweight',
      '--from-card',
      cardPath,
      '--json',
    ]);
    expect(created.code, created.stderr).toBe(0);
    const payload = JSON.parse(created.stdout) as {
      status: string;
      version: number;
      resumed: boolean;
    };
    expect(payload).toMatchObject({ status: 'PROPOSED', version: 1, resumed: false });

    const base = join(project, 'ideas', 'calib-reweight');
    for (const entry of [
      'idea.json',
      'idea.md',
      'workspace.json',
      'README.md',
      'versions/v1.json',
      'src',
      'config',
      'data',
      'experiments',
    ]) {
      const path = join(base, entry);
      await expect(
        (await import('node:fs/promises')).stat(path),
        `missing ${entry}`,
      ).resolves.toBeTruthy();
    }

    const readme = await readFile(join(base, 'README.md'), 'utf8');
    expect(readme).toContain('Do not write outside it');
    expect(readme).toContain('ideaseek idea checkpoint');
    expect(readme).toContain('quick/standard experiments');

    const ideaMd = await readFile(join(base, 'idea.md'), 'utf8');
    expect(ideaMd).toContain('reweighting by calibration error');
    expect(ideaMd).toContain('PROPOSED');
    expect(ideaMd).toContain('falsifier');

    const listed = await runCli(project, ['idea', 'list', '--json']);
    const listPayload = JSON.parse(listed.stdout) as {
      ideas: { ideaId: string; status: string }[];
    };
    expect(listPayload.ideas).toEqual([
      expect.objectContaining({ ideaId: 'calib-reweight', status: 'PROPOSED' }),
    ]);

    const shown = await runCli(project, ['idea', 'show', 'calib-reweight', '--json']);
    expect(shown.code).toBe(0);
    const showPayload = JSON.parse(shown.stdout) as {
      nextTransitions: string[];
      cardGate: string;
    };
    expect(showPayload.nextTransitions).toContain('IMPLEMENTING');
    expect(showPayload.cardGate).toBe('CANDIDATE');
  }, 60_000);

  it('refuses duplicate creation and idempotent checkpoints', async () => {
    const cardPath = await writeCard(project, 'card.json', makeCard('calib-reweight'));
    const first = await runCli(project, [
      'idea',
      'create',
      'calib-reweight',
      '--from-card',
      cardPath,
    ]);
    expect(first.code).toBe(0);

    const dup = await runCli(project, [
      'idea',
      'create',
      'calib-reweight',
      '--from-card',
      cardPath,
    ]);
    expect(dup.code).toBe(2);
    expect(dup.stderr).toContain('already exists');

    // Checkpoint: first records a hash, second (unchanged) is idempotent.
    await mkdir(join(project, 'ideas', 'calib-reweight', 'src'), { recursive: true });
    await writeFile(
      join(project, 'ideas', 'calib-reweight', 'src', 'train.py'),
      'def train():\n    return 1\n',
      'utf8',
    );
    const firstCp = await runCli(project, [
      'idea',
      'checkpoint',
      'calib-reweight',
      '--message',
      'initial train stub',
      '--json',
    ]);
    expect(firstCp.code).toBe(0);
    const cp1 = JSON.parse(firstCp.stdout) as { changed: boolean; codeHash: string | null };
    expect(cp1.changed).toBe(true);
    expect(cp1.codeHash).toMatch(/^sha256:/);

    const secondCp = await runCli(project, [
      'idea',
      'checkpoint',
      'calib-reweight',
      '--message',
      'same tree again',
      '--json',
    ]);
    expect(secondCp.code).toBe(0);
    const cp2 = JSON.parse(secondCp.stdout) as { changed: boolean };
    expect(cp2.changed).toBe(false);

    // Code change → new hash bound to the same idea version.
    await writeFile(
      join(project, 'ideas', 'calib-reweight', 'src', 'train.py'),
      'def train():\n    return 2\n',
      'utf8',
    );
    const thirdCp = await runCli(project, [
      'idea',
      'checkpoint',
      'calib-reweight',
      '--message',
      'tweak',
      '--json',
    ]);
    const cp3 = JSON.parse(thirdCp.stdout) as { changed: boolean; codeHash: string };
    expect(cp3.changed).toBe(true);
    expect(cp3.codeHash).not.toBe(cp1.codeHash);

    const versions = await loadVersionRecords(project, 'calib-reweight');
    expect(versions).toHaveLength(1);
    expect(versions[0]!.codeHash).toBe(cp3.codeHash);
    expect(versions[0]!.checkpoint?.message).toBe('tweak');
  }, 60_000);

  it('detects input changes against the recorded data manifest', async () => {
    const dataFile = join(project, 'source-data.csv');
    await writeFile(dataFile, 'x,y\n1,0\n', 'utf8');
    const cardPath = await writeCard(project, 'card.json', makeCard('calib-reweight'));
    const created = await runCli(project, [
      'idea',
      'create',
      'calib-reweight',
      '--from-card',
      cardPath,
      '--data',
      dataFile,
    ]);
    expect(created.code).toBe(0);

    const clean = await runCli(project, ['idea', 'verify', 'calib-reweight', '--json']);
    expect(clean.code).toBe(0);
    expect((JSON.parse(clean.stdout) as { ok: boolean }).ok).toBe(true);

    // Input drift (requirement: 输入变化 must be detected, never silent).
    await writeFile(dataFile, 'x,y\n2,1\n', 'utf8');
    const changed = await runCli(project, ['idea', 'verify', 'calib-reweight', '--json']);
    expect(changed.code).toBe(2);
    const payload = JSON.parse(changed.stdout) as {
      ok: boolean;
      inputsChanged: string[];
      issues: { kind: string }[];
    };
    expect(payload.ok).toBe(false);
    expect(payload.inputsChanged.join(' ')).toContain('source-data.csv');
    expect(payload.issues.some((issue) => issue.kind === 'input-changed')).toBe(true);
  }, 60_000);

  it('a corrupt version file fails loudly with recovery guidance (no raw SyntaxError)', async () => {
    // Listing path: one garbage version used to escape as an uncaught
    // SyntaxError with no code and no next step.
    const dir = join(project, 'ideas', 'corrupt-idea', 'versions');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'v1.json'), '{"version": 1, "summar', 'utf8');
    await expect(loadVersionRecords(project, 'corrupt-idea')).rejects.toThrow(/not valid JSON/);

    // Crash-recovery path: the pointer says v2 exists, the file is garbage.
    const cardPath = await writeCard(project, 'corrupt-card.json', makeCard('corrupt-revise'));
    const created = await runCli(project, [
      'idea',
      'create',
      'corrupt-revise',
      '--from-card',
      cardPath,
    ]);
    expect(created.code, created.stderr).toBe(0);
    await writeFile(
      join(project, 'ideas', 'corrupt-revise', 'versions', 'v2.json'),
      '{"version": 2, "trunc',
      'utf8',
    );
    const revise = await runCli(project, [
      'idea',
      'revise',
      'corrupt-revise',
      '--kind',
      'engineering',
      '--summary',
      'resume',
    ]);
    expect(revise.code).toBe(1); // INVALID_STATE = task failure, honest not silent
    expect(revise.stderr + revise.stdout).toMatch(/not valid JSON|unreadable/);
    expect(revise.stderr + revise.stdout).toContain('move');
  });

  it('resumes a crashed create and a crashed revise without corrupting the chain', async () => {
    // Crash window 1: workspace.json exists, idea.json missing.
    const partialDir = join(project, 'ideas', 'partial-idea');
    await mkdir(join(partialDir, 'versions'), { recursive: true });
    await writeFile(
      join(partialDir, 'workspace.json'),
      JSON.stringify(
        {
          ideaId: 'partial-idea',
          parentIdeaId: null,
          childIdeaIds: [],
          status: 'PROPOSED',
          statusReason: null,
          currentVersion: 1,
          createdAt: 1,
          updatedAt: 1,
          history: [],
        },
        null,
        2,
      ),
      'utf8',
    );
    const cardPath = await writeCard(project, 'card.json', makeCard('partial-idea'));
    const resumed = await runCli(project, [
      'idea',
      'create',
      'partial-idea',
      '--from-card',
      cardPath,
      '--json',
    ]);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect((JSON.parse(resumed.stdout) as { resumed: boolean }).resumed).toBe(true);
    const verifyPartial = await runCli(project, ['idea', 'verify', 'partial-idea', '--json']);
    expect(verifyPartial.code).toBe(0);

    // Crash window 2: revise wrote versions/v2.json but never bumped the pointer.
    const card2 = await writeCard(project, 'card2.json', makeCard('crash-revise'));
    const created = await runCli(project, ['idea', 'create', 'crash-revise', '--from-card', card2]);
    expect(created.code).toBe(0);
    await writeFile(
      join(project, 'ideas', 'crash-revise', 'versions', 'v2.json'),
      JSON.stringify(
        {
          ideaId: 'crash-revise',
          version: 2,
          parentVersion: 1,
          changeKind: 'engineering',
          codeHash: null,
          summary: 'interrupted revise',
          createdAt: 2,
        },
        null,
        2,
      ),
      'utf8',
    );
    const broken = await runCli(project, ['idea', 'verify', 'crash-revise', '--json']);
    expect(broken.code).toBe(2);
    expect(
      (JSON.parse(broken.stdout) as { issues: { detail: string }[] }).issues
        .map((issue) => issue.detail)
        .join(' '),
    ).toContain('crashed revise');

    // Rerunning revise completes v2 instead of creating v3.
    const fixed = await runCli(project, [
      'idea',
      'revise',
      'crash-revise',
      '--kind',
      'engineering',
      '--summary',
      'resume interrupted revision',
      '--json',
    ]);
    expect(fixed.code, fixed.stderr).toBe(0);
    expect((JSON.parse(fixed.stdout) as { version: number }).version).toBe(2);
    const versions = await loadVersionRecords(project, 'crash-revise');
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    const verifyFixed = await runCli(project, ['idea', 'verify', 'crash-revise', '--json']);
    expect(verifyFixed.code).toBe(0);
  }, 60_000);

  it('separates engineering revisions from scientific branches', async () => {
    const cardPath = await writeCard(project, 'card.json', makeCard('calib-reweight'));
    await runCli(project, ['idea', 'create', 'calib-reweight', '--from-card', cardPath]);

    // Scientific kind is refused in place — a new idea id is mandatory.
    const scientific = await runCli(project, [
      'idea',
      'revise',
      'calib-reweight',
      '--kind',
      'scientific',
      '--summary',
      'switch hypothesis entirely',
    ]);
    expect(scientific.code).toBe(2);
    expect(scientific.stderr).toContain('idea branch');

    // Engineering revision bumps version and the card together.
    const revised = await runCli(project, [
      'idea',
      'revise',
      'calib-reweight',
      '--kind',
      'engineering',
      '--summary',
      'add gradient clipping',
      '--json',
    ]);
    expect(revised.code).toBe(0);
    expect((JSON.parse(revised.stdout) as { version: number }).version).toBe(2);
    const card = JSON.parse(
      await readFile(join(project, 'ideas', 'calib-reweight', 'idea.json'), 'utf8'),
    ) as { version: number; parentVersion: number };
    expect(card).toEqual({ ...card, version: 2, parentVersion: 1 });
    expect((await loadWorkspaceMeta(project, 'calib-reweight')).currentVersion).toBe(2);

    // Scientific branch: new idea id linked to the parent, both verify clean.
    const childCardPath = await writeCard(
      project,
      'child.json',
      makeCard('calib-reweight-v2', {
        hypothesis: { statement: 'entirely new mechanism', targetProblem: 'x' },
      }),
    );
    const branch = await runCli(project, [
      'idea',
      'branch',
      'calib-reweight',
      'calib-reweight-v2',
      '--from-card',
      childCardPath,
      '--confirm', // guided-mode confirmation for a hypothesis change
      '--json',
    ]);
    expect(branch.code, branch.stderr).toBe(0);
    const parentMeta = await loadWorkspaceMeta(project, 'calib-reweight');
    const childMeta = await loadWorkspaceMeta(project, 'calib-reweight-v2');
    expect(parentMeta.childIdeaIds).toContain('calib-reweight-v2');
    expect(childMeta.parentIdeaId).toBe('calib-reweight');
    expect(childMeta.currentVersion).toBe(1);

    const childVersions = await loadVersionRecords(project, 'calib-reweight-v2');
    expect(childVersions[0]!.changeKind).toBe('scientific-branch');
    expect(childVersions[0]!.parentIdeaId).toBe('calib-reweight');

    expect((await runCli(project, ['idea', 'verify', 'calib-reweight'])).code).toBe(0);
    expect((await runCli(project, ['idea', 'verify', 'calib-reweight-v2'])).code).toBe(0);
  }, 60_000);

  it('refuses SUPPORTED without a recorded analysis verdict, then accepts one', async () => {
    // SUPPORTED names an evidentiary verdict: walking the legal chain to
    // ANALYZING and then hand-setting SUPPORTED must fail until the analysis
    // artifact exists (set-status used to just check the transition graph).
    const cardPath = await writeCard(project, 'card-s.json', makeCard('supported-gate'));
    expect(
      (await runCli(project, ['idea', 'create', 'supported-gate', '--from-card', cardPath])).code,
    ).toBe(0);
    for (const status of ['IMPLEMENTING', 'SMOKE_TESTED', 'RUNNING', 'ANALYZING']) {
      const step = await runCli(project, ['idea', 'set-status', 'supported-gate', status]);
      expect(step.code, step.stderr).toBe(0);
    }
    const refused = await runCli(project, ['idea', 'set-status', 'supported-gate', 'SUPPORTED']);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('analysis');

    // The artifact analyze persists is what unblocks the same command.
    await writeFile(
      join(project, 'ideas', 'supported-gate', 'analysis.json'),
      JSON.stringify({ verdict: 'supported', reasons: [] }),
      'utf8',
    );
    const ok = await runCli(project, ['idea', 'set-status', 'supported-gate', 'SUPPORTED']);
    expect(ok.code, ok.stderr).toBe(0);
  }, 60_000);

  it('enforces lifecycle transitions and reasons through the CLI', async () => {
    const cardPath = await writeCard(project, 'card.json', makeCard('calib-reweight'));
    await runCli(project, ['idea', 'create', 'calib-reweight', '--from-card', cardPath]);

    const illegal = await runCli(project, ['idea', 'set-status', 'calib-reweight', 'SUPPORTED']);
    expect(illegal.code).not.toBe(0);
    expect(illegal.stderr).toContain('illegal idea transition');

    const rejectedNoReason = await runCli(project, [
      'idea',
      'set-status',
      'calib-reweight',
      'REJECTED',
    ]);
    expect(rejectedNoReason.code).toBe(2);
    expect(rejectedNoReason.stderr).toContain('requires --reason');

    const rejected = await runCli(project, [
      'idea',
      'set-status',
      'calib-reweight',
      'REJECTED',
      '--reason',
      'duplicate of fedprox',
      '--json',
    ]);
    expect(rejected.code).toBe(0);
    const payload = JSON.parse(rejected.stdout) as { status: string; nextTransitions: string[] };
    expect(payload.status).toBe('REJECTED');
    expect(payload.nextTransitions).toEqual([]);

    const shown = await runCli(project, ['idea', 'show', 'calib-reweight', '--json']);
    const showPayload = JSON.parse(shown.stdout) as {
      statusReason: string;
      history: { to: string; reason: string | null }[];
    };
    expect(showPayload.statusReason).toBe('duplicate of fedprox');
    expect(showPayload.history.at(-1)).toMatchObject({
      to: 'REJECTED',
      reason: 'duplicate of fedprox',
    });
  }, 60_000);

  it('verifies version-chain corruption as an issue', async () => {
    const cardPath = await writeCard(project, 'card.json', makeCard('chain-broken'));
    await runCli(project, ['idea', 'create', 'chain-broken', '--from-card', cardPath]);

    // Card/workspace version divergence.
    const ideaPath = join(project, 'ideas', 'chain-broken', 'idea.json');
    const card = JSON.parse(await readFile(ideaPath, 'utf8')) as { version: number };
    card.version = 7;
    await writeFile(ideaPath, JSON.stringify(card), 'utf8');

    const verify = await runCli(project, ['idea', 'verify', 'chain-broken', '--json']);
    expect(verify.code).toBe(2);
    const payload = JSON.parse(verify.stdout) as { issues: { kind: string; detail: string }[] };
    const chainIssue = payload.issues.find((issue) => issue.kind === 'version-chain');
    expect(chainIssue?.detail).toContain('card.version 7');

    // Direct unit check of the in-process verifier too.
    const result = await verifyWorkspace(project, 'chain-broken');
    expect(result.ok).toBe(false);
  }, 60_000);
});
