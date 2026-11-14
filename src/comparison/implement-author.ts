import { sha256Of } from '../core/hash.js';
import { IdeaseekError } from '../core/errors.js';
import type { HarnessAdapter } from '../dsh/adapter.js';
import type { ReproductionBlueprint } from './types.js';

/**
 * Generates the implementation for a reproduction blueprint.
 *
 * Deliberately separate from authoring the plan: asking one response to carry
 * both a structured blueprint and a several-hundred-line program is what
 * produced a truncated JSON in one run and a non-compiling program in
 * another. A plan is reviewed as a plan; code is generated, compiled and then
 * handed to `baseline reproduce --code`.
 */
/**
 * The harness frames every request as "return ONLY a JSON object matching
 * schema <outputSchema>", so asking for a bare program contradicts that and
 * the model splits the difference — live it returned one line. The program
 * travels inside a JSON field instead, which is the one shape both sides agree on.
 */
export const IMPLEMENT_INSTRUCTION = `You are the Baseline Reproduction implementer. Turn the supplied
reproduction blueprint into ONE self-contained Python program. Output exactly one JSON object:
{"program": string, "notes": string}
where "program" is the complete source as a single JSON string (real newlines escaped as \\n).
Hard requirements for the program:
- Accepts argv[1] as one of: smoke | check-data | check-metrics (default: smoke).
- check-data --data <path>: verify the declared data interface is readable; print one JSON line
  {"status":"ok", ...counts} and exit 0, or exit non-zero with a reason if it is not. Judge the
  handed path by its own contents: structure, the domains the plan declares, labels readable, and
  counts against whatever the path's manifest states. Never require a total sample count from the
  blueprint's measured-corpus figure — that is the full corpus, and these checks run on a selected
  subset, so an absolute expectation fails a correct subset and reads as a data problem.
- check-metrics: prove the metrics are computable and exit 0. Compute each metric function on a
  small synthetic batch you build in memory — do NOT load the corpus and do NOT run the method,
  because this check has a per-command timeout and training does not fit in it. Print one JSON line
  {"metrics": {...}} whose KEYS are exactly the blueprint's metric names. The values here are
  proofs of computability, not results: only the smoke line is ever read as a measurement.
- smoke: run the method end to end on a small slice and print one JSON line
  {"metrics": {...}} with the blueprint's metric names and values actually computed.
- Where the data lives: only check-data is handed a --data path. smoke and check-metrics get no
  path, so resolve the data location in this order: an explicit --data/--data-root flag if you
  provide one, then the environment variable IDEASEEK_DATA_PATH (the exact selection the caller
  asked for, injected into every phase), then IDEASEEK_DATASET_ROOTS (all usable corpus roots,
  OS path-delimiter separated; take the first that holds the expected layout), then
  IDEASEEK_PROJECT_ROOT joined with the blueprint's data interface. Do NOT invent a
  method-specific variable name and do NOT fall back to the current working directory: the program
  runs from its own worktree, so a cwd guess resolves to an empty directory and reports "no data"
  as if the corpus were missing. If nothing resolves, exit non-zero listing every location tried.
- Emit only that JSON line on stdout for the metrics-bearing commands; diagnostics go to stderr.
- Do not fabricate results. If a dependency or the data is unavailable, exit non-zero and explain.
  Never report a status such as "skipped" or "ephemeral_passed" with exit code 0.
- Import only the standard library and the packages the blueprint declares as requirements.
- Keep it under 500 lines; prefer a faithful minimal implementation over a broad incomplete one.
- Start with a short module docstring naming the method and the blueprint's paper-explicit basis.
"notes" states, in one or two sentences, what the implementation could not ground in the blueprint.`;

// Safety bound, not a style preference. It must sit above the instruction's
// own target (500) or the guard rejects ordinary output and the step never
// completes — which reads as a model failure but is a configuration one.
const MAX_PROGRAM_LINES = 800;

/** Registered in src/core/schema so the named contract actually exists. */
export const IMPLEMENTATION_SCHEMA = 'implementation-program-v1';

export interface AuthoredImplementation {
  source: string;
  lines: number;
  origin: 'agent';
  contextHash: string;
  notes: string;
}

