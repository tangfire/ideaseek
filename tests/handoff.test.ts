import { describe, expect, it } from 'vitest';
import { buildHandoff, validateHandoff } from '../src/experiment/handoff.js';
import { buildDefaultPortfolio } from '../src/experiment/scenarios.js';
import type { DatasetSlice } from '../src/experiment/slices.js';

const HASH_A: `sha256:${string}` = `sha256:${'a'.repeat(64)}`;
const HASH_B: `sha256:${string}` = `sha256:${'b'.repeat(64)}`;

function slice(overrides: Partial<DatasetSlice> = {}): DatasetSlice {
  return {
    sliceId: 'ds-x-quick-r1',
    datasetSnapshotId: 'data-x',
    scale: 'quick',
    rule: 'seeded shuffle take 10/100',
    ruleVersion: 1,
    inputHash: HASH_A,
    outputHash: HASH_B,
    stats: { totalRows: 100, selectedRows: 10 },
    seed: 7,
    boundaries: ['row-level selection (rule v1)'],
    generatedBy: 'test',
    generatedAt: 1,
    limits: [],
    ...overrides,
  };
}

const baseOptions = {
  subjectId: 'idea-001',
  portfolio: buildDefaultPortfolio({
    ideaId: 'idea-001',
    maxRounds: 3,
    hasExternalData: false,
    generatedAt: 1,
    generatedBy: 'test',
  }),
  slices: [slice()],
  requirements: ['python>=3.10', 'torch==2.4.0'],
  commands: ['python train.py --config quick.yaml', 'python eval.py --config quick.yaml'],
  inputHashes: [HASH_A],
  protocolHash: `sha256:${'c'.repeat(64)}`,
  codeCommit: 'deadbeef'.repeat(5),
  generatedAt: 1,
  generatedBy: 'unit',
};

describe('buildHandoff + validateHandoff', () => {
  it('produces a valid manifest with explicit non-execution boundaries', () => {
    const handoff = buildHandoff(baseOptions);
    const result = validateHandoff(handoff);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(handoff.portfolioId).toBe('pf-idea-001-v1');
    expect(handoff.slices[0]!.outputHash).toBe(HASH_B);
    expect(handoff.environment.commands).toHaveLength(2);
    expect(handoff.boundaries.join(' ')).toContain('did not run full-scale training');
    expect(handoff.boundaries.join(' ')).toContain('never modified');
    expect(handoff.provenance.protocolHash).toBe(`sha256:${'c'.repeat(64)}`);
  });

  it('allows null portfolio for baseline handoffs', () => {
    const handoff = buildHandoff({ ...baseOptions, portfolio: null });
    expect(handoff.portfolioId).toBeNull();
    expect(validateHandoff(handoff).ok).toBe(true);
  });

  it('rejects missing slices, bad hashes and empty boundaries', () => {
    const noSlices = buildHandoff({ ...baseOptions, slices: [] });
    expect(validateHandoff(noSlices).errors.join(' ')).toContain('at least one dataset slice');

    const badSlice = buildHandoff(baseOptions);
    (badSlice.slices[0] as { outputHash: string }).outputHash = 'md5:x';
    expect(validateHandoff(badSlice).errors.join(' ')).toContain('sha256');

    const noCommands = buildHandoff({ ...baseOptions, commands: [] });
    expect(validateHandoff(noCommands).errors.join(' ')).toContain('environment.commands');

    const noBoundaries = buildHandoff(baseOptions);
    (noBoundaries as { boundaries: string[] }).boundaries = [];
    expect(validateHandoff(noBoundaries).errors.join(' ')).toContain('boundaries');

    const badHashes = buildHandoff({ ...baseOptions, inputHashes: ['not-a-hash'] });
    expect(validateHandoff(badHashes).errors.join(' ')).toContain('provenance.inputHashes[0]');
  });

  it('rejects non-objects', () => {
    expect(validateHandoff(null).ok).toBe(false);
    expect(validateHandoff([]).ok).toBe(false);
    expect(validateHandoff('handoff').ok).toBe(false);
  });
});
