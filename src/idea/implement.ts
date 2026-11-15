import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256Of } from '../core/hash.js';
import { IdeaseekError } from '../core/errors.js';
import { redactSecrets } from '../core/redact.js';
import { checkPythonSyntax } from '../knowledge/materialize.js';
import type { HarnessAdapter } from '../dsh/adapter.js';
import type { IdeaCard } from './card.js';

/**
 * Idea-side code generation, the half `comparison implement` already covers.
 *
 * Without it the research chain dead-ends: `idea scaffold` writes a template
 * whose smoke declares itself synthetic, `idea check` (correctly) refuses that,
 * and nothing on the idea side produces real code. A researcher following the
 * product's own next steps could never reach an experiment without hand-writing
 * Python, which contradicts what Research mode promises.
 */
export const IDEA_IMPLEMENT_INSTRUCTION = `You are the Idea Implementation Agent. Turn the supplied
IdeaCard into a small but real implementation of the idea's mechanism, written into the idea's own workspace.
Output exactly one JSON object:
{"files": [{"path": string, "content": string}], "notes": string}
Rules:
- Return the COMPLETE set of files the idea needs to run, including src/smoke.py: the workspace is
  replaced by this answer, not patched. Returning one file leaves the previous generation's
  modules in place, and a mix of two generations is worse than either.
- "path" is relative to the idea workspace, e.g. "src/train.py", "src/check_data.py",
  "src/check_metrics.py", "src/smoke.py". Paths outside src/, absolute paths and ".." are refused.
- "src/smoke.py" is what the platform runs: it must READ the handed data (IDEASEEK_DATA_PATH,
  else IDEASEEK_DATASET_ROOTS, else IDEASEEK_PROJECT_ROOT) and print exactly one JSON line
  {"metrics": {...}} whose keys are exactly the idea's configured metric names.
- The platform invokes each file as "python src/<name>.py" with the WORKSPACE ROOT as the working
  directory, which puts src/ itself on sys.path. Import siblings by BARE module name
  ("from geometry import project"), never "from src.geometry import ..." — there is no package
  named src, and that form fails as "No module named 'src'" (this wording came from the platform
  and cost one full generation round). Resolve any file you open against __file__ or the workspace
  root, never against the src/ directory, and never reference a sibling as a bare relative path
  (observed failure: check_metrics.py ran "python smoke.py" and the platform reported the file
  as missing).
- Files under src/tests/ are run by the platform's unit-test phase; import the modules they test
  by bare name too, and never assume a package path.
- Never print a placeholder constant. Do not output a "synthetic" key, do not report
  {"status":"scaffold-not-implemented"}, and do not return 0.5 for everything: the platform
  refuses a smoke line that declares itself synthetic, and a template number that reaches a
  results record is worse than a failing check.
- If the data or a dependency is unavailable, exit non-zero with a message naming what you tried.
- Import only the standard library and the packages listed in the card's requirements; prefer
  numpy-level minimal math over reconstructing a full training stack in one file.
- Keep every file under 250 lines and the whole answer under 600 lines. A faithful small
  implementation beats a broad incomplete one.
"notes" states in one or two sentences what could not be grounded in the card.`;

const IMPLEMENTATION_OUTPUT_SCHEMA = 'idea-implementation-v1';
const MAX_FILES = 8;
const MAX_FILE_LINES = 400;
const ALLOWED_PREFIX = 'src/';

export interface AuthoredIdeaCode {
  files: { path: string; content: string }[];
  notes: string;
  contextHash: string;
}

function refusePath(path: string): string | null {
  if (typeof path !== 'string' || !path.trim()) return 'empty path';
  if (path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path)) return 'absolute path';
  if (path.includes('..')) return 'parent traversal';
  if (!path.startsWith(ALLOWED_PREFIX)) return 'not under src/';
  if (!path.endsWith('.py')) return 'not a python file';
  return null;
}

