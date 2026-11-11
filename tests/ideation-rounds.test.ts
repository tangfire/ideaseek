import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ideaFingerprint } from '../src/idea/rounds.js';
import type { IdeationRound } from '../src/idea/rounds.js';
import type { IdeaCard } from '../src/idea/card.js';
import { CLI_BIN } from './helpers.js';

/**
 * IdeationRound (docs/IDEATION_ROUNDS.md): immutable round snapshots, honest
 * no-new-information gating, dedup fingerprints, novelty constraints and
 * append-only user feedback with an auditable event.
 */

function makeCard(ideaId: string, overrides: Record<string, unknown> = {}): IdeaCard {
  return {
    ideaId,
    version: 1,
    parentVersion: null,
    status: 'CANDIDATE',
    hypothesis: { statement: `hypothesis for ${ideaId}`, targetProblem: 't' },
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
      { component: 'calibration probe', role: 'necessary-mechanism', removeEffect: 'gain gone' },
    ],
    competingExplanations: ['x'],
    boundaryConditions: ['x'],
    risks: ['x'],
    minimalExperiment: {
      code: 'src/train.py',
      data: 'd',
      baselines: ['fedavg'],
      metrics: ['accuracy'],
      ablations: ['a'],
    },
    falsification: { conditions: ['f'] },
    budget: { maxRounds: 1, maxGpuMinutes: 10 },
    stopConditions: ['s'],
    createdAt: 1,
    ...overrides,
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

async function freshProject(): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), 'ideaseek-rounds-'));
  expect((await runCli(project, ['init'])).code).toBe(0);
  return project;
}

async function createIdea(project: string, id: string): Promise<void> {
  const cardPath = join(project, `${id}.json`);
  await writeFile(cardPath, JSON.stringify(makeCard(id)), 'utf8');
  const created = await runCli(project, ['idea', 'create', id, '--from-card', cardPath]);
  expect(created.code, created.stderr).toBe(0);
}

describe('ideaFingerprint (unit)', () => {
  it('is stable across key order and sensitive to hypothesis/mechanism/comparisons', () => {
    const card = makeCard('fp-test');
    const reordered = {
      nearestComparisons: card.nearestComparisons,
      mechanismChain: card.mechanismChain,
      hypothesis: card.hypothesis,
    };
    expect(ideaFingerprint(reordered as never)).toBe(ideaFingerprint(card));

    const changed = makeCard('fp-test', {
      hypothesis: { statement: 'a different hypothesis entirely', targetProblem: 't' },
    });
    expect(ideaFingerprint(changed)).not.toBe(ideaFingerprint(card));

    const extraComparison = makeCard('fp-test', {
      nearestComparisons: [
        ...card.nearestComparisons,
        { methodId: 'fedprox', difference: 'd', evidence: 'e' },
      ],
    });
    expect(ideaFingerprint(extraComparison)).not.toBe(ideaFingerprint(card));
  });
});

