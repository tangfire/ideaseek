import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { ExperimentDoc } from '../src/workflow/db.js';
import { buildLeaderboard, formatLeaderboard } from '../src/experiment/leaderboard.js';
import { CLI_BIN, makeProjectDir, openRuntime } from './helpers.js';

/**
 * Cross-idea leaderboard (design review #13a): rank idea-bound experiment
 * results by a metric. What these tests pin down is the honesty contract —
 * direction comes from each spec (never guessed), a typo'd metric is louder
 * than an empty board, conflicting directions refuse to rank, and when no
 * metric is common the board shows raw values instead of inventing a
 * comparison.
 */

function ideaDoc(
  ideaId: string,
  opts: {
    specId?: string;
    status?: ExperimentDoc['status'];
    metrics?: { name: string; value: number; stdev?: number; n?: number }[];
    declared?: { name: string; direction: 'higher' | 'lower' }[];
    scale?: string;
    version?: number;
    updatedAt?: number;
    failureSummary?: string;
  } = {},
): ExperimentDoc {
  const status = opts.status ?? 'succeeded';
  const declared = opts.declared ?? [
    { name: 'acc', direction: 'higher' as const },
    { name: 'f1', direction: 'higher' as const },
  ];
  return {
    specId: opts.specId ?? `idea-${ideaId}`,
    version: opts.version ?? 1,
    specHash: 'hash',
    status,
    spec: {
      idea: { ideaId, version: 1 },
      metrics: declared,
      ...(opts.scale ? { scale: opts.scale } : {}),
    },
    result:
      status === 'succeeded'
        ? {
            status: 'succeeded',
            metrics: opts.metrics ?? [
              { name: 'acc', value: 0.9 },
              { name: 'f1', value: 0.8 },
            ],
            failure: null,
          }
        : {
            status,
            metrics: [],
            failure: opts.failureSummary ? { summary: opts.failureSummary } : null,
          },
    updatedAt: opts.updatedAt ?? 1,
  };
}

