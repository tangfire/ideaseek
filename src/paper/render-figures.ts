import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { sha256OfFile } from '../core/hash.js';
import { redactSecrets } from '../core/redact.js';
import { runProcess } from '../core/proc.js';
import { pythonBinary } from '../knowledge/pdf.js';

/**
 * Phase 7 figure pipeline slice: EXECUTES the plotting scripts persisted
 * by `paper figure` inside figures/, through the shared subprocess adapter
 * (timeout + tree-kill), with MPLBACKEND=Agg so nothing opens a window.
 * Outputs are discovered by directory diff (any new non-script file under
 * figures/), hashed into the report for the source-manifest trail.
 *
 * Honest status: rendered (every figure produced outputs) | partial |
 * failed — a script that exits 0 without writing anything is a failure,
 * never a silent pass.
 */

export const FIGURE_RENDER_SCHEMA = 'figure-render-v1';

export interface RenderedOutput {
  path: string;
  bytes: number;
  sha256: string;
}

export interface FigureRenderResult {
  id: string;
  ok: boolean;
  outputs: RenderedOutput[];
  error: string | null;
  durationMs: number;
}

export interface FigureRenderReport {
  status: 'rendered' | 'partial' | 'failed';
  figures: FigureRenderResult[];
  python: string;
  skill: { name: string; sha256: string };
  planInputHash: string;
  renderedAt: number;
}

interface StoredFigurePlan {
  contract: string;
  inputHash: string;
  skill: { name: string; sha256: string };
  figures: {
    figures: { id: string; script: string }[];
  };
}

async function readFigurePlan(root: string): Promise<StoredFigurePlan> {
  let stored: StoredFigurePlan;
  try {
    stored = JSON.parse(
      await readFile(join(root, 'reports', 'paper', 'figures-plan.json'), 'utf8'),
    ) as StoredFigurePlan;
  } catch {
    throw new IdeaseekError(
      'USER_INPUT_REQUIRED',
      'no figure plan found — run: ideaseek paper figure (then paper render-figures)',
    );
  }
  if (stored.contract !== 'paper-figure-v1' || !stored.figures?.figures) {
    throw new IdeaseekError(
      'INVALID_ARTIFACT',
      'reports/paper/figures-plan.json is not a paper-figure-v1 artifact — rerun: ideaseek paper figure',
    );
  }
  return stored;
}

async function listFigureFiles(dir: string): Promise<Set<string>> {
  try {
    return new Set(await readdir(dir));
  } catch {
    return new Set();
  }
}

export interface RenderOptions {
  /** Per-figure execution bound (tree-killed on timeout). */
  timeoutMs?: number;
  now?: number;
}

export async function renderFigures(
  root: string,
  skillMeta: { name: string; sha256: string },
  opts: RenderOptions = {},
): Promise<{ report: FigureRenderReport; figuresDir: string }> {
  const plan = await readFigurePlan(root);
  const figuresDir = join(root, 'figures');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(figuresDir, { recursive: true });

  const python = await pythonBinary();
  const initial = await listFigureFiles(figuresDir);
  const seenOutputs = new Set<string>(initial);

  const results: FigureRenderResult[] = [];
  const specs = plan.figures.figures.slice(0, 50); // hard bound
  for (const spec of specs) {
    const scriptPath = join(figuresDir, `${spec.id}.py`);
    await writeFile(scriptPath, spec.script, 'utf8');
    const started = Date.now();
    const env = { ...process.env, MPLBACKEND: 'Agg' };
    let outcome: Awaited<ReturnType<typeof runProcess>>;
    try {
      outcome = await runProcess(python, [scriptPath], {
        cwd: figuresDir,
        timeoutMs: opts.timeoutMs ?? 120_000,
        env,
      });
    } catch (error) {
      results.push({
        id: spec.id,
        ok: false,
        outputs: [],
        error: `python could not be started: ${(error as Error).message}`,
        durationMs: Date.now() - started,
      });
      continue;
    }

    const current = await listFigureFiles(figuresDir);
    const outputs: RenderedOutput[] = [];
    for (const name of current) {
      if (seenOutputs.has(name) || name.endsWith('.py')) continue;
      seenOutputs.add(name);
      const abs = join(figuresDir, name);
      const info = await import('node:fs/promises').then((fs) => fs.stat(abs));
      outputs.push({
        path: `figures/${name}`,
        bytes: info.size,
        sha256: await sha256OfFile(abs),
      });
    }

    const durationMs = Date.now() - started;
    if (outcome.timedOut) {
      results.push({
        id: spec.id,
        ok: false,
        outputs,
        error: `timed out after ${opts.timeoutMs ?? 120_000} ms (process tree killed)`,
        durationMs,
      });
      continue;
    }
    if (outcome.code !== 0) {
      results.push({
        id: spec.id,
        ok: false,
        outputs,
        error: redactSecrets(
          `${outcome.stderr}\n${outcome.stdout}`.trim().slice(-2_000) || `exit ${outcome.code}`,
        ),
        durationMs,
      });
      continue;
    }
    if (outputs.length === 0) {
      results.push({
        id: spec.id,
        ok: false,
        outputs: [],
        error: 'script exited 0 but produced no new files under figures/',
        durationMs,
      });
      continue;
    }
    results.push({ id: spec.id, ok: true, outputs, error: null, durationMs });
  }

  const okCount = results.filter((result) => result.ok).length;
  const status: FigureRenderReport['status'] =
    results.length > 0 && okCount === results.length
      ? 'rendered'
      : okCount > 0
        ? 'partial'
        : 'failed';

  return {
    report: {
      status,
      figures: results,
      python,
      skill: skillMeta,
      planInputHash: plan.inputHash,
      renderedAt: opts.now ?? Date.now(),
    },
    figuresDir,
  };
}