export function parseIdeaImplementationOutput(output: string): AuthoredIdeaCode['files'] {
  let value: unknown;
  try {
    value = JSON.parse(output) as unknown;
  } catch (error) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `implementation output is not JSON: ${(error as Error).message}`,
    );
  }
  const files = (value as { files?: unknown }).files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      'no files returned — the JSON envelope must carry the implementation under "files"',
    );
  }
  const out: AuthoredIdeaCode['files'] = [];
  for (const entry of files.slice(0, MAX_FILES)) {
    const record = (entry ?? {}) as Record<string, unknown>;
    const path = typeof record.path === 'string' ? record.path.trim() : '';
    const refusal = refusePath(path);
    if (refusal) {
      throw new IdeaseekError(
        'INVALID_ARTIFACT',
        `refused file "${path}": ${refusal} — nothing was written`,
      );
    }
    if (typeof record.content !== 'string' || !record.content.trim()) {
      throw new IdeaseekError('INVALID_ARTIFACT', `file ${path} came back empty`);
    }
    if (record.content.includes('\0')) {
      // Observed in a real run: the returned string carried NUL bytes, which
      // compiles as "source code string cannot contain null bytes" and would
      // otherwise look like a transport failure rather than bad output.
      throw new IdeaseekError(
        'INVALID_ARTIFACT',
        `file ${path} contains null bytes — return plain UTF-8 source`,
      );
    }
    const lines = record.content.split(/\r?\n/).length;
    if (lines > MAX_FILE_LINES) {
      throw new IdeaseekError(
        'INVALID_ARTIFACT',
        `${path} is ${lines} lines (limit ${MAX_FILE_LINES}) — refusing an unreviewable blob`,
      );
    }
    out.push({ path, content: record.content });
  }
  return out;
}

export function buildIdeaImplementationContext(
  card: IdeaCard,
  dataPath: string | null,
  measuredData?: string | null,
): string {
  const parts = [
    `## idea\n${card.ideaId} v${card.version}`,
    `## hypothesis\n${card.hypothesis.statement}\ntarget problem: ${card.hypothesis.targetProblem}`,
    `## mechanism chain\n${card.mechanismChain.steps
      .map((step, index) => `${index + 1}. [${step.kind}] ${step.text}`)
      .join('\n')}`,
    `## design-principle link\n${card.mechanismChain.designPrincipleLink}`,
    `## minimal experiment (this is the scope to implement)\n${card.minimalExperiment.code}`,
    `## data expectation\n${card.minimalExperiment.data}`,
    // The platform has already profiled the corpus for most projects. Without
    // this the generator invents column names and the check fails with "no
    // numeric feature column among ['image','domain','label'] — a guess about
    // data the platform knew.
    measuredData
      ? `## measured data structure (trust this over the expectation above)\n${measuredData}`
      : `## measured data structure\n(not profiled — run ideaseek data describe; probe defensively and report what you find instead of assuming columns)`,
    `## metrics the smoke line must key\n${
      card.minimalExperiment.metrics.map((metric) => `- ${metric}`).join('\n') || '(none declared)'
    }`,
    `## baselines to be comparable against\n${card.minimalExperiment.baselines.join(', ') || '(none)'}`,
    `## nearest comparisons and their claimed difference\n${
      card.nearestComparisons
        .map((item) => `- ${item.methodId}: ${item.difference} [${item.evidence}]`)
        .join('\n') || '(none)'
    }`,
    `## boundary conditions and risks\n${
      [...card.boundaryConditions, ...card.risks].map((item) => `- ${item}`).join('\n') || '(none)'
    }`,
    `## budget\nmaxRounds ${card.budget.maxRounds} · maxGpuMinutes ${card.budget.maxGpuMinutes}`,
    `## data path handed to the checks\n${dataPath ?? '(caller supplies; use the environment)'}`,
  ];
  const joined = parts.join('\n\n');
  return joined.length > 12_000 ? `${joined.slice(0, 12_000)}\n(context truncated)` : joined;
}

/**
 * Generate the idea's code, compile-check every file, and write into
 * ideas/<id>/src/. Existing files are only replaced when the caller passes
 * force, because a user's hand-written implementation outranks a template.
 */
