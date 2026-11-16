import { expect, it } from 'vitest';
import { latexDependencyNames } from '../src/paper/compile.js';

it('reads every declared class and package, including option lists and groups', () => {
  // The preflight must name the one missing support file rather than burn a
  // latexmk run or report all twenty packages as absent.
  const source = [
    '\\documentclass{article}',
    '\\usepackage{iclr2026_conference,times}',
    '\\usepackage[utf8]{inputenc}',
    '\\usepackage{amsmath, amssymb}',
    '% \\usepackage{commented-out}',
  ].join('\n');
  expect(latexDependencyNames(source)).toEqual([
    'article',
    'iclr2026_conference',
    'times',
    'inputenc',
    'amsmath',
    'amssymb',
    'commented-out',
  ]);
});
