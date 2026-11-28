import { expect, it } from 'vitest';
import {
  figureLegibilityWarnings,
  FIGURE_CATEGORY_LIMIT,
  FIGURE_LABEL_CHAR_LIMIT,
  validatePaperFigurePlan,
} from '../src/paper/figure.js';

const figure = (over: Record<string, unknown>) => ({
  id: 'Fig 1',
  type: 'bar',
  title: 'Unseen-domain accuracy by method',
  caption: 'Bar chart of the recorded primary metric.',
  statistics: ['target_unseen_domain_top1_accuracy'],
  dataSources: [{ kind: 'result-file', ref: 'reports/paper/results.json' }],
  script: [
    'import matplotlib.pyplot as plt',
    'rows = load("reports/paper/results.json")',
    'fig, ax = plt.subplots()',
    'ax.bar(rows.labels, rows.values)',
    "fig.savefig('figures/Fig 1.pdf')",
    "fig.savefig('figures/Fig 1.png')",
  ].join('\n'),
  latexInclude: '\\includegraphics{figures/Fig 1.pdf}',
  claims: ['claim-1'],
  ...over,
});

const plan = (figures: unknown[]) => ({
  venue: 'ICLR',
  figures,
  style: 'publication',
  dpi: 300,
  format: 'pdf',
  preservedExisting: [],
  manualRemaining: [],
  reviewerFeedback: { verdict: 'REVIEW_UNAVAILABLE', notes: ['no reviewer backend in this run'] },
});

it('accepts a script that saves the figure and reads its declared source', () => {
  const result = validatePaperFigurePlan(plan([figure({})]));
  expect(result.errors).toEqual([]);
});

it('rejects a script that draws but never saves', () => {
  // The library is not the contract; the output file is. A plan whose scripts
  // name matplotlib but write nothing used to validate and then fail at
  // render time with an unexplained "no files produced".
  const result = validatePaperFigurePlan(
    plan([figure({ script: 'import matplotlib.pyplot as plt\nplt.plot([1, 2])\n' })]),
  );
  expect(result.errors.join(' ')).toMatch(/must save the figure/);
});

it('rejects a script that invents values while claiming a recorded source', () => {
  // The exact FDG case: six "publication figures" from `ax.bar(['fake'], [1.0])`,
  // each declaring a data source none of them read, reported as rendered 6/6.
  const result = validatePaperFigurePlan(
    plan([
      figure({
        script:
          "import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.bar(['fake'], [1.0])\nfig.savefig('Fig 1.pdf')\nfig.savefig('Fig 1.png')",
      }),
    ]),
  );
  expect(result.errors.join(' ')).toMatch(/does not read its declared data source/);
});

it('does not require a source reference for context-only figures', () => {
  const result = validatePaperFigurePlan(
    plan([
      figure({
        dataSources: [{ kind: 'context', ref: 'protocol split rules' }],
        script:
          "import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.text(0.5, 0.5, 'split design')\nfig.savefig('Fig 1.pdf')\nfig.savefig('Fig 1.png')",
      }),
    ]),
  );
  expect(result.errors.join(' ')).not.toMatch(/does not read its declared data source/);
});

it('legibility warnings: bar figures over budget or with long labels warn; clean stays silent', () => {
  const bar = [{ type: 'bar' }, { type: 'multi-panel' }];
  const shortIds = Array.from({ length: FIGURE_CATEGORY_LIMIT }, (_, i) => `spec-${i}`);
  const longId = `a-very-long-spec-id-beyond-the-${FIGURE_LABEL_CHAR_LIMIT}-char-budget-x`;

  // Within budget, short labels → silent.
  expect(figureLegibilityWarnings(bar, shortIds)).toEqual([]);
  // No bar-type figures → the arithmetic does not apply.
  expect(figureLegibilityWarnings([{ type: 'scatter' }], [...shortIds, longId])).toEqual([]);
  // No recorded rows → nothing to count.
  expect(figureLegibilityWarnings(bar, [])).toEqual([]);

  // One row past the category budget → warn (the observed Figure2 had 11).
  const overBudget = figureLegibilityWarnings(bar, [...shortIds, 'spec-extra']);
  expect(overBudget).toHaveLength(1);
  expect(overBudget[0]).toContain(`${FIGURE_CATEGORY_LIMIT}-category budget`);

  // A raw spec id that cannot fit an axis label → warn by name.
  const longLabel = figureLegibilityWarnings(bar, [longId]);
  expect(longLabel.join(' ')).toContain('longer than');
  expect(longLabel.join(' ')).toContain(longId.slice(0, 40));
});