describe('ideation rounds (CLI)', () => {
  it('creates r1 with snapshots and reports new information honestly', async () => {
    const project = await freshProject();
    const created = await runCli(project, [
      'ideate',
      '--round',
      'new',
      '--question',
      'find a different mechanism',
      '--ideas',
      '3',
      '--json',
    ]);
    expect(created.code, created.stderr).toBe(0);
    const payload = JSON.parse(created.stdout) as {
      mode: string;
      roundId: string;
      hasNewInformation: boolean;
      ideaLimit: number;
      snapshots: { paperCardCount: number; comparisonSet: unknown[] };
      noveltyConstraints: unknown[];
    };
    expect(payload.mode).toBe('new');
    expect(payload.roundId).toBe('r1');
    expect(payload.hasNewInformation).toBe(true); // first round is always new
    expect(payload.ideaLimit).toBe(3);
    expect(payload.snapshots.comparisonSet).toEqual([]);
    expect(payload.noveltyConstraints).toEqual([]);

    const plain = await runCli(project, ['rounds', 'list']);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain('r1');
    expect(plain.stdout).toContain('find a different mechanism');
  }, 60_000);

  it('creates r2 with an honest no-new-information gate when nothing changed', async () => {
    const project = await freshProject();
    expect(
      (await runCli(project, ['ideate', '--round', 'new', '--question', 'first round'])).code,
    ).toBe(0);

    const second = await runCli(project, ['ideate', '--round', 'new', '--json']);
    expect(second.code, second.stderr).toBe(0);
    const payload = JSON.parse(second.stdout) as {
      roundId: string;
      hasNewInformation: boolean;
      note: string;
      stopReason: string | null;
      parentRoundId: string | null;
    };
    expect(payload.roundId).toBe('r2');
    expect(payload.hasNewInformation).toBe(false);
    expect(payload.note).toContain('no new evidence');
    expect(payload.stopReason).toBe('no-new-information');
    expect(payload.parentRoundId).toBe('r1');

    const plain = await runCli(project, ['ideate', '--round', 'new']);
    expect(plain.stdout).toContain('没有足够新信息');
    expect(plain.stdout).toContain('never padded');
  }, 60_000);

  it('detects new information from user feedback and inherits idea context', async () => {
    const project = await freshProject();
    await createIdea(project, 'idea-001');
    // First round (baseline snapshot), then feedback changes the state.
    expect((await runCli(project, ['ideate', '--round', 'new'])).code).toBe(0);
    // A run binds feedback events.
    expect((await runCli(project, ['run', '--question', 'round ctx', '--enqueue-only'])).code).toBe(
      0,
    );

    expect(
      (
        await runCli(project, [
          'feedback',
          'useful',
          '--idea',
          'idea-001',
          '--reason',
          'clear mechanism',
          '--json',
        ])
      ).code,
    ).toBe(0);

    const created = await runCli(project, ['ideate', '--round', 'new', '--json']);
    expect(created.code, created.stderr).toBe(0);
    const payload = JSON.parse(created.stdout) as {
      roundId: string;
      hasNewInformation: boolean;
      note: string;
      inherited: { ideaId: string; fingerprint: string; feedbackLabels: string[] }[];
      noveltyConstraints: string[];
    };
    expect(payload.roundId).toBe('r2');
    expect(payload.hasNewInformation).toBe(true);
    expect(payload.note).toContain('feedback');
    expect(payload.inherited).toHaveLength(1);
    expect(payload.inherited[0]).toMatchObject({
      ideaId: 'idea-001',
      feedbackLabels: ['useful'],
    });
    expect(payload.inherited[0]!.fingerprint).toMatch(/^sha256:/);
    expect(payload.noveltyConstraints.join(' ')).toContain('necessary-mechanism:calibration probe');

    // Feedback file is append-only: a second label keeps the first.
    expect(
      (
        await runCli(project, [
          'feedback',
          'invalid',
          '--idea',
          'idea-001',
          '--reason',
          'no signal',
          '--json',
        ])
      ).code,
    ).toBe(0);
    const feedback = JSON.parse(
      await readFile(join(project, 'ideas', 'idea-001', 'feedback.json'), 'utf8'),
    ) as { label: string }[];
    expect(feedback.map((f) => f.label)).toEqual(['useful', 'invalid']);
  }, 120_000);

  it('records feedback as a run event and validates labels/ideas', async () => {
    const project = await freshProject();
    await createIdea(project, 'idea-002');
    expect((await runCli(project, ['run', '--question', 'fb', '--enqueue-only'])).code).toBe(0);

    const recorded = await runCli(project, [
      'feedback',
      'prior-work',
      '--idea',
      'idea-002',
      '--json',
    ]);
    expect(recorded.code, recorded.stderr).toBe(0);
    const payload = JSON.parse(recorded.stdout) as {
      eventSeq: number | null;
      totalFeedback: number;
    };
    expect(payload.eventSeq).toBeGreaterThan(0);
    expect(payload.totalFeedback).toBe(1);

    const events = await runCli(project, ['events', '--json']);
    const feedbackEvent = (
      JSON.parse(events.stdout) as {
        events: { eventType: string; status: string; summary: string }[];
      }
    ).events.find((e) => e.eventType === 'feedback');
    expect(feedbackEvent).toBeTruthy();
    expect(feedbackEvent!.status).toBe('prior-work');
    expect(feedbackEvent!.summary).toContain('idea-002');

    const badLabel = await runCli(project, ['feedback', 'meh', '--idea', 'idea-002']);
    expect(badLabel.code).not.toBe(0);
    expect(badLabel.stderr).toContain('label must be one of');

    const ghost = await runCli(project, ['feedback', 'useful', '--idea', 'ghost-idea']);
    expect(ghost.code).not.toBe(0);
    expect(ghost.stderr).toContain('not found');
  }, 120_000);

  it('rounds show exposes immutable snapshots and continue loads read-only', async () => {
    const project = await freshProject();
    await createIdea(project, 'idea-003');
    expect((await runCli(project, ['ideate', '--round', 'new'])).code).toBe(0);

    const shown = await runCli(project, ['rounds', 'show', 'r1', '--json']);
    expect(shown.code).toBe(0);
    const round = (JSON.parse(shown.stdout) as { round: IdeationRound }).round;
    expect(round.roundId).toBe('r1');
    expect(round.status).toBe('open');
    expect(round.snapshots.paperCardCount).toBe(0);
    expect(round.inherited.map((ref) => ref.ideaId)).toContain('idea-003');
    expect(round.knownFingerprints[0]).toMatch(/^sha256:/);

    const continued = await runCli(project, ['ideate', '--round', 'r1', '--continue']);
    expect(continued.code).toBe(0);
    expect(continued.stdout).toContain('continuing r1');
    expect(continued.stdout).toContain('idea-003');

    // The round file was not mutated by --continue (immutable rounds).
    const reread = JSON.parse(
      await readFile(join(project, 'knowledge', 'ideation-rounds', 'r1.json'), 'utf8'),
    ) as IdeationRound;
    expect(reread.status).toBe('open');

    const ghost = await runCli(project, ['rounds', 'show', 'r99']);
    expect(ghost.code).not.toBe(0);
    expect(ghost.stderr).toContain('not found');
  }, 120_000);
});
