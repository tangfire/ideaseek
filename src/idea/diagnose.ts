import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Of } from '../core/hash.js';
import { redactSecrets } from '../core/redact.js';
import { IdeaseekError } from '../core/errors.js';
import { assertAgainstSchema } from '../core/schema/index.js';
import type { HarnessAdapter } from '../dsh/adapter.js';
import type { IdeaCheckReport } from './check.js';

/**
 * Diagnosing a failed phase by asking an agent, not by matching keywords.
 *
 * The first version of this was a table of regexes for quota, network and
 * docker symptoms. It worked on the four examples I thought of and was a
 * maintenance list for everything else: symptom spaces are open-ended, new
 * providers phrase their errors differently, and a platform whose whole
 * purpose is to reason about research should not outsource that reasoning to
 * a string match it wrote itself. The vocabulary is still ARIS's —
 * `shared-references/compute-env-contract.md` §5, which organises failures by
 * LAYER — but the call is the agent's, and it has to quote the lines its
 * verdict rests on, because a diagnosis without evidence is a guess.
 */
export const DIAGNOSIS_SCHEMA = 'failure-diagnosis-v1';

export const DIAGNOSIS_INSTRUCTION = `You are the Failure Diagnosis Agent for a research platform. A generated
implementation of a research idea failed the platform's check ladder. Decide WHICH LAYER is wrong,
using the ARIS compute-env-contract §5 vocabulary, and what should happen next.

Output exactly one JSON object:
{"layer": "spec"|"build"|"weights"|"resolution"|"exec"|"code"|"plan"|"unknown",
 "environmentBlocked": boolean, "worthRetrying": boolean,
 "reasoning": string, "evidence": [string], "recommendedAction": string, "confidence": number}

Rules:
- A keyword-based guess from the platform may appear in the evidence. It is the thing you are
  replacing, not a prior to confirm: contradict it whenever the log does not support it, and say in
  "reasoning" which layer the log actually shows.
- "evidence" must quote lines from the supplied log, verbatim and short. A verdict with no quoted
  evidence is not accepted, so if you cannot quote something that supports it, answer
  layer "unknown" with confidence below 0.4.
- environmentBlocked is true only for missing access, credentials, quota, networking, container
  runtime or driver/GPU support — things another generation of code cannot change.
- layer "plan" means the idea card, its experiment scope or the locked protocol is what is wrong.
  Set worthRetrying false in that case: more attempts at code will not fix a bad plan, and saying
  so plainly is more useful than spending the budget.
- Distinguish a version conflict (the environment has a package that contradicts the spec) from a
  missing package (the spec never declared it) from a genuine code fault (shapes, indexing,
  algorithm logic). Each has a different next action; do not collapse them into "dependency".
- Do not propose installing a module that belongs to the idea's own workspace.
- reasoning is for a researcher who will act on it: name the cause, not the category.`;

export interface FailureDiagnosis {
  layer: string;
  environmentBlocked: boolean;
  worthRetrying: boolean;
  reasoning: string;
  evidence: string[];
  recommendedAction: string;
  confidence: number;
}

const LOG_TAIL = 4000;

async function phaseEvidence(projectRoot: string, report: IdeaCheckReport): Promise<string> {
  const parts: string[] = [];
  for (const phase of report.phases) {
    if (phase.skipped || phase.ok || !phase.logPath) continue;
    const tail = await readFile(join(projectRoot, phase.logPath), 'utf8').catch(() => '');
    // The mechanical classification is passed as what it is — a keyword guess
    // the agent is expected to contradict. Stating it in the evidence header
    // without that framing made the table the agent exists to replace the
    // first thing the agent read, and a model tends to agree with a label that
    // is already printed above the log.
    parts.push(
      `### ${phase.phase} (exit ${phase.exitCode})\n` +
        `command: ${phase.command.join(' ')}\n` +
        `platform keyword guess (you may contradict it, and should if the log does not support it): ` +
        `${phase.failureKind ?? 'none'}\n` +
        redactSecrets(tail).slice(-LOG_TAIL),
    );
  }
  if (parts.length === 0) {
    parts.push(
      `### outcome ${report.outcome}\nno failing phase log was recorded; summary only:\n` +
        report.phases.map((phase) => `- ${phase.phase}: ${phase.summary ?? ''}`).join('\n'),
    );
  }
  return parts.join('\n\n');
}

