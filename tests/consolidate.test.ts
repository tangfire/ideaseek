import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, makeProjectDir } from './helpers.js';
import {
  CONSOLIDATION_SCHEMA,
  parseConsolidationOutput,
  type ConsolidationContext,
} from '../src/idea/consolidate.js';

/**
 * Synthesis Lead (docs/AGENT_ROLES.md): final candidate set with tradeoff
 * reasons. Two machine-enforced boundaries — every input ref gets a
 * selection (never silently deleted) and failure opinions survive when
 * the context has them (不能删除失败意见).
 */

function context(overrides: Partial<ConsolidationContext> = {}): ConsolidationContext {
  return {
    refs: ['alpha', 'beta'],
    failureOpinions: 0,
    sources: ['speculation', 'round:r1', 'idea:alpha', 'idea:beta'],
    lines: [],
    ...overrides,
  };
}

function validConsolidation(): Record<string, unknown> {
  return {
    contract: CONSOLIDATION_SCHEMA,
    selections: [
      {
        ref: 'alpha',
        decision: 'advance',
        rationale: 'Supported by experiment evidence.',
        evidence: [{ source: 'idea:alpha', location: 'analysis' }],
      },
      {
        ref: 'beta',
        decision: 'drop',
        rationale: 'No discriminating experiment separates it from alpha.',
        evidence: [{ source: 'speculation', location: 'no result yet' }],
      },
    ],
    mergedInto: [],
    retainedCompetingExplanations: ['lr schedule explains the gain (kept)'],
    retainedFailureOpinions: [],
    recommendation: 'Advance alpha; keep beta on file.',
  };
}

function expectRejected(
  output: Record<string, unknown>,
  ctx: ConsolidationContext,
  pattern: RegExp,
): void {
  try {
    parseConsolidationOutput(JSON.stringify(output), ctx);
    expect.unreachable('should have thrown');
  } catch (error) {
    expect((error as { message: string }).message).toMatch(pattern);
  }
}

