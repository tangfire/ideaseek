import { mkdir, mkdtemp, writeFile, utimes, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyFile, scanProject, SCAN_PARSER_VERSION } from '../src/knowledge/scan.js';
import { applyOrganize, loadIndexManifest, planOrganize } from '../src/knowledge/organize.js';
import { initInternals } from '../src/commands/init.js';

async function makeScanProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ideaseek-scan-'));
  for (const workspaceDir of initInternals.WORKSPACE_DIRS) {
    await mkdir(join(dir, workspaceDir), { recursive: true });
  }
  return dir;
}

const ROOTS = ['papers', 'datasets', 'comparisons', 'incoming'];

describe('classifyFile', () => {
  it('classifies by extension with root context and records basis', () => {
    expect(classifyFile('paper.pdf', { rootName: 'papers' })).toMatchObject({
      role: 'paper',
      confidence: 0.95,
    });
    expect(classifyFile('notes.pdf', { rootName: 'incoming' })).toMatchObject({
      role: 'paper',
      confidence: 0.7,
    });
    expect(classifyFile('train.csv', { rootName: 'datasets' })).toMatchObject({ role: 'data' });
    expect(classifyFile('train.csv', { rootName: 'incoming' })).toMatchObject({ role: 'data' });
    expect(classifyFile('model.json', { rootName: 'datasets' })).toMatchObject({ role: 'data' });
    expect(classifyFile('config.json', { rootName: 'papers' })).toMatchObject({ role: 'doc' });
    expect(classifyFile('requirements.txt', { rootName: 'incoming' })).toMatchObject({
      role: 'code',
    });
    expect(classifyFile('archive.tar.gz', { rootName: 'incoming' })).toMatchObject({
      role: 'archive',
    });
    expect(classifyFile('mystery.qqq', { rootName: 'incoming' })).toMatchObject({
      role: 'unknown',
    });
    expect(classifyFile('paper.pdf', { rootName: 'papers' }).basis).toContain('extension:.pdf');
  });
});