/**
 * Ask the harness to diagnose one failed check report.
 *
 * Returns null when no harness is available: the caller then behaves as before,
 * with the platform's own mechanical classification, rather than inventing a
 * verdict it cannot support.
 */
export async function diagnoseFailure(opts: {
  harness: HarnessAdapter;
  projectRoot: string;
  report: IdeaCheckReport;
  ideaId: string;
  runId: string;
  /**
   * What the plan asked for (card scope, declared requirements, locked
   * protocol metrics). Without it the agent can only reason about the code, and
   * `layer: "plan"` — the verdict that stops the loop instead of spending the
   * budget — becomes unfalsifiable: nothing in a traceback says "this is what
   * the card asked for and it is impossible on this data".
   */
  planContext?: string;
}): Promise<FailureDiagnosis | null> {
  const evidence = await phaseEvidence(opts.projectRoot, opts.report);
  if (!evidence.trim()) return null;
  const input = opts.planContext
    ? `${evidence}\n\n## what the plan required (judge the code against this, and judge whether this itself is what is wrong)\n${redactSecrets(opts.planContext).slice(0, LOG_TAIL)}`
    : evidence;
  const result = await opts.harness.runTask({
    runId: opts.runId,
    taskId: `diagnose-${opts.ideaId}`,
    profile: 'demo',
    instruction: DIAGNOSIS_INSTRUCTION,
    inputs: [{ kind: 'text', name: 'failed-check-report', content: input }],
    outputSchema: DIAGNOSIS_SCHEMA,
    budget: { timeoutMs: 120_000, maxOutputTokens: 2_000 },
    idempotencyKey: `diagnose:${opts.ideaId}:${sha256Of(input).slice(7, 23)}`,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.output) as unknown;
  } catch (error) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `failure diagnosis output is not JSON: ${(error as Error).message}`,
    );
  }
  const value = (parsed ?? {}) as Record<string, unknown>;
  // Prose is clamped to the contract's ceilings before validating. The first
  // real run failed the whole command because a diagnosis explanation ran 50
  // characters long, which is the wrong trade: structure (which layer, is it
  // environmental, what evidence) is what must be enforced, and losing a good
  // verdict to a length limit is a worse outcome than a shortened one.
  const clamp = (text: unknown, max: number): string =>
    String(text ?? '')
      .trim()
      .slice(0, max);
  if (typeof value.reasoning === 'string') value.reasoning = clamp(value.reasoning, 900);
  if (typeof value.recommendedAction === 'string') {
    value.recommendedAction = clamp(value.recommendedAction, 400);
  }
  if (Array.isArray(value.evidence)) {
    // Over-abundance is not a defect: a verdict quoting nine lines is better
    // than one quoting three, and the second real run aborted the whole
    // command on maxItems=6. Keep the strongest lines, enforce the structure.
    value.evidence = value.evidence
      .map((line) => clamp(line, 300))
      .filter((line) => line.length > 0)
      .slice(0, 6);
  }
  assertAgainstSchema(DIAGNOSIS_SCHEMA, value);
  return {
    layer: String(value.layer),
    environmentBlocked: value.environmentBlocked === true,
    worthRetrying: value.worthRetrying !== false,
    reasoning: redactSecrets(String(value.reasoning)).slice(0, 900),
    evidence: (value.evidence as string[]).map((line) => redactSecrets(line).slice(0, 300)),
    recommendedAction: redactSecrets(String(value.recommendedAction ?? '')).slice(0, 400),
    confidence: typeof value.confidence === 'number' ? value.confidence : 0.5,
  };
}
