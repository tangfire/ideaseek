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
export const IMPLEMENT_INSTRUCTION = `You are the Baseline Reproduction implementer. Turn the supplied
reproduction blueprint into ONE self-contained Python program. Output ONLY the program, no prose, no markdown fences.
Hard requirements:
- Accepts argv[1] as one of: smoke | check-data | check-metrics (default: smoke).
- check-data --data <path>: verify the declared data interface is readable; print one JSON line
  {"status":"ok", ...counts} and exit 0, or exit non-zero with a reason if it is not.
- check-metrics: print one JSON line {"metrics": {...}} using exactly the blueprint's metric names.
- smoke: run the method end to end on a small slice and print one JSON line
  {"metrics": {...}} with the blueprint's metric names and values actually computed.
- Emit ONLY that JSON line on stdout for the metrics-bearing commands; diagnostics go to stderr.
- Do not fabricate results. If a dependency or the data is unavailable, exit non-zero and explain.
  Never report a status such as "skipped" or "ephemeral_passed" with exit code 0.
- Import only the standard library and the packages the blueprint declares as requirements.
- Keep it under 300 lines; prefer a faithful minimal implementation over a broad incomplete one.
- Add a short module docstring naming the method and citing the blueprint's paper-explicit basis.`;

const MAX_PROGRAM_LINES = 400;

export interface AuthoredImplementation {
  source: string;
  lines: number;
  origin: 'agent';
  contextHash: string;
}

function stripFences(text: string): string {
  const fenced = /```(?:python)?\s*([\s\S]*?)```/.exec(text);
  return (fenced?.[1] ?? text).trim() + '\n';
}

export function buildImplementationContext(
  blueprint: ReproductionBlueprint,
  dataPath: string | null,
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
  return joined.length > 10_000 ? `${joined.slice(0, 10_000)}\n(context truncated)` : joined;
}

export async function authorImplementation(opts: {
  harness: HarnessAdapter;
  blueprint: ReproductionBlueprint;
  dataPath: string | null;
  runId: string;
  now: number;
}): Promise<AuthoredImplementation> {
  const context = buildImplementationContext(opts.blueprint, opts.dataPath);
  const result = await opts.harness.runTask({
    runId: opts.runId,
    taskId: `implement-${opts.blueprint.methodId}`,
    // Tool-less reasoning profile: this call writes a program, it must not be
    // able to touch the worktree, run installs or reach the network.
    profile: 'demo',
    instruction: IMPLEMENT_INSTRUCTION,
    inputs: [{ kind: 'text', name: 'reproduction-blueprint', content: context }],
    outputSchema: 'python-program-v1',
    budget: { timeoutMs: 300_000, maxOutputTokens: 16_384 },
    idempotencyKey: `implement:${opts.blueprint.methodId}:${sha256Of(context).slice(7, 23)}`,
  });

  const source = stripFences(result.output);
  const lines = source.split(/\r?\n/).filter(Boolean).length;
  if (lines < 10) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `authored implementation is only ${lines} line(s) — not a usable program; rerun with --force`,
    );
  }
  if (lines > MAX_PROGRAM_LINES) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `authored implementation is ${lines} lines (limit ${MAX_PROGRAM_LINES}) — refusing to write an unreviewable blob`,
    );
  }
  return { source, lines, origin: 'agent', contextHash: sha256Of(context) };
}
