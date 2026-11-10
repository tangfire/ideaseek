/**
 * Minimal LaTeX source parser (docs: PDF/LaTeX/OCR 解析 — the LaTeX leg).
 * Deterministic, dependency-free text normalization: strips comments and
 * control sequences while keeping human-readable content, so .tex inputs
 * flow through the SAME parsed-paper artifact shape as PDFs (single page,
 * source-hashed, incremental).
 */
export interface LatexSection {
  heading: string;
  body: string;
}

export interface LatexDocument {
  title: string | null;
  sections: LatexSection[];
  /** Full readable text (title + sections), used as the single evidence page. */
  text: string;
  parser: string;
}

export const LATEX_PARSER_VERSION = 'latex-v1';

function stripComments(source: string): string {
  return source.replace(/(?<!\\)%[^\n]*/g, '');
}

function extractCommandBody(source: string, command: string): string | null {
  const marker = `\\${command}{`;
  const start = source.indexOf(marker);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start + marker.length; i < source.length; i += 1) {
    const char = source[i];
    if (char === '{') depth += 1;
    else if (char === '}') {
      if (depth === 0) return source.slice(start + marker.length, i);
      depth -= 1;
    }
  }
  return null;
}

/** Removes control sequences but keeps their readable arguments. */
function readable(source: string): string {
  return (
    source
      // keep the contents of \command{...} / [args]
      .replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?\s*/g, ' ')
      .replace(/[{}$]/g, ' ')
      .replace(/\\([^\w\s])/g, '$1') // escaped punctuation: \& \% \_ -> plain
      .replace(/\\[a-zA-Z]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

export function parseLatex(source: string): LatexDocument {
  const cleaned = stripComments(source);
  const titleRaw = extractCommandBody(cleaned, 'title');
  const title = titleRaw ? readable(titleRaw) || null : null;

  const sections: LatexSection[] = [];
  const sectionPattern = /\\(?:section|subsection|subsubsection)\s*\{([^}]*)\}/g;
  const matches = [...cleaned.matchAll(sectionPattern)];
  matches.forEach((match, index) => {
    const heading = readable(match[1] ?? '') || `section ${index + 1}`;
    const bodyStart = (match.index ?? 0) + match[0].length;
    const bodyEnd =
      index + 1 < matches.length ? (matches[index + 1]!.index ?? cleaned.length) : cleaned.length;
    const body = readable(cleaned.slice(bodyStart, bodyEnd));
    sections.push({ heading, body });
  });

  const preamble = sections.length > 0 ? cleaned.slice(0, matches[0]!.index ?? 0) : cleaned;
  const parts = [
    title ? `Title: ${title}` : '',
    sections.length === 0 ? readable(preamble) : '',
    ...sections.map((section) => `${section.heading}: ${section.body}`),
  ].filter((part) => part.length > 0);

  return {
    title,
    sections,
    text: parts.join('\n\n'),
    parser: LATEX_PARSER_VERSION,
  };
}
