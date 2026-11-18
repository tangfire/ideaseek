import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  HarnessAdapter,
  HarnessHealth,
  HarnessTaskRequest,
  HarnessTaskResult,
} from '../src/dsh/adapter.js';
import { FakeHarnessAdapter } from '../src/dsh/fake-adapter.js';
import {
  chooseStrategy,
  countInputs,
  parseStrategyChoice,
  resolveStrategy,
  STRATEGY_WORDING,
  strategyWording,
} from '../src/workflow/strategy.js';

describe('resolveStrategy', () => {
  it('honors explicit modes over scale heuristics', () => {
    expect(resolveStrategy('starter', { papers: 500, datasets: 10, comparisons: 5 })).toBe(
      'starter',
    );
    expect(resolveStrategy('research', { papers: 0, datasets: 0, comparisons: 0 })).toBe(
      'research',
    );
    expect(resolveStrategy('standard', { papers: 500, datasets: 10, comparisons: 5 })).toBe(
      'standard',
    );
  });

  it('adapts auto mode to input scale', () => {
    expect(resolveStrategy('auto', { papers: 0, datasets: 0, comparisons: 0 })).toBe('starter');
    expect(resolveStrategy('auto', { papers: 9, datasets: 1, comparisons: 0 })).toBe('starter');
    // Comparisons present → at least standard even with few papers.
    expect(resolveStrategy('auto', { papers: 5, datasets: 0, comparisons: 1 })).toBe('standard');
    expect(resolveStrategy('auto', { papers: 10, datasets: 1, comparisons: 0 })).toBe('standard');
    expect(resolveStrategy('auto', { papers: 49, datasets: 5, comparisons: 2 })).toBe('standard');
    expect(resolveStrategy('auto', { papers: 50, datasets: 1, comparisons: 0 })).toBe('research');
    expect(resolveStrategy('auto', { papers: 500, datasets: 10, comparisons: 5 })).toBe('research');
  });
});

describe('strategy wording', () => {
  it('provides a label and a disclaimer for every strategy', () => {
    for (const strategy of ['starter', 'standard', 'research'] as const) {
      const wording = STRATEGY_WORDING[strategy];
      expect(wording.label.length).toBeGreaterThan(0);
      expect(wording.disclaimer.length).toBeGreaterThan(20);
    }
    expect(STRATEGY_WORDING.starter.disclaimer).toContain('方向筛选');
    expect(STRATEGY_WORDING.research.disclaimer).toContain('未覆盖');
  });

  it('falls back to standard wording for unknown strategy strings', () => {
    expect(strategyWording('nonsense').label).toBe(STRATEGY_WORDING.standard.label);
  });
});

describe('countInputs', () => {
  it('counts papers recursively, datasets and comparison methods by unit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-strategy-'));
    await mkdir(join(dir, 'papers', 'nested'), { recursive: true });
    await writeFile(join(dir, 'papers', 'a.pdf'), 'a');
    await writeFile(join(dir, 'papers', 'nested', 'b.pdf'), 'b');
    await writeFile(join(dir, 'papers', 'nested', 'notes.txt'), 'n');

    await mkdir(join(dir, 'datasets', 'd1'), { recursive: true });
    await mkdir(join(dir, 'datasets', 'd2'), { recursive: true });
    await writeFile(join(dir, 'datasets', 'd1', 'train.csv'), 'x,y\n');
    await writeFile(join(dir, 'datasets', 'd2', 'test.csv'), 'x,y\n');

    await mkdir(join(dir, 'comparisons', 'method-a'), { recursive: true });
    await mkdir(join(dir, 'comparisons', 'method-b'), { recursive: true });
    await mkdir(join(dir, 'comparisons', '_candidates'), { recursive: true });
    await writeFile(join(dir, 'comparisons', 'method-a', 'code.py'), 'pass');

    const counts = await countInputs(dir, {
      papers: 'papers',
      datasets: 'datasets',
      comparisons: 'comparisons',
    });
    expect(counts).toEqual({ papers: 3, datasets: 2, comparisons: 2 });
  });

  it('returns zeros for missing directories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-strategy-'));
    const counts = await countInputs(dir, {
      papers: 'papers',
      datasets: 'datasets',
      comparisons: 'comparisons',
    });
    expect(counts).toEqual({ papers: 0, datasets: 0, comparisons: 0 });
    expect(resolveStrategy('auto', counts)).toBe('starter');
  });
});