/** Extracts the program field. A JSON envelope without a program is not source code. */
export function parseImplementationOutput(output: string): { program: string; notes: string } {
  const trimmed = output.trim();
  if (trimmed.startsWith('{')) {
    // Parsed as the required envelope: no program means no program. Falling
    // through here would write `{"notes": ...}` into reproduce.py and leave it
    // to the compile step to notice — a check is not a substitute for a gate.
    try {
      const parsed = JSON.parse(trimmed) as { program?: unknown; notes?: unknown };
      const notes = typeof parsed.notes === 'string' ? parsed.notes.slice(0, 400) : '';
      return {
        program: typeof parsed.program === 'string' ? parsed.program : '',
        notes,
      };
    } catch {
      // Starts like JSON but is not: treat as source and let the bounds decide.
    }
  }
  const fenced = /```(?:python)?\s*([\s\S]*?)```/.exec(trimmed);
  const body = (fenced?.[1] ?? trimmed).trim();
  return { program: body, notes: 'response was not a JSON object; used as-is' };
}

export function buildImplementationContext(
  blueprint: ReproductionBlueprint,
  dataPath: string | null,
  correction?: string,
): string {
  const parts = [
    `## method\n${blueprint.methodId}`,
    `## confidence\n${blueprint.confidence}`,
    `## paper-explicit basis\n${blueprint.paperExplicit
      .map((entry) => `- ${entry.statement}  [${entry.evidence}]`)
      .join('\n')}`,
    `## assumptions\n${blueprint.assumptions.map((item) => `- ${item}`).join('\n') || '(none)'}`,
    `## missing details (do not invent; keep the implementation honest about these)\n${
      blueprint.missingDetails.map((item) => `- ${item}`).join('\n') || '(none)'
    }`,
    `## data interface\n${blueprint.algorithm.dataInterface.description}`,
    `## metrics to emit (names must match exactly)\n${blueprint.algorithm.metrics
      .map((metric) => `- ${metric.name} (${metric.direction})`)
      .join('\n')}`,
    `## hyperparameters\n${JSON.stringify(blueprint.algorithm.hyperparameters ?? {})}`,
    `## declared requirements\n${(blueprint.algorithm.requirements ?? []).join(', ') || '(stdlib only)'}`,
    `## data path the checks will receive\n${dataPath ?? '(caller supplies --data)'}`,
  ];
  const joined = parts.join('\n\n');
  const body = joined.length > 10_000 ? `${joined.slice(0, 10_000)}\n(context truncated)` : joined;
  // Appended after truncation, as in buildBlueprintContext: a retry that
  // arrives without its feedback is the same request sent twice.
  return correction ? `${body}\n\n## correction required\n${correction}` : body;
}

export async function authorImplementation(opts: {
  harness: HarnessAdapter;
  blueprint: ReproductionBlueprint;
  dataPath: string | null;
  runId: string;
  now: number;
  /** Why a previous attempt was refused; see buildImplementationContext. */
  correction?: string;
}): Promise<AuthoredImplementation> {
  const context = buildImplementationContext(opts.blueprint, opts.dataPath, opts.correction);
  const result = await opts.harness.runTask({
    runId: opts.runId,
    taskId: `implement-${opts.blueprint.methodId}`,
    // Tool-less reasoning profile: this call writes a program, it must not be
    // able to touch the worktree, run installs or reach the network.
    profile: 'demo',
    instruction: IMPLEMENT_INSTRUCTION,
    inputs: [{ kind: 'text', name: 'reproduction-blueprint', content: context }],
    outputSchema: IMPLEMENTATION_SCHEMA,
    budget: { timeoutMs: 300_000, maxOutputTokens: 16_384 },
    idempotencyKey: `implement:${opts.blueprint.methodId}:${sha256Of(context).slice(7, 23)}`,
  });

  const { program, notes } = parseImplementationOutput(result.output);
  // Diagnostics escape hatch: when generation keeps failing a bound, the only
  // way to tell "the model wrote bad code" from "the transport mangled it" is
  // to look at what actually came back. Off unless asked for.
  if (process.env.IDEASEEK_IMPLEMENT_DEBUG) {
    try {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(process.env.IDEASEEK_IMPLEMENT_DEBUG, result.output, 'utf8');
    } catch {
      // Diagnostics must never become the reason a run fails.
    }
  }
  const source = program.trimEnd() + '\n';
  const lines = source.split(/\r?\n/).filter(Boolean).length;
  if (lines < 10) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `authored implementation is only ${lines} line(s) — not a usable program. ` +
        `${notes ? `Model notes: ${notes.slice(0, 200)}` : 'The response carried no program.'} ` +
        'Rerun with --force; if it repeats, the blueprint is too vague to implement and needs new confirmed details.',
    );
  }
  if (lines > MAX_PROGRAM_LINES) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `authored implementation is ${lines} lines (limit ${MAX_PROGRAM_LINES}) — refusing to write an unreviewable blob`,
    );
  }
  return { source, lines, origin: 'agent', contextHash: sha256Of(context), notes };
}