describe('buildLeaderboard', () => {
  it('ranks succeeded results by the first common metric, higher first', () => {
    const board = buildLeaderboard([
      ideaDoc('alpha-idea', { metrics: [{ name: 'acc', value: 0.91 }] }),
      ideaDoc('beta-idea', { metrics: [{ name: 'acc', value: 0.87 }] }),
      ideaDoc('gamma-idea', { metrics: [{ name: 'acc', value: 0.95 }] }),
    ]);
    expect(board.mode).toBe('ranked');
    expect(board.metric).toBe('acc');
    expect(board.direction).toBe('higher');
    expect(board.autoSelected).toBe(true);
    expect(board.ranked.map((entry) => [entry.rank, entry.ideaId])).toEqual([
      [1, 'gamma-idea'],
      [2, 'alpha-idea'],
      [3, 'beta-idea'],
    ]);
  });

  it('ranks lower-is-better ascending and breaks value ties by ideaId', () => {
    const board = buildLeaderboard([
      ideaDoc('beta-idea', {
        metrics: [{ name: 'latency', value: 12 }],
        declared: [{ name: 'latency', direction: 'lower' }],
      }),
      ideaDoc('alpha-idea', {
        metrics: [{ name: 'latency', value: 12 }],
        declared: [{ name: 'latency', direction: 'lower' }],
      }),
      ideaDoc('gamma-idea', {
        metrics: [{ name: 'latency', value: 5 }],
        declared: [{ name: 'latency', direction: 'lower' }],
      }),
    ]);
    expect(board.direction).toBe('lower');
    expect(board.ranked.map((entry) => entry.ideaId)).toEqual([
      'gamma-idea', // 5 is best when lower is better
      'alpha-idea', // tie → ideaId order, stable
      'beta-idea',
    ]);
  });

  it('excludes failed results with their failure summary visible', () => {
    const board = buildLeaderboard([
      ideaDoc('ok-idea', { metrics: [{ name: 'acc', value: 0.9 }] }),
      ideaDoc('broken-idea', { status: 'failed', failureSummary: 'CUDA OOM at step 3' }),
      ideaDoc('partial-idea', { status: 'partial' }),
    ]);
    expect(board.ranked.map((entry) => entry.ideaId)).toEqual(['ok-idea']);
    const reasons = Object.fromEntries(board.notRanked.map((e) => [e.ideaId, e.reason]));
    expect(reasons['broken-idea']).toContain('CUDA OOM at step 3');
    expect(reasons['partial-idea']).toBe('partial');
    expect(formatLeaderboard(board)).toContain('CUDA OOM at step 3');
  });

  it('ignores baseline and protocol runs (spec.idea is null)', () => {
    const baseline: ExperimentDoc = {
      ...ideaDoc('ignored', { metrics: [{ name: 'acc', value: 0.99 }] }),
      spec: { metrics: [{ name: 'acc', direction: 'higher' }] },
    };
    const board = buildLeaderboard([baseline, ideaDoc('real-idea')]);
    expect(board.rows.map((row) => row.ideaId)).toEqual(['real-idea']);
  });

  it('auto-selects the first common metric and lists the rest as available', () => {
    const board = buildLeaderboard([
      ideaDoc('a', {
        metrics: [
          { name: 'f1', value: 0.8 },
          { name: 'acc', value: 0.9 },
        ],
      }),
      ideaDoc('b', {
        metrics: [
          { name: 'f1', value: 0.7 },
          { name: 'acc', value: 0.85 },
        ],
      }),
    ]);
    // First row's declared order picks f1, and acc is offered via --metric.
    expect(board.metric).toBe('f1');
    expect(board.autoSelected).toBe(true);
    expect(board.commonMetrics).toEqual(['f1', 'acc']);
    expect(board.availableMetrics).toEqual(expect.arrayContaining(['f1', 'acc']));
    const rankedByAcc = buildLeaderboard(
      [
        ideaDoc('a', {
          metrics: [
            { name: 'f1', value: 0.8 },
            { name: 'acc', value: 0.9 },
          ],
        }),
        ideaDoc('b', {
          metrics: [
            { name: 'f1', value: 0.7 },
            { name: 'acc', value: 0.85 },
          ],
        }),
      ],
      'acc',
    );
    expect(rankedByAcc.metric).toBe('acc');
    expect(rankedByAcc.autoSelected).toBe(false);
    expect(rankedByAcc.ranked[0]!.ideaId).toBe('a');
  });

  it('degrades to a value table when no metric is common', () => {
    const board = buildLeaderboard([
      ideaDoc('a', {
        metrics: [{ name: 'acc', value: 0.9 }],
        declared: [{ name: 'acc', direction: 'higher' }],
      }),
      ideaDoc('b', {
        metrics: [{ name: 'bleu', value: 30 }],
        declared: [{ name: 'bleu', direction: 'higher' }],
      }),
    ]);
    expect(board.mode).toBe('table');
    expect(board.metric).toBeNull();
    expect(board.ranked).toEqual([]);
    expect(board.rows).toHaveLength(2);
    const text = formatLeaderboard(board);
    expect(text).toContain('no metric is common');
    expect(text).toContain('acc=0.9000');
    expect(text).toContain('rank with: ideaseek experiment leaderboard --metric');
  });

  it('rejects a metric no succeeded result records (typo, not silence)', () => {
    const docs = [ideaDoc('a', { metrics: [{ name: 'acc', value: 0.9 }] })];
    expect(() => buildLeaderboard(docs, 'accuracy')).toThrowError(/not recorded.*available: acc/);
  });

  it('refuses to rank when the metric has conflicting directions', () => {
    const docs = [
      ideaDoc('a', {
        metrics: [{ name: 'loss', value: 0.2 }],
        declared: [{ name: 'loss', direction: 'lower' }],
      }),
      ideaDoc('b', {
        metrics: [{ name: 'loss', value: 0.3 }],
        declared: [{ name: 'loss', direction: 'higher' }],
      }),
    ];
    expect(() => buildLeaderboard(docs, 'loss')).toThrowError(/conflicting directions/);
  });

  it('excludes rows whose spec never declared the ranking metric', () => {
    const board = buildLeaderboard(
      [
        ideaDoc('declared', {
          metrics: [{ name: 'acc', value: 0.9 }],
          declared: [{ name: 'acc', direction: 'higher' }],
        }),
        ideaDoc('undeclared', {
          metrics: [{ name: 'acc', value: 0.95 }],
          declared: [{ name: 'f1', direction: 'higher' }],
        }),
      ],
      'acc',
    );
    expect(board.ranked.map((entry) => entry.ideaId)).toEqual(['declared']);
    expect(board.notRanked.find((entry) => entry.ideaId === 'undeclared')?.reason).toContain(
      'not declared by spec',
    );
  });

  it('an empty project formats as a friendly no-op', () => {
    const board = buildLeaderboard([]);
    expect(board.mode).toBe('table');
    expect(board.ranked).toEqual([]);
    expect(formatLeaderboard(board)).toContain('no idea-bound experiment results');
    expect(formatLeaderboard(board)).toContain('ideaseek idea run-ready');
  });
});