describe('parseConsolidationOutput (coverage + retention)', () => {
  it('accepts a complete consolidation', () => {
    const parsed = parseConsolidationOutput(JSON.stringify(validConsolidation()), context());
    expect(parsed.selections).toHaveLength(2);
    expect(parsed.retainedCompetingExplanations.length).toBeGreaterThan(0);
  });

  it('rejects silent deletion of input refs', () => {
    const dropped = validConsolidation();
    (dropped.selections as unknown[]).pop(); // beta unselected
    expectRejected(dropped, context(), /"beta" has no selection/);

    const empty = validConsolidation();
    empty.selections = [];
    expectRejected(empty, context(), /dropped silently/);
  });

  it('allows an empty selection only when there are no inputs', () => {
    const none = validConsolidation();
    none.selections = [];
    expect(() =>
      parseConsolidationOutput(JSON.stringify(none), context({ refs: [] })),
    ).not.toThrow();
  });

  it('rejects duplicate selections, bad decisions and invented sources', () => {
    const dup = validConsolidation();
    (dup.selections as unknown[]).push(structuredClone((dup.selections as unknown[])[0]));
    expectRejected(dup, context(), /selected twice/);

    const badDecision = validConsolidation();
    (badDecision.selections as Record<string, unknown>[])[0]!.decision = 'yeet';
    expectRejected(badDecision, context(), /advance \| merge \| drop/);

    const invented = validConsolidation();
    (invented.selections as Record<string, unknown>[])[0]!.evidence = [
      { source: 'ghost-2026', location: 'p.1' },
    ];
    expectRejected(invented, context(), /not among the context sources/);
  });

  it('enforces the anti-deletion retention rules', () => {
    const noCompeting = validConsolidation();
    noCompeting.retainedCompetingExplanations = [];
    expectRejected(noCompeting, context(), /never delete competing explanations/);

    const lostFailures = validConsolidation();
    lostFailures.retainedFailureOpinions = [];
    expectRejected(lostFailures, context({ failureOpinions: 2 }), /failure opinion\(s\)/);

    // No failures in context → empty retention is honest.
    expect(() =>
      parseConsolidationOutput(
        JSON.stringify(validConsolidation()),
        context({ failureOpinions: 0 }),
      ),
    ).not.toThrow();
  });

  it('rejects malformed merges and a missing recommendation', () => {
    const badMerge = validConsolidation();
    badMerge.mergedInto = [{ source: 'a', target: '', reason: 'r' }];
    expectRejected(badMerge, context(), /mergedInto\[0\]/);

    const noRecommendation = validConsolidation();
    noRecommendation.recommendation = ' ';
    expectRejected(noRecommendation, context(), /recommendation/);

    const wrongContract = validConsolidation();
    wrongContract.contract = 'other-v1';
    expectRejected(wrongContract, context(), /contract must be/);
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
    hypothesis: { statement: 'h', targetProblem: 'p' },
    paperEvidence: [{ paperRef: 'mcmahan17a', statement: 's', evidence: 'p.1' }],
    contradictions: ['c'],
    novelty: { claim: 'n', uncertainty: 'u', whyNotRestatement: 'w' },
    mechanismChain: {
      designPrincipleLink: 'd',
      steps: [{ kind: 'observation', text: 't' }],
    },
    nearestComparisons: [{ methodId: 'fedavg', difference: 'x', evidence: 'e' }],
    componentNecessity: [],
    competingExplanations: ['ce'],
    boundaryConditions: ['bc'],
    risks: ['r'],
    minimalExperiment: {
      code: 'c',
      data: 'd',
      baselines: ['b'],
      metrics: ['m'],
      ablations: ['a'],
    },
    falsification: { conditions: ['f'] },
    budget: { maxRounds: 1, maxGpuMinutes: 10 },
    stopConditions: ['s'],
    createdAt: 1,
  };
}

describe('ideaseek consolidate (e2e, fake harness)', () => {
  it('selects every input ref and writes the consolidation, then reuses it', async () => {
    const dir = await makeProjectDir();
    const cardPath = join(dir, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard('alpha')), 'utf8');
    expect((await runCli(dir, ['idea', 'create', 'alpha', '--from-card', cardPath])).code).toBe(0);

    const first = await runCli(dir, ['consolidate', '--harness', 'fake']);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).toContain('consolidation written');

    const stored = JSON.parse(
      await readFile(join(dir, 'knowledge', 'consolidation.json'), 'utf8'),
    ) as {
      contract: string;
      consolidation: {
        selections: { ref: string; decision: string }[];
        retainedCompetingExplanations: string[];
        recommendation: string;
      };
    };
    expect(stored.contract).toBe('synthesis-lead-v1');
    // The created idea must be covered (anti-deletion).
    expect(stored.consolidation.selections.map((s) => s.ref)).toContain('alpha');
    expect(stored.consolidation.retainedCompetingExplanations.length).toBeGreaterThan(0);
    expect(stored.consolidation.recommendation.length).toBeGreaterThan(0);

    const second = await runCli(dir, ['consolidate', '--harness', 'fake']);
    expect(second.stdout).toContain('reused consolidation');
  }, 180_000);

  it('maps quota blocks to exit 2 with nothing written', async () => {
    const dir = await makeProjectDir();
    const blocked = await runCli(dir, ['consolidate', '--harness', 'fake'], {
      IDEASEEK_FAKE_BLOCK: 'QUOTA_EXHAUSTED',
    });
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain('nothing was written');
    await expect(readFile(join(dir, 'knowledge', 'consolidation.json'), 'utf8')).rejects.toThrow();
  }, 180_000);

  it('rejects output that drops an input ref (zero writes)', async () => {
    const dir = await makeProjectDir();
    const cardPath = join(dir, 'card.json');
    await writeFile(cardPath, JSON.stringify(makeCard('alpha')), 'utf8');
    expect((await runCli(dir, ['idea', 'create', 'alpha', '--from-card', cardPath])).code).toBe(0);

    // Override selects nothing while context.ref = [alpha] → coverage error.
    const dropped = JSON.stringify({
      contract: CONSOLIDATION_SCHEMA,
      selections: [],
      mergedInto: [],
      retainedCompetingExplanations: ['kept'],
      retainedFailureOpinions: [],
      recommendation: 'x',
    });
    const failed = await runCli(dir, ['consolidate', '--harness', 'fake'], {
      IDEASEEK_FAKE_CONSOLIDATE_OUTPUT: dropped,
    });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('dropped silently');
    await expect(readFile(join(dir, 'knowledge', 'consolidation.json'), 'utf8')).rejects.toThrow();
  }, 180_000);
});
