import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { escapeCaption, placeVerifiedFigures } from '../src/paper/place-figures.js';

/**
 * Deterministic figure placement.
 *
 * The compile-side cross-check refuses to publish a paper whose planned figures
 * are missing — correct, and until now the only remedy it offered was another
 * model turn. These tests pin the deterministic remedy: what gets inserted is
 * exactly what a render record vouches for AND what is still on disk, running it
 * twice converges instead of stacking duplicate floats, and a stale record is
 * reported rather than turned into a LaTeX "file not found".
 */

const MAIN =
  '\\documentclass{iclr2026_conference}\n\\begin{document}\n\\section{Results}\n\\end{document}\n';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'placefig-'));
  await mkdir(join(root, 'paper'), { recursive: true });
  await mkdir(join(root, 'figures'), { recursive: true });
  await mkdir(join(root, 'reports', 'paper'), { recursive: true });
  await writeFile(join(root, 'paper', 'main.tex'), MAIN, 'utf8');
  await writeFile(join(root, 'figures', 'pipeline.pdf'), '%PDF-1.4\n', 'utf8');
  await writeFile(join(root, 'figures', 'topology.svg'), '<svg xmlns="x"></svg>\n', 'utf8');
  // A spaced name is what the model-authored matplotlib scripts actually
  // produced on the real project (`fig.savefig('Fig 1.pdf')`).
  await writeFile(join(root, 'figures', 'Fig 1.pdf'), '%PDF-1.4\n', 'utf8');
  await writeFile(join(root, 'figures', 'broken.pdf'), '%PDF-1.4\n', 'utf8');
  await writeFile(
    join(root, 'reports', 'paper', 'diagram-render.json'),
    JSON.stringify({
      contract: 'diagram-render-v1',
      renders: [
        {
          specPath: join(root, 'reports', 'paper', 'diagram.json'),
          outputPath: join(root, 'figures', 'pipeline.pdf'),
          bytes: 9,
          sha256: 'sha256:abc',
        },
        {
          specPath: join(root, 'reports', 'paper', 'topology.json'),
          outputPath: join(root, 'figures', 'topology.svg'),
          bytes: 22,
          sha256: 'sha256:def',
        },
      ],
    }),
    'utf8',
  );
  await writeFile(
    join(root, 'reports', 'paper', 'figure-render.json'),
    JSON.stringify({
      contract: 'figure-render-v1',
      status: 'partial',
      figures: [
        { id: 'Fig 1', ok: true, outputs: [{ path: 'figures/Fig 1.pdf', bytes: 9 }] },
        // The render failed (matplotlib vs numpy 2, e.g.); its bytes on disk
        // are from an earlier run and must NOT be advertised as evidence.
        { id: 'Fig 2', ok: false, outputs: [{ path: 'figures/broken.pdf', bytes: 9 }] },
      ],
    }),
    'utf8',
  );
  await writeFile(
    join(root, 'reports', 'paper', 'figures-plan.json'),
    JSON.stringify({
      contract: 'paper-figure-v1',
      figures: {
        figures: [
          { id: 'Fig 1', caption: 'Unseen-domain top-1 accuracy (%, all folds)' },
          { id: 'Fig 2', caption: 'Never verified' },
        ],
      },
    }),
    'utf8',
  );
}, 60_000);

