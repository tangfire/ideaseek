import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import { CLI_BIN, implementIdeaSmoke } from './helpers.js';

/**
 * Rejected → revise → new version closure (LONG_RUNNING_WORKFLOWS + Journey G):
 * an engineering revision produces idea v2 while every v1 artifact (analysis,
 * mirrors, results) stays immutable; a scientific change branches to a NEW
 * idea_id with parentIdeaId; unaffected nodes (registered baselines) are not
 * re-run; a still-rejected idea can never be packaged for handoff.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fl-goldset');

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[], timeoutMs = 90_000): Promise<CliResult> {
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

describe('rejected → revise → branch closure (CLI)', () => {
  let project: string;
  let cardPath: string;

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'ideaseek-revloop-'));
    const init = await runCli(project, ['init']);
    expect(init.code).toBe(0);
    cardPath = join(project, 'card.json');
    const fixtureCard = await readFile(join(FIXTURES, 'idea-revisable.json'), 'utf8');
    await writeFile(cardPath, fixtureCard, 'utf8');
  }, 60_000);

  async function setupRejected(): Promise<void> {
    expect(
      (await runCli(project, ['idea', 'create', 'synth-revisable-idea', '--from-card', cardPath]))
        .code,
    ).toBe(0);
    expect(
      (await runCli(project, ['idea', 'set-status', 'synth-revisable-idea', 'IMPLEMENTING'])).code,
    ).toBe(0);
    expect((await runCli(project, ['idea', 'scaffold', 'synth-revisable-idea'])).code).toBe(0);
    // The check ladder runs src/smoke.py and now refuses the scaffold's
    // self-declared synthetic values, so this fixture needs a computing smoke.
    await implementIdeaSmoke(project, 'synth-revisable-idea');

    // Stronger registered baseline covering the card's nearest comparison.
    const baselineSpec = {
      specId: 'base-revloop-fixture',
      version: 1,
      idea: null,
      comparisonIds: ['baseline-majority-fixture'],
      codeCommit: null,
      dataSnapshotId: 'synthetic:fixture',
      sliceIds: [],
      environment: { python: 'v24', notes: ['scale:smoke'] },
      command: ['python', '-c', 'pass'],
      metrics: [{ name: 'accuracy', direction: 'higher' }],
      seeds: [42, 43],
      resources: {},
      budget: { maxRuns: 1, maxMinutes: 1 },
      protocolId: null,
      createdAt: 1,
    };
    const specPath = join(project, 'baseline-spec.json');
    await writeFile(specPath, JSON.stringify(baselineSpec), 'utf8');
    expect((await runCli(project, ['experiment', 'spec', specPath])).code).toBe(0);
    const baselineResult = {
      specId: 'base-revloop-fixture',
      status: 'succeeded',
      logRefs: [],
      artifactRefs: [],
      metrics: [{ name: 'accuracy', value: 0.9 }],
      resourcesUsed: {},
      failure: null,
      startedAt: 1,
      finishedAt: 2,
    };
    const resultPath = join(project, 'baseline-result.json');
    await writeFile(resultPath, JSON.stringify(baselineResult), 'utf8');
    expect((await runCli(project, ['experiment', 'result', resultPath])).code).toBe(0);

    expect((await runCli(project, ['idea', 'check', 'synth-revisable-idea'])).code).toBe(0);
    const exp = await runCli(project, ['idea', 'experiment', 'synth-revisable-idea', '--json']);
    expect(exp.code, exp.stdout + exp.stderr).toBe(0);
    expect(
      (await runCli(project, ['idea', 'analyze', 'synth-revisable-idea', '--json'])).code,
    ).toBe(0);
  }

  it('closes the loop: rejected → NEEDS_REVISION → v2 re-run → artifacts retained → still not packageable', async () => {
    await setupRejected();

    // The fixture idea really is rejected against the stronger baseline.
    const firstAnalysis = JSON.parse(
      await readFile(
        join(project, 'ideas', 'synth-revisable-idea', 'experiments', 'analysis.json'),
        'utf8',
      ),
    ) as { verdict: string; failureClass: string };
    expect(firstAnalysis.verdict).toBe('rejected');
    expect(firstAnalysis.failureClass).toBe('effect-insufficient');

    // Handoff refuses the rejected idea.
    const refused = await runCli(project, ['idea', 'handoff', 'synth-revisable-idea']);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('rejected');

    // --- engineering revision → same idea, new version.
    expect(
      (
        await runCli(project, [
          'idea',
          'set-status',
          'synth-revisable-idea',
          'NEEDS_REVISION',
          '--reason',
          'estimator underperforms baseline',
        ])
      ).code,
    ).toBe(0);
    expect(
      (await runCli(project, ['idea', 'set-status', 'synth-revisable-idea', 'IMPLEMENTING'])).code,
    ).toBe(0);
    const revised = await runCli(project, [
      'idea',
      'revise',
      'synth-revisable-idea',
      '--kind',
      'engineering',
      '--summary',
      'switch to trimmed aggregation in train.py',
      '--json',
    ]);
    expect(revised.code, revised.stderr).toBe(0);
    expect((JSON.parse(revised.stdout) as { version: number }).version).toBe(2);

    // Workspace card (authoritative) and version chain: v1 → v2, same ideaId.
    const card = JSON.parse(
      await readFile(join(project, 'ideas', 'synth-revisable-idea', 'idea.json'), 'utf8'),
    ) as { ideaId: string; version: number; parentVersion: number | null };
    expect(card).toMatchObject({ ideaId: 'synth-revisable-idea', version: 2, parentVersion: 1 });

    // --- re-validate and re-run ONLY the affected idea node.
    expect((await runCli(project, ['idea', 'check', 'synth-revisable-idea'])).code).toBe(0);
    const rerun = await runCli(project, ['idea', 'experiment', 'synth-revisable-idea', '--json']);
    expect(rerun.code, rerun.stdout + rerun.stderr).toBe(0);
    const rerunPayload = JSON.parse(rerun.stdout) as { version: number };
    expect(rerunPayload.version).toBe(2); // new spec version from idea-v:2 binding

    // Ablations re-run bound to the new idea version (idea-v:2 in notes).
    const ablate = await runCli(project, ['idea', 'ablate', 'synth-revisable-idea', '--json']);
    expect(ablate.code, ablate.stdout + ablate.stderr).toBe(0);
    const ablationPayload = JSON.parse(ablate.stdout) as {
      entries: { ablationId: string; specId: string }[];
    };
    expect(ablationPayload.entries.length).toBeGreaterThanOrEqual(1);
    const firstAblation = await runCli(project, [
      'experiment',
      'show',
      ablationPayload.entries[0]!.specId,
      '--json',
    ]);
    expect(firstAblation.code).toBe(0);
    const ablDoc = JSON.parse(firstAblation.stdout) as {
      spec: { environment: { notes: string[] } };
    };
    expect(ablDoc.spec.environment.notes.join(' ')).toContain('idea-v:2');

    // --- re-analyze at v2 (fresh verdict against the same baseline).
    const reanalyze = await runCli(project, ['idea', 'analyze', 'synth-revisable-idea', '--json']);
    expect(reanalyze.code).toBe(0);

    // --- immutability: v1 artifacts all survive.
    const analysisV1 = JSON.parse(
      await readFile(
        join(project, 'ideas', 'synth-revisable-idea', 'experiments', 'analysis-v1.json'),
        'utf8',
      ),
    ) as { ideaVersion: number; verdict: string };
    expect(analysisV1.ideaVersion).toBe(1);
    expect(analysisV1.verdict).toBe('rejected');
    const analysisV2 = JSON.parse(
      await readFile(
        join(project, 'ideas', 'synth-revisable-idea', 'experiments', 'analysis-v2.json'),
        'utf8',
      ),
    ) as { ideaVersion: number };
    expect(analysisV2.ideaVersion).toBe(2);
    await expect(
      readFile(
        join(
          project,
          'ideas',
          'synth-revisable-idea',
          'experiments',
          'idea-synth-revisable-idea-v1.json',
        ),
        'utf8',
      ),
    ).resolves.toContain('"spec"');
    await expect(
      readFile(
        join(
          project,
          'ideas',
          'synth-revisable-idea',
          'experiments',
          'idea-synth-revisable-idea-v2.json',
        ),
        'utf8',
      ),
    ).resolves.toContain('"spec"');

    // --- unaffected nodes: the registered baseline was NOT re-run.
    const baseline = await runCli(project, [
      'experiment',
      'show',
      'base-revloop-fixture',
      '--json',
    ]);
    expect(baseline.code).toBe(0);
    const baselineDoc = JSON.parse(baseline.stdout) as { version: number };
    expect(baselineDoc.version).toBe(1);

    // Still rejected after the revision (scaffold values unchanged) → no package.
    const finalAnalysis = JSON.parse(
      await readFile(
        join(project, 'ideas', 'synth-revisable-idea', 'experiments', 'analysis.json'),
        'utf8',
      ),
    ) as { verdict: string };
    expect(finalAnalysis.verdict).toBe('rejected');
    const stillRefused = await runCli(project, ['idea', 'handoff', 'synth-revisable-idea']);
    expect(stillRefused.code).not.toBe(0);
  }, 300_000);

  it('scientific change branches to a new idea_id with parentIdeaId, preserving the parent', async () => {
    await setupRejected();

    // Child card: same fixture, new id + different hypothesis (scientific).
    const parentCard = JSON.parse(await readFile(cardPath, 'utf8')) as Record<string, unknown>;
    const childCard = {
      ...parentCard,
      ideaId: 'synth-branched-idea',
      hypothesis: {
        statement: 'per-class thresholding beats aggregation reweighting under heterogeneity',
        targetProblem: String((parentCard.hypothesis as { targetProblem: string }).targetProblem),
      },
      createdAt: Date.now(),
    };
    const childPath = join(project, 'child-card.json');
    await writeFile(childPath, JSON.stringify(childCard, null, 2), 'utf8');

    const branch = await runCli(project, [
      'idea',
      'branch',
      'synth-revisable-idea',
      'synth-branched-idea',
      '--from-card',
      childPath,
      '--confirm',
      '--json',
    ]);
    expect(branch.code, branch.stderr).toBe(0);
    const branchPayload = JSON.parse(branch.stdout) as { parentIdeaId: string };
    expect(branchPayload.parentIdeaId).toBe('synth-revisable-idea');

    // Parent linkage recorded on both sides; parent artifacts untouched.
    const parentMeta = JSON.parse(
      await readFile(join(project, 'ideas', 'synth-revisable-idea', 'workspace.json'), 'utf8'),
    ) as { childIdeaIds: string[] };
    expect(parentMeta.childIdeaIds).toContain('synth-branched-idea');
    const childMeta = JSON.parse(
      await readFile(join(project, 'ideas', 'synth-branched-idea', 'workspace.json'), 'utf8'),
    ) as { parentIdeaId: string; currentVersion: number };
    expect(childMeta.parentIdeaId).toBe('synth-revisable-idea');
    expect(childMeta.currentVersion).toBe(1);

    const childVersions = JSON.parse(
      await readFile(join(project, 'ideas', 'synth-branched-idea', 'versions', 'v1.json'), 'utf8'),
    ) as { changeKind: string; parentIdeaId: string };
    expect(childVersions.changeKind).toBe('scientific-branch');
    expect(childVersions.parentIdeaId).toBe('synth-revisable-idea');

    // Parent's rejected analysis is still there (never deleted by branching).
    const parentAnalysis = JSON.parse(
      await readFile(
        join(project, 'ideas', 'synth-revisable-idea', 'experiments', 'analysis.json'),
        'utf8',
      ),
    ) as { verdict: string };
    expect(parentAnalysis.verdict).toBe('rejected');
  }, 300_000);
});
