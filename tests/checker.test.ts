import { describe, expect, it } from 'vitest';
import { verifyPaperEvidence } from '../src/knowledge/checker.js';

const HASH = `sha256:${'b'.repeat(64)}`;

function card(overrides: Record<string, unknown> = {}) {
  return {
    paper_id: 'paper-bbbbbbbbbbbb',
    document_hash: HASH,
    title: 'unknown',
    problem: 'unknown',
    method: { summary: 'unknown', steps: [], motivation: [] },
    datasets: [],
    metrics: [],
    baselines: [],
    limitations: [],
    claims: [
      {
        text: 'attention beats recurrence',
        evidence: [{ page: 1, quote: 'the model uses attention mechanisms' }],
      },
    ],
    unknowns: [],
    parser_version: 'pypdf/7.0.0',
    prompt_schema_version: 'papercard-v1',
    ...overrides,
  };
}

const PAGES = [
  { page: 1, text: 'Introduction. The model uses attention mechanisms throughout.' },
  { page: 2, text: 'Experiments show 28.4 BLEU on the translation task.' },
];

describe('verifyPaperEvidence', () => {
  it('passes when quotes appear on the claimed pages and hash binds', () => {
    const report = verifyPaperEvidence({
      card: card(),
      pages: PAGES,
      sourceText: null,
      sourceHash: HASH,
      now: 1000,
    });
    expect(report.verdict).toBe('pass');
    expect(report.hashMatch).toBe(true);
    expect(report.stats).toMatchObject({ claims: 1, spans: 1, verified: 1, failed: 0 });
    expect(report.spanChecks[0]!.foundPage).toBe(1);
  });

  it('fails when a quote does not exist in the source', () => {
    const report = verifyPaperEvidence({
      card: card({
        claims: [{ text: 'made up', evidence: [{ page: 1, quote: 'this text appears nowhere' }] }],
      }),
      pages: PAGES,
      sourceText: null,
      sourceHash: HASH,
      now: 1000,
    });
    expect(report.verdict).toBe('fail');
    expect(report.stats.failed).toBe(1);
    expect(report.spanChecks[0]!.detail).toContain('not found');
  });

  it('fails when the quote is on a different page than claimed', () => {
    const report = verifyPaperEvidence({
      card: card({
        claims: [{ text: 'wrong page', evidence: [{ page: 1, quote: '28.4 BLEU' }] }],
      }),
      pages: PAGES,
      sourceText: null,
      sourceHash: HASH,
      now: 1000,
    });
    expect(report.verdict).toBe('fail');
    expect(report.spanChecks[0]!.foundPage).toBe(2);
    expect(report.spanChecks[0]!.detail).toContain('claim says page 1');
  });

  it('fails when claimed pages fall outside the document', () => {
    const report = verifyPaperEvidence({
      card: card({
        claims: [{ text: 'out of range', evidence: [{ page: 99, quote: 'attention' }] }],
      }),
      pages: PAGES,
      sourceText: null,
      sourceHash: HASH,
      now: 1000,
    });
    expect(report.verdict).toBe('fail');
    expect(report.spanChecks[0]!.detail).toContain('outside document range');
  });

  it('fails on document hash mismatch (binding check is independent)', () => {
    const report = verifyPaperEvidence({
      card: card(),
      pages: PAGES,
      sourceText: null,
      sourceHash: `sha256:${'c'.repeat(64)}`,
      now: 1000,
    });
    expect(report.verdict).toBe('fail');
    expect(report.hashMatch).toBe(false);
  });

  it('treats page-only locators as weak but non-failing', () => {
    const report = verifyPaperEvidence({
      card: card({
        claims: [{ text: 'page only', evidence: [{ page: 2 }] }],
      }),
      pages: PAGES,
      sourceText: null,
      sourceHash: HASH,
      now: 1000,
    });
    expect(report.verdict).toBe('pass');
    expect(report.stats.weak).toBe(1);
    expect(report.stats.verified).toBe(0);
  });

  it('matches quotes against raw text when there is no parsed PDF', () => {
    const report = verifyPaperEvidence({
      card: card({
        claims: [
          {
            text: 'excerpt claim',
            evidence: [{ quote: 'a verbatim line from the excerpt' }],
          },
        ],
      }),
      pages: null,
      sourceText: 'Intro\nA Verbatim Line   from the excerpt\nmore',
      sourceHash: HASH,
      now: 1000,
    });
    expect(report.verdict).toBe('pass');
    expect(report.spanChecks[0]!.foundPage).toBeNull();
  });

  it('normalizes whitespace and case when locating quotes', () => {
    const report = verifyPaperEvidence({
      card: card({
        claims: [
          { text: 'c', evidence: [{ page: 1, quote: 'THE MODEL   uses attention MECHANISMS' }] },
        ],
      }),
      pages: PAGES,
      sourceText: null,
      sourceHash: HASH,
      now: 1000,
    });
    expect(report.verdict).toBe('pass');
  });

  it('fails on structural errors even when quotes would match', () => {
    const broken = card();
    delete (broken as Record<string, unknown>).title;
    const report = verifyPaperEvidence({
      card: broken,
      pages: PAGES,
      sourceText: null,
      sourceHash: HASH,
      now: 1000,
    });
    expect(report.verdict).toBe('fail');
    expect(report.structureErrors.join(' ')).toContain('title');
  });
});
