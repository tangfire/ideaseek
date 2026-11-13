import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, makeProjectDir } from './helpers.js';
import {
  IDEA_DISCUSS_SCHEMA,
  parseDiscussionOutput,
  type DiscussContext,
} from '../src/idea/discuss.js';

/**
 * Research Discussant (docs/AGENT_ROLES.md): structured pro/con arguments
 * over an existing idea, every evidence source bound to the context
 * (or explicitly `speculation`); both sides must be argued; the envelope
 * pins ideaId + cardVersion so a revised idea forces a fresh discussion.
 */

function context(): DiscussContext {
  return {
    ideaId: 'alpha',
    cardVersion: 1,
    sources: ['speculation', 'idea-card', 'question', 'experiment:idea-alpha'],
    lines: ['Idea: alpha v1 [DRAFT_COMPOSITION]', 'Hypothesis: h'],
  };
}

function validDiscussion(): Record<string, unknown> {
  return {
    contract: IDEA_DISCUSS_SCHEMA,
    ideaId: 'alpha',
    cardVersion: 1,
    position: 'contested',
    arguments: [
      {
        side: 'pro',
        statement: 'Mechanism chain is complete.',
        evidence: [{ source: 'idea-card', location: 'mechanismChain.steps' }],
        confidence: 0.7,
      },
      {
        side: 'con',
        statement: 'No reproduced baseline yet.',
        evidence: [{ source: 'speculation', location: 'no baseline in context' }],
        confidence: 0.6,
      },
    ],
    openQuestions: ['Does it hold on the standard slice?'],
    recommendation: 'Reproduce the baseline first.',
  };
}

function expectRejected(output: Record<string, unknown>, pattern: RegExp): void {
  try {
    parseDiscussionOutput(JSON.stringify(output), context());
    expect.unreachable('should have thrown');
  } catch (error) {
    const message = (error as { message: string }).message;
    expect(message).toMatch(pattern);
  }
}

describe('parseDiscussionOutput (contract + bindings)', () => {
  it('accepts a complete discussion and echoes the envelope', () => {
    const parsed = parseDiscussionOutput(JSON.stringify(validDiscussion()), context());
    expect(parsed.position).toBe('contested');
    expect(parsed.arguments).toHaveLength(2);
  });

  it('rejects wrong contract, idea and version bindings', () => {
    expectRejected({ ...validDiscussion(), contract: 'other-v1' }, /contract must be/);
    expectRejected({ ...validDiscussion(), ideaId: 'beta' }, /verbatim/);
    expectRejected({ ...validDiscussion(), cardVersion: 2 }, /verbatim/);
  });

  it('requires both sides', () => {
    const oneSided = validDiscussion();
    (oneSided.arguments as Record<string, unknown>[])[1]!.side = 'pro';
    expectRejected(oneSided, /at least one con/);
  });

  it('rejects invented evidence sources and empty questions', () => {
    const invented = validDiscussion();
    (invented.arguments as Record<string, unknown>[])[0]!.evidence = [
      { source: 'ghost-paper-2026', location: 'p.9' },
    ];
    expectRejected(invented, /not among the context sources/);

    const noQuestions = validDiscussion();
    noQuestions.openQuestions = [];
    expectRejected(noQuestions, /openQuestions/);
  });

  it('rejects a missing recommendation', () => {
    const bad = validDiscussion();
    bad.recommendation = ' ';
    expectRejected(bad, /recommendation/);
  });
});

