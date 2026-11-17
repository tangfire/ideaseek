import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256Of } from '../core/hash.js';
import { IdeaseekError } from '../core/errors.js';
import { redactSecrets } from '../core/redact.js';
import { checkPythonSyntax } from '../knowledge/materialize.js';
import type { HarnessAdapter } from '../dsh/adapter.js';
import type { IdeaCard } from './card.js';
import type { IdeaCheckReport } from './check.js';
import type { FailureDiagnosis } from './diagnose.js';

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
- "src/train.py" is what the platform runs for "--scale quick|standard": it must consume a LARGER
  slice than src/smoke.py and print "scale" set to the value it was given
  ({"metrics": {...}, "scale": "quick"}). An entry that reuses the smoke computation under a quick
  label is refused, because the record would claim more data than was read (observed on a real
  idea whose train.py printed "scale": "smoke" while run-ready asked for quick).
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
  // The contract says the answer must be the complete set, so a missing
  // src/smoke.py is not a stylistic gap: the workspace keeps the scaffold's
  // placeholder smoke, `idea check` then grades that template, and the loop
  // stops on "scaffold-placeholder" while believing it evaluated the
  // generation. An instruction nothing verifies is a suggestion.
  if (!out.some((file) => file.path === 'src/smoke.py')) {
    throw new IdeaseekError(
      'INVALID_ARTIFACT',
      'the answer omitted src/smoke.py — the platform runs that file, and leaving the scaffold ' +
        'placeholder in place means the next check grades the template instead of this work',
    );
  }
  return out;
}

/**
 * `cleanRebuild` marks the ARIS "discard and reimplement cleanly" mode: two
 * patches on the same failure is usually worse than a rebuild from the card,
 * so the model is told explicitly that it is starting over rather than
 * continuing to edit, and must not try to preserve the previous structure.
 */
export function buildIdeaImplementationContext(
  card: IdeaCard,
  dataPath: string | null,
  measuredData?: string | null,
  cleanRebuild = false,
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
  if (cleanRebuild) {
    parts.push(
      '## mode: clean rebuild\n' +
        'The previous attempt is discarded, not patched: none of it remains on disk. Write the ' +
        'implementation straight from the card and the measured data above. Do not reproduce the ' +
        'previous file layout, and do not narrow the scope just to make a phase go green.',
    );
  }
  const joined = parts.join('\n\n');
  return joined.length > 12_000 ? `${joined.slice(0, 12_000)}\n(context truncated)` : joined;
}

/**
 * Outcome of the generate/check/refine loop.
 *
 * The policy is ARIS's, not invented here: `aris-skills/skills/experiment-bridge/
 * SKILL.md` budgets up to 2 patch attempts on the same failure, then up to 2
 * clean reimplements, and stops when two clean reimplements fail the same way
 * because at that point the plan or the environment is wrong rather than the
 * code. My first version capped rounds at 3 and stopped on byte-identical
 * output, which is a weaker signal than "same failure twice" and would keep
 * patching code that should have been discarded.
 */
export interface IdeaRefineResult {
  report: IdeaCheckReport;
  rounds: number;
  patches: number;
  reimplements: number;
  written: string[];
  kept: string[];
  removed: string[];
  notes: string;
  /** Two clean reimplements met the same verdict: the plan or environment is wrong. */
  stalled: boolean;
  /** True when the agent judged the cause environmental, i.e. not code's fault. */
  environmentBlocked: boolean;
  /** True when the agent put the fault in the plan/protocol rather than the code. */
  planIsWrong: boolean;
  /** The agent's final reading of the failing evidence, when one was obtained. */
  diagnosis: FailureDiagnosis | null;
  attempts: { round: number; mode: 'patch' | 'reimplement'; detail: string }[];
}

/** ARIS experiment-bridge budget: 2 patches on one failure, then 2 clean rebuilds. */
const MAX_PATCH_ATTEMPTS = 2;
const MAX_CLEAN_REIMPLEMENTS = 2;

function signatureOf(report: IdeaCheckReport): string {
  return report.phases
    .filter((phase) => !phase.skipped && !phase.ok)
    .map((phase) => `${phase.phase}:${phase.failureKind ?? 'failed'}`)
    .sort()
    .join('|');
}

