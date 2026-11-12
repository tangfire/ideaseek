import { describe, expect, it } from 'vitest';
import { validatePaperCard } from '../src/knowledge/papercard.js';
import {
  assertAgainstSchema,
  listSchemaNames,
  validateAgainstSchema,
} from '../src/core/schema/index.js';
import { IdeaseekError } from '../src/core/errors.js';
import { FakeHarnessAdapter } from '../src/dsh/fake-adapter.js';
import { FakeWorker } from '../src/worker/worker.js';
import { buildHandlers } from '../src/commands/shared.js';
import { makeProjectDir, openRuntime } from './helpers.js';

/**
 * JSON Schema contract layer (DEPENDENCY_POLICY: JSON Schema + mature
 * validator as the single cross-language authority). The structural rules
 * must decide EXACTLY like the existing domain validator — parity is the
 * point: schema and validatePaperCard cannot drift into accepting different
 * payloads — and the extract handler must fail closed on violations.
 */

function validCard(): Record<string, unknown> {
  return {
    paper_id: 'paper-001',
    document_hash: `sha256:${'a'.repeat(64)}`,
    title: 'Attention Is All You Need',
    problem: 'Sequence transduction without recurrence',
    method: {
      summary: 'Transformer architecture',
      steps: ['encode', 'attend', 'decode'],
      motivation: ['parallel training'],
    },
    datasets: ['WMT 2014 EN-DE'],
    metrics: ['BLEU'],
    baselines: ['RNN Encoder-Decoder'],
    limitations: ['quadratic attention cost'],
    claims: [
      {
        text: 'The model achieves 28.4 BLEU on EN-DE',
        evidence: [{ page: 8, section: 'Experiments', quote: '28.4 BLEU' }],
      },
    ],
    unknowns: ['learning rate schedule details'],
    parser_version: 'ideaseek-scan-1',
    prompt_schema_version: 'papercard-v1',
  };
}

function clone(base = validCard()): Record<string, unknown> {
  return structuredClone(base);
}

describe('schema registry', () => {
  it('registers papercard-v1 and rejects unknown names as programming errors', () => {
    expect(listSchemaNames()).toEqual(['papercard-v1']);
    expect(() => validateAgainstSchema('nope-v1' as 'papercard-v1', {})).toThrow(IdeaseekError);
    try {
      validateAgainstSchema('nope-v1' as 'papercard-v1', {});
    } catch (error) {
      expect((error as IdeaseekError).code).toBe('INVALID_ARGUMENT');
    }
  });

  it('accepts the complete fixture card', () => {
    const check = validateAgainstSchema('papercard-v1', validCard());
    expect(check.errors).toEqual([]);
    expect(check.ok).toBe(true);
    expect(assertAgainstSchema('papercard-v1', validCard())).toBeUndefined();
  });

  it('reports per-field issues with instance paths', () => {
    const card = clone();
    delete card.title;
    card.document_hash = 'md5:nope';
    const check = validateAgainstSchema('papercard-v1', card);
    expect(check.ok).toBe(false);
    expect(check.issues.some((issue) => issue.path === '/title')).toBe(true);
    expect(check.issues.some((issue) => issue.path === '/document_hash')).toBe(true);
    expect(check.errors.join(' ')).toContain('required property');
  });

  it('assertAgainstSchema throws INVALID_ARTIFACT carrying the issues', () => {
    try {
      assertAgainstSchema('papercard-v1', { title: 42 });
      expect.unreachable('should have thrown');
    } catch (error) {
      const typed = error as IdeaseekError;
      expect(typed.code).toBe('INVALID_ARTIFACT');
      expect(typed.message).toContain('papercard-v1');
      expect(Array.isArray(typed.details?.issues)).toBe(true);
    }
  });
});