function runCli(
  cwd: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
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
  });
}

describe('ideaseek experiment leaderboard (CLI)', () => {
  it('ranks recorded idea results, shows failures honestly, and rejects a typo metric', async () => {
    const dir = await makeProjectDir();
    const runtime = await openRuntime(dir);
    try {
      await runtime.db.upsertExperiment({
        specId: 'idea-alpha-idea',
        version: 1,
        specHash: 'h1',
        status: 'succeeded',
        spec: {
          idea: { ideaId: 'alpha-idea', version: 1 },
          metrics: [{ name: 'acc', direction: 'higher' }],
          scale: 'smoke',
        },
        result: {
          status: 'succeeded',
          metrics: [{ name: 'acc', value: 0.91, n: 3 }],
          failure: null,
        },
        updatedAt: 10,
      });
      await runtime.db.upsertExperiment({
        specId: 'idea-beta-idea',
        version: 1,
        specHash: 'h2',
        status: 'succeeded',
        spec: {
          idea: { ideaId: 'beta-idea', version: 1 },
          metrics: [{ name: 'acc', direction: 'higher' }],
          scale: 'smoke',
        },
        result: {
          status: 'succeeded',
          metrics: [{ name: 'acc', value: 0.87 }],
          failure: null,
        },
        updatedAt: 20,
      });
      await runtime.db.upsertExperiment({
        specId: 'idea-gamma-idea',
        version: 1,
        specHash: 'h3',
        status: 'failed',
        spec: {
          idea: { ideaId: 'gamma-idea', version: 1 },
          metrics: [{ name: 'acc', direction: 'higher' }],
        },
        result: { status: 'failed', metrics: [], failure: { summary: 'diverged at epoch 2' } },
        updatedAt: 30,
      });
    } finally {
      await runtime.close();
    }

    const json = await runCli(dir, ['experiment', 'leaderboard', '--json']);
    expect(json.code, json.stdout + json.stderr).toBe(0);
    const payload = JSON.parse(json.stdout) as {
      mode: string;
      metric: string;
      autoSelected: boolean;
      ranked: { rank: number; ideaId: string; value: number }[];
      notRanked: { ideaId: string; reason: string }[];
    };
    expect(payload.mode).toBe('ranked');
    expect(payload.metric).toBe('acc');
    expect(payload.autoSelected).toBe(true);
    expect(payload.ranked.map((entry) => [entry.rank, entry.ideaId])).toEqual([
      [1, 'alpha-idea'],
      [2, 'beta-idea'],
    ]);
    const gamma = payload.notRanked.find((entry) => entry.ideaId === 'gamma-idea');
    expect(gamma?.reason).toContain('diverged at epoch 2');

    const human = await runCli(dir, ['experiment', 'leaderboard']);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('leaderboard by acc');
    expect(human.stdout).toContain('alpha-idea');
    expect(human.stdout).toContain('not ranked:');

    const typo = await runCli(dir, ['experiment', 'leaderboard', '--metric', 'accuracy']);
    expect(typo.code).not.toBe(0);
    expect(typo.stderr).toContain('not recorded');
    expect(typo.stderr).toContain('available: acc');
  }, 180_000);
});