/**
 * Generate, check, and regenerate with the check's own verdict fed back.
 *
 * The comparison ladder has planFix/executeRepair for exactly this — a failure
 * is classified, fixed, and retried — while the idea ladder stopped after one
 * generation. On the first real FDG run that meant the program reached the
 * point of running and printed no metrics line, and the product had nothing
 * further to do: the model never learned what the check had said, so the human
 * became the retry loop.
 *
 * See IdeaRefineResult for why the budget is ARIS's. The environment layer is
 * checked first (compute-env-contract.md §5): missing access, authentication,
 * networking or driver support is not fixed by rewriting the training script,
 * and the line that separates them from code faults is which layer is wrong —
 * spec, build, weights or exec.
 */
export async function implementIdeaWithRefine(opts: {
  harness: HarnessAdapter;
  card: IdeaCard;
  ideaId: string;
  projectRoot: string;
  dataPath: string | null;
  measuredData: string | null;
  runId: string;
  timeoutMs?: number;
  /** The locked protocol's metric declarations; see `RunChecksOptions.metricContract`. */
  metricContract?: string[];
  onRound?: (round: number, detail: string) => void;
}): Promise<IdeaRefineResult> {
  const { runIdeaChecks } = await import('./check.js');
  const { diagnoseFailure } = await import('./diagnose.js');
  const { clearGeneratedIdeaFiles } = await import('./implement-clean.js');
  let correction: string | undefined;
  let report: IdeaCheckReport | null = null;
  let notes = '';
  let written: string[] = [];
  let kept: string[] = [];
  let removed: string[] = [];
  let patches = 0;
  let reimplements = 0;
  let stalled = false;
  let environmentBlocked = false;
  let planIsWrong = false;
  let lastDiagnosis: Awaited<ReturnType<typeof diagnoseFailure>> | null = null;
  const attempts: IdeaRefineResult['attempts'] = [];
  const seenAfterReimplement: string[] = [];

  for (let round = 1; round <= MAX_PATCH_ATTEMPTS + MAX_CLEAN_REIMPLEMENTS + 2; round += 1) {
    // The verdict on which layer is wrong comes from an agent reading the log,
    // not from a keyword table the platform maintains (see src/idea/diagnose.ts).
    // What stays hard here is cost, not judgement: the round ceiling below is
    // what bounds spend, while the decision to continue at all is the agent's.
    if (report !== null && report.outcome !== 'passed') {
      const diagnosis = await diagnoseFailure({
        harness: opts.harness,
        projectRoot: opts.projectRoot,
        report,
        ideaId: opts.ideaId,
        runId: opts.runId,
        // The plan side of the question, so `layer: "plan"` can be reached by
        // reasoning rather than by exhaustion of the code hypothesis.
        planContext: [
          `scope: ${opts.card.minimalExperiment.code}`,
          `data expectation: ${opts.card.minimalExperiment.data}`,
          `metrics: ${opts.card.minimalExperiment.metrics.join(', ')}`,
          `baselines: ${opts.card.minimalExperiment.baselines.join(', ')}`,
          `budget: maxRounds=${opts.card.budget.maxRounds} maxGpuMinutes=${opts.card.budget.maxGpuMinutes}`,
          `hypothesis: ${opts.card.hypothesis.statement}`,
        ].join('\n'),
      });
      if (diagnosis) {
        lastDiagnosis = diagnosis;
        if (diagnosis.environmentBlocked || !diagnosis.worthRetrying) {
          environmentBlocked = diagnosis.environmentBlocked;
          if (!diagnosis.environmentBlocked && diagnosis.layer === 'plan') planIsWrong = true;
          attempts.push({
            round,
            mode: 'patch',
            detail:
              `diagnosis (${diagnosis.layer}${diagnosis.environmentBlocked ? ', environment blocked' : ''}): ` +
              `${diagnosis.reasoning} [evidence: ${diagnosis.evidence.join(' / ')}]` +
              (diagnosis.recommendedAction ? ` → ${diagnosis.recommendedAction}` : ''),
          });
          opts.onRound?.(round, attempts[attempts.length - 1]!.detail);
          break;
        }
      }
    }

    const mode: 'patch' | 'reimplement' =
      report === null || patches < MAX_PATCH_ATTEMPTS ? 'patch' : 'reimplement';
    if (mode === 'reimplement') {
      if (reimplements >= MAX_CLEAN_REIMPLEMENTS) break;
      reimplements += 1;
      // A rebuild, not a third patch on two wrong ones. Only files on the
      // manifest are eligible — that list is what separates the platform's own
      // scaffolding from code a person wrote, and no judgement call changes it.
      const cleared = await clearGeneratedIdeaFiles(ideaWorkspace(opts.projectRoot, opts.ideaId));
      removed = [...new Set([...removed, ...cleared])];
      correction = undefined;
    } else if (report === null) {
      // The first generation clears too, or the template's smoke and unit test
      // survive into the run that is supposed to be grading new code.
      const cleared = await clearGeneratedIdeaFiles(ideaWorkspace(opts.projectRoot, opts.ideaId));
      removed = [...new Set(cleared)];
      patches += 1;
    } else {
      patches += 1;
    }

    let authored: AuthoredIdeaCode | null = null;
    let refusal: string | null = null;
    try {
      authored = await authorIdeaImplementation({
        harness: opts.harness,
        card: opts.card,
        dataPath: opts.dataPath,
        measuredData: opts.measuredData,
        runId: opts.runId,
        now: Date.now(),
        correction,
        cleanRebuild: mode === 'reimplement',
      });
      refusal = await checkAuthoredFiles(authored.files);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }

    if (!authored || refusal) {
      attempts.push({ round, mode, detail: `refused: ${refusal ?? 'no files returned'}` });
      opts.onRound?.(round, attempts[attempts.length - 1]!.detail);
      correction =
        `the previous answer was refused: ${refusal ?? 'no files returned'}. Return only .py ` +
        'files under src/, plain UTF-8, each under 400 lines, importing siblings by bare ' +
        'module name.';
      continue;
    }

    notes = authored.notes;
    const outcome = await writeIdeaFiles(
      ideaWorkspace(opts.projectRoot, opts.ideaId),
      authored.files,
      { force: true },
    );
    written = outcome.written;
    kept = [...new Set([...kept, ...outcome.kept])];
    report = await runIdeaChecks(opts.projectRoot, opts.ideaId, {
      timeoutMs: opts.timeoutMs,
      metricContract: opts.metricContract ?? [],
    });

    if (report.outcome === 'passed') {
      attempts.push({ round, mode, detail: 'check passed' });
      break;
    }
    if (report.outcome === 'not-implemented' || report.outcome === 'scaffold-placeholder') {
      attempts.push({
        round,
        mode,
        detail: `no real implementation under src/ (${report.outcome})`,
      });
      break;
    }

    const detail = report.phases
      .filter((phase) => !phase.skipped && !phase.ok)
      .map((phase) => `${phase.phase} (${phase.failureKind ?? 'failed'}): ${phase.summary ?? ''}`)
      .join('\n');
    attempts.push({ round, mode, detail });
    opts.onRound?.(round, `check failed:\n${detail}`);

    if (mode === 'reimplement') {
      const signature = signatureOf(report);
      if (seenAfterReimplement.includes(signature)) {
        // The ARIS stop: two clean rebuilds meeting the same verdict means the
        // plan or the environment is wrong, and that is what needs the human —
        // not a fourth generation.
        stalled = true;
        break;
      }
      seenAfterReimplement.push(signature);
    }

    correction =
      `the previous implementation failed the check ladder:
${detail}
` +
      `Mode: ${mode === 'patch' ? 'patch the named cause' : 'rebuild cleanly from the card'}. ` +
      'Do not report placeholder or constant metrics to satisfy the smoke phase, and do not ' +
      'import a package the card does not declare.';
  }

  return {
    report: report ?? {
      ideaId: opts.ideaId,
      version: opts.card.version,
      codeHash: null,
      startedAt: 0,
      finishedAt: 0,
      outcome: 'failed',
      phases: [],
    },
    rounds: attempts.length,
    patches,
    reimplements,
    written,
    kept,
    removed,
    notes,
    stalled,
    environmentBlocked,
    planIsWrong,
    diagnosis: lastDiagnosis,
    attempts,
  };
}

function ideaWorkspace(projectRoot: string, ideaId: string): string {
  return join(projectRoot, 'ideas', ideaId);
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
  /** True when the previous attempt is discarded rather than patched. */
  cleanRebuild?: boolean;
}): Promise<AuthoredIdeaCode> {
  const base = buildIdeaImplementationContext(
    opts.card,
    opts.dataPath,
    opts.measuredData ?? null,
    opts.cleanRebuild === true,
  );
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
