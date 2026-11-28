import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validatePaperCard } from '../src/knowledge/papercard.js';
import { validateProtocolProposal } from '../src/experiment/protocol.js';
import { evaluateComparisonGate, type ComparisonGateDb } from '../src/comparison/gate.js';
import { assessIdeaCard } from '../src/idea/card.js';
import { analyzeIdea, type AnalysisInput } from '../src/idea/analysis.js';
import { computeHandoffLevel } from '../src/idea/handoff.js';
import { IDEA_TRANSITIONS } from '../src/idea/workspace.js';

/**
 * FL model-heterogeneity gold set (docs/EVALUATION): committed SYNTHETIC
 * fixtures that pin the validators, gate and analyst against a known-good
 * direction sample. No real papers, real data or secrets live here.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fl-goldset');

async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(FIXTURES, name), 'utf8')) as T;
}

describe('gold set: paper / claim / evidence', () => {
  it('the synthetic PaperCard satisfies the structural contract with locatable claims', async () => {
    const card = await fixture<Record<string, unknown>>('papercard.json');
    const result = validatePaperCard(card);
    expect(result).toEqual({ ok: true, errors: [] });
    const claims = card.claims as { evidence: unknown[] }[];
    expect(claims.length).toBeGreaterThanOrEqual(2);
    for (const claim of claims) {
      expect(claim.evidence.length).toBeGreaterThan(0);
    }
    expect(String(card.document_hash)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('gold set: dataset manifest and client statistics', () => {
  it('keeps the federated manifest schema: clients, shapes, label counts, non-IID, rootHash', async () => {
    const manifest = await fixture<{
      datasets: {
        profile: {
          parser: string;
          splits: Record<
            string,
            {
              clientCount: number;
              totalSamples: number;
              clients: {
                id: string;
                samples: number;
                xShape: number[];
                yShape: number[];
                labelCounts: Record<string, number>;
              }[];
            }
          >;
          nonIid: { tvDistanceMean: number };
          rootHash: string;
          writable: boolean;
        };
      }[];
    }>('dataset-manifest.json');

    expect(manifest.datasets).toHaveLength(1);
    const profile = manifest.datasets[0]!.profile;
    expect(profile.parser).toBe('npz-pickle-v1');
    expect(profile.writable).toBe(false);
    expect(profile.rootHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(profile.nonIid.tvDistanceMean).toBeGreaterThan(0);

    const train = profile.splits.train!;
    expect(train.clientCount).toBe(3);
    expect(train.clients).toHaveLength(3);
    let summed = 0;
    for (const client of train.clients) {
      expect(client.xShape).toEqual([client.samples, 1, 28, 28]);
      expect(client.yShape).toEqual([client.samples]);
      const labelSum = Object.values(client.labelCounts).reduce((a, b) => a + b, 0);
      expect(labelSum).toBe(client.samples);
      summed += client.samples;
    }
    expect(summed).toBe(train.totalSamples);
    expect(Object.keys(profile.splits)).toEqual(['train', 'test']);
  });
});

describe('gold set: protocol proposal and user confirmation items', () => {
  it('validates and surfaces low-confidence items that require confirmation', async () => {
    const proposal = await fixture<Record<string, unknown>>('protocol-proposal.json');
    const result = validateProtocolProposal(proposal);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    // agent-inference / low-confidence entries must be raised to the user.
    expect(result.confirmations.length).toBeGreaterThan(0);
    const joined = result.confirmations.join(' | ');
    expect(joined).toMatch(/resourceEstimate|secondaryMetrics|per-client/);
    // primary metrics carry directions the experiment specs must honor.
    const primary = proposal.primaryMetrics as { name: string; direction: string }[];
    expect(primary.map((m) => m.name)).toContain('accuracy');
    expect(primary.every((m) => m.direction === 'higher' || m.direction === 'lower')).toBe(true);
  });
});

describe('gold set: comparison gate', () => {
  it('passes runnable/excluded methods and blocks on an unfinished required method', async () => {
    const fx = await fixture<{
      methods: { methodId: string; status: string; record: Record<string, unknown> }[];
      experiments: {
        specId: string;
        spec: Record<string, unknown>;
        result: Record<string, unknown>;
        status: string;
      }[];
      extraMethods: { methodId: string; status: string; record: Record<string, unknown> }[];
    }>('gate-fixture.json');

    const makeDb = (methods: typeof fx.methods): ComparisonGateDb => ({
      listComparisons: async (filter) => {
        // All fixture methods are required; `methods` is the mutable set the
        // scenarios filter (e.g. drop the unfinished one to pass the gate).
        const all = [...methods, ...fx.extraMethods];
        return filter.required
          ? all.map((m) => ({ ...m, required: true }))
          : all.map((m) => ({ ...m, required: false }));
      },
      listExperiments: async () => fx.experiments,
    });

    // With the unfinished repairing method present → blocked.
    const blocked = await evaluateComparisonGate(makeDb(fx.methods));
    expect(blocked.ok).toBe(false);
    expect(blocked.passed.map((p) => p.methodId).sort()).toEqual([
      'fedavg-fixture',
      'fedproto-fixture',
    ]);
    expect(blocked.passed.find((p) => p.methodId === 'fedproto-fixture')!.via).toBe('experiment');
    expect(blocked.skipped).toEqual([
      { methodId: 'fedprox-fixture', reason: 'license forbids use (fixture)' },
    ]);
    expect(blocked.blocking.map((b) => b.methodId)).toEqual(['feddf-fixture']);
    expect(blocked.blocking[0]!.hint).toContain('baseline repair');

    // Only runnable + reasoned-excluded required methods → gate passes.
    const ready = await evaluateComparisonGate(
      makeDb(fx.methods.filter((m) => m.methodId !== 'feddf-fixture')),
    );
    expect(ready.ok).toBe(true);
    expect(ready.blocking).toEqual([]);
  });
});

it('comparison gate blocks an empty registry instead of vouching for nothing', async () => {
  // A project with zero required comparisons used to note-and-pass: handoff
  // and a paper could reach completion with no baseline in existence.
  const zero = await evaluateComparisonGate({
    listComparisons: async () => [],
    listExperiments: async () => [],
  });
  expect(zero.ok).toBe(false);
  expect(zero.required).toBe(0);
  expect(zero.note).toBe('no required comparisons registered');
  expect(zero.blocking.some((entry) => entry.methodId === '(none)')).toBe(true);
  expect(zero.blocking.find((entry) => entry.methodId === '(none)')!.hint).toContain(
    'ideaseek comparison discover',
  );
});

describe('gold set: rejected and revisable idea fixtures', () => {
  function losingInput(card: Record<string, unknown>): AnalysisInput {
    return {
      ideaId: String(card.ideaId),
      ideaVersion: 1,
      codeHash: 'sha256:' + 'a'.repeat(64),
      card: card as never,
      main: {
        spec: {
          specId: 'idea-x',
          version: 1,
          idea: { ideaId: String(card.ideaId), version: 1 },
          comparisonIds: ['baseline-majority-fixture'],
          codeCommit: null,
          dataSnapshotId: 'synthetic:fixture',
          sliceIds: [],
          environment: { python: 'v24', notes: ['scale:smoke'] },
          command: ['python', 'src/smoke.py'],
          metrics: [{ name: 'accuracy', direction: 'higher' }],
          seeds: [42, 43],
          resources: {},
          budget: { maxRuns: 1, maxMinutes: 5 },
          protocolId: null,
          createdAt: 1,
        } as never,
        result: {
          specId: 'idea-x',
          status: 'succeeded',
          logRefs: [],
          artifactRefs: [],
          metrics: [{ name: 'accuracy', value: 30 }],
          resourcesUsed: {},
          failure: null,
          startedAt: 1,
          finishedAt: 2,
        } as never,
      },
      ablations: [],
      baselines: [{ methodId: 'baseline-majority-fixture', value: 45 }],
      scalesRun: ['quick', 'smoke'],
      datasetsRun: ['synthetic:fixture'],
      seedsCount: 2,
      failures: [],
      resources: [],
    };
  }

  it('the rejected fixture really yields rejected / effect-insufficient', async () => {
    const card = await fixture<Record<string, unknown>>('idea-rejected.json');
    expect(assessIdeaCard(card).ok).toBe(true);
    const analysis = analyzeIdea(losingInput(card));
    expect(analysis.verdict).toBe('rejected');
    expect(analysis.failureClass).toBe('effect-insufficient');
    expect(analysis.primaryDelta!).toBeLessThan(0);
    // Handoff must refuse to package it.
    const gate = computeHandoffLevel({
      analysisVerdict: analysis.verdict,
      scalesRun: analysis.coverage.scales,
      seedsCount: analysis.coverage.seeds,
      comparisonGateOk: true,
    });
    expect(gate.level).toBe('EXPLORATORY');
    expect(gate.handoffReady).toBe(false);
    expect(gate.blockers.join(' ')).toContain('no handoff package');
  });

  it('the revisable fixture is a valid candidate with a legal revision path', async () => {
    const card = await fixture<Record<string, unknown>>('idea-revisable.json');
    const assessment = assessIdeaCard(card);
    expect(assessment.ok).toBe(true);
    expect(assessment.gate.status).toBe('CANDIDATE');
    // rejected → NEEDS_REVISION → IMPLEMENTING is the documented repair path.
    expect(IDEA_TRANSITIONS.ANALYZING).toContain('NEEDS_REVISION');
    expect(IDEA_TRANSITIONS.NEEDS_REVISION).toContain('IMPLEMENTING');
    expect(IDEA_TRANSITIONS.IMPLEMENTING).toContain('SMOKE_TESTED');
  });
});
