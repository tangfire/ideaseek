import { sha256Of } from '../core/hash.js';
import { IdeaseekError } from '../core/errors.js';
import { redactSecrets } from '../core/redact.js';
import type { HarnessAdapter } from '../dsh/adapter.js';
import type { ReproductionBlueprint } from './types.js';
import { metricIdentifier } from './reproduce.js';

/**
 * Produces a ReproductionBlueprint from the papers, so `baseline reproduce`
 * has something to consume. The contract and its validator already existed;
 * nothing generated the input, which made paper reimplementation — the
 * designed route when no official code exists — unreachable in practice.
 *
 * The agent authors the plan; the platform validates it with the same
 * `validateReproductionBlueprint` the reproduce step uses, so a blueprint that
 * would fail later cannot be written now.
 */
export const BLUEPRINT_INSTRUCTION = `You are the Baseline Reproduction Agent. A comparison method has no
official code, so it must be reimplemented from the papers. Author a
reproduction blueprint grounded ONLY in the supplied evidence. Output exactly one JSON object:
{
 "methodId": string,
 "paperExplicit": [{"statement": string, "evidence": string}],
 "assumptions": [string],
 "missingDetails": [string],
 "confidence": "high"|"medium"|"low",
 "algorithm": {
   "source": string,
   "entry": [string],
   "dataInterface": {"description": string},
   "metrics": [{"name": string, "direction": "higher"|"lower"}],
   "hyperparameters": object
 }
}
Rules:
- paperExplicit: only what a paper states outright, each with a locator (paper id + page/quote).
- Anything you supply that the papers do not state goes in assumptions, never in paperExplicit.
- Details the papers omit go in missingDetails — list them; do not silently fill them.
- confidence: high only when paperExplicit alone determines the algorithm; medium when
  assumptions carry real weight; low when missingDetails could change the result.
- algorithm.source: leave it empty (""). This is a PLAN, not a program — a separate call
  (comparison implement) writes the code into the worktree from this plan. Embedding a whole
  Python file in one JSON string field is the fragile shape: it travels as escaped newlines inside
  a JSON value, it hits output-token limits, and a plan gets refused for a bracket instead of for
  bad science. Describe what the program must do in dataInterface, metrics and hyperparameters
  instead.
- algorithm.entry is the ARGV PREFIX used to invoke the file, e.g. ["python","reproduce.py"].
  Never put the subcommands there; smoke/check-data/check-metrics are appended by the runner.
- Only check-data receives a path. The data interface must therefore also be reachable from the
  environment the platform injects into every phase: IDEASEEK_DATA_PATH (the exact selection the
  caller requested), IDEASEEK_DATASET_ROOTS (usable corpus roots, OS path-delimiter separated) and
  IDEASEEK_PROJECT_ROOT. Describe resolution in that order, and say what is checked inside each
  candidate (manifest, expected layout) so a missing corpus is reported as a missing corpus rather
  than as zero samples.
- Do not put an absolute sample count into any check. The measured corpus figure describes the
  full corpus; the checks run on a smaller selected subset, so "expected 9991 +- 499" rejects a
  correct subset as a layout mismatch. Assert structure instead (the layout exists, every declared
  domain is present, labels are readable) and compare counts only against what the handed path
  itself declares — its manifest row count, not a number remembered from profiling.
- algorithm.metrics must reuse the locked protocol's primary and secondary metric names
  verbatim when a protocol is supplied. Do not collapse several distinct metrics into one
  generic name; if the protocol lists three, emit three.
- Never claim the reimplementation equals official code.
- Never degrade into a fake pass. If a dependency, the data or a required
  computation is unavailable, exit non-zero and say why. Do not emit a status
  like "skipped", "ephemeral_passed" or "partial" with exit code 0, and do not
  report metrics that were not actually computed — a smoke run that pretends to
  succeed is worse than one that fails, because everything downstream trusts it.
- Assume the method may run with no third-party packages installed: state in
  assumptions exactly which packages the implementation needs, and keep the
  smoke path honest about whether they were present.
- List those packages again in algorithm.requirements as bare pip requirement
  specs (e.g. ["torch","pillow","scikit-learn"]). The runner builds an isolated
  venv from that list before checking; leave it empty only if the code truly
  needs nothing beyond the standard library.`;

export const BLUEPRINT_OUTPUT_SCHEMA = 'reproduction-blueprint-v1';

const MAX_CONTEXT = 14_000;

export interface BlueprintEvidence {
  methodId: string;
  question: string;
  papers: {
    source: string;
    title: string;
    // PaperCard pages are nullable: a claim can be grounded in a quote whose
    // page the parser could not resolve.
    topClaims: { text: string; page: number | null }[];
  }[];
  protocol: { primaryMetrics: { name: string; direction: string }[]; splitRules: string[] } | null;
  corpus: {
    samples: number;
    domainAxis: string | null;
    domains: string[];
    classes: number;
  } | null;
  /**
   * Feedback from a rejected previous attempt, appended to the context so a
   * corrective retry changes the model's input rather than being the same
   * request again. Without this the retry is a coin flip on identical prompt.
   */
  correction?: string;
}

