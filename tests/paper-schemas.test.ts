import { describe, expect, it } from 'vitest';
import { validatePaperPlan } from '../src/paper/plan.js';
import { validatePaperFigurePlan } from '../src/paper/figure.js';
import { validateManuscript } from '../src/paper/write.js';
import {
  assertAgainstSchema,
  listSchemaNames,
  validateAgainstSchema,
} from '../src/core/schema/index.js';

/**
 * paper-plan-v1 / paper-figure-v1 / paper-write-v1: structural mirrors of
 * the platform-owned paper-* validators (ADR-009). Context pins (figure
 * ids from the stored plan, venue equality) stay TS — one-way
 * divergences; the TS validators run first at runtime.
 */

function validPlan(): Record<string, unknown> {
  return {
    paperType: 'empirical-study',
    venue: 'ICLR',
    maxPages: 9,
    contribution: 'A locked-protocol study.',
    claimsEvidence: [
      {
        claim: 'A beats baseline',
        evidence: [{ source: 'repro-fedavg', location: 'metrics.accuracy' }],
        status: 'supported',
      },
    ],
    structure: [
      { section: '§1 Introduction', purpose: 'motivate', keyPoints: ['gap', 'contribution'] },
    ],
    figurePlan: [
      {
        id: 'fig-1',
        kind: 'bar',
        caption: 'Main comparison',
        supportsClaims: ['A beats baseline'],
      },
    ],
    citationPlan: [{ topic: 'federated baselines', candidates: ['mcmahan17a'] }],
    reviewerFeedback: { verdict: 'REVIEW_UNAVAILABLE', notes: ['no backend'] },
    nextSteps: ['draft the introduction'],
  };
}

function validFigurePlan(): Record<string, unknown> {
  return {
    style: 'publication',
    dpi: 300,
    format: 'pdf',
    figures: [
      {
        id: 'fig-1',
        type: 'bar',
        title: 'Main comparison',
        caption: 'Main comparison caption.',
        statistics: ['bar height = final accuracy'],
        dataSources: [{ kind: 'experiment-spec', ref: 'repro-fedavg' }],
        script: 'import matplotlib.pyplot as plt\n',
        latexInclude: '\\includegraphics{figures/fig-1}',
        claims: ['A beats baseline'],
      },
    ],
    preservedExisting: [],
    manualRemaining: ['architecture diagram'],
    reviewerFeedback: { verdict: 'REVIEW_UNAVAILABLE', notes: ['none'] },
  };
}

function validManuscript(): Record<string, unknown> {
  return {
    venue: 'ICLR',
    title: 'Locked-Protocol Study',
    abstract: 'We study the question.',
    sections: [
      { id: 'intro', heading: 'Introduction', latex: '\\section{Introduction}', sources: ['plan'] },
    ],
    bibliography: [{ key: 'mcmahan2017', bibtex: '@inproceedings{mcmahan2017, title={FedAvg}}' }],
    qualityPasses: ['reverse-outline'],
    manualFixes: [],
    reviewerFeedback: { verdict: 'REVIEW_UNAVAILABLE', notes: ['none'] },
  };
}

function mutate(
  value: Record<string, unknown>,
  apply: (record: Record<string, unknown>) => void,
): Record<string, unknown> {
  const copy = structuredClone(value);
  apply(copy);
  return copy;
}

describe('paper-plan-v1 schema', () => {
  it('is registered and accepts a valid plan', () => {
    expect(listSchemaNames()).toContain('paper-plan-v1');
    const check = validateAgainstSchema('paper-plan-v1', validPlan());
    expect(check.errors).toEqual([]);
    expect(() => assertAgainstSchema('paper-plan-v1', validPlan())).not.toThrow();
    expect(validatePaperPlan(validPlan()).ok).toBe(true);
  });

  const cases: { name: string; plan: unknown; ok: boolean }[] = [
    { name: 'null', plan: null, ok: false },
    { name: 'bad venue', plan: mutate(validPlan(), (p) => (p.venue = 'arXiv')), ok: false },
    { name: 'maxPages 0', plan: mutate(validPlan(), (p) => (p.maxPages = 0)), ok: false },
    {
      name: 'empty contribution',
      plan: mutate(validPlan(), (p) => (p.contribution = '')),
      ok: false,
    },
    { name: 'no claims', plan: mutate(validPlan(), (p) => (p.claimsEvidence = [])), ok: false },
    {
      name: 'bad claim status',
      plan: mutate(
        validPlan(),
        (p) => ((p.claimsEvidence as Record<string, unknown>[])[0]!.status = 'proven'),
      ),
      ok: false,
    },
    { name: 'no structure', plan: mutate(validPlan(), (p) => (p.structure = [])), ok: false },
    { name: 'no figures', plan: mutate(validPlan(), (p) => (p.figurePlan = [])), ok: false },
    { name: 'no citations', plan: mutate(validPlan(), (p) => (p.citationPlan = [])), ok: false },
    {
      name: 'bad reviewer verdict',
      plan: mutate(
        validPlan(),
        (p) => ((p.reviewerFeedback as Record<string, unknown>).verdict = 'LGTM'),
      ),
      ok: false,
    },
    { name: 'no nextSteps', plan: mutate(validPlan(), (p) => (p.nextSteps = [])), ok: false },
  ];
  for (const testCase of cases) {
    it(`both ${testCase.ok ? 'accept' : 'reject'}: ${testCase.name}`, () => {
      expect(validateAgainstSchema('paper-plan-v1', testCase.plan).ok).toBe(testCase.ok);
      expect(validatePaperPlan(testCase.plan).ok).toBe(testCase.ok);
    });
  }
});