/** Minimal adapter stub: canned output, counts calls. */
class StubHarness implements HarnessAdapter {
  readonly kind = 'fake' as const;
  readonly version = 'stub-1';
  calls = 0;
  constructor(private readonly output: string | (() => string)) {}
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
      output: typeof this.output === 'function' ? this.output() : this.output,
      usage: {},
      model: 'stub',
      toolCalls: [],
      runtime: { kind: 'fake', version: this.version },
      finishedAt: Date.now(),
    };
  }
}

describe('parseStrategyChoice', () => {
  it('accepts a schema-valid tier and redacts the rationale', () => {
    const choice = parseStrategyChoice(
      JSON.stringify({
        strategy: 'research',
        rationale: 'focused replication needs the uncovered-ranges report, sk-abc123456789 aside',
      }),
    );
    expect(choice?.strategy).toBe('research');
    expect(choice?.rationale).toContain('sk-***');
    expect(choice?.rationale).not.toContain('sk-abc123456789');
  });

  it('rejects non-JSON, unknown tiers and extra fields', () => {
    expect(parseStrategyChoice('nope')).toBeNull();
    expect(parseStrategyChoice(JSON.stringify({ strategy: 'huge' }))).toBeNull();
    expect(
      parseStrategyChoice(JSON.stringify({ strategy: 'starter', tier: 'research' })),
    ).toBeNull();
    expect(parseStrategyChoice('[]')).toBeNull();
  });
});

describe('chooseStrategy (agent-first tier choice)', () => {
  const counts = { papers: 5, datasets: 1, comparisons: 0 }; // thresholds → starter

  it('treats an explicit mode as a decision, not a judgment', async () => {
    const stub = new StubHarness(JSON.stringify({ strategy: 'research' }));
    const choice = await chooseStrategy({
      mode: 'research',
      counts: { papers: 500, datasets: 10, comparisons: 5 },
      question: 'q',
      harness: stub,
    });
    expect(choice).toEqual({ strategy: 'research', source: 'config' });
    expect(stub.calls).toBe(0);
  });

  it('falls back to the scale rule without a harness', async () => {
    const choice = await chooseStrategy({ mode: 'auto', counts, question: 'q', harness: null });
    expect(choice).toEqual({ strategy: 'starter', source: 'thresholds' });
  });

  it('uses a valid agent choice over the threshold prior', async () => {
    const stub = new StubHarness(
      JSON.stringify({
        strategy: 'research',
        rationale: 'the question demands uncovered-range reporting despite the small corpus',
      }),
    );
    const choice = await chooseStrategy({ mode: 'auto', counts, question: 'q', harness: stub });
    expect(choice.strategy).toBe('research');
    expect(choice.source).toBe('agent');
    expect(choice.rationale).toContain('uncovered-range');
    expect(stub.calls).toBe(1);
  });

  it('falls back to the scale rule when the agent output is invalid', async () => {
    const stub = new StubHarness(JSON.stringify({ strategy: 'huge', rationale: 'x' }));
    const choice = await chooseStrategy({ mode: 'auto', counts, question: 'q', harness: stub });
    expect(choice).toEqual({ strategy: 'starter', source: 'thresholds' });
  });

  it('falls back to the scale rule when the harness throws', async () => {
    const stub = new StubHarness('{}');
    stub.runTask = async () => {
      throw new Error('provider unreachable');
    };
    const choice = await chooseStrategy({ mode: 'auto', counts, question: 'q', harness: stub });
    expect(choice).toEqual({ strategy: 'starter', source: 'thresholds' });
  });

  it('round-trips the threshold prior through the fake harness', async () => {
    const fake = new FakeHarnessAdapter();
    const choice = await chooseStrategy({ mode: 'auto', counts, question: 'q', harness: fake });
    // The fake echoes the prior: e2e exercises call → validation → accept
    // while producing exactly the tier the scale rule computed.
    expect(choice.strategy).toBe(resolveStrategy('auto', counts));
    expect(choice.source).toBe('agent');
    expect(choice.rationale).toBeUndefined();
  });
});
