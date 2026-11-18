import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  HarnessAdapter,
  HarnessHealth,
  HarnessTaskRequest,
  HarnessTaskResult,
} from '../src/dsh/adapter.js';
import { FakeHarnessAdapter } from '../src/dsh/fake-adapter.js';
import {
  classifyFailureWithAgent,
  parseFailureClassification,
} from '../src/comparison/failure-judge.js';
import {
  executeRepair,
  isRepairFailureKind,
  type ExecuteRepairInput,
  type RepairFailure,
} from '../src/comparison/repair.js';
import type { RepairRecord } from '../src/comparison/types.js';

/**
 * Agent-first failure classification (P2 判断面 agent 化): the keyword table
 * stays the mechanical prior and the fallback, the agent may correct it, and
 * every classification — injected by model, test or keyword — is re-validated
 * at the repair loop's trust boundary. What must never happen: a model
 * inventing a kind, claiming a timeout the executor did not measure, or a
 * harness outage changing the answer the keywords already gave.
 */

/** Minimal adapter stub: canned output, counts calls. */
class StubHarness implements HarnessAdapter {
  readonly kind = 'fake' as const;
  readonly version = 'stub-1';
  calls = 0;
  constructor(private readonly output: string) {}
  async initialize(): Promise<void> {}
  async health(): Promise<HarnessHealth> {
    return { reachable: true, models: [], blocked: false, blockReason: null };
  }
  async shutdown(): Promise<void> {}
  async runTask(request: HarnessTaskRequest): Promise<HarnessTaskResult> {
    this.calls += 1;
    return {
      runId: request.runId,
      taskId: request.taskId,
      output: this.output,
      usage: {},
      model: 'stub',
      toolCalls: [],
      runtime: { kind: 'fake', version: this.version },
      finishedAt: Date.now(),
    };
  }
}

describe('parseFailureClassification', () => {
  it('accepts a schema-valid classification and keeps the module', () => {
    const parsed = parseFailureClassification(
      JSON.stringify({
        kind: 'missing-dependency',
        summary: "ModuleNotFoundError: No module named 'torch'",
        module: 'torch',
      }),
    );
    expect(parsed).toEqual({
      kind: 'missing-dependency',
      summary: "ModuleNotFoundError: No module named 'torch'",
      module: 'torch',
    });
  });

  it('rejects non-JSON, unknown kinds, missing summaries and extra fields', () => {
    expect(parseFailureClassification('not json at all')).toBeNull();
    expect(
      parseFailureClassification(JSON.stringify({ kind: 'meltdown', summary: 'x' })),
    ).toBeNull();
    expect(parseFailureClassification(JSON.stringify({ kind: 'unknown' }))).toBeNull();
    expect(
      parseFailureClassification(JSON.stringify({ kind: 'unknown', summary: 'x', extra: 1 })),
    ).toBeNull();
    expect(parseFailureClassification('[]')).toBeNull();
  });

  it('redacts secret shapes from the stored summary', () => {
    const parsed = parseFailureClassification(
      JSON.stringify({ kind: 'unknown', summary: 'leaked sk-abc123456789 in output' }),
    );
    expect(parsed?.summary).toBe('leaked sk-*** in output');
  });

  it('rejects a module that is not a dotted identifier', () => {
    // The module name steers the fix planner; paths and shell fragments
    // must invalidate the whole output rather than be coerced.
    expect(
      parseFailureClassification(
        JSON.stringify({ kind: 'missing-dependency', summary: 'x', module: 'torch; import os' }),
      ),
    ).toBeNull();
    expect(
      parseFailureClassification(
        JSON.stringify({ kind: 'missing-dependency', summary: 'x', module: '../../etc/passwd' }),
      ),
    ).toBeNull();
  });
});

describe('classifyFailureWithAgent', () => {
  const base = {
    log: "ModuleNotFoundError: No module named 'torch'",
    exitCode: 1,
    timedOut: false,
    runId: 'run-1',
    taskId: 'repair-fedavg',
    now: 1,
  };

  it('returns a valid agent classification over the keyword prior', async () => {
    // The keywords say missing-dependency; the agent reads the log tail and
    // corrects to device-error — the agent wins when it validates.
    const stub = new StubHarness(
      JSON.stringify({
        kind: 'device-error',
        summary: 'CUDA error: an illegal memory access was encountered',
      }),
    );
    const failure = await classifyFailureWithAgent({ harness: stub, ...base });
    expect(failure?.kind).toBe('device-error');
    expect(stub.calls).toBe(1);
  });

  it('returns null when the harness throws', async () => {
    const stub = new StubHarness('{}');
    stub.runTask = async () => {
      throw new Error('provider unreachable');
    };
    expect(await classifyFailureWithAgent({ harness: stub, ...base })).toBeNull();
  });

  it('returns null when the output fails validation', async () => {
    const stub = new StubHarness(JSON.stringify({ kind: 'meltdown', summary: 'x' }));
    expect(await classifyFailureWithAgent({ harness: stub, ...base })).toBeNull();
  });

  it('never consults the model for a timeout', async () => {
    const stub = new StubHarness(JSON.stringify({ kind: 'timeout', summary: 'x' }));
    const failure = await classifyFailureWithAgent({ harness: stub, ...base, timedOut: true });
    expect(failure).toBeNull();
    expect(stub.calls).toBe(0);
  });

  it('round-trips the mechanical prior through the fake harness', async () => {
    const fake = new FakeHarnessAdapter();
    const failure = await classifyFailureWithAgent({ harness: fake, ...base });
    // The fake echoes the keyword prior: e2e exercises call → validation →
    // accept while producing exactly the classification the table computed.
    expect(failure?.kind).toBe('missing-dependency');
    expect(failure?.module).toBe('torch');
    expect(failure?.summary).toContain('No module named');
  });
});

