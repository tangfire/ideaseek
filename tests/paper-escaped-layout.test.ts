import { describe, expect, it } from 'vitest';
import { normalizeEscapedLayout } from '../src/paper/compile.js';

describe('escaped-layout repair', () => {
  it('decodes double-escaped newlines but leaves real control words alone', () => {
    // Observed twice on FDG: in the vendored ICLR preamble and in a
    // model-written section, `\\n` survived as a literal backslash-n, and
    // pdflatex stopped with "Undefined control sequence" at main.tex:75 — no
    // PDF could be produced while every platform check (style files, inputs,
    // staged dependencies) passed.
    const broken =
      '\\usepackage{hyperref}\\n\\usepackage[capitalize]{cleveref}\n\\nAnswering that question\n';
    const fixed = normalizeEscapedLayout(broken);
    expect(fixed).toContain('\\usepackage{hyperref}\n\\usepackage[capitalize]{cleveref}');
    expect(fixed).not.toContain('\\nAnswering');
  });

  it('does not touch genuine macros, without a name list to maintain', () => {
    expect(normalizeEscapedLayout('\\newtheorem{theorem}{Theorem}')).toBe(
      '\\newtheorem{theorem}{Theorem}',
    );
    expect(normalizeEscapedLayout('$\\nu$ and \\times')).toBe('$\\nu$ and \\times');
    expect(normalizeEscapedLayout('\\noindent')).toBe('\\noindent');
  });
});
