import { describe, expect, it } from 'vitest';
import { validatePaperCard } from '../src/knowledge/papercard.js';

function validCard() {
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
    prompt_schema_version: 'papercard-lite-v1',
  };
}

describe('validatePaperCard', () => {
  it('accepts a complete card with evidence-backed claims', () => {
    const result = validatePaperCard(validCard());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('allows explicit unknowns but never missing required fields', () => {
    const card = validCard() as Record<string, unknown>;
    delete card.title;
    const result = validatePaperCard(card);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('title');
  });

  it('requires every claim to carry at least one evidence locator', () => {
    const card = validCard();
    card.claims.push({ text: 'unsupported claim', evidence: [] });
    const result = validatePaperCard(card);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('evidence must contain at least one locator');

    (card.claims as unknown[])[1] = { text: 'weak locator', evidence: [{}] };
    const weak = validatePaperCard(card);
    expect(weak.ok).toBe(false);
    expect(weak.errors.join(' ')).toContain('page, section or quote locator');
  });

  it('rejects malformed hashes and non-object input', () => {
    const card = validCard();
    card.document_hash = 'md5:nope';
    expect(validatePaperCard(card).ok).toBe(false);
    expect(validatePaperCard(null).ok).toBe(false);
    expect(validatePaperCard([]).ok).toBe(false);
  });

  it('validates method structure', () => {
    const card = validCard() as unknown as { method: unknown };
    card.method = { summary: 42 };
    const result = validatePaperCard(card);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
