import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { redactSecrets } from '../core/redact.js';
import { sha256Of } from '../core/hash.js';
import { IdeaseekError } from '../core/errors.js';
import { assertAgainstSchema } from '../core/schema/index.js';
import { metricIdentifier } from '../core/metric-id.js';
import type { HarnessAdapter } from '../dsh/adapter.js';
import type { LockedProtocol } from '../experiment/protocol-source.js';
import { protocolMetricNames } from '../experiment/protocol-source.js';
import { ideaDir } from './workspace.js';
import type { IdeaCard } from './card.js';

/**
 * Deciding, per idea, which protocol metric each card metric measures.
 *
 * The idea card and the locked protocol are written by two different model
 * calls that were never given a shared vocabulary. Ideation produces prose
 * ("unseen-domain top-1 accuracy (held-out domain)"), the protocol produces an
 * identifier with its definition glued on ("target_unseen_domain_top1_accuracy
 * (held-out domain value, all samples, %)"), and the primary-metric guard in
 * `workflow/autonomy.ts` then refused every `idea experiment` on FDG because
 * the two strings differ — asking a human to "align config/train.json" over a
 * discrepancy the platform created itself.
 *
 * Whether those two names denote the same measurement is a judgement: it turns
 * on the population, the split and the aggregation, which live in sentences.
 * So it is asked of an agent, in the same shape as `diagnose.ts` (quoted
 * evidence or no verdict). What stays deterministic is the boundary: the agent
 * may only pick an identifier it was handed, so it cannot invent a metric name
 * and change what a run claims to measure; and a protocol metric left uncovered
 * keeps blocking, because an experiment that does not produce the primary is
 * not allowed to pass by reassigning the name.
 */
export const METRIC_ALIGNMENT_SCHEMA = 'metric-alignment-v1';

export const METRIC_ALIGNMENT_FILE = 'experiments/metric-alignment.json';

export interface MetricMapping {
  cardMetric: string;
  /** A protocol identifier, or null when the protocol does not define it. */
  protocolMetric: string | null;
  reasoning: string;
  evidence: string[];
  confidence: number;
}

export interface MetricAlignment {
  ideaId: string;
  protocolId: string | null;
  mappings: MetricMapping[];
  unmeasuredProtocolMetrics: string[];
  summary: string;
  createdAt: number;
  alignmentHash: string;
}

export const ALIGNMENT_INSTRUCTION = `You are the Metric Alignment Agent for a research platform. An idea card declares
metric names; the project has a locked protocol that defines the metric identifiers every experiment
must report. Decide, for each card metric, which protocol metric it measures — or none.

Output exactly one JSON object:
{"mappings": [{"cardMetric": string, "protocolMetric": string|null, "reasoning": string,
  "evidence": [string], "confidence": number}],
 "unmeasuredProtocolMetrics": [string], "summary": string}

Rules:
- "protocolMetric" must be one of the identifiers listed in the input, exactly as given, or null.
  Never write a new name, a synonym, or an abbreviation of one you were not given: choosing a name
  is how a primary metric changes silently, and the platform cannot audit a name it has never seen.
- "evidence" must quote text from the protocol definition and/or the card that the verdict rests on,
  verbatim and short. If you cannot quote something that decides it, answer null: an alignment
  without evidence is a guess about what an experiment measured, which is the worst thing this
  platform can record.
- Decide on the measurement, not the string. "unseen-domain top-1 accuracy" and
  "target_unseen_domain_top1_accuracy" are the same metric; a metric averaged over domains and one
  computed on all held-out samples are NOT the same metric even when both are called accuracy.
  Say which of those features decided your answer.
- A card metric may legitimately measure something the protocol does not define (an intermediate
  diagnostic). Then protocolMetric is null and the card metric stays as it is; that is not a failure.
- "unmeasuredProtocolMetrics" lists the protocol identifiers no card metric covers. Do not drop one
  to make the set look complete: a missing primary is the finding, not the noise.
- "summary" is for the researcher who has to act: what aligned, what did not, and what has to be
  revisited (the card, or the protocol deliberately re-locked) when the disagreement is real.`;

