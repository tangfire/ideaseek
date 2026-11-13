import { describe, expect, it } from 'vitest';
import { validateForensicsOutput } from '../src/idea/forensics.js';
import {
  assertAgainstSchema,
  listSchemaNames,
  validateAgainstSchema,
} from '../src/core/schema/index.js';

/**
 * integrity-forensics-v1: structural mirror of the model-output
 * validator. Context-bound rules (ideaId/cardVersion equality, unique
 * finding ids) stay TS — pinned as one-way divergences; the runtime
 * validator runs first.
 */

const EXPECTED = { ideaId: 'alpha', cardVersion: 2 };

function validOutput(): Record<string, unknown> {
  return {
    ideaId: 'alpha',
    cardVersion: 2,
    findings: [
      {
        id: 'missing-seed',
        family: 'coverage',
        severity: 'major',
        detail: 'only one seed supports the headline claim',
        evidence: 'experiments/spec-a.result.metrics',
      },
    ],
    summary: 'One coverage gap; no integrity violations found.',
  };
}

function validatorOk(output: unknown): boolean {
  return validateForensicsOutput(output, EXPECTED).ok;
}

function mutate(apply: (output: Record<string, unknown>) => void): Record<string, unknown> {
  const output = structuredClone(validOutput());
  apply(output);
  return output;
}

describe('integrity-forensics-v1 schema', () => {
  it('is registered and accepts a valid output', () => {
    expect(listSchemaNames()).toContain('integrity-forensics-v1');
    const check = validateAgainstSchema('integrity-forensics-v1', validOutput());
    expect(check.errors).toEqual([]);
    expect(() => assertAgainstSchema('integrity-forensics-v1', validOutput())).not.toThrow();
  });

  const structural: { name: string; output: unknown }[] = [
    { name: 'null', output: null },
    { name: 'findings not array', output: mutate((o) => (o.findings = 'x')) },
    {
      name: 'unknown family',
      output: mutate((o) => ((o.findings as Record<string, unknown>[])[0]!.family = 'vibes')),
    },
    {
      name: 'bad severity',
      output: mutate((o) => ((o.findings as Record<string, unknown>[])[0]!.severity = 'fatal')),
    },
    {
      name: 'empty detail',
      output: mutate((o) => ((o.findings as Record<string, unknown>[])[0]!.detail = '')),
    },
    {
      name: 'missing evidence',
      output: mutate((o) => delete (o.findings as Record<string, unknown>[])[0]!.evidence),
    },
    { name: 'empty summary', output: mutate((o) => (o.summary = '')) },
    { name: 'missing ideaId', output: mutate((o) => delete o.ideaId) },
    { name: 'cardVersion 0', output: mutate((o) => (o.cardVersion = 0)) },
  ];
  for (const testCase of structural) {
    it(`rejects: ${testCase.name}`, () => {
      const check = validateAgainstSchema('integrity-forensics-v1', testCase.output);
      expect(check.ok, check.errors.join('; ')).toBe(false);
    });
  }

  it('accepts empty findings (clean sweep)', () => {
    expect(
      validateAgainstSchema(
        'integrity-forensics-v1',
        mutate((o) => (o.findings = [])),
      ).ok,
    ).toBe(true);
  });

  const tsOnly: { name: string; output: unknown }[] = [
    { name: 'wrong ideaId', output: mutate((o) => (o.ideaId = 'beta')) },
    { name: 'wrong cardVersion', output: mutate((o) => (o.cardVersion = 9)) },
    {
      name: 'duplicate finding id',
      output: mutate((o) => {
        const findings = o.findings as Record<string, unknown>[];
        findings.push({ ...findings[0]! });
      }),
    },
    { name: 'whitespace summary', output: mutate((o) => (o.summary = ' ')) },
  ];
  for (const testCase of tsOnly) {
    it(`TS-only rule (documented subset): ${testCase.name}`, () => {
      expect(validatorOk(testCase.output)).toBe(false);
      expect(validateAgainstSchema('integrity-forensics-v1', testCase.output).ok).toBe(true);
    });
  }
});