describe('placeVerifiedFigures', () => {
  it('inserts a float for each includable figure, none for an unverified one', async () => {
    const result = await placeVerifiedFigures(root);
    expect(result.inserted).toBe(2);
    expect(result.figures.map((figure) => figure.id).sort()).toEqual(['Fig 1', 'pipeline', 'topology']);

    const mainTex = await readFile(join(root, 'paper', 'main.tex'), 'utf8');
    expect(mainTex).toContain('\\includegraphics[width=0.9\\linewidth]{figures/pipeline.pdf}');
    // A spaced name is brace-wrapped so pdflatex does not end the argument early.
    expect(mainTex).toContain('\\includegraphics[width=0.9\\linewidth]{figures/{Fig 1.pdf}}');
    expect(mainTex).toContain('Unseen-domain top-1 accuracy (\\%, all folds)');
    expect(mainTex).toContain('\\label{fig:pipeline}');
    expect(mainTex).not.toContain('broken.pdf');
    // graphicx cannot include SVG without a converter, so an SVG-only artifact
    // is reported instead of becoming a build failure later.
    const svg = result.figures.find((figure) => figure.id === 'topology')!;
    expect(svg.action).toBe('skipped');
    expect(svg.reason).toContain('cannot be included by pdflatex/xelatex graphicx');
    expect(mainTex).not.toContain('topology.svg');
    // The float must land inside the document, before \end{document}.
    expect(mainTex.indexOf('\\end{figure}')).toBeLessThan(mainTex.lastIndexOf('\\end{document}'));
  }, 60_000);

  it('converges when run again instead of stacking duplicates', async () => {
    const first = await placeVerifiedFigures(root);
    const second = await placeVerifiedFigures(root);
    expect(first.inserted).toBe(2);
    expect(second.inserted).toBe(0);
    expect(second.already).toBe(2);
    const mainTex = await readFile(join(root, 'paper', 'main.tex'), 'utf8');
    expect(mainTex.match(/\\begin\{figure\}/g)).toHaveLength(2);
  }, 60_000);

  it('skips a figure whose record vouches for bytes that are gone', async () => {
    await rm(join(root, 'figures', 'Fig 1.pdf'));
    const result = await placeVerifiedFigures(root);
    const missing = result.figures.find((figure) => figure.id === 'Fig 1')!;
    expect(missing.action).toBe('skipped');
    expect(missing.reason).toContain('the file is gone or empty');
    const mainTex = await readFile(join(root, 'paper', 'main.tex'), 'utf8');
    expect(mainTex).not.toContain('Fig 1.pdf');
    // The other figure still gets placed: one stale record must not veto the paper.
    expect(result.inserted).toBe(1);
  }, 60_000);

  /**
   * The table is the evidence route that survives a broken plotting stack: it
   * needs no matplotlib, no SVG converter, and no model. Assertions therefore
   * check WHICH runs and WHICH cells made it in, not merely that a float
   * appeared — a table of the wrong rows compiles just as happily.
   */
  it('places a results table built only from succeeded stored runs', async () => {
    await writeFile(
      join(root, 'reports', 'paper', 'results.json'),
      JSON.stringify({
        schemaVersion: 1,
        rows: [
          {
            specId: 'idea-alpha',
            ideaId: 'alpha-idea',
            scale: 'quick',
            status: 'succeeded',
            metrics: [
              { name: 'target_unseen_domain_top1_accuracy', value: 23.639027148 },
              { name: 'worst_domain_accuracy', value: 11.1774744 },
            ],
          },
          {
            specId: 'idea-beta',
            ideaId: 'beta-idea',
            scale: 'quick',
            status: 'succeeded',
            metrics: [{ name: 'target_unseen_domain_top1_accuracy', value: 14.7132 }],
          },
          // A failed run must not lend its numbers to the paper.
          {
            specId: 'idea-gamma',
            ideaId: 'gamma-idea',
            scale: 'smoke',
            status: 'failed',
            metrics: [{ name: 'target_unseen_domain_top1_accuracy', value: 99.9 }],
          },
          // Indistinguishable from beta: the table has to say so in the PDF.
          {
            specId: 'idea-beta-abl-x',
            ideaId: 'beta-idea',
            scale: 'quick',
            status: 'succeeded',
            metrics: [{ name: 'target_unseen_domain_top1_accuracy', value: 14.7132 }],
          },
        ],
      }),
      'utf8',
    );

    const result = await placeVerifiedFigures(root);
    expect(result.table.action).toBe('inserted');
    expect(result.table.rowCount).toBe(3);
    expect(result.table.columns).toEqual([
      'target_unseen_domain_top1_accuracy',
      'worst_domain_accuracy',
    ]);

    const mainTex = await readFile(join(root, 'paper', 'main.tex'), 'utf8');
    expect(mainTex).toContain('\\label{tab:ideaseek-results}');
    expect(mainTex).toContain('23.64');
    expect(mainTex).toContain('14.71');
    expect(mainTex).not.toContain('99.9');
    // beta has no worst-domain value: the cell says so rather than inventing 0.
    expect(mainTex).toContain('n/a');
    // The unit basis is stated where a reader would otherwise assume one.
    expect(mainTex).toContain('the unit basis per metric');
    // …and so is the indistinguishable pair, inside the caption the reader sees.
    expect(mainTex).toContain('identical values for every');
    // Rows are keyed by specId (one run), not ideaId: an ablation shares its
    // parent's idea id and would otherwise replace it in the table.
    expect(mainTex).toContain('idea-beta & quick');

    const again = await placeVerifiedFigures(root);
    expect(again.table.action).toBe('already');
    const rewritten = await readFile(join(root, 'paper', 'main.tex'), 'utf8');
    expect(rewritten.match(/\\begin\{table\}/g)).toHaveLength(1);
  }, 60_000);

  it('escapes the characters that appear in real metric captions', () => {
    expect(escapeCaption('top-1 accuracy (%, all folds) & 3 seeds')).toBe(
      'top-1 accuracy (\\%, all folds) \\& 3 seeds',
    );
    // A macro already in the caption is left alone — escaping backslashes would
    // turn \textbf into garbage in the name of safety.
    expect(escapeCaption('\\textbf{gain}')).toBe('\\textbf{gain}');
  });
});