function clamp(text: unknown, max: number): string {
  return String(text ?? '')
    .trim()
    .slice(0, max);
}

/** The card's own metric declarations, prose and all — that is what must be judged. */
function cardMetricList(card: IdeaCard): string[] {
  return card.minimalExperiment.metrics.filter((metric) => metric.trim().length > 0);
}

function alignmentInput(card: IdeaCard, protocol: LockedProtocol): string {
  const names = protocolMetricNames(protocol);
  const expectedChange = card.mechanismChain.steps
    .filter((step) => step.kind === 'expected-change')
    .map((step) => step.text);
  return [
    `## idea\n${card.ideaId} v${card.version}\nhypothesis: ${card.hypothesis.statement}`,
    `## what the card expects to change (the sentences that define its measurements)\n${
      expectedChange.join(' | ') || card.novelty.claim
    }`,
    `## card metrics to align (verbatim, exactly as declared)\n${cardMetricList(card)
      .map((metric) => `- ${metric}`)
      .join('\n')}`,
    `## locked protocol ${protocol.protocolId ?? '(unidentified)'} — the ONLY permitted targets\n` +
      [
        ...protocol.primaryMetrics.map(
          (metric) =>
            `- primary ${metric.name} (direction: ${metric.direction}) — identifier: ${metricIdentifier(metric.name)}`,
        ),
        ...protocol.secondaryMetrics.map(
          (metric) =>
            `- secondary ${metric.name} (direction: ${metric.direction}) — identifier: ${metricIdentifier(metric.name)}`,
        ),
      ].join('\n') || '(none)',
    `## protocol split rules (often what distinguishes two lookalike accuracies)\n${
      protocol.splitRules.join('; ') || '(none recorded)'
    }`,
    '',
    `Answer with ${names.length} or fewer mappings per card metric, using the identifiers above.`,
  ].join('\n\n');
}

/**
 * Ask the harness to align one card against one protocol.
 *
 * Returns null when the answer cannot be used at all (unparseable, or the
 * schema rejects it): the caller then keeps the guard's refusal, which is the
 * honest outcome. An alignment invented by the platform to avoid a refusal
 * would be worse than the refusal.
 */
