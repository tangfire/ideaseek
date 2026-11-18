import { readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256OfFile } from '../core/hash.js';
import { IdeaseekError } from '../core/errors.js';
import { redactSecrets } from '../core/redact.js';
import { runProcess } from '../core/proc.js';
import { pythonBinary } from '../knowledge/pdf.js';

/**
 * Overleaf-compatible export (Phase 7 line: Overleaf 兼容 LaTeX/BibTeX
 * 工程、图表、源数据、provenance 和复现包导出): assembles the compiled
 * paper (main.tex + references.bib + venue style files), the rendered
 * figures, the provenance chain (plan/figure/manuscript/compile/render
 * JSON) and a reproduction README into one directory, then zips it with
 * the Python stdlib zipfile (no new npm dependency) for Overleaf upload.
 *
 * Everything is copied read-only from platform outputs; the bundle
 * carries a sha256 manifest and contains no secrets (policy: never
 * export .env or key material).
 */

export const OVERLEAF_EXPORT_SCHEMA = 'overleaf-export-v1';

export interface OverleafFileEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface OverleafManifest {
  contract: typeof OVERLEAF_EXPORT_SCHEMA;
  createdAt: number;
  bundleDir: string;
  /**
   * Where the ZIP is created. `status` decides whether it exists: the path is
   * a target, and `overleaf-export-v1` requires the field to be a string, so
   * the state — not an empty string — carries the difference.
   */
  zipPath: string;
  /** Whether the bundle finished; `incomplete` must never be read as a submission-ready ZIP. */
  status: 'complete' | 'incomplete';
  /** Why the bundle is unfinished (the ZIP step's own failure text), else null. */
  reason: string | null;
  files: OverleafFileEntry[];
  provenance: string[];
  notes: string[];
}

/**
 * Recorded in the artifact, because the persisted file and the emitted one
 * differ in exactly one entry and a reader with both on screen is entitled to
 * know why rather than having to guess which is broken: a manifest cannot
 * carry the digest of the bytes it is written into, so `files` lists every
 * bundled file except `manifest.json`, and the returned (printed) copy appends
 * that entry with the digest of the persisted file.
 */
const SELF_ENTRY_NOTE =
  'files lists every bundled file except manifest.json (a file cannot carry its own digest); ' +
  'the copy printed by --json appends that entry, digesting the persisted file';

