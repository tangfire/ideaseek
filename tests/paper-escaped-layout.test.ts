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

describe('manuscript layout is repaired before it is stored', () => {
  it('normalizes abstract, sections and bibtex on the way in', async () => {
    // The compile-side normaliser fixed what the engine saw while the stored
    // artifact stayed dirty: the paper in the repository was not the paper that
    // compiled, and every later reader (claim audit, exporter, human) inherited
    // literal escape pairs.
    const { normalizeManuscriptLayout } = await import('../src/paper/write.js');
    // The dirty fixtures must carry LITERAL escape pairs (backslash + n), not
    // real newlines. The first version of this test wrote them as real
    // newlines, which made every assertion pass while testing nothing — the
    // same "green for the wrong reason" shape the fairness suite just showed.
    const dirty = {
      title: 'T',
      venue: 'ICLR',
      abstract: 'We show\\nthat this works.',
      sections: [
        {
          id: 'intro',
          heading: 'Introduction\\n',
          latex: 'First sentence.\\n\\nSecond paragraph.',
          sources: ['plan:intro'],
        },
      ],
      bibliography: [{ key: 'smith2024', bibtex: '@article{a,\\ntitle={A}\\n}' }],
    } as unknown as Parameters<typeof normalizeManuscriptLayout>[0];

    const clean = normalizeManuscriptLayout(dirty);
    // Paragraph breaks (two escapes in a row) are never two control words, so
    // they are repaired unconditionally.
    expect(clean.sections[0]!.latex).toContain('\n\nSecond paragraph.');
    // A heading whose escape ends the string is unambiguous: no control word
    // can be cut off at the end of a field.
    expect(clean.sections[0]!.heading).toBe('Introduction\n');
    expect(clean.bibliography[0]!.bibtex).toContain('\\ntitle');
    // `…show\nthat this works` is ambiguous: it reads exactly like a control
    // word would (`\newtheorem`). Repairing it needs a macro name list, which
    // the platform refuses to maintain, so it is REPORTED for a human instead
    // of guessed. Asserting a repair here would encode a false promise.
    expect(clean.abstract).toBe('We show\\nthat this works.');
    expect(clean.ambiguousEscapes.length).toBeGreaterThan(0);
    expect(clean.ambiguousEscapes.join(' ')).toContain('that this works');
    // Real macros survive the repair, which is the whole reason the rule is
    // "not followed by a lowercase letter" rather than a name list.
    const macros = {
      ...clean,
      sections: [
        {
          id: 'method',
          heading: 'Method',
          latex: '\\newtheorem{thm}{Theorem}\\nu \\in \\mathbb{R}\\nratio = 2',
          sources: ['plan:method'],
        },
      ],
    } as unknown as Parameters<typeof normalizeManuscriptLayout>[0];
    const kept = normalizeManuscriptLayout(macros);
    expect(kept.sections[0]!.latex).toContain('\\newtheorem');
    expect(kept.sections[0]!.latex).toContain('\\nu');
    expect(kept.sections[0]!.latex).toContain('\\nratio');
  });
});