export async function alignIdeaMetrics(opts: {
  harness: HarnessAdapter;
  card: IdeaCard;
  protocol: LockedProtocol;
  ideaId: string;
  runId: string;
}): Promise<MetricAlignment | null> {
  const permitted = protocolMetricNames(opts.protocol).map(metricIdentifier);
  if (permitted.length === 0) return null;
  const input = alignmentInput(opts.card, opts.protocol);
  const result = await opts.harness.runTask({
    runId: opts.runId,
    taskId: `align-metrics-${opts.ideaId}`,
    profile: 'demo',
    instruction: ALIGNMENT_INSTRUCTION,
    inputs: [{ kind: 'text', name: 'card-and-protocol', content: input }],
    outputSchema: METRIC_ALIGNMENT_SCHEMA,
    budget: { timeoutMs: 180_000, maxOutputTokens: 3_000 },
    idempotencyKey: `align-metrics:${opts.ideaId}:${sha256Of(input).slice(7, 23)}`,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.output) as unknown;
  } catch {
    return null;
  }
  const value = (parsed ?? {}) as Record<string, unknown>;
  const mappingsRaw = Array.isArray(value.mappings) ? value.mappings : [];
  const mappings: MetricMapping[] = [];
  for (const entry of mappingsRaw.slice(0, 24)) {
    const record = (entry ?? {}) as Record<string, unknown>;
    const cardMetric = clamp(record.cardMetric, 400);
    if (!cardMetric) continue;
    // The boundary, enforced here rather than asked for: a name outside the
    // protocol's own set is not an alignment, it is a new metric.
    const offered = clamp(record.protocolMetric, 200);
    const protocolMetric = permitted.includes(offered) ? offered : null;
    const evidence = (Array.isArray(record.evidence) ? record.evidence : [])
      .map((line) => clamp(line, 300))
      .filter((line) => line.length > 0)
      .slice(0, 6);
    // An empty evidence list is recorded as such instead of being left empty:
    // the schema requires at least one quoted line, and rejecting the whole
    // answer over one unsupported mapping would throw away the verdicts that
    // *were* supported. `supported` is decided before that note is added, or
    // the placeholder would talk the boundary out of refusing.
    const supported = evidence.length > 0;
    if (!supported) {
      evidence.push('the agent quoted no evidence for this mapping, so it is not applied');
    }
    mappings.push({
      cardMetric,
      // An answer that names a metric but quotes nothing is a guess; null it so
      // the guard still refuses rather than passing on an unsupported mapping.
      protocolMetric: supported ? protocolMetric : null,
      reasoning: redactSecrets(clamp(record.reasoning, 900)),
      evidence: evidence.map(redactSecrets),
      confidence: typeof record.confidence === 'number' ? record.confidence : 0.5,
    });
  }

  const covered = new Set(mappings.map((mapping) => mapping.protocolMetric));
  const unmeasured = new Set(
    (Array.isArray(value.unmeasuredProtocolMetrics) ? value.unmeasuredProtocolMetrics : [])
      .map((name) => clamp(name, 200))
      .filter((name) => permitted.includes(name)),
  );
  // Trust the set difference over the model's list: an agent that forgets to
  // report an uncovered primary must not be able to make one appear.
  for (const name of permitted) if (!covered.has(name)) unmeasured.add(name);

  // The fallback strings are inside the schema's minLength: a placeholder
  // shorter than the contract turns an otherwise usable verdict into a schema
  // rejection, which the caller reads as "the harness returned nothing".
  const fallbackReasoning = 'the agent gave no reasoning for this mapping';
  const fallbackSummary = 'the agent returned no summary for this alignment';
  const candidate = {
    mappings: mappings.map((mapping) => ({
      cardMetric: mapping.cardMetric,
      protocolMetric: mapping.protocolMetric,
      reasoning: mapping.reasoning || fallbackReasoning,
      evidence: mapping.evidence,
      confidence: mapping.confidence,
    })),
    unmeasuredProtocolMetrics: [...unmeasured],
    summary: redactSecrets(clamp(value.summary, 900)) || fallbackSummary,
  };
  try {
    assertAgainstSchema(METRIC_ALIGNMENT_SCHEMA, candidate);
  } catch (error) {
    if (error instanceof IdeaseekError) return null;
    throw error;
  }

  const createdAt = Date.now();
  return {
    ideaId: opts.ideaId,
    protocolId: opts.protocol.protocolId,
    mappings,
    unmeasuredProtocolMetrics: [...unmeasured],
    summary: candidate.summary,
    createdAt,
    alignmentHash: sha256Of(JSON.stringify(candidate)),
  };
}

export async function readMetricAlignment(
  projectRoot: string,
  ideaId: string,
): Promise<MetricAlignment | null> {
  try {
    const stored = JSON.parse(
      await readFile(join(ideaDir(projectRoot, ideaId), METRIC_ALIGNMENT_FILE), 'utf8'),
    ) as MetricAlignment;
    return stored && Array.isArray(stored.mappings) ? stored : null;
  } catch {
    return null;
  }
}

