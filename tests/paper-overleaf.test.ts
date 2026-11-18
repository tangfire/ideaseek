import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildOverleafExport, OVERLEAF_EXPORT_SCHEMA } from '../src/paper/overleaf.js';
import { sha256OfFile } from '../src/core/hash.js';

/**
 * The Overleaf bundle is what leaves the project, so its manifest is the
 * receipt: it must not advertise a ZIP that was never created, and the file on
 * disk must not disagree with what `--json` reported about that same file.
 *
 * Both properties are ordering properties, and the tests therefore drive the
 * real bundle directory and the real zipfile subprocess rather than a stub —
 * a mocked "zip failed" would not prove the persisted state is honest.
 */
async function projectWithPaper(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'overleaf-'));
  await mkdir(join(dir, 'paper'), { recursive: true });
  await writeFile(
    join(dir, 'paper', 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n',
    'utf8',
  );
  await writeFile(join(dir, 'paper', 'references.bib'), '@article{x2026, title={X}}\n', 'utf8');
  await mkdir(join(dir, 'figures'), { recursive: true });
  await writeFile(join(dir, 'figures', 'fig-1.pdf'), '%PDF-1.4\n', 'utf8');
  await mkdir(join(dir, 'reports', 'paper'), { recursive: true });
  await writeFile(
    join(dir, 'reports', 'paper', 'compile-report.json'),
    JSON.stringify({ contract: 'paper-compile-v1', status: 'compiled' }),
    'utf8',
  );
  return dir;
}

describe('overleaf-export-v1 manifest', () => {
  it('marks the bundle complete only once the ZIP is really there', async () => {
    const dir = await projectWithPaper();
    const bundleDir = join(dir, 'reports', 'paper', 'overleaf-test');
    const emitted = await buildOverleafExport(dir, { to: bundleDir, now: 1_760_000_000_000 });
    expect(emitted.contract).toBe(OVERLEAF_EXPORT_SCHEMA);
    expect(emitted.status).toBe('complete');
    expect(emitted.reason).toBeNull();

    const zip = await stat(emitted.zipPath).catch(() => null);
    expect(zip?.isFile()).toBe(true);
    expect(zip?.size ?? 0).toBeGreaterThan(0);

    const persisted = JSON.parse(
      await readFile(join(bundleDir, 'manifest.json'), 'utf8'),
    ) as typeof emitted;
    expect(persisted.status).toBe('complete');
    expect(persisted.zipPath).toBe(emitted.zipPath);
    expect(persisted.provenance).toEqual(emitted.provenance);

    // The persisted `files` cannot carry its own digest, so the emitted copy
    // adds exactly that one entry — and the file itself says so, instead of
    // leaving two artifacts that disagree with no record of why.
    const persistedPaths = persisted.files.map((file) => file.path);
    expect(persistedPaths).not.toContain('manifest.json');
    const self = emitted.files.filter((file) => file.path === 'manifest.json');
    expect(self).toHaveLength(1);
    const bytes = await readFile(join(bundleDir, 'manifest.json'));
    expect(self[0]!.bytes).toBe(bytes.length);
    expect(self[0]!.sha256).toBe(await sha256OfFile(join(bundleDir, 'manifest.json')));
    expect(
      persisted.files.every((entry) =>
        emitted.files.some(
          (file) =>
            file.path === entry.path && file.sha256 === entry.sha256 && file.bytes === entry.bytes,
        ),
      ),
    ).toBe(true);
    expect(emitted.notes.join(' ')).toContain('cannot carry its own digest');
  }, 180_000);

  it('leaves the manifest saying the bundle is unfinished when the ZIP cannot be made', async () => {
    const dir = await projectWithPaper();
    const bundleDir = join(dir, 'reports', 'paper', 'overleaf-blocked');
    // A real, reproducible failure of the ZIP step: the promised bundle path is
    // occupied by a directory, so nothing can be written there.
    await mkdir(`${bundleDir}.zip`, { recursive: true });

    await expect(
      buildOverleafExport(dir, { to: bundleDir, now: 1_760_000_000_000 }),
    ).rejects.toMatchObject({
      code: 'ENV_UNSUPPORTED',
    });

    const persisted = JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8')) as {
      status: string;
      reason: string | null;
      files: { path: string }[];
      notes: string[];
    };
    expect(persisted.status).toBe('incomplete');
    expect(persisted.reason).toBeTruthy();
    // Not a claim of a finished bundle: no manifest entry pretends the ZIP is
    // part of the deliverable, and the state field is what a reader checks.
    expect(persisted.files.map((file) => file.path)).not.toContain('manifest.json');
    expect(persisted.notes.join(' ')).toContain('cannot carry its own digest');
    const zipStat = await stat(`${bundleDir}.zip`);
    expect(zipStat.isDirectory()).toBe(true);
  }, 180_000);

  it('bundles the figures and the provenance chain it claims to', async () => {
    const dir = await projectWithPaper();
    // The deterministic routes write INTO the document, so their records have
    // to leave with the bundle: a reviewer who cannot re-derive the results
    // table or the FigureSpec diagram has nothing to check.
    await writeFile(
      join(dir, 'reports', 'paper', 'results.json'),
      JSON.stringify({ schemaVersion: 1, rows: [], identicalValueGroups: [] }),
      'utf8',
    );
    await writeFile(
      join(dir, 'reports', 'paper', 'diagram-render.json'),
      JSON.stringify({ contract: 'diagram-render-v1', renders: [] }),
      'utf8',
    );
    const bundleDir = join(dir, 'reports', 'paper', 'overleaf-content');
    const emitted = await buildOverleafExport(dir, { to: bundleDir, now: 1_760_000_000_000 });
    const paths = emitted.files.map((file) => file.path);
    expect(paths).toEqual(
      expect.arrayContaining(['main.tex', 'references.bib', 'README.md', 'figures/fig-1.pdf']),
    );
    expect(paths).toContain('provenance/compile-report.json');
    expect(emitted.provenance.join(' ')).toContain('provenance/compile-report.json');
    expect(paths).toContain('provenance/results.json');
    expect(paths).toContain('provenance/diagram-render.json');
    const listed = emitted.provenance.join(' ');
    expect(listed).toContain('recorded runs the results table cites');
    expect(listed).toContain('deterministic FigureSpec renders');
    // The bundled bytes must be the project's, not a re-serialized copy.
    expect(emitted.files.find((file) => file.path === 'provenance/results.json')!.sha256).toBe(
      await sha256OfFile(join(dir, 'reports', 'paper', 'results.json')),
    );
  }, 180_000);
});
