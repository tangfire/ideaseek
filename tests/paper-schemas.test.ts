import { describe, expect, it } from 'vitest';
import { validatePaperPlan } from '../src/paper/plan.js';
import { validatePaperFigurePlan } from '../src/paper/figure.js';
import { validateManuscript } from '../src/paper/write.js';
import { validateRebuttal, validateSlidesDeck, validateTalkPlan } from '../src/paper/engagement.js';
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

describe('rebuttal-v1 schema', () => {
  const valid = (): Record<string, unknown> => ({
    overallResponse: 'Locked evidence answers the concerns.',
    pointResponses: [
      {
        point: 'thin evidence',
        response: 'Grounded in repro-fedavg.',
        evidence: [{ source: 'repro-fedavg', location: 'metrics' }],
      },
    ],
    newEvidence: [],
    revisedClaims: [],
    reviewerFeedback: { verdict: 'REVIEW_UNAVAILABLE', notes: ['none'] },
  });

  it('is registered and accepts a valid rebuttal', () => {
    expect(listSchemaNames()).toContain('rebuttal-v1');
    expect(validateAgainstSchema('rebuttal-v1', valid()).ok).toBe(true);
    expect(validateRebuttal(valid()).ok).toBe(true);
    expect(() => assertAgainstSchema('rebuttal-v1', valid())).not.toThrow();
  });

  const cases: { name: string; value: unknown; ok: boolean }[] = [
    { name: 'null', value: null, ok: false },
    {
      name: 'empty overallResponse',
      value: mutate(valid(), (r) => (r.overallResponse = '')),
      ok: false,
    },
    {
      name: 'no pointResponses',
      value: mutate(valid(), (r) => (r.pointResponses = [])),
      ok: false,
    },
    {
      name: 'point without evidence',
      value: mutate(
        valid(),
        (r) => ((r.pointResponses as Record<string, unknown>[])[0]!.evidence = []),
      ),
      ok: false,
    },
    {
      name: 'bad newEvidence entry',
      value: mutate(valid(), (r) => (r.newEvidence = [{ source: 'x', location: 'y' }])),
      ok: false,
    },
    {
      name: 'bad reviewer verdict',
      value: mutate(
        valid(),
        (r) => ((r.reviewerFeedback as Record<string, unknown>).verdict = 'LGTM'),
      ),
      ok: false,
    },
    {
      name: 'revisedClaims with number',
      value: mutate(valid(), (r) => (r.revisedClaims = [42])),
      ok: false,
    },
  ];
  for (const testCase of cases) {
    it(`both ${testCase.ok ? 'accept' : 'reject'}: ${testCase.name}`, () => {
      expect(validateAgainstSchema('rebuttal-v1', testCase.value).ok).toBe(testCase.ok);
      expect(validateRebuttal(testCase.value).ok).toBe(testCase.ok);
    });
  }
});

