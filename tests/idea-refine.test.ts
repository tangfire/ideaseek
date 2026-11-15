import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DIAGNOSIS_INSTRUCTION, DIAGNOSIS_SCHEMA } from '../src/idea/diagnose.js';
import { clearGeneratedIdeaFiles, GENERATED_MANIFEST } from '../src/idea/implement-clean.js';

describe('failure diagnosis contract', () => {
  it('requires quoted evidence and the ARIS layer vocabulary', () => {
    // The point of replacing the keyword table: the agent has to show which
    // lines its verdict rests on, and it reasons about layers rather than
    // matching a list of strings the platform happened to think of.
    expect(DIAGNOSIS_INSTRUCTION).toContain('evidence" must quote lines');
    expect(DIAGNOSIS_INSTRUCTION).toContain('compute-env-contract');
    expect(DIAGNOSIS_INSTRUCTION).toContain('version conflict');
    expect(DIAGNOSIS_INSTRUCTION).toContain('more attempts at code will not fix a bad plan');
    expect(DIAGNOSIS_SCHEMA).toBe('failure-diagnosis-v1');
  });

  it('is registered so the verdict is validated, not merely requested', async () => {
    const { listSchemaNames, assertAgainstSchema } = await import('../src/core/schema/index.js');
    expect(listSchemaNames()).toContain(DIAGNOSIS_SCHEMA);
    const good = {
      layer: 'spec',
      environmentBlocked: false,
      worthRetrying: true,
      reasoning:
        'The spec pins numpy<2 while a later package requires numpy 2, so the install order is wrong.',
      evidence: ['numpy.core.multiarray failed to import'],
      recommendedAction: 'add a snap-back install phase after the conflicting package',
      confidence: 0.7,
    };
    expect(() => assertAgainstSchema(DIAGNOSIS_SCHEMA, good)).not.toThrow();
    // An unevidenced verdict must not load: without this the field is optional
    // in practice and the diagnosis degrades back into a guess.
    expect(() => assertAgainstSchema(DIAGNOSIS_SCHEMA, { ...good, evidence: [] })).toThrow();
    expect(() => assertAgainstSchema(DIAGNOSIS_SCHEMA, { ...good, layer: 'dependency' })).toThrow();
  });
});

describe('clearGeneratedIdeaFiles (only the generator owns files)', () => {
  it('removes listed files and nothing else', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'idea-clean-'));
    await mkdir(join(dir, 'src'), { recursive: true });
    for (const name of ['smoke.py', 'geometry.py', 'human.py']) {
      await writeFile(join(dir, 'src', name), '# code\n', 'utf8');
    }
    await writeFile(
      join(dir, GENERATED_MANIFEST),
      JSON.stringify({ schemaVersion: 1, files: ['src/smoke.py', 'src/geometry.py'] }),
      'utf8',
    );
    const removed = await clearGeneratedIdeaFiles(dir);
    expect(removed.sort()).toEqual(['src/geometry.py', 'src/smoke.py']);
    expect(await readFile(join(dir, 'src', 'human.py'), 'utf8')).toBe('# code\n');
    expect(await readFile(join(dir, GENERATED_MANIFEST), 'utf8').catch(() => null)).toBeNull();
  });

  it('refuses to act on a manifest that names anything outside src/', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'idea-clean-evil-'));
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'research.yaml'), 'project:\n  name: keep\n', 'utf8');
    await writeFile(
      join(dir, GENERATED_MANIFEST),
      JSON.stringify({ files: ['../research.yaml', '/etc/passwd', 'src/ok.py'] }),
      'utf8',
    );
    await writeFile(join(dir, 'src', 'ok.py'), 'x = 1\n', 'utf8');
    const removed = await clearGeneratedIdeaFiles(dir);
    expect(removed).toEqual(['src/ok.py']);
    expect(await readFile(join(dir, 'research.yaml'), 'utf8')).toContain('keep');
  });

  it('is a no-op without a manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'idea-clean-none-'));
    expect(await clearGeneratedIdeaFiles(dir)).toEqual([]);
  });
});

it('clamps long prose instead of discarding a usable verdict', async () => {
  // Observed on the first real diagnosis run: a 950-character explanation made
  // the whole `idea implement` fail on schema validation. Structure is what the
  // contract must enforce; length should degrade, not abort.
  const { readFile } = await import('node:fs/promises');
  const schema = JSON.parse(
    await readFile(
      new URL('../src/core/schema/schemas/failure-diagnosis-v1.json', import.meta.url),
      'utf8',
    ),
  ) as { properties: Record<string, { maxLength?: number; maxItems?: number }> };
  expect(schema.properties.reasoning?.maxLength).toBe(900);
  expect(schema.properties.evidence?.maxItems).toBe(6);
  const { assertAgainstSchema } = await import('../src/core/schema/index.js');
  const long = 'x'.repeat(950);
  const clamped = long.slice(0, 900);
  expect(() =>
    assertAgainstSchema('failure-diagnosis-v1', {
      layer: 'code',
      environmentBlocked: false,
      worthRetrying: true,
      reasoning: clamped,
      evidence: ['ValueError: matmul: Input operand 1 has a mismatch'],
      recommendedAction: 'fix the basis projection shape',
      confidence: 0.8,
    }),
  ).not.toThrow();
});
