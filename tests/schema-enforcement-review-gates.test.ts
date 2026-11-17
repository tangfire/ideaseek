import { describe, expect, it } from 'vitest';
import { assertAgainstSchema, validateAgainstSchema } from '../src/core/schema/index.js';
import {
  applyComparisonMatrix,
  buildComparisonMatrix,
  type ComparisonMatrix,
} from '../src/comparison/matrix.js';
import { parseBlueprintOutput } from '../src/comparison/blueprint-author.js';
import { parseDependencyPlan } from '../src/comparison/dep-inference.js';
import { validateMatrixProposal, type PlannerContext } from '../src/comparison/planner.js';
import { assertApprovable, type FullPlan } from '../src/full/plan.js';
import { assertFairnessApprovable, type FairnessLock } from '../src/full/fairness.js';
import { makeProjectDir, openRuntime, createDemoRun } from './helpers.js';

/**
 * Task #14, second half: registering these contracts as JSON Schema did not
 * enforce them, because no call site validated the payloads. This file is the
 * proof that each new gate FIRES, and — just as important — that it fires only
 * on structure the platform cannot serve, never on a payload it handles today.
 *
 * The two directions are tested as a pair per contract: a real product of the
 * module passes (the gate cannot abort a working run), and the specific
 * violation the gate exists for is refused or recorded (the gate is not
 * decoration). The full-suite e2e coverage in comparison-matrix.test.ts,
 * full-fairness.test.ts, full-plan.test.ts, baseline-reproduce.test.ts and
 * comparison-planner.test.ts stays the proof that nothing on the happy paths
 * changed.
 */

describe('comparison-matrix-v1 at the apply boundary (src/comparison/matrix.ts)', () => {
  it('accepts what the builder produces, then refuses a hand-broken matrix', async () => {
    const dir = await makeProjectDir();
    const built = await buildComparisonMatrix(dir);
    // The builder's own output must satisfy the contract it names, or the gate
    // below would abort every real `comparison matrix --confirm`.
    expect(validateAgainstSchema('comparison-matrix-v1', built).errors).toEqual([]);

    const draft = { ...built } as ComparisonMatrix;
    // @ts-expect-error deleting a persisted member is exactly the corruption probe
    delete draft.blockers;
    await expect(applyComparisonMatrix(dir, draft)).rejects.toThrow(
      /comparison-matrix-v1 payload failed schema validation/,
    );
  });

  it('refuses structurally before touching the registry', async () => {
    const dir = await makeProjectDir();
    const matrix = {
      contract: 'comparison-matrix-v1',
      inputHash: 'sha256:' + 'a'.repeat(64),
      generatedAt: 1,
      context: { questions: [], venue: null, corpusPaperCards: 0, researchMapPresent: false },
      // An entry that cannot exist: `sources` is what the merge and the report
      // dereference. Before this gate the loop reached the registry lookup and
      // reported INVALID_STATE about a method id, hiding the real defect.
      entries: [
        { methodId: 'ghost', classification: 'required', rationale: 'x', origin: 'registered' },
      ],
      blockers: [],
    } as unknown as ComparisonMatrix;
    await expect(applyComparisonMatrix(dir, matrix)).rejects.toThrow(
      /comparison-matrix-v1 payload failed schema validation/,
    );
  });

  it('records a malformed planner proposal as un-applied instead of half-merging it', async () => {
    const dir = await makeProjectDir();
    const runtime = await openRuntime(dir, { recover: false });
    try {
      await runtime.db.upsertComparison({
        methodId: 'fedavg',
        status: 'smoke-tested',
        required: true,
        record: { sourceKind: 'official-code' },
        updatedAt: 1,
      });
      const run = await createDemoRun(runtime, 'matrix enforcement probe');
      const task = await runtime.db.claimNextTask(run.runId, 'probe-worker', { leaseMs: 60_000 });
      const staged = await runtime.store.stage(
        'comparison-matrix-proposal',
        `${JSON.stringify(
          {
            contract: 'comparison-matrix-proposal-v1',
            // An entry the merge would silently skip (no `sources`, no
            // `rationale`) while still reporting `applied: true`.
            entries: [{ methodId: 'fedavg', classification: 'excluded' }],
          },
          null,
          2,
        )}\n`,
        {},
      );
      await runtime.db.beginCommit({
        taskId: task!.taskId,
        workerId: 'probe-worker',
        attempt: task!.attempt,
        artifacts: [
          {
            kind: 'comparison-matrix-proposal',
            tempPath: staged.tempPath,
            contentHash: staged.contentHash,
            size: staged.size,
            meta: staged.meta,
          },
        ],
        result: { summary: 'seeded', artifacts: [] },
      });
      await runtime.store.promote([staged]);
      await runtime.db.finalizeCommit({ taskId: task!.taskId, workerId: 'probe-worker' });
    } finally {
      await runtime.close();
    }

    const matrix = await buildComparisonMatrix(dir);
    // Degradation, not abort: the deterministic classification still lands, and
    // the researcher is told the proposal was refused and why.
    expect(matrix.agentProposal?.applied).toBe(false);
    expect(matrix.agentProposal?.note ?? '').toContain('comparison-matrix-proposal-v1');
    expect(matrix.entries.find((entry) => entry.methodId === 'fedavg')?.classification).toBe(
      'required',
    );
  });
});

