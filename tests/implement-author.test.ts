import { describe, expect, it } from 'vitest';
import {
  buildImplementationContext,
  authorImplementation,
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

describe('buildImplementationContext', () => {
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
});

describe('authorImplementation', () => {
  it('accepts a program, strips fences and reports its size', async () => {
    const result = await authorImplementation({
      harness: harnessReturning('```python\n' + PROGRAM + '\n```'),
      blueprint: blueprint(),
      dataPath: null,
      runId: 'run-1',
      now: 1000,
    });
    expect(result.origin).toBe('agent');
    expect(result.lines).toBe(40);
    expect(result.source).not.toContain('```');
    expect(result.contextHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('refuses a stub too small to be a real implementation', async () => {
    await expect(
      authorImplementation({
        harness: harnessReturning('print("hi")'),
        blueprint: blueprint(),
        dataPath: null,
        runId: 'run-1',
        now: 1000,
      }),
    ).rejects.toThrow(/only \d+ line/);
  });

  it('refuses an unreviewable blob instead of writing it', async () => {
    const huge = Array.from({ length: 900 }, (_, i) => `x${i} = ${i}`).join('\n');
    await expect(
      authorImplementation({
        harness: harnessReturning(huge),
        blueprint: blueprint(),
        dataPath: null,
        runId: 'run-1',
        now: 1000,
      }),
    ).rejects.toThrow(/limit 400/);
  });
});
