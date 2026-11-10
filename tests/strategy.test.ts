import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  countInputs,
  resolveStrategy,
  STRATEGY_WORDING,
  strategyWording,
} from '../src/workflow/strategy.js';

describe('resolveStrategy', () => {
  it('honors explicit modes over scale heuristics', () => {
    expect(resolveStrategy('starter', { papers: 500, datasets: 10, comparisons: 5 })).toBe(
      'starter',
    );
    expect(resolveStrategy('research', { papers: 0, datasets: 0, comparisons: 0 })).toBe(
      'research',
    );
    expect(resolveStrategy('standard', { papers: 500, datasets: 10, comparisons: 5 })).toBe(
      'standard',
    );
  });

  it('adapts auto mode to input scale', () => {
    expect(resolveStrategy('auto', { papers: 0, datasets: 0, comparisons: 0 })).toBe('starter');
    expect(resolveStrategy('auto', { papers: 9, datasets: 1, comparisons: 0 })).toBe('starter');
    // Comparisons present → at least standard even with few papers.
    expect(resolveStrategy('auto', { papers: 5, datasets: 0, comparisons: 1 })).toBe('standard');
    expect(resolveStrategy('auto', { papers: 10, datasets: 1, comparisons: 0 })).toBe('standard');
    expect(resolveStrategy('auto', { papers: 49, datasets: 5, comparisons: 2 })).toBe('standard');
    expect(resolveStrategy('auto', { papers: 50, datasets: 1, comparisons: 0 })).toBe('research');
    expect(resolveStrategy('auto', { papers: 500, datasets: 10, comparisons: 5 })).toBe('research');
  });
});

describe('strategy wording', () => {
  it('provides a label and a disclaimer for every strategy', () => {
    for (const strategy of ['starter', 'standard', 'research'] as const) {
      const wording = STRATEGY_WORDING[strategy];
      expect(wording.label.length).toBeGreaterThan(0);
      expect(wording.disclaimer.length).toBeGreaterThan(20);
    }
    expect(STRATEGY_WORDING.starter.disclaimer).toContain('方向筛选');
    expect(STRATEGY_WORDING.research.disclaimer).toContain('未覆盖');
  });

  it('falls back to standard wording for unknown strategy strings', () => {
    expect(strategyWording('nonsense').label).toBe(STRATEGY_WORDING.standard.label);
  });
});

describe('countInputs', () => {
  it('counts papers recursively, datasets and comparison methods by unit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-strategy-'));
    await mkdir(join(dir, 'papers', 'nested'), { recursive: true });
    await writeFile(join(dir, 'papers', 'a.pdf'), 'a');
    await writeFile(join(dir, 'papers', 'nested', 'b.pdf'), 'b');
    await writeFile(join(dir, 'papers', 'nested', 'notes.txt'), 'n');

    await mkdir(join(dir, 'datasets', 'd1'), { recursive: true });
    await mkdir(join(dir, 'datasets', 'd2'), { recursive: true });
    await writeFile(join(dir, 'datasets', 'd1', 'train.csv'), 'x,y\n');
    await writeFile(join(dir, 'datasets', 'd2', 'test.csv'), 'x,y\n');

    await mkdir(join(dir, 'comparisons', 'method-a'), { recursive: true });
    await mkdir(join(dir, 'comparisons', 'method-b'), { recursive: true });
    await mkdir(join(dir, 'comparisons', '_candidates'), { recursive: true });
    await writeFile(join(dir, 'comparisons', 'method-a', 'code.py'), 'pass');

    const counts = await countInputs(dir, {
      papers: 'papers',
      datasets: 'datasets',
      comparisons: 'comparisons',
    });
    expect(counts).toEqual({ papers: 3, datasets: 2, comparisons: 2 });
  });

  it('returns zeros for missing directories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-strategy-'));
    const counts = await countInputs(dir, {
      papers: 'papers',
      datasets: 'datasets',
      comparisons: 'comparisons',
    });
    expect(counts).toEqual({ papers: 0, datasets: 0, comparisons: 0 });
    expect(resolveStrategy('auto', counts)).toBe('starter');
  });
});