function runCli(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 60_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
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

function makeCard(ideaId: string): Record<string, unknown> {
  return {
    ideaId,
    version: 1,
    parentVersion: null,
    status: 'DRAFT_COMPOSITION',
    hypothesis: { statement: 'Drift term helps.', targetProblem: 'label skew' },
    paperEvidence: [{ paperRef: 'mcmahan17a', statement: 'FedAvg', evidence: 'p.1' }],
    contradictions: ['prior work says otherwise'],
    novelty: {
      claim: 'drift estimator',
      uncertainty: 'thin evidence',
      whyNotRestatement: 'adds a term',
    },
    mechanismChain: {
      designPrincipleLink: 'compensate drift',
      steps: [{ kind: 'observation', text: 'updates diverge' }],
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
      metrics: ['accuracy'],
      ablations: ['w/o term'],
    },
    falsification: { conditions: ['no gain'] },
    budget: { maxRounds: 2, maxGpuMinutes: 30 },
    stopConditions: ['budget'],
    createdAt: 1,
  };
}

async function seededProject(): Promise<{ dir: string; ideaId: string }> {
  const dir = await makeProjectDir();
  const ideaId = 'alpha';
  const cardPath = join(dir, 'card.json');
  await writeFile(cardPath, JSON.stringify(makeCard(ideaId)), 'utf8');
  expect((await runCli(dir, ['idea', 'create', ideaId, '--from-card', cardPath])).code).toBe(0);
  return { dir, ideaId };
}

describe('ideaseek idea discuss (e2e, fake harness)', () => {
  it('writes a bound discussion with both sides, then reuses it', async () => {
    const { dir, ideaId } = await seededProject();
    const first = await runCli(dir, ['idea', 'discuss', ideaId, '--harness', 'fake']);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).toContain('discussion written');
    expect(first.stdout).toContain('1 pro / 1 con');

    const stored = JSON.parse(
      await readFile(join(dir, 'ideas', ideaId, 'discussion.json'), 'utf8'),
    ) as {
      contract: string;
      inputHash: string;
      discussion: {
        ideaId: string;
        cardVersion: number;
        arguments: { side: string }[];
        position: string;
      };
    };
    expect(stored.contract).toBe('idea-discuss-v1');
    expect(stored.discussion.ideaId).toBe(ideaId);
    expect(stored.discussion.cardVersion).toBe(1);
    expect(stored.discussion.arguments.some((arg) => arg.side === 'pro')).toBe(true);
    expect(stored.discussion.arguments.some((arg) => arg.side === 'con')).toBe(true);

    // Immutable versioned history alongside the pointer.
    const versions = await readFile(
      join(dir, 'ideas', ideaId, 'discussions', 'discussion-v1.json'),
      'utf8',
    );
    expect(versions).toContain('idea-discuss-v1');

    const second = await runCli(dir, ['idea', 'discuss', ideaId, '--harness', 'fake']);
    expect(second.stdout).toContain('reused discussion');
  }, 180_000);

  it('maps quota blocks to exit 2 with nothing written', async () => {
    const { dir, ideaId } = await seededProject();
    const blocked = await runCli(dir, ['idea', 'discuss', ideaId, '--harness', 'fake'], {
      IDEASEEK_FAKE_BLOCK: 'QUOTA_EXHAUSTED',
    });
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain('nothing was written');
    await expect(readFile(join(dir, 'ideas', ideaId, 'discussion.json'), 'utf8')).rejects.toThrow();
  }, 180_000);

  it('rejects output citing invented sources with zero writes', async () => {
    const { dir, ideaId } = await seededProject();
    const bad = JSON.stringify({
      ...JSON.parse(
        JSON.stringify({
          contract: IDEA_DISCUSS_SCHEMA,
          ideaId,
          cardVersion: 1,
          position: 'supported',
          arguments: [
            {
              side: 'pro',
              statement: 'great',
              evidence: [{ source: 'invented-paper-9000', location: 'p.1' }],
              confidence: 0.9,
            },
            {
              side: 'con',
              statement: 'but',
              evidence: [{ source: 'speculation', location: 'x' }],
              confidence: 0.5,
            },
          ],
          openQuestions: ['q?'],
          recommendation: 'wait',
        }),
      ),
    });
    const failed = await runCli(dir, ['idea', 'discuss', ideaId, '--harness', 'fake'], {
      IDEASEEK_FAKE_DISCUSS_OUTPUT: bad,
    });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('not among the context sources');
    await expect(readFile(join(dir, 'ideas', ideaId, 'discussion.json'), 'utf8')).rejects.toThrow();
  }, 180_000);
});