describe('paper-slides-v1 schema', () => {
  const valid = (): Record<string, unknown> => ({
    venue: 'ICLR',
    talkType: 'conference',
    slideCount: 3,
    slides: [1, 2, 3].map((number) => ({
      number,
      title: `Slide ${number}`,
      bullets: [`Point ${number}`],
      speakerNotes: `Notes ${number}.`,
      claimSources: ['plan-claim'],
    })),
    talkScript: 'Word-for-word script.',
    timeBudgetMinutes: 15,
    qaPrep: [{ question: 'Q?', answer: 'A.', source: 'protocol' }],
    reviewerFeedback: { verdict: 'REVIEW_UNAVAILABLE', notes: ['none'] },
  });

  it('is registered and accepts a valid deck', () => {
    expect(listSchemaNames()).toContain('paper-slides-v1');
    expect(validateAgainstSchema('paper-slides-v1', valid()).ok).toBe(true);
    expect(validateSlidesDeck(valid()).ok).toBe(true);
  });

  const cases: { name: string; value: unknown; ok: boolean; schemaOnly?: boolean }[] = [
    { name: 'null', value: null, ok: false },
    { name: 'bad venue', value: mutate(valid(), (s) => (s.venue = 'arXiv')), ok: false },
    { name: 'bad talkType', value: mutate(valid(), (s) => (s.talkType = 'webinar')), ok: false },
    {
      name: 'two slides',
      value: mutate(valid(), (s) => {
        s.slides = (s.slides as unknown[]).slice(0, 2);
        s.slideCount = 2;
      }),
      ok: false,
    },
    {
      name: 'empty bullets',
      value: mutate(valid(), (s) => ((s.slides as Record<string, unknown>[])[0]!.bullets = [])),
      ok: false,
    },
    { name: 'no qaPrep', value: mutate(valid(), (s) => (s.qaPrep = [])), ok: false },
    {
      name: 'zero time budget',
      value: mutate(valid(), (s) => (s.timeBudgetMinutes = 0)),
      ok: false,
    },
    { name: 'empty talkScript', value: mutate(valid(), (s) => (s.talkScript = '')), ok: false },
    {
      name: 'count mismatch is TS-only (schema accepts)',
      value: mutate(valid(), (s) => (s.slideCount = 5)),
      ok: false,
      schemaOnly: true,
    },
  ];
  for (const testCase of cases) {
    it(`${testCase.schemaOnly ? 'TS-only rule (documented subset)' : `both ${testCase.ok ? 'accept' : 'reject'}`}: ${testCase.name}`, () => {
      if (testCase.schemaOnly) {
        // slideCount === slides.length is relational — schema accepts,
        // the TS validator rejects; runtime order runs TS first.
        expect(validateAgainstSchema('paper-slides-v1', testCase.value).ok).toBe(true);
        expect(validateSlidesDeck(testCase.value).ok).toBe(false);
        return;
      }
      expect(validateAgainstSchema('paper-slides-v1', testCase.value).ok).toBe(testCase.ok);
      expect(validateSlidesDeck(testCase.value).ok).toBe(testCase.ok);
    });
  }
});

describe('paper-talk-v1 schema', () => {
  const valid = (): Record<string, unknown> => ({
    readiness: 'draft',
    checklist: [{ item: 'slides present', status: 'pass', detail: 'stored deck found' }],
    talkTrack: 'Question → evidence → takeaway.',
    qAndA: [{ question: 'Q?', answer: 'A.', source: 'plan-claim' }],
    blockers: [],
    reviewerFeedback: { verdict: 'REVIEW_UNAVAILABLE', notes: ['none'] },
  });

  it('is registered and accepts a valid draft', () => {
    expect(listSchemaNames()).toContain('paper-talk-v1');
    expect(validateAgainstSchema('paper-talk-v1', valid()).ok).toBe(true);
    expect(validateTalkPlan(valid()).ok).toBe(true);
  });

  const cases: { name: string; value: unknown; ok: boolean }[] = [
    { name: 'null', value: null, ok: false },
    { name: 'bad readiness', value: mutate(valid(), (t) => (t.readiness = 'maybe')), ok: false },
    { name: 'empty checklist', value: mutate(valid(), (t) => (t.checklist = [])), ok: false },
    {
      name: 'bad checklist status',
      value: mutate(
        valid(),
        (t) => ((t.checklist as Record<string, unknown>[])[0]!.status = 'meh'),
      ),
      ok: false,
    },
    { name: 'no qAndA', value: mutate(valid(), (t) => (t.qAndA = [])), ok: false },
    { name: 'empty talkTrack', value: mutate(valid(), (t) => (t.talkTrack = '')), ok: false },
    {
      name: 'ready with blocker',
      value: mutate(valid(), (t) => {
        t.readiness = 'ready';
        (t.blockers as string[]).push('x');
      }),
      ok: false,
    },
    {
      name: 'ready with failing item',
      value: mutate(valid(), (t) => {
        t.readiness = 'ready';
        (t.checklist as Record<string, unknown>[])[0]!.status = 'fail';
      }),
      ok: false,
    },
    {
      name: 'blocked without blocker',
      value: mutate(valid(), (t) => (t.readiness = 'blocked')),
      ok: false,
    },
    { name: 'draft with blocker', value: mutate(valid(), (t) => (t.blockers = ['x'])), ok: false },
    {
      name: 'clean ready is fine',
      value: mutate(valid(), (t) => (t.readiness = 'ready')),
      ok: true,
    },
  ];
  for (const testCase of cases) {
    it(`both ${testCase.ok ? 'accept' : 'reject'}: ${testCase.name}`, () => {
      expect(validateAgainstSchema('paper-talk-v1', testCase.value).ok).toBe(testCase.ok);
      expect(validateTalkPlan(testCase.value).ok).toBe(testCase.ok);
    });
  }
});
