import { describe, expect, it } from 'vitest';
import {
  listSchemaNames,
  validateAgainstSchema,
  assertAgainstSchema,
} from '../src/core/schema/index.js';
import { parseParsedPaper } from '../src/knowledge/parsed-paper.js';
import { isIdeaseekError } from '../src/core/errors.js';

/**
 * parsed-paper-v1: the Python worker (pdf/OCR) and the LaTeX parser emit
 * this shape; TypeScript validates it at BOTH boundaries — before persisting
 * (paper.parse / paper.latex handlers) and when reading committed artifacts
 * back (extract rehydration). A foreign/corrupted payload must fail with
 * field paths, never a downstream TypeError.
 */

function pythonEmitted(): Record<string, unknown> {
  return {
    source: 'papers/attention.pdf',
    pageCount: 2,
    pages: [
      { page: 1, text: 'page one text' },
      { page: 2, text: 'page two text' },
    ],
    parser: 'ideaseek-pdf/7.0.0',
  };
}

describe('parsed-paper-v1 schema', () => {
  it('is registered alongside papercard-v1', () => {
    expect(listSchemaNames()).toContain('papercard-v1');
    expect(listSchemaNames()).toContain('parsed-paper-v1');
  });

  const accepted: Record<string, unknown>[] = [
    pythonEmitted(),
    { ...pythonEmitted(), sourceHash: `sha256:${'b'.repeat(64)}`, ocr: true },
    // LaTeX leg: extra per-parser fields are allowed.
    {
      source: 'papers/notes.tex',
      sourceHash: `sha256:${'c'.repeat(64)}`,
      pageCount: 1,
      pages: [{ page: 1, text: 'text' }],
      parser: 'ideaseek-latex-1',
      title: 'A Title',
      sectionCount: 4,
    },
    // Degenerate but legal: parser may be null, zero pages allowed.
    { pageCount: 0, pages: [], parser: null },
  ];
  for (const [index, payload] of accepted.entries()) {
    it(`accepts payload #${index + 1}`, () => {
      const check = validateAgainstSchema('parsed-paper-v1', payload);
      expect(check.errors).toEqual([]);
      expect(() => assertAgainstSchema('parsed-paper-v1', payload)).not.toThrow();
    });
  }

  const rejected: unknown[] = [
    { ...pythonEmitted(), pages: 'all of them' },
    { ...pythonEmitted(), pageCount: -1 },
    { ...pythonEmitted(), pageCount: 1.5 },
    { pageCount: 2, pages: [{ page: 0, text: 'zero-indexed' }] },
    { pageCount: 1, pages: [{ page: 1, text: 42 }] },
    { pageCount: 1, pages: [{ page: 1 }] }, // missing text
    { ...pythonEmitted(), sourceHash: 'md5:nope' },
    { ...pythonEmitted(), ocr: 'yes' },
    { ...pythonEmitted(), parser: 7 },
    null,
    [],
    'parsed',
  ];
  for (const [index, payload] of rejected.entries()) {
    it(`rejects payload #${index + 1}`, () => {
      const check = validateAgainstSchema('parsed-paper-v1', payload);
      expect(check.ok).toBe(false);
      expect(check.errors.length).toBeGreaterThan(0);
      expect(() => assertAgainstSchema('parsed-paper-v1', payload)).toThrow();
    });
  }
});

describe('parseParsedPaper (read boundary)', () => {
  it('round-trips a valid payload', () => {
    const parsed = parseParsedPaper(JSON.stringify(pythonEmitted()));
    expect(parsed.pageCount).toBe(2);
    expect(parsed.pages[1]!.page).toBe(2);
    expect(parsed.pages[0]!.text).toBe('page one text');
  });

  it('fails with PARSE_FAILED on invalid JSON', () => {
    try {
      parseParsedPaper('{not json');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isIdeaseekError(error)).toBe(true);
      expect((error as { code: string }).code).toBe('PARSE_FAILED');
      expect((error as { message: string }).message).toContain('not valid JSON');
    }
  });

  it('fails with field paths when the shape violates the contract', () => {
    try {
      parseParsedPaper(JSON.stringify({ pageCount: 1, pages: [{ page: 0, text: 'x' }] }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isIdeaseekError(error)).toBe(true);
      const typed = error as { code: string; message: string; details?: { issues?: unknown } };
      expect(typed.code).toBe('PARSE_FAILED');
      expect(typed.message).toContain('schema validation');
      expect(typed.details?.issues).toBeDefined();
      // The issue points at the offending instance path, not a generic blob.
      expect(JSON.stringify(typed.details?.issues)).toContain('/pages/0/page');
    }
  });
});
