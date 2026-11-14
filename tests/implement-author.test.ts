import { describe, expect, it } from 'vitest';
import {
  buildImplementationContext,
  authorImplementation,
  IMPLEMENT_INSTRUCTION,
  parseImplementationOutput,
} from '../src/comparison/implement-author.js';
import type { ReproductionBlueprint } from '../src/comparison/types.js';
import type { HarnessAdapter } from '../src/dsh/adapter.js';

/**
 * Separating the plan from the program. One response carrying both is what
 * produced a truncated JSON in one run and a non-compiling program in another.
 */

function blueprint(over: Partial<ReproductionBlueprint> = {}): ReproductionBlueprint {
  return {
    methodId: 'fedavg',
    paperExplicit: [
      {
        statement: 'clients average model weights weighted by sample counts',
        evidence: 'papers/fedavg.pdf p3',
      },
    ],
    assumptions: ['lr=0.01 SGD'],
    missingDetails: ['exact client sampling rate not stated'],
    confidence: 'medium',
    algorithm: {
      dataInterface: { description: 'manifest.csv with image,label,domain' },
      metrics: [
        { name: 'unseen_domain_accuracy', direction: 'higher' },
        { name: 'source_to_unseen_gap', direction: 'lower' },
      ],
      hyperparameters: { lr: 0.01, rounds: 100 },
      requirements: ['numpy'],
    },
    ...over,
  } as ReproductionBlueprint;
}

function harnessReturning(output: string): HarnessAdapter {
  return {
    kind: 'fake',
    async initialize() {},
    async runTask() {
      return {
        output,
        finishReason: 'completed',
        usage: { inputTokens: 100, outputTokens: 200 },
      } as never;
    },
    async cancel() {},
    async shutdown() {},
  } as unknown as HarnessAdapter;
}

const PROGRAM = Array.from({ length: 40 }, (_, i) => `# line ${i}`).join('\n');

describe('parseImplementationOutput', () => {
  it('takes the program from the JSON envelope the harness requires', () => {
    const parsed = parseImplementationOutput(
      JSON.stringify({ program: PROGRAM, notes: 'rounds not grounded' }),
    );
    expect(parsed.program).toBe(PROGRAM);
    expect(parsed.notes).toBe('rounds not grounded');
  });

  it('still accepts a bare program rather than discarding a usable answer', () => {
    const parsed = parseImplementationOutput('```python\n' + PROGRAM + '\n```');
    expect(parsed.program).toContain('# line 39');
    expect(parsed.notes).toContain('not a JSON object');
  });

  it('reports the model notes when the envelope carries no program', () => {
    const parsed = parseImplementationOutput(JSON.stringify({ notes: 'I need more detail' }));
    expect(parsed.program).toBe('');
  });
});

describe('buildImplementationContext', () => {
  it('judges the handed path by its own contents, not by a remembered total', () => {
    expect(IMPLEMENT_INSTRUCTION).toContain('Never require a total sample count');
    expect(IMPLEMENT_INSTRUCTION).toContain('checks run on a selected');
  });

  it('tells the program where data actually comes from during smoke', () => {
    // smoke is invoked with no path argument. A program that only understands
    // --data resolves the corpus from its working directory, which is the
    // worktree: it reports "no images found" about a corpus that is present.
    expect(IMPLEMENT_INSTRUCTION).toContain('IDEASEEK_DATASET_ROOTS');
    expect(IMPLEMENT_INSTRUCTION).toContain('IDEASEEK_PROJECT_ROOT');
    expect(IMPLEMENT_INSTRUCTION).toContain('current working directory');
  });

  it('carries the plan, the metric names and the honesty constraints', () => {
    const context = buildImplementationContext(blueprint(), 'datasets-derived/pacs-smoke');
    expect(context).toContain('clients average model weights');
    expect(context).toContain('papers/fedavg.pdf p3');
    expect(context).toContain('unseen_domain_accuracy (higher)');
    expect(context).toContain('exact client sampling rate not stated');
    expect(context).toContain('manifest.csv with image,label,domain');
    expect(context).toContain('numpy');
    expect(context).toContain('datasets-derived/pacs-smoke');
  });

  it('says when the caller supplies the path rather than inventing one', () => {
    expect(buildImplementationContext(blueprint(), null)).toContain('caller supplies');
  });

  it('appends the refusal so a retry is not the identical request', () => {
    const context = buildImplementationContext(
      blueprint(),
      'datasets/x',
      'line 210: expected ( — the program is 595 lines long',
    );
    expect(context).toContain('## correction required');
    expect(context).toContain('line 210: expected (');
  });

  it('keeps the correction past a truncated context', () => {
    const huge = blueprint();
    huge.algorithm.dataInterface.description = 'd'.repeat(20_000);
    const context = buildImplementationContext(huge, 'datasets/x', 'fix the brackets');
    expect(context).toContain('(context truncated)');
    expect(context.indexOf('## correction required')).toBeGreaterThan(
      context.indexOf('(context truncated)'),
    );
  });
});

describe('authorImplementation', () => {
  it('accepts a program inside the JSON envelope the harness requires', async () => {
    const result = await authorImplementation({
      harness: harnessReturning(JSON.stringify({ program: PROGRAM, notes: 'rounds assumed' })),
      blueprint: blueprint(),
      dataPath: null,
      runId: 'run-1',
      now: 1000,
    });
    expect(result.origin).toBe('agent');
    expect(result.lines).toBe(40);
    expect(result.notes).toBe('rounds assumed');
    expect(result.source).not.toContain('```');
    expect(result.contextHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('refuses a stub too small to be a real implementation, quoting the model', async () => {
    await expect(
      authorImplementation({
        harness: harnessReturning(JSON.stringify({ program: 'print("hi")', notes: 'too vague' })),
        blueprint: blueprint(),
        dataPath: null,
        runId: 'run-1',
        now: 1000,
      }),
    ).rejects.toThrow(/too vague/);
  });

  it('refuses an unreviewable blob instead of writing it', async () => {
    const huge = Array.from({ length: 1200 }, (_, i) => `x${i} = ${i}`).join('\n');
    await expect(
      authorImplementation({
        harness: harnessReturning(huge),
        blueprint: blueprint(),
        dataPath: null,
        runId: 'run-1',
        now: 1000,
      }),
    ).rejects.toThrow(/limit 800/);
  });
});