describe('paper-figure-v1 schema', () => {
  it('is registered and accepts a valid plan', () => {
    expect(listSchemaNames()).toContain('paper-figure-v1');
    const check = validateAgainstSchema('paper-figure-v1', validFigurePlan());
    expect(check.errors).toEqual([]);
    expect(() => assertAgainstSchema('paper-figure-v1', validFigurePlan())).not.toThrow();
    expect(validatePaperFigurePlan(validFigurePlan()).ok).toBe(true);
  });

  const cases: { name: string; plan: unknown; ok: boolean }[] = [
    { name: 'null', plan: null, ok: false },
    { name: 'bad style', plan: mutate(validFigurePlan(), (p) => (p.style = 'print')), ok: false },
    { name: 'dpi 71', plan: mutate(validFigurePlan(), (p) => (p.dpi = 71)), ok: false },
    { name: 'bad format', plan: mutate(validFigurePlan(), (p) => (p.format = 'svg')), ok: false },
    { name: 'no figures', plan: mutate(validFigurePlan(), (p) => (p.figures = [])), ok: false },
    {
      name: 'bad plot type',
      plan: mutate(
        validFigurePlan(),
        (p) => ((p.figures as Record<string, unknown>[])[0]!.type = 'pie'),
      ),
      ok: false,
    },
    {
      name: 'no caption',
      plan: mutate(
        validFigurePlan(),
        (p) => delete (p.figures as Record<string, unknown>[])[0]!.caption,
      ),
      ok: false,
    },
    {
      name: 'no statistics',
      plan: mutate(
        validFigurePlan(),
        (p) => ((p.figures as Record<string, unknown>[])[0]!.statistics = []),
      ),
      ok: false,
    },
    {
      name: 'script without matplotlib',
      plan: mutate(
        validFigurePlan(),
        (p) => ((p.figures as Record<string, unknown>[])[0]!.script = 'print(1)'),
      ),
      ok: false,
    },
    {
      name: 'empty claims',
      plan: mutate(
        validFigurePlan(),
        (p) => ((p.figures as Record<string, unknown>[])[0]!.claims = []),
      ),
      ok: false,
    },
    {
      name: 'bad source kind',
      plan: mutate(
        validFigurePlan(),
        (p) =>
          ((p.figures as Record<string, unknown>[])[0]!.dataSources = [
            { kind: 'guess', ref: 'x' },
          ]),
      ),
      ok: false,
    },
  ];
  for (const testCase of cases) {
    it(`both ${testCase.ok ? 'accept' : 'reject'}: ${testCase.name}`, () => {
      expect(validateAgainstSchema('paper-figure-v1', testCase.plan).ok).toBe(testCase.ok);
      expect(validatePaperFigurePlan(testCase.plan).ok).toBe(testCase.ok);
    });
  }
});

describe('paper-write-v1 schema', () => {
  it('is registered and accepts a valid manuscript', () => {
    expect(listSchemaNames()).toContain('paper-write-v1');
    const check = validateAgainstSchema('paper-write-v1', validManuscript());
    expect(check.errors).toEqual([]);
    expect(() => assertAgainstSchema('paper-write-v1', validManuscript())).not.toThrow();
    expect(validateManuscript(validManuscript()).ok).toBe(true);
  });

  const cases: { name: string; ms: unknown; ok: boolean }[] = [
    { name: 'null', ms: null, ok: false },
    { name: 'bad venue', ms: mutate(validManuscript(), (m) => (m.venue = 'arXiv')), ok: false },
    { name: 'empty title', ms: mutate(validManuscript(), (m) => (m.title = '')), ok: false },
    { name: 'no sections', ms: mutate(validManuscript(), (m) => (m.sections = [])), ok: false },
    {
      name: 'documentclass in section',
      ms: mutate(
        validManuscript(),
        (m) => ((m.sections as Record<string, unknown>[])[0]!.latex = '\\documentclass{article}'),
      ),
      ok: false,
    },
    {
      name: 'section without sources',
      ms: mutate(
        validManuscript(),
        (m) => ((m.sections as Record<string, unknown>[])[0]!.sources = []),
      ),
      ok: false,
    },
    {
      name: 'no bibliography',
      ms: mutate(validManuscript(), (m) => (m.bibliography = [])),
      ok: false,
    },
    {
      name: 'bibtex without @',
      ms: mutate(
        validManuscript(),
        (m) => ((m.bibliography as Record<string, unknown>[])[0]!.bibtex = 'plain text'),
      ),
      ok: false,
    },
    {
      name: 'no quality passes',
      ms: mutate(validManuscript(), (m) => (m.qualityPasses = [])),
      ok: false,
    },
    {
      name: 'bad reviewer verdict',
      ms: mutate(
        validManuscript(),
        (m) => ((m.reviewerFeedback as Record<string, unknown>).verdict = 'SHIP'),
      ),
      ok: false,
    },
  ];
  for (const testCase of cases) {
    it(`both ${testCase.ok ? 'accept' : 'reject'}: ${testCase.name}`, () => {
      expect(validateAgainstSchema('paper-write-v1', testCase.ms).ok).toBe(testCase.ok);
      expect(validateManuscript(testCase.ms).ok).toBe(testCase.ok);
    });
  }
});
