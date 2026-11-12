import { IdeaseekError } from '../core/errors.js';
import { validateAgainstSchema } from '../core/schema/index.js';

/**
 * parsed-paper-v1 (schemas/parsed-paper-v1.json): the artifact shape the
 * Python worker (pdf/OCR), the LaTeX parser and every TypeScript reader
 * share. Parsing goes through the schema so a corrupted or foreign payload
 * fails with field paths instead of a downstream TypeError — cross-language
 * contract enforcement at the read boundary.
 */

export interface ParsedPaperPage {
  page: number;
  text: string;
}

export interface ParsedPaperArtifact {
  source?: string;
  sourceHash?: string;
  pageCount: number;
  pages: ParsedPaperPage[];
  parser?: string | null;
  ocr?: boolean;
}

/** JSON.parse + schema validation; throws PARSE_FAILED with issue paths. */
export function parseParsedPaper(text: string): ParsedPaperArtifact {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `parsed-paper artifact is not valid JSON: ${(error as Error).message}`,
    );
  }
  const check = validateAgainstSchema('parsed-paper-v1', raw);
  if (!check.ok) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `parsed-paper artifact failed schema validation: ${check.errors.slice(0, 5).join('; ')}`,
      { issues: check.issues },
    );
  }
  return raw as ParsedPaperArtifact;
}