describe('decision parity: JSON Schema vs validatePaperCard', () => {
  const cases: { name: string; card: unknown }[] = [
    { name: 'valid card', card: validCard() },
    { name: 'null input', card: null },
    { name: 'array input', card: [] },
    { name: 'scalar input', card: 42 },
    {
      name: 'missing title',
      card: (() => {
        const c = clone();
        delete c.title;
        return c;
      })(),
    },
    {
      name: 'empty title',
      card: (() => {
        const c = clone();
        c.title = '';
        return c;
      })(),
    },
    {
      name: 'bad hash',
      card: (() => {
        const c = clone();
        c.document_hash = 'md5:x';
        return c;
      })(),
    },
    {
      name: 'missing parser_version',
      card: (() => {
        const c = clone();
        delete c.parser_version;
        return c;
      })(),
    },
    {
      name: 'missing method',
      card: (() => {
        const c = clone();
        delete c.method;
        return c;
      })(),
    },
    {
      name: 'method summary wrong type',
      card: (() => {
        const c = clone();
        (c.method as Record<string, unknown>).summary = 42;
        return c;
      })(),
    },
    {
      name: 'datasets with number',
      card: (() => {
        const c = clone();
        c.datasets = ['ok', 3];
        return c;
      })(),
    },
    {
      name: 'empty datasets allowed',
      card: (() => {
        const c = clone();
        c.datasets = [];
        return c;
      })(),
    },
    {
      name: 'claims not array',
      card: (() => {
        const c = clone();
        c.claims = 'none';
        return c;
      })(),
    },
    {
      name: 'empty claims array allowed',
      card: (() => {
        const c = clone();
        c.claims = [];
        return c;
      })(),
    },
    {
      name: 'claim without evidence',
      card: (() => {
        const c = clone();
        (c.claims as unknown[]).push({ text: 'x', evidence: [] });
        return c;
      })(),
    },
    {
      name: 'evidence without any locator',
      card: (() => {
        const c = clone();
        (c.claims as unknown[]).push({ text: 'x', evidence: [{}] });
        return c;
      })(),
    },
    {
      name: 'evidence page below 1',
      card: (() => {
        const c = clone();
        (c.claims as unknown[]).push({ text: 'x', evidence: [{ page: 0 }] });
        return c;
      })(),
    },
    {
      name: 'evidence empty quote only',
      card: (() => {
        const c = clone();
        (c.claims as unknown[]).push({ text: 'x', evidence: [{ quote: '' }] });
        return c;
      })(),
    },
    {
      name: 'evidence section locator accepted',
      card: (() => {
        const c = clone();
        (c.claims as unknown[]).push({ text: 'x', evidence: [{ section: 'Method' }] });
        return c;
      })(),
    },
    {
      name: 'evidence page valid despite bad quote type',
      card: (() => {
        const c = clone();
        (c.claims as unknown[]).push({ text: 'x', evidence: [{ page: 2, quote: 5 }] });
        return c;
      })(),
    },
    {
      name: 'empty claim text',
      card: (() => {
        const c = clone();
        (c.claims as unknown[]).push({ text: '', evidence: [{ page: 1 }] });
        return c;
      })(),
    },
    {
      name: 'extra unknown field accepted',
      card: (() => {
        const c = clone();
        c.whatever = { nested: true };
        return c;
      })(),
    },
  ];

  for (const testCase of cases) {
    it(`agrees on: ${testCase.name}`, () => {
      const domain = validatePaperCard(testCase.card);
      const schema = validateAgainstSchema('papercard-v1', testCase.card);
      expect(schema.ok, `schema errors: ${schema.errors.join('; ')}`).toBe(domain.ok);
    });
  }
});

describe('paper.extract schema gate (fail closed at the persistence boundary)', () => {
  it('rejects a model payload that violates papercard-v1 and commits nothing', async () => {
    const dir = await makeProjectDir('schema-gate');
    const harness = new FakeHarnessAdapter();
    await harness.initialize();
    process.env.IDEASEEK_FAKE_PAPERCARD_OUTPUT = '{"title": 42}';
    try {
      const runtime = await openRuntime(dir, { recover: false, harness });
      const run = await runtime.db.createRun({
        projectId: runtime.project.id,
        question: 'schema gate',
        config: runtime.config,
        strategy: 'starter',
      });
      await runtime.db.enqueueTask({
        runId: run.runId,
        type: 'paper.extract',
        phase: 'DEMO',
        payload: { paperName: 'attention.pdf', paperText: 'some text long enough to parse' },
        idempotencyKey: 'paper.extract:schema-gate',
        maxAttempts: 1,
      });

      const exit = await new FakeWorker({
        runtime,
        runId: run.runId,
        kind: 'test',
        handlers: buildHandlers(),
        leaseMs: 5_000,
        heartbeatMs: 100,
        pollMs: 10,
      }).run();
      // The task's permanent contract violation fails the worker's claim loop.
      expect(exit.reason).toBe('failed');

      const task = (await runtime.db.listTasks(run.runId))[0]!;
      expect(task.status).toBe('failed');
      expect(task.error?.message).toContain('schema validation');
      expect(task.error?.code).toBe('INVALID_ARTIFACT');
      expect(await runtime.db.listArtifacts(task.taskId)).toHaveLength(0);
      await runtime.close();
    } finally {
      delete process.env.IDEASEEK_FAKE_PAPERCARD_OUTPUT;
      await harness.shutdown();
    }
  }, 30_000);

  it('the default fake payload passes the same gate (no false rejections)', async () => {
    const dir = await makeProjectDir('schema-gate-ok');
    const harness = new FakeHarnessAdapter();
    await harness.initialize();
    try {
      const runtime = await openRuntime(dir, { recover: false, harness });
      const run = await runtime.db.createRun({
        projectId: runtime.project.id,
        question: 'schema gate ok',
        config: runtime.config,
        strategy: 'starter',
      });
      await runtime.db.enqueueTask({
        runId: run.runId,
        type: 'paper.extract',
        phase: 'DEMO',
        payload: { paperName: 'attention.pdf', paperText: 'some text long enough to parse' },
        idempotencyKey: 'paper.extract:schema-gate-ok',
        maxAttempts: 1,
      });
      const exit = await new FakeWorker({
        runtime,
        runId: run.runId,
        kind: 'test',
        handlers: buildHandlers(),
        leaseMs: 5_000,
        heartbeatMs: 100,
        pollMs: 10,
      }).run();
      expect(exit.reason).toBe('completed');
      const task = (await runtime.db.listTasks(run.runId))[0]!;
      expect(task.status).toBe('succeeded');
      await runtime.close();
    } finally {
      await harness.shutdown();
    }
  }, 30_000);
});
