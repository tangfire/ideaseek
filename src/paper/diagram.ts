import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { runProcess } from '../core/proc.js';
import { arisSkillsRoot } from '../aris/skill.js';

/**
 * Deterministic diagram rendering through the vendored ARIS FigureSpec tool.
 *
 * Why this exists next to `paper figure`: the model-authored matplotlib route
 * answers "plot these numbers", which is the right tool for a data figure and
 * the wrong tool for an architecture or pipeline diagram, where the honest
 * requirement is "these boxes, these arrows, reproducible byte for byte, no
 * random seed and no plotting library". Upstream ARIS ships a stdlib-only
 * JSON→SVG renderer for exactly that; IdeaSeek had no SVG path at all, so
 * diagram figures went through the matplotlib route and came out as whatever
 * the model drew that day. Vendoring it also takes the diagram route off a
 * dependency that is currently broken on this machine outright: the ambient
 * matplotlib cannot import against numpy 2.
 *
 * The subprocess contract is the part worth reading. Upstream prints a success
 * line beginning with an emoji, and on a Windows console whose default code
 * page cannot encode it the renderer writes the SVG and THEN dies with
 * UnicodeEncodeError — a completed render reported as a failed run, observed
 * directly here. So the child's text encoding is pinned, and the artefact is
 * checked on disk rather than trusting the exit code alone, because an exit
 * code that lies in one direction is answered by an exit code that lies in the
 * other.
 */

const RENDERER = join('skills', 'figure-spec', 'scripts', 'figure_renderer.py');

export interface DiagramRender {
  path: string;
  bytes: number;
  sha256: string;
  /** The renderer's own validation verdict, kept for the report. */
  validated: boolean;
  /**
   * Which vendored renderer produced the SVG and its digest. The determinism
   * claim is "same spec + same renderer → same bytes", so a record without the
   * renderer hash cannot be re-checked after a vendor update — it would look
   * like the platform lost the plot, when the plot's author changed.
   */
  rendererPath: string;
  rendererSha256: string;
  specSha256: string;
}

function pythonBinary(): string {
  const configured = process.env.IDEASEEK_PYTHON?.trim();
  return configured && configured.length > 0 ? configured : 'python';
}

/**
 * The child environment for the renderer.
 *
 * `runProcess` hands `env` straight to `spawn`, which REPLACES the environment:
 * passing only PYTHONIOENCODING would drop PATH and the child would not find
 * Python at all, producing a failure that looks like a broken renderer. Merge
 * from process.env and say so, because this exact mistake has already cost this
 * project a debugging session elsewhere.
 */
function rendererEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PYTHONIOENCODING: 'utf-8' };
}

async function rendererPath(): Promise<string> {
  const abs = join(arisSkillsRoot(), RENDERER);
  try {
    await stat(abs);
  } catch {
    throw new IdeaseekError(
      'SKILL_NOT_FOUND',
      `the vendored FigureSpec renderer is missing at ${abs} — restore aris-skills/ with: ` +
        'node scripts/aris-vendor.mjs --upstream <ARIS checkout> --skill figure-spec --apply',
    );
  }
  return abs;
}

async function runRenderer(
  script: string,
  argv: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number; out: string; timedOut: boolean }> {
  const run = await runProcess(pythonBinary(), [script, ...argv], {
    cwd,
    env: rendererEnv(),
    timeoutMs,
  });
  return { exitCode: run.code ?? -1, out: run.stdout + run.stderr, timedOut: run.timedOut };
}

/**
 * Validate a spec with the renderer's own subcommand, so the platform never
 * keeps a second copy of the schema's rules. A duplicated validator is how a
 * spec starts passing here and failing there.
 */
async function validateSpec(script: string, specPath: string, cwd: string): Promise<void> {
  const run = await runRenderer(script, ['validate', specPath], cwd, 30_000);
  if (run.timedOut || run.exitCode !== 0) {
    throw new IdeaseekError(
      'INVALID_ARTIFACT',
      `FigureSpec validation failed for ${specPath}` +
        `${run.timedOut ? ' (timed out)' : ''}: ${run.out.slice(-400)}`,
    );
  }
}

export async function renderDiagram(opts: {
  specPath: string;
  outputPath: string;
  cwd?: string;
  timeoutMs?: number;
}): Promise<DiagramRender> {
  const script = await rendererPath();
  const cwd = opts.cwd ?? process.cwd();
  await validateSpec(script, opts.specPath, cwd);
  const run = await runRenderer(
    script,
    ['render', opts.specPath, '--output', opts.outputPath],
    cwd,
    opts.timeoutMs ?? 60_000,
  );

  let size: number;
  try {
    size = (await stat(opts.outputPath)).size;
  } catch {
    throw new IdeaseekError(
      'ENV_UNSUPPORTED',
      `FigureSpec render produced no file at ${opts.outputPath} ` +
        `(exit ${run.exitCode}): ${run.out.slice(-400)}`,
    );
  }
  if (size === 0) {
    throw new IdeaseekError(
      'ENV_UNSUPPORTED',
      `FigureSpec wrote an empty file: ${opts.outputPath}`,
    );
  }
  // The document has to actually be SVG. An error page or a truncated write
  // would otherwise be committed as a figure and discovered by a reviewer who
  // cannot open it.
  const head = (await readFile(opts.outputPath)).subarray(0, 256).toString('utf8');
  if (!head.includes('<svg')) {
    throw new IdeaseekError(
      'INVALID_ARTIFACT',
      `${opts.outputPath} is not an SVG document (starts with ${head.slice(0, 60)})`,
    );
  }
  if (run.timedOut || run.exitCode !== 0) {
    // The artefact exists and is well-formed, yet the tool still reported
    // failure. Surfacing that is the honest choice: upstream routes real
    // diagnostics through the exit code, and accepting a nonzero render because
    // of one known Windows quirk would hide the next, genuine breakage.
    throw new IdeaseekError(
      'ENV_UNSUPPORTED',
      `FigureSpec exited ${run.exitCode}${run.timedOut ? ' (timed out)' : ''} after writing ` +
        `${opts.outputPath}: ${run.out.slice(-300)} — the file is valid SVG; if this is the ` +
        'console-encoding quirk again, the child env already pins PYTHONIOENCODING, so look for ' +
        'a different upstream failure before assuming it is cosmetic',
    );
  }
  const digest = createHash('sha256')
    .update(await readFile(opts.outputPath))
    .digest('hex');
  const [rendererBytes, specBytes] = await Promise.all([readFile(script), readFile(opts.specPath)]);
  return {
    path: opts.outputPath,
    bytes: size,
    sha256: `sha256:${digest}`,
    validated: true,
    rendererPath: script,
    rendererSha256: `sha256:${createHash('sha256').update(rendererBytes).digest('hex')}`,
    specSha256: `sha256:${createHash('sha256').update(specBytes).digest('hex')}`,
  };
}