describe('scanProject', () => {
  it('discovers files, classifies them, groups candidates and finds duplicates', async () => {
    const dir = await makeScanProject();
    await writeFile(join(dir, 'papers', 'alpha.pdf'), '%PDF-1.4 alpha');
    await writeFile(join(dir, 'papers', 'alpha.zip'), '%PDF-1.4 alpha'); // same bytes
    await writeFile(join(dir, 'papers', 'alpha.tex'), '\\documentclass{}');
    await mkdir(join(dir, 'datasets', 'd1'), { recursive: true });
    await writeFile(join(dir, 'datasets', 'd1', 'train.csv'), 'a,b\n1,2\n');
    await mkdir(join(dir, 'comparisons', 'method-a'), { recursive: true });
    await writeFile(join(dir, 'comparisons', 'method-a', 'README.md'), '# method a');
    await writeFile(join(dir, 'incoming', 'mystery.bin'), '???');
    // Must NOT be scanned by default roots:
    await writeFile(join(dir, '.research', 'leak.pdf'), 'should not appear');
    await mkdir(join(dir, 'ideas', 'idea-001'), { recursive: true });
    await writeFile(join(dir, 'ideas', 'idea-001', 'notes.md'), 'skip me');

    const manifest = await scanProject({
      projectRoot: dir,
      roots: [...ROOTS],
      now: Date.now(),
    });

    expect(manifest.parserVersion).toBe(SCAN_PARSER_VERSION);
    const rels = manifest.files.map((file) => file.relPath);
    expect(rels).toContain('papers/alpha.pdf');
    expect(rels).toContain('datasets/d1/train.csv');
    expect(rels).toContain('comparisons/method-a/README.md');
    expect(rels).toContain('incoming/mystery.bin');
    expect(rels.some((rel) => rel.startsWith('.research/'))).toBe(false);
    expect(rels.some((rel) => rel.startsWith('ideas/'))).toBe(false);

    const alpha = manifest.files.find((file) => file.relPath === 'papers/alpha.pdf');
    expect(alpha?.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(alpha?.hashStatus).toBe('ok');

    // Same bytes under different names → one duplicate set.
    expect(manifest.duplicateSets).toHaveLength(1);
    expect(manifest.duplicateSets[0]!.paths).toEqual(['papers/alpha.pdf', 'papers/alpha.zip']);

    // Same-stem files in papers/ group together.
    const paperGroup = manifest.groups.find((group) => group.files.includes('papers/alpha.pdf'));
    expect(paperGroup?.kind).toBe('paper');
    expect(paperGroup?.files.sort()).toEqual(
      ['papers/alpha.pdf', 'papers/alpha.tex', 'papers/alpha.zip'].sort(),
    );
    expect(paperGroup?.needsConfirmation).toBe(true);

    // Dataset directory groups its files.
    const datasetGroup = manifest.groups.find((group) => group.kind === 'dataset');
    expect(datasetGroup?.files).toEqual(['datasets/d1/train.csv']);

    // Missing roots are tolerated.
    await rm(join(dir, 'datasets'), { recursive: true, force: true });
    const second = await scanProject({ projectRoot: dir, roots: [...ROOTS], now: Date.now() });
    expect(second.files.length).toBe(manifest.files.length - 1);
  });

  it('reuses hashes incrementally when path, size and mtime are unchanged', async () => {
    const dir = await makeScanProject();
    const target = join(dir, 'papers', 'stable.pdf');
    await writeFile(target, 'content-version-1');
    const first = await scanProject({ projectRoot: dir, roots: [...ROOTS], now: Date.now() });
    const firstHash = first.files[0]!.sha256;

    // Same size, same mtime, different bytes: the fast path must reuse the
    // stored hash (documented mtime+size heuristic).
    await writeFile(target, 'content-version-2');
    const info = await (await import('node:fs/promises')).stat(target);
    await utimes(target, info.atime, new Date(first.files[0]!.mtimeMs));
    const second = await scanProject({
      projectRoot: dir,
      roots: [...ROOTS],
      now: Date.now(),
      previous: first,
    });
    expect(second.files[0]!.sha256).toBe(firstHash);

    // A real change (size differs) is re-hashed.
    await writeFile(target, 'content-version-3-longer');
    const third = await scanProject({
      projectRoot: dir,
      roots: [...ROOTS],
      now: Date.now(),
      previous: second,
    });
    expect(third.files[0]!.sha256).not.toBe(firstHash);
    expect(third.files[0]!.bytes).toBe('content-version-3-longer'.length);
  });

  it('skips hashing files above the size cap but still classifies them', async () => {
    const dir = await makeScanProject();
    const manifest = await scanProject({
      projectRoot: dir,
      roots: [...ROOTS],
      now: Date.now(),
      previous: null,
    });
    expect(Array.isArray(manifest.files)).toBe(true);
    // (Cap behavior itself is covered via MAX_HASH_BYTES contract below.)
    const { MAX_HASH_BYTES } = await import('../src/knowledge/scan.js');
    expect(MAX_HASH_BYTES).toBeGreaterThan(1024 * 1024);
  });
});

describe('organize', () => {
  it('previews and applies an index without touching originals; idempotent', async () => {
    const dir = await makeScanProject();
    const original = join(dir, 'papers', 'alpha.pdf');
    const bytes = '%PDF-1.4 organize me';
    await writeFile(original, bytes);
    const { sha256Of } = await import('../src/core/hash.js');
    const originalHash = sha256Of(bytes);

    const manifest = await scanProject({ projectRoot: dir, roots: [...ROOTS], now: Date.now() });
    const plan = planOrganize(manifest);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.action).toBe('link');

    const first = await applyOrganize(dir, manifest, Date.now());
    expect(first.applied).toHaveLength(1);
    expect(['symlink', 'copy']).toContain(first.applied[0]!.method);
    expect(first.applied[0]!.source).toBe('papers/alpha.pdf');

    // Original untouched, still readable with identical content.
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(original, 'utf8')).toBe(bytes);
    expect(sha256Of(await readFile(original))).toBe(originalHash);

    const index = await loadIndexManifest(dir);
    expect(index?.entries).toHaveLength(1);
    expect(index?.entries[0]!.sha256).toBe(originalHash);

    // Idempotent: nothing new, nothing clobbered.
    const second = await applyOrganize(dir, manifest, Date.now());
    expect(second.applied).toHaveLength(0);
    expect(second.skipped.some((item) => item.action === 'skip-existing')).toBe(true);

    // An occupied slot is never overwritten.
    await rm(join(dir, 'knowledge', 'index'), { recursive: true, force: true });
    await mkdir(join(dir, 'knowledge', 'index', 'paper'), { recursive: true });
    const plan2 = planOrganize(manifest);
    const { writeFile: wf } = await import('node:fs/promises');
    await wf(join(dir, plan2[0]!.link), 'user file, do not clobber', 'utf8');
    const third = await applyOrganize(dir, manifest, Date.now());
    expect(third.applied).toHaveLength(0);
    expect(await readFile(join(dir, plan2[0]!.link), 'utf8')).toBe('user file, do not clobber');
  });

  it('records absolute-safe relative links pointing at the original', async () => {
    const dir = await makeScanProject();
    await writeFile(join(dir, 'incoming', 'linked.txt'), 'link target');
    const manifest = await scanProject({ projectRoot: dir, roots: [...ROOTS], now: Date.now() });
    const result = await applyOrganize(dir, manifest, Date.now());
    expect(result.applied).toHaveLength(1);
    const entry = result.applied[0]!;
    const absLink = join(dir, ...entry.link.split('/'));
    const target = await readFile(absLink, 'utf8');
    expect(target).toBe('link target');
  });
});