describe('executeRepair accepts an agent classifier at its trust boundary', () => {
  let projectRoot: string;
  let worktree: string;
  let saved: RepairRecord | null;
  const store = {
    load: async (): Promise<RepairRecord | null> => saved,
    save: async (record: RepairRecord): Promise<void> => {
      saved = record;
    },
  };

  beforeEach(async () => {
    saved = null;
    // The worktree must exist: spawn() takes it as cwd, and a missing cwd
    // fails the process before any classification input exists.
    projectRoot = await mkdtemp(join(tmpdir(), 'ideaseek-failure-judge-'));
    worktree = await mkdtemp(join(tmpdir(), 'ideaseek-failure-judge-wt-'));
  });

  function input(overrides: Partial<ExecuteRepairInput> = {}): ExecuteRepairInput {
    return {
      projectRoot,
      methodId: 'fedavg',
      worktreeDir: worktree,
      entry: ['python', '-c', 'import module_that_does_not_exist_zz'],
      maxRounds: 3,
      timeoutMs: 30_000,
      store,
      ...overrides,
    };
  }

  it('uses a valid agent classification over the keyword prior', async () => {
    const result = await executeRepair(
      input({
        classifyFailure: async () => ({
          kind: 'device-error',
          summary: 'CUDA error: an illegal memory access was encountered',
        }),
      }),
    );
    expect(result.record.attempts[0]!.failureKind).toBe('device-error');
    // device-error plans no automated fix — one round, then blocked.
    expect(result.outcome).toBe('blocked-no-fix');
    expect(result.record.attempts).toHaveLength(1);
  });

  it('keeps the keyword answer when the hook returns null', async () => {
    const result = await executeRepair(input({ classifyFailure: async () => null }));
    expect(result.record.attempts[0]!.failureKind).toBe('missing-dependency');
  });

  it('keeps the keyword answer when the hook throws', async () => {
    const result = await executeRepair(
      input({
        classifyFailure: async () => {
          throw new Error('provider unreachable');
        },
      }),
    );
    expect(result.record.attempts[0]!.failureKind).toBe('missing-dependency');
  });

  it('rejects a bogus kind from the hook', async () => {
    const result = await executeRepair(
      input({
        // A buggy classifier (or a model that escaped validation upstream)
        // must not be able to record a kind the fix planner cannot read.
        classifyFailure: async () =>
          ({ kind: 'meltdown', summary: 'x' }) as unknown as RepairFailure,
      }),
    );
    expect(result.record.attempts[0]!.failureKind).toBe('missing-dependency');
  });

  it('rejects a timeout claim when the timer did not fire', async () => {
    const result = await executeRepair(
      input({
        classifyFailure: async () => ({ kind: 'timeout', summary: 'model says timeout' }),
      }),
    );
    expect(result.record.attempts[0]!.failureKind).toBe('missing-dependency');
  });

  it('skips the hook entirely on a real timeout', async () => {
    let calls = 0;
    const result = await executeRepair(
      input({
        entry: ['python', '-c', 'import time; time.sleep(30)'],
        timeoutMs: 500,
        classifyFailure: async () => {
          calls += 1;
          return null;
        },
      }),
    );
    expect(result.record.attempts[0]!.failureKind).toBe('timeout');
    expect(calls).toBe(0);
  }, 20_000);
});

describe('isRepairFailureKind', () => {
  it('accepts the taxonomy and nothing else', () => {
    for (const kind of [
      'missing-dependency',
      'path-error',
      'syntax-error',
      'permission-error',
      'device-error',
      'timeout',
      'unknown',
    ]) {
      expect(isRepairFailureKind(kind)).toBe(true);
    }
    expect(isRepairFailureKind('meltdown')).toBe(false);
    expect(isRepairFailureKind(42)).toBe(false);
    expect(isRepairFailureKind(null)).toBe(false);
  });
});