describe('comparison-matrix-proposal-v1 (src/comparison/planner.ts)', () => {
  it('refuses a proposal that passes every domain rule but not its contract', () => {
    const context = plannerContext();
    const grounded = (over: Record<string, unknown>): unknown => ({
      contract: 'comparison-matrix-proposal-v1',
      entries: [
        {
          methodId: 'fedavg',
          classification: 'required',
          rationale: 'classic baseline for the drift question',
          sources: ['paper-card:paper-test123'],
        },
      ],
      ...over,
    });
    expect(validateMatrixProposal(grounded({}), context).ok).toBe(true);
    // `notes` as prose is invisible to the domain validator (it never reads it)
    // and fatal to anything parsing the persisted artifact against the contract.
    expect(() => validateMatrixProposal(grounded({ notes: 'see the entries' }), context)).toThrow(
      /comparison-matrix-proposal-v1 payload failed schema validation/,
    );
  });

  it('keeps the domain errors as errors (no abort for what the planner can be told)', () => {
    const context = plannerContext();
    const result = validateMatrixProposal(
      {
        contract: 'comparison-matrix-proposal-v1',
        entries: [
          {
            methodId: 'fedavg',
            classification: 'required',
            rationale: 'x',
            sources: ['invented-does-not-exist'],
          },
        ],
      },
      context,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('NOT in the provided literature');
  });
});

describe('reproduction-blueprint-v1 (src/comparison/blueprint-author.ts)', () => {
  it('stamps the platform method id and keeps a conforming plan', () => {
    const blueprint = parseBlueprintOutput(
      JSON.stringify({
        methodId: 'written-by-the-model-not-ours',
        paperExplicit: [{ statement: 'FedAvg aggregates weighted.', evidence: 'mcmahan17a p.2' }],
        assumptions: ['lr 0.01'],
        missingDetails: [],
        confidence: 'medium',
        algorithm: {
          dataInterface: { description: 'read IDEASEEK_DATA_PATH' },
          metrics: [{ name: 'average_accuracy_across_folds', direction: 'higher' }],
          requirements: ['torch'],
        },
      }),
      'fedavg',
    );
    expect(blueprint.methodId).toBe('fedavg');
    expect(validateAgainstSchema('reproduction-blueprint-v1', blueprint).errors).toEqual([]);
  });

  it('refuses an answer that is not a plan, with the contract field list', () => {
    // Two shapes the parser used to hand onward unchecked: an object missing
    // everything, and a JSON list (which used to be stamped and then fail as
    // `blueprint must be an object`, or crash on a primitive).
    expect(() => parseBlueprintOutput('{}', 'fedavg')).toThrow(
      /reproduction-blueprint-v1 payload failed schema validation/,
    );
    expect(() => parseBlueprintOutput('[1,2,3]', 'fedavg')).toThrow(/reproduction-blueprint-v1/);
    expect(() => parseBlueprintOutput('"a sentence"', 'fedavg')).toThrow(
      /reproduction-blueprint-v1/,
    );
    expect(() => parseBlueprintOutput('not json', 'fedavg')).toThrow(/not JSON/);
  });

  it('does not tighten the vocabularies the domain validator owns', () => {
    // A metric name outside the locked protocol is a SCIENCE problem and stays
    // the domain validator's (with the CLI's corrective retry); the schema must
    // not pre-empt it, so this shape still parses.
    const blueprint = parseBlueprintOutput(
      JSON.stringify({
        paperExplicit: [{ statement: 's', evidence: 'p.1' }],
        assumptions: [],
        missingDetails: ['split order'],
        confidence: 'low',
        algorithm: {
          dataInterface: { description: 'd' },
          metrics: [{ name: 'some_other_accuracy', direction: 'higher' }],
        },
      }),
      'fedavg',
    );
    expect(blueprint.algorithm.metrics[0]?.name).toBe('some_other_accuracy');
  });
});

describe('dependency-plan-v1 (src/comparison/dep-inference.ts)', () => {
  it('does not abort the repairs the parser already repairs', () => {
    // The hazard the registered contract created: the prompt declares `notes`,
    // so a required-of-the-model note would fail plans that work today. The
    // gate sits after the repair, so all three of these still yield a plan.
    expect(parseDependencyPlan(JSON.stringify({ packages: ['torch'] }))).toEqual({
      packages: ['torch'],
      notes: '',
    });
    expect(parseDependencyPlan(JSON.stringify({ packages: ['torch'], notes: 42 })).notes).toBe('');
    expect(parseDependencyPlan(JSON.stringify({ packages: ['torch', 42, 'numpy>=1.21'] }))).toEqual(
      {
        packages: ['torch', 'numpy>=1.21'],
        notes: ' | rejected 1 unsafe spec(s): 42',
      },
    );
  });

  it('ships a plan that satisfies its own contract, including the notes stamp', () => {
    for (const answer of [
      { packages: ['torch'] },
      { packages: ['torch', 'rm -rf /'] },
      { packages: ['numpy>=1.21,<2'], notes: 'from README' },
    ]) {
      const plan = parseDependencyPlan(JSON.stringify(answer));
      assertAgainstSchema('dependency-plan-v1', plan);
    }
  });

  it('keeps refusing answers with nothing installable', () => {
    expect(() => parseDependencyPlan(JSON.stringify({ packages: ['-e .'] }))).toThrow(
      /no usable requirement specs/,
    );
    expect(() => parseDependencyPlan(JSON.stringify({ packages: 'torch' }))).toThrow(
      /packages array/,
    );
  });
});

describe('fairness-lock-v1 (src/full/fairness.ts)', () => {
  it('confirms a lock the builder could have written', () => {
    const lock = baseLock();
    expect(validateAgainstSchema('fairness-lock-v1', lock).errors).toEqual([]);
    expect(() => assertFairnessApprovable(lock, lock.inputHash)).not.toThrow();
  });

  it('names the contract where it used to throw a TypeError', () => {
    const lock = baseLock();
    // @ts-expect-error deleting a persisted member is the corruption probe
    delete lock.blockers;
    // Before: `lock.blockers.length` on undefined — a stack trace at the
    // confirm gate of the gate that authorises a full run.
    expect(() => assertFairnessApprovable(lock, lock.inputHash)).toThrow(
      /fairness-lock-v1 payload failed schema validation/,
    );
  });

  it('still reports staleness and blockers for valid locks', () => {
    const lock = baseLock();
    expect(() => assertFairnessApprovable(lock, 'sha256:' + 'f'.repeat(64))).toThrow(/stale/);
    expect(() =>
      assertFairnessApprovable(
        { ...lock, blockers: ['required comparison fedavg is blocked'] },
        lock.inputHash,
      ),
    ).toThrow(/USER_INPUT_REQUIRED|blocked/);
  });
});

describe('full-plan-v1 (src/full/plan.ts)', () => {
  it('approves a plan that matches the contract', () => {
    const plan = basePlan();
    expect(validateAgainstSchema('full-plan-v1', plan).errors).toEqual([]);
    expect(() => assertApprovable(plan, plan.inputHash)).not.toThrow();
  });

  it('refuses a plan whose readiness cannot be read', () => {
    const plan = basePlan();
    // @ts-expect-error deleting a persisted member is the corruption probe
    delete plan.readiness;
    expect(() => assertApprovable(plan, plan.inputHash)).toThrow(
      /full-plan-v1 payload failed schema validation/,
    );
  });

  it('keeps the readiness refusal it has always given', () => {
    const plan = basePlan();
    plan.readiness = { ready: false, handoffLevel: 'PROMISING', blockers: ['seeds 1 < 2'] };
    expect(() => assertApprovable(plan, plan.inputHash)).toThrow(/seeds 1 < 2/);
  });
});

function baseLock(over: Partial<FairnessLock> = {}): FairnessLock {
  return {
    contract: 'fairness-lock-v1',
    ideaId: 'alpha',
    inputHash: 'sha256:' + 'a'.repeat(64),
    generatedAt: 1,
    protocol: { protocolId: 'proto-1', protocolHash: 'sha256:' + 'b'.repeat(64) },
    reference: {
      specId: 'idea-alpha',
      dataSnapshotId: 'synthetic:x',
      sliceIds: ['s1'],
      seeds: [42, 7],
      metrics: ['rare-class recall'],
    },
    methods: [
      {
        methodId: 'fedavg',
        status: 'smoke-tested',
        dimensions: [
          { dimension: 'data-split', status: 'aligned', detail: 'same snapshot' },
          { dimension: 'preprocessing', status: 'unknown', detail: 'researcher declares' },
          { dimension: 'metrics', status: 'aligned', detail: 'produces all metrics' },
          { dimension: 'tuning-budget', status: 'unknown', detail: 'researcher declares' },
          { dimension: 'seeds-repeats', status: 'aligned', detail: 'same seeds' },
          { dimension: 'resources', status: 'unknown', detail: 'researcher declares' },
          { dimension: 'early-stopping', status: 'unknown', detail: 'researcher declares' },
          { dimension: 'model-selection', status: 'unknown', detail: 'researcher declares' },
        ],
        deviations: [],
      },
    ],
    blockers: [],
    ...over,
  };
}

function basePlan(over: Partial<FullPlan> = {}): FullPlan {
  return {
    contract: 'full-plan-v1',
    ideaId: 'alpha',
    ideaVersion: 1,
    inputHash: 'sha256:' + 'a'.repeat(64),
    generatedAt: 1,
    question: 'q',
    readiness: { ready: true, handoffLevel: 'HANDOFF_READY', blockers: [] },
    lock: {
      protocol: null,
      dataSnapshotId: null,
      sliceIds: [],
      codeCommit: null,
      seeds: [42, 7],
    },
    comparisons: { gateOk: true, required: [], inventory: [], blocking: [] },
    budget: { maxModelCost: 10, maxGpuHours: 100, ideaMaxGpuMinutes: 60, basis: 'test' },
    timeLimit: { ceilingHours: 100, basis: 'test' },
    network: { allowNetwork: false, externalSearch: false, basis: 'test' },
    resources: { gpus: 1, memoryGiB: 16, diskFreeGiB: 100, basis: 'test' },
    licenses: { kinds: ['MIT'], policyNote: 'ok' },
    fairness: {
      present: true,
      confirmed: true,
      current: true,
      inputHash: 'sha256:' + 'c'.repeat(64),
      blockers: [],
    },
    approvalsNeeded: ['confirm question'],
    boundaries: ['draft'],
    ...over,
  };
}

function plannerContext(over: Partial<PlannerContext> = {}): PlannerContext {
  return {
    generator: 'comparison-planner-v1',
    questions: ['Drift term lifts rare-class recall.'],
    venue: null,
    subfield: null,
    candidates: [
      {
        methodId: 'fedavg',
        currentClassification: 'required',
        origin: 'registered',
        currentRationale: 'registered as required',
      },
    ],
    literature: [
      {
        sourceId: 'paper-card:paper-test123',
        title: 'Recent Advances',
        year: null,
        kind: 'paper-card',
      },
    ],
    researchMap: null,
    benchmarkEvidence: [{ methodId: 'fedavg', status: 'smoke-tested', required: true }],
    indexNote: 'external_search off',
    ...over,
  };
}