/** The ZIP step describes itself, so `reason` is never a guess. */
const PRE_ZIP_REASON =
  'the ZIP had not been created when this copy was written; the manifest.json inside the ZIP is ' +
  'this pre-zip copy, marked incomplete on purpose so a half-done bundle cannot be read as done';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function copyIfPresent(source: string, dest: string): Promise<boolean> {
  if (!(await exists(source))) return false;
  const { copyFile, mkdir } = await import('node:fs/promises');
  await mkdir(join(dest, '..'), { recursive: true });
  await copyFile(source, dest);
  return true;
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

/**
 * The entry for `manifest.json` itself, computed from the bytes as persisted.
 *
 * Only the returned (printed) manifest carries it: writing it into the file
 * would change the file it describes, so the persisted copy documents the rule
 * instead (`SELF_ENTRY_NOTE`). Both copies otherwise agree field for field,
 * which is what makes the emitted one safe to diff against the artifact.
 */
async function manifestEntry(manifestPath: string): Promise<OverleafFileEntry> {
  const info = await stat(manifestPath);
  return { path: 'manifest.json', bytes: info.size, sha256: await sha256OfFile(manifestPath) };
}

export interface OverleafExportOptions {
  /** Target directory (default: reports/paper/overleaf-<ts>). */
  to?: string;
  now?: number;
  /**
   * Extra provenance payloads written under provenance/ (filename →
   * JSON text) — e.g. experiment registry dumps (the source data behind
   * the figures) and protocol locks supplied by the command layer.
   */
  extraProvenance?: Record<string, string>;
}

export async function buildOverleafExport(
  root: string,
  opts: OverleafExportOptions = {},
): Promise<OverleafManifest> {
  const now = opts.now ?? Date.now();
  const paperDir = join(root, 'paper');
  const mainTex = join(paperDir, 'main.tex');
  const bib = join(paperDir, 'references.bib');
  if (!(await exists(mainTex)) || !(await exists(bib))) {
    throw new IdeaseekError(
      'USER_INPUT_REQUIRED',
      'no compiled paper project — run: ideaseek paper write && ideaseek paper compile',
    );
  }

  const bundleDir = opts.to ?? join(root, 'reports', 'paper', `overleaf-${now}`);
  const { mkdir, copyFile } = await import('node:fs/promises');
  await mkdir(bundleDir, { recursive: true });
  await mkdir(join(bundleDir, 'figures'), { recursive: true });
  await mkdir(join(bundleDir, 'provenance'), { recursive: true });

  // 1) LaTeX sources + venue style files.
  await copyFile(mainTex, join(bundleDir, 'main.tex'));
  await copyFile(bib, join(bundleDir, 'references.bib'));
  const provenance: string[] = [];
  for (const name of await listFiles(paperDir)) {
    if (/\.(cls|bst|sty)$/.test(name)) {
      await copyFile(join(paperDir, name), join(bundleDir, name));
    }
  }

  // 2) Rendered figures (vector + raster).
  let figureCount = 0;
  for (const name of await listFiles(join(root, 'figures'))) {
    if (/\.(pdf|png|svg)$/i.test(name)) {
      await copyFile(join(root, 'figures', name), join(bundleDir, 'figures', name));
      figureCount += 1;
    }
  }

  // 3a) Caller-supplied source data (experiment registry / protocol locks).
  const extraNames = Object.keys(opts.extraProvenance ?? {}).sort();
  for (const name of extraNames) {
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(join(bundleDir, 'provenance', name), opts.extraProvenance![name]!, 'utf8'),
    );
    provenance.push(`source data (${name})`);
  }

  // 3b) Provenance chain (plan → figure plan → manuscript → compile → render).
  //
  // results.json and diagram-render.json are listed because the deterministic
  // routes put their output INTO the document: a bundled paper whose table and
  // FigureSpec diagram have no shipped record is a claim the reviewer cannot
  // re-derive, which is precisely what this bundle exists to avoid.
  const provenanceSources = [
    ['plan.json', 'paper plan (claims/structure/figure plan)'],
    ['figures-plan.json', 'figure plan (ids/captions/statistics)'],
    ['results.json', 'recorded runs the results table cites, with input hash'],
    ['manuscript.json', 'manuscript content contract'],
    ['compile-report.json', 'compile status + skill hash'],
    ['figure-render.json', 'figure outputs + sha256 + review status'],
    ['diagram-render.json', 'deterministic FigureSpec renders (spec/renderer/output hashes)'],
  ] as const;
  for (const [name, label] of provenanceSources) {
    const copied = await copyIfPresent(
      join(root, 'reports', 'paper', name),
      join(bundleDir, 'provenance', name),
    );
    if (copied) provenance.push(`${label} (provenance/${name})`);
  }

  // 4) Reproduction README (no secrets; commands are user-run).
  const readme = [
    '# IdeaSeek Overleaf bundle',
    '',
    'Contents:',
    '- main.tex + references.bib — assembled from ideaseek paper write (venue template preamble).',
    `- figures/ — ${figureCount} rendered figure(s), sha256 in provenance/figure-render.json.`,
    `- provenance/ — ${provenance.length} contract record(s) binding claims, sources and hashes.`,
    '',
    'To build locally:  latexmk -pdf -interaction=nonstopmode main.tex',
    'To submit:        upload this ZIP to Overleaf (or extract and sync).',
    '',
    'Full-scale experiments are NOT run by IdeaSeek — see the idea handoff',
    'package (ideaseek idea handoff <id>) for commands.txt / environment.lock.',
    '',
    'No secrets are included (policy: .env and key material never leave the project).',
    '',
  ].join('\n');
  await import('node:fs/promises').then((fs) =>
    fs.writeFile(join(bundleDir, 'README.md'), readme, 'utf8'),
  );

  // 5) Manifest with sha256 per file. `manifest.json` is skipped by the walk:
  //    its own bytes cannot be digested inside itself, and a rerun into an
  //    existing bundle directory would otherwise list the previous run's copy.
  const files: OverleafFileEntry[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const name of (await listFiles(join(bundleDir, rel))).sort()) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (childRel === 'manifest.json') continue;
      const full = join(bundleDir, ...childRel.split('/'));
      const info = await stat(full);
      if (info.isDirectory()) await walk(childRel);
      else {
        files.push({
          path: childRel,
          bytes: info.size,
          sha256: await sha256OfFile(full),
        });
      }
    }
  };
  await walk('');
  const manifestPath = join(bundleDir, 'manifest.json');
  const zipPath = `${bundleDir}.zip`;
  const notes = [
    'no secrets; originals read-only; full-scale runs are user-executed (handoff package)',
    SELF_ENTRY_NOTE,
  ];

  const writeManifest = async (
    status: OverleafManifest['status'],
    reason: string | null,
  ): Promise<OverleafManifest> => {
    const manifest: OverleafManifest = {
      contract: OVERLEAF_EXPORT_SCHEMA,
      createdAt: now,
      bundleDir,
      zipPath,
      status,
      reason,
      files,
      provenance,
      notes,
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return manifest;
  };
  // The persisted state is written before the ZIP is attempted, so every
  // outcome — including a process killed mid-bundle — leaves a manifest whose
  // `status` is behind the claim it makes. `zipPath` used to be advertised up
  // front and the ZIP created afterwards: when that step threw
  // (ENV_UNSUPPORTED: no python, zipfile failure) the file on disk kept
  // promising a bundle that did not exist, and nothing marked the bundle
  // half-done.
  await writeManifest('incomplete', PRE_ZIP_REASON);

  // 6) Zip via the Python stdlib (no new npm dependency).
  try {
    const python = await pythonBinary();
    await rm(zipPath, { force: true });
    const topLevel = (await listFiles(bundleDir)).filter((name) => name !== 'manifest.json');
    const result = await runProcess(
      python,
      ['-m', 'zipfile', '-c', zipPath, ...topLevel, 'manifest.json'],
      { cwd: bundleDir, timeoutMs: 120_000, env: { ...process.env, PYTHONUTF8: '1' } },
    );
    if (result.timedOut || result.code !== 0) {
      throw new IdeaseekError(
        'ENV_UNSUPPORTED',
        `could not create the Overleaf ZIP: ${redactSecrets(
          (result.stderr || result.stdout || 'zipfile failed').slice(0, 300),
        )}`,
      );
    }
    // A zero exit is not the fact: mark the bundle complete only once the ZIP is
    // readable where it was promised.
    const zipInfo = await stat(zipPath).catch(() => null);
    if (!zipInfo?.isFile() || zipInfo.size === 0) {
      throw new IdeaseekError(
        'ENV_UNSUPPORTED',
        `zipfile exited 0 but ${zipPath} is not a readable non-empty file`,
      );
    }
  } catch (error) {
    const why = redactSecrets((error as Error).message).slice(0, 400);
    await writeManifest('incomplete', why);
    if (error instanceof IdeaseekError) throw error;
    // A filesystem failure at the ZIP path (`rm` refusing a directory, an
    // unwritable target) is still "the bundle could not be finished": it gets
    // the same coded error as a missing python, and the manifest on disk has
    // already been marked incomplete before this throws.
    throw new IdeaseekError(
      'ENV_UNSUPPORTED',
      `could not create the Overleaf ZIP at ${zipPath}: ${why} — ` +
        `${manifestPath} is written and marked incomplete; the bundle directory itself is complete`,
      { bundleDir, zipPath },
    );
  }

  const final = await writeManifest('complete', null);
  return { ...final, files: [...files, await manifestEntry(manifestPath)] };
}
