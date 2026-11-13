import { readdir, stat } from 'node:fs/promises';
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
  zipPath: string;
  files: OverleafFileEntry[];
  provenance: string[];
  notes: string[];
}

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
  const provenanceSources = [
    ['plan.json', 'paper plan (claims/structure/figure plan)'],
    ['figures-plan.json', 'figure plan (ids/captions/statistics)'],
    ['manuscript.json', 'manuscript content contract'],
    ['compile-report.json', 'compile status + skill hash'],
    ['figure-render.json', 'figure outputs + sha256 + review status'],
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

  // 5) Manifest with sha256 per file (excluding the manifest itself).
  const files: OverleafFileEntry[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const name of (await listFiles(join(bundleDir, rel))).sort()) {
      const childRel = rel ? `${rel}/${name}` : name;
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
  const manifest: OverleafManifest = {
    contract: OVERLEAF_EXPORT_SCHEMA,
    createdAt: now,
    bundleDir,
    zipPath: `${bundleDir}.zip`,
    files,
    provenance,
    notes: ['no secrets; originals read-only; full-scale runs are user-executed (handoff package)'],
  };
  await import('node:fs/promises').then((fs) =>
    fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
  );
  files.push({
    path: 'manifest.json',
    bytes: (await stat(manifestPath)).size,
    sha256: await sha256OfFile(manifestPath),
  });

  // 6) Zip via the Python stdlib (no new npm dependency).
  const python = await pythonBinary();
  const zipPath = `${bundleDir}.zip`;
  await import('node:fs/promises').then((fs) => fs.rm(zipPath, { force: true }));
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
  return manifest;
}