export function buildBlueprintContext(evidence: BlueprintEvidence): string {
  const parts: string[] = [];
  parts.push(`## method\n${evidence.methodId}`);
  parts.push(`## research question\n${evidence.question || '(none configured)'}`);
  parts.push(
    `## papers (verified PaperCards)\n${
      evidence.papers
        .map(
          (paper) =>
            `- ${paper.source} :: ${paper.title}\n${paper.topClaims
              .slice(0, 6)
              .map(
                (claim) =>
                  `    ${claim.page === null ? 'p?' : `p${claim.page}`}: ${claim.text.slice(0, 220)}`,
              )
              .join('\n')}`,
        )
        .join('\n') || '(none — a blueprint cannot be grounded without papers)'
    }`,
  );
  if (evidence.protocol) {
    parts.push(
      `## locked protocol\nprimary metrics: ${evidence.protocol.primaryMetrics
        .map((metric) => `${metric.name} (${metric.direction})`)
        .join(', ')}\nsplit rules: ${evidence.protocol.splitRules.join(' | ')}`,
    );
    // "reuse verbatim" is an instruction the model can satisfy in spirit and
    // miss in fact; naming the required keys makes the mismatch detectable by
    // the platform's feasibility check instead of a later reproduce run.
    const keys = evidence.protocol.primaryMetrics.map((metric) => metric.name);
    if (keys.length > 0) {
      parts.push(
        `## required output metric keys\nalgorithm.metrics MUST report every one of these names ` +
          `exactly as written: ${keys.map(metricIdentifier).join(', ')}\n` +
          `The locked protocol stores each one with its definition appended in parentheses, e.g. ` +
          `"${keys[0]}" — the name is the part BEFORE the parenthesis, and the parenthetical is ` +
          `documentation, not part of the key. Keep the spelling and underscores of the identifier ` +
          `as given; do not lowercase it or strip its separators. A different-looking identifier ` +
          `(unseen_domain_accuracy for target_unseen_domain_top1_accuracy) is not a substitute: ` +
          `results keyed differently cannot answer the protocol.`,
      );
    }
  } else {
    parts.push('## locked protocol\n(none — metrics must be proposed as assumptions)');
  }
  if (evidence.corpus) {
    parts.push(
      `## measured corpus\nsamples: ${evidence.corpus.samples}\n` +
        `domain axis: ${evidence.corpus.domainAxis ?? '(none measured)'}\n` +
        `domains: ${evidence.corpus.domains.join(', ') || '(none)'}\n` +
        `classes: ${evidence.corpus.classes}\n` +
        `scale: this count is the FULL corpus as profiled. check-data, check-metrics and smoke all ` +
        `run on a subset selected by the platform (runtime.default_data_scale), so the number of ` +
        `samples a check sees is expected to be smaller than this.`,
    );
  } else {
    parts.push('## measured corpus\n(not profiled — describe the data interface as an assumption)');
  }
  const joined = parts.join('\n\n');
  const body =
    joined.length > MAX_CONTEXT ? `${joined.slice(0, MAX_CONTEXT)}\n(context truncated)` : joined;
  // Appended after truncation: a corrective retry whose correction got sliced
  // off is the identical request again, and would silently return the same
  // rejected answer.
  return evidence.correction ? `${body}\n\n## correction required\n${evidence.correction}` : body;
}

export function parseBlueprintOutput(output: string, methodId: string): ReproductionBlueprint {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch (error) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `blueprint output is not JSON: ${(error as Error).message}`,
    );
  }
  const record = (value ?? {}) as Record<string, unknown>;
  // The method id is platform-assigned: a model echoing another id would
  // silently attach this plan to the wrong comparison.
  record.methodId = methodId;
  return record as unknown as ReproductionBlueprint;
}

/** Asks the harness for a blueprint. Validation happens at the call site. */
export async function authorBlueprint(opts: {
  harness: HarnessAdapter;
  evidence: BlueprintEvidence;
  runId: string;
  now: number;
}): Promise<{ blueprint: ReproductionBlueprint; contextHash: string }> {
  const context = buildBlueprintContext(opts.evidence);
  if (opts.evidence.papers.length === 0) {
    throw new IdeaseekError(
      'USER_INPUT_REQUIRED',
      'a reproduction blueprint needs paper evidence — run: ideaseek extract, and register the method with --paper <ref>',
    );
  }
  const result = await opts.harness.runTask({
    runId: opts.runId,
    taskId: `blueprint-${opts.evidence.methodId}`,
    profile: 'experiment-designer',
    instruction: BLUEPRINT_INSTRUCTION,
    inputs: [{ kind: 'text', name: 'reproduction-evidence', content: context }],
    outputSchema: BLUEPRINT_OUTPUT_SCHEMA,
    budget: { timeoutMs: 180_000, maxOutputTokens: 4096 },
    idempotencyKey: `blueprint:${opts.evidence.methodId}:${sha256Of(context).slice(7, 23)}`,
  });
  return {
    blueprint: parseBlueprintOutput(result.output, opts.evidence.methodId),
    contextHash: sha256Of(context),
  };
}

/** Human summary for the review step: what is grounded vs assumed. */
export function describeBlueprint(blueprint: ReproductionBlueprint): string {
  return [
    `confidence: ${blueprint.confidence}`,
    `paper-explicit statements: ${blueprint.paperExplicit.length}`,
    `assumptions: ${blueprint.assumptions.length}`,
    `missing details: ${blueprint.missingDetails.length}`,
    blueprint.missingDetails.length > 0
      ? `  (could change the result: ${redactSecrets(blueprint.missingDetails[0] ?? '').slice(0, 120)})`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}
