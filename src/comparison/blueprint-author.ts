import { sha256Of } from '../core/hash.js';
import { IdeaseekError } from '../core/errors.js';
import { redactSecrets } from '../core/redact.js';
import type { HarnessAdapter } from '../dsh/adapter.js';
import type { ReproductionBlueprint } from './types.js';

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
- algorithm.source must be a single self-contained Python file that reads data, runs the
  method, and prints one JSON line {"metrics": {...}}. It must support the subcommands
  smoke | check-data | check-metrics and must not require GPU to pass smoke.
- algorithm.entry is the ARGV PREFIX used to invoke the file, e.g. ["python","reproduce.py"].
  Never put the subcommands there; smoke/check-data/check-metrics are appended by the runner.
- algorithm.metrics must reuse the locked protocol's primary and secondary metric names
  verbatim when a protocol is supplied. Do not collapse several distinct metrics into one
  generic name; if the protocol lists three, emit three.
- Never claim the reimplementation equals official code.`;

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
  } else {
    parts.push('## locked protocol\n(none — metrics must be proposed as assumptions)');
  }
  if (evidence.corpus) {
    parts.push(
      `## measured corpus\nsamples: ${evidence.corpus.samples}\n` +
        `domain axis: ${evidence.corpus.domainAxis ?? '(none measured)'}\n` +
        `domains: ${evidence.corpus.domains.join(', ') || '(none)'}\n` +
        `classes: ${evidence.corpus.classes}`,
    );
  } else {
    parts.push('## measured corpus\n(not profiled — describe the data interface as an assumption)');
  }
  const joined = parts.join('\n\n');
  return joined.length > MAX_CONTEXT
    ? `${joined.slice(0, MAX_CONTEXT)}\n(context truncated)`
    : joined;
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