export async function authorIdeaImplementation(opts: {
  harness: HarnessAdapter;
  card: IdeaCard;
  dataPath: string | null;
  measuredData?: string | null;
  runId: string;
  now: number;
  correction?: string;
}): Promise<AuthoredIdeaCode> {
  const base = buildIdeaImplementationContext(opts.card, opts.dataPath, opts.measuredData ?? null);
  const context = opts.correction ? `${base}\n\n## correction required\n${opts.correction}` : base;
  const result = await opts.harness.runTask({
    runId: opts.runId,
    taskId: `idea-implement-${opts.card.ideaId}`,
    profile: 'demo',
    instruction: IDEA_IMPLEMENT_INSTRUCTION,
    inputs: [{ kind: 'text', name: 'idea-card', content: context }],
    outputSchema: IMPLEMENTATION_OUTPUT_SCHEMA,
    budget: { timeoutMs: 300_000, maxOutputTokens: 16_384 },
    idempotencyKey: `idea-implement:${opts.card.ideaId}:${sha256Of(context).slice(7, 23)}`,
  });
  if (!result.output || !result.output.trim()) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      'the idea implementation turn returned no output at all',
    );
  }
  const files = parseIdeaImplementationOutput(result.output);
  // Same escape hatch that turned two guessed diagnoses into facts on the
  // comparison side: the value is a path the operator chooses, off unless set.
  if (process.env.IDEASEEK_IMPLEMENT_DEBUG) {
    try {
      await writeFile(process.env.IDEASEEK_IMPLEMENT_DEBUG, result.output, 'utf8');
    } catch {
      // Diagnostics must never become the reason a run fails.
    }
  }
  let notes = '';
  try {
    notes = String((JSON.parse(result.output) as { notes?: string }).notes ?? '').slice(0, 400);
  } catch {
    // parseIdeaImplementationOutput already validated the envelope shape.
  }
  return {
    files,
    notes: redactSecrets(notes),
    contextHash: sha256Of(context),
  };
}

/** Compile every generated file before any of it is written. */
export async function checkAuthoredFiles(files: AuthoredIdeaCode['files']): Promise<string | null> {
  const scratch = await mkdtempSafe();
  try {
    for (const file of files) {
      const probe = join(scratch, file.path.replace(/[\\/]/g, '_'));
      await writeFile(probe, file.content, 'utf8');
      const syntax = await checkPythonSyntax(probe);
      if (!syntax.ok) {
        return `${file.path}: line ${syntax.line}: ${syntax.message}`;
      }
    }
    return null;
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function mkdtempSafe(): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(join(tmpdir(), 'ideaseek-idea-implement-'));
}

/**
 * Manifest of files the generator owns.
 *
 * Without it `--force` patched the previous generation with the new one: an
 * answer containing src/data.py alone left last run's broken geometry.py and
 * smoke.py in place, and `idea check` then graded a mix of two generations. The
 * manifest makes removal precise — only files this command wrote are eligible
 * to be deleted, so hand-written or agent-edited code is never touched.
 */
export const GENERATED_MANIFEST = 'src/.generated.json';

export async function writeIdeaFiles(
  workspace: string,
  files: AuthoredIdeaCode['files'],
  opts: { force: boolean },
): Promise<{ written: string[]; kept: string[]; removed: string[] }> {
  const { readFile, rm } = await import('node:fs/promises');
  const target = (path: string): string => join(workspace, path);
  let previouslyGenerated: string[] = [];
  try {
    const stored = JSON.parse(await readFile(target(GENERATED_MANIFEST), 'utf8')) as {
      files?: unknown;
    };
    previouslyGenerated = Array.isArray(stored.files)
      ? stored.files.filter((path): path is string => typeof path === 'string')
      : [];
  } catch {
    // no manifest yet: nothing is known to be generator-owned
  }
  const next = new Set(files.map((file) => file.path));
  const removed: string[] = [];
  if (opts.force) {
    for (const path of previouslyGenerated) {
      if (next.has(path) || !path.startsWith(ALLOWED_PREFIX) || path.includes('..')) continue;
      await rm(target(path), { force: true }).catch(() => undefined);
      removed.push(path);
    }
  }
  const written: string[] = [];
  const kept: string[] = [];
  for (const file of files) {
    const destination = target(file.path);
    await mkdir(join(destination, '..'), { recursive: true });
    const existing = await readFile(destination, 'utf8').catch(() => null);
    if (existing !== null && !opts.force && !previouslyGenerated.includes(file.path)) {
      // Kept: a file the generator never wrote, so it is someone else's work.
      kept.push(file.path);
      continue;
    }
    await writeFile(destination, file.content, 'utf8');
    written.push(file.path);
  }
  await writeFile(
    target(GENERATED_MANIFEST),
    `${JSON.stringify({ schemaVersion: 1, files: [...next].sort() }, null, 2)}\n`,
    'utf8',
  );
  return { written, kept, removed };
}