export async function writeMetricAlignment(
  projectRoot: string,
  alignment: MetricAlignment,
): Promise<string> {
  const target = join(ideaDir(projectRoot, alignment.ideaId), METRIC_ALIGNMENT_FILE);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(alignment, null, 2)}\n`, 'utf8');
  return target;
}

/**
 * Lowest agent confidence that may change what an experiment reports.
 *
 * Quoted evidence is not enough on its own. The second real FDG run mapped
 * "in-domain accuracy" onto `average_accuracy_across_folds` and said in its own
 * summary that this was "the looser guess" — the evidence was quoted, the name
 * was permitted, and the mapping was still a claim the agent had flagged as
 * shaky. Confidence is the agent's own assessment of exactly that, so it is the
 * one signal the platform can enforce without pretending to re-judge the
 * science: below this bar the card metric keeps its own name, which the primary
 * metric guard will still refuse if it was the primary — a refused experiment
 * is recoverable, a silently redefined measurement is not.
 */
export const MIN_APPLIED_ALIGNMENT_CONFIDENCE = 0.7;

/**
 * The metric names an experiment should declare: an aligned card metric takes
 * the protocol's identifier, anything else keeps its own identifier part.
 */
export function alignedMetricNames(declared: string[], alignment: MetricAlignment): string[] {
  const byCard = new Map(
    alignment.mappings
      .filter((mapping) => mapping.confidence >= MIN_APPLIED_ALIGNMENT_CONFIDENCE)
      .map((mapping) => [mapping.cardMetric.trim(), mapping.protocolMetric]),
  );
  const out: string[] = [];
  for (const metric of declared) {
    // An unaligned metric keeps its declared string verbatim. Stripping its
    // trailing prose looked harmless and was not: the idea's own code emits the
    // key the card declared, so rewriting `in-domain accuracy (no transfer
    // cost)` to `in-domain accuracy` made the config disagree with the program
    // and the check ladder failed a passing idea. This command renames a metric
    // onto a protocol identifier or leaves it entirely alone.
    const value = byCard.get(metric.trim()) ?? metric;
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

/** Aligned mappings the platform will not act on, for the user to see why. */
export function lowConfidenceMappings(alignment: MetricAlignment): MetricMapping[] {
  return alignment.mappings.filter(
    (mapping) =>
      mapping.protocolMetric !== null && mapping.confidence < MIN_APPLIED_ALIGNMENT_CONFIDENCE,
  );
}

/**
 * The single metric an experiment must report to be comparable at all.
 *
 * Deliberately narrower than `unmeasuredPrimaryMetrics`, and it has to be: the
 * guard in `workflow/autonomy.ts` refuses an experiment when the protocol's
 * FIRST primary metric is absent, and an apply gate that demanded every primary
 * would be stricter than the rule it feeds. That is not hypothetical — the
 * stricter gate blocked the one command able to repair a config it had just
 * refused, leaving names in `config/train.json` that the platform would neither
 * accept nor rewrite. Secondary and additional primaries are reported as
 * information; they are not this command's business to enforce.
 */
export function requiredPrimaryMetric(protocol: LockedProtocol): string | null {
  const first = protocol.primaryMetrics[0];
  return first ? metricIdentifier(first.name) : null;
}

/**
 * Apply an alignment to the idea's experiment config.
 *
 * Only the metric names change, and only to protocol identifiers the agent
 * quoted evidence for. Unaligned card metrics keep their own declared name
 * (minus the prose): an idea's extra diagnostic is still a real metric, and
 * dropping it would quietly narrow what the run claims.
 */
export async function applyMetricAlignment(opts: {
  projectRoot: string;
  ideaId: string;
  declaredMetrics: string[];
  alignment: MetricAlignment;
}): Promise<{ before: string[]; after: string[]; path: string }> {
  const path = join(ideaDir(opts.projectRoot, opts.ideaId), 'config', 'train.json');
  const config = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  const before = opts.declaredMetrics;
  const after = alignedMetricNames(before, opts.alignment);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    await writeFile(path, `${JSON.stringify({ ...config, metrics: after }, null, 2)}\n`, 'utf8');
  }
  return { before, after, path };
}
