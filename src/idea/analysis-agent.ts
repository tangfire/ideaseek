import { sha256Of } from '../core/hash.js';
import { metricIdentifier } from '../core/metric-id.js';
import { redactSecrets } from '../core/redact.js';
import { assertAgainstSchema } from '../core/schema/index.js';
import { loadArisSkill, renderArisSkill } from '../aris/skill.js';
import type { HarnessAdapter } from '../dsh/adapter.js';

/**
 * Asking whether an idea beat its baselines, instead of subtracting numbers.
 *
 * The deterministic ladder in `analysis.ts` decided "effect insufficient:
 * primary target_unseen_domain_top1_accuracy=0.16858931604511102 does not beat
 * best baseline (fedavg=18.75, rethinkfl=0.2209625991904911)". The arithmetic
 * was right. The comparison was not a comparison: one side was a 0-1 fraction
 * and the other a percentage, so no fraction could ever have won, and a
 * hypothesis was written up as having lost. A table of magnitude thresholds
 * would not fix that either — it would be a new magic rule that fires on a
 * legitimate `communication_cost_per_round` of 0.5 MB against 100 KB, and
 * misses the case where two units differ by 1.5x.
 *
 * So the question "are these the same measurement in the same unit, and is the
 * gap meaningful" is asked of an agent, working from the vendored ARIS
 * `analyze-results` skill (which specifies this verdict) and shown the
 * protocol's own metric text. What stays deterministic is verifiable: the
 * enums are closed, a crash is never a scientific failure (that rule stays in
 * `analysis.ts`, which decides whether to call this at all), and every number
 * the verdict cites is re-read from the platform's records — a citation that
 * does not match a recorded value discards the verdict instead of adopting it.
 */
export const ANALYSIS_VERDICT_SCHEMA = 'analysis-verdict-v1';

export const ANALYSIS_SKILL = 'analyze-results';

export interface ComparisonFact {
  source: string;
  metric: string;
  value: number;
  scale: string | null;
  provenance: string;
}

export interface ComparativeVerdict {
  comparable: boolean;
  verdict: 'supported' | 'inconclusive' | 'rejected' | 'invalid-run';
  failureClass: string;
  unitAssessment: string;
  reasoning: string;
  citedValues: { source: string; metric: string; value: number; unit?: string }[];
  evidence: string[];
  recommendedNext: string;
  confidence: number;
}

const clamp = (text: unknown, max: number): string =>
  String(text ?? '')
    .trim()
    .slice(0, max);

function factsBlock(facts: ComparisonFact[]): string {
  return facts
    .map(
      (fact) =>
        `- ${fact.source}: ${fact.metric} = ${fact.value} (scale: ${fact.scale ?? 'undeclared'}; ` +
        `provenance: ${fact.provenance})`,
    )
    .join('\n');
}

const VERDICT_CONTRACT = `Output exactly one JSON object:
{"comparable": boolean, "verdict": "supported"|"inconclusive"|"rejected"|"invalid-run",
 "failureClass": "none"|"engineering"|"environment"|"data"|"resource"|"metric"|"hypothesis"|"effect-insufficient"|"unknown",
 "unitAssessment": string, "reasoning": string,
 "citedValues": [{"source": string, "metric": string, "value": number, "unit": string}],
 "evidence": [string], "recommendedNext": string, "confidence": number}

Rules:
- First decide comparability, then decide the outcome. Two numbers are comparable only if they are
  the same measurement, on the same population and split, aggregated the same way, in the same unit
  and value domain. Different scale (smoke vs quick) is not comparable either.
- If they are not comparable, "comparable" is false and "verdict" is "inconclusive". Never
  "rejected": a hypothesis that was never actually tested cannot be recorded as having lost.
  Say in unitAssessment what differs and what would make them comparable.
- "citedValues" must repeat the numbers you used exactly as given in the facts, with their source.
  The platform re-reads every one of them from its own records and discards the verdict if any
  citation does not match, so do not round, recompute, or recall a number.
- "evidence" must quote text from the protocol metric definitions or the records shown below,
  verbatim. A comparability claim with no quoted definition is a guess about units.
- Percent versus fraction shows up as a value above 1 next to a value at or below 1 for something
  both sides call an accuracy; state it as such, or state why both are already in the same system.
- Do not treat a small difference as insignificant, or a large one as decisive, without saying what
  spread the platform recorded (seeds, scales, ablations) — "insufficient evidence" is a verdict.
- Use ONLY what is shown above. Workspace files, older experiment records, and anything you could
  look up are out of scope: if a number is not in "Recorded values" or the coverage line, do not
  reason from it — the platform already selected the records that count, and citing anything else
  makes this review about history instead of the comparison in front of you.`;

/**
 * What the review is told about the recorded spread.
 *
 * The verdict contract requires the agent to weigh "what spread the platform
 * recorded (seeds, scales, ablations)" — but the context used to list only
 * scales/seeds, so a careful agent could never see that the necessary-
 * component ablations had already degraded the metric as predicted, and
 * "insufficient evidence" became its only safe answer. The ablations join
 * the coverage line as facts to weigh; citations stay limited to `facts`
 * (the platform only re-reads those), so quoting them in citedValues would
 * discard the verdict — context, not citable numbers.
 */
export function buildCoverageText(analysis: {
  coverage: { scales: string[]; datasets: unknown[]; seeds: number; missing: string[] };
  mechanismEvidence: {
    ablationId: string;
    mainValue: number | null;
    ablationValue: number | null;
    supports: boolean | null;
  }[];
}): string {
  const spread =
    analysis.mechanismEvidence.length > 0
      ? analysis.mechanismEvidence
          .map((entry) => {
            const pair = `${entry.mainValue ?? 'n/a'}→${entry.ablationValue ?? 'n/a'}`;
            const flag =
              entry.supports === null
                ? ''
                : entry.supports
                  ? ' [necessary holds]'
                  : ' [NOT as predicted]';
            return `${entry.ablationId} ${pair}${flag}`;
          })
          .join('; ')
      : '(none recorded)';
  return (
    `scales=[${analysis.coverage.scales.join(', ')}] ` +
    `datasets=${analysis.coverage.datasets.length} seeds=${analysis.coverage.seeds} ` +
    `missing=${analysis.coverage.missing.join('; ') || '(none)'} · ` +
    `ablations: ${spread}`
  );
}

/**
 * Ask the agent for the comparative verdict.
 *
 * Returns null when the answer cannot be trusted (unreadable skill, unparseable
 * output, a citation that matches no record): the caller keeps its
 * deterministic verdict and reports that comparability was not established. A
 * discarded agent answer is a lost round; an adopted one is a scientific
 * conclusion.
 */
export async function compareWithAgent(opts: {
  harness: HarnessAdapter;
  ideaId: string;
  runId: string;
  protocolText: string;
  coverageText: string;
  facts: ComparisonFact[];
}): Promise<ComparativeVerdict | null> {
  const skill = await loadArisSkill(ANALYSIS_SKILL).catch(() => null);
  if (!skill) return null;
  const records = opts.facts.filter((fact) => Number.isFinite(fact.value));
  if (records.length === 0) return null;

  const context = [
    `Idea: ${opts.ideaId}`,
    `Protocol metric definitions and comparison rules:\n${opts.protocolText || '(none recorded)'}`,
    `Coverage recorded by the platform:\n${opts.coverageText || '(none)'}`,
    `Recorded values (cite these verbatim in citedValues):\n${factsBlock(records)}`,
  ].join('\n\n');

  const instruction = [
    renderArisSkill(skill, { arguments: context }),
    '',
    '---',
    '',
    VERDICT_CONTRACT,
    '',
    'The task is the comparison of the values above, nothing else.',
  ].join('\n');

  const result = await opts.harness.runTask({
    runId: opts.runId,
    taskId: `analyze-${opts.ideaId}`,
    profile: 'demo',
    instruction,
    inputs: [{ kind: 'text', name: 'recorded-values', content: context }],
    outputSchema: ANALYSIS_VERDICT_SCHEMA,
    budget: { timeoutMs: 180_000, maxOutputTokens: 2_500 },
    idempotencyKey: `analyze:${opts.ideaId}:${sha256Of(context).slice(7, 23)}`,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.output) as unknown;
  } catch {
    return null;
  }
  const value = (parsed ?? {}) as Record<string, unknown>;
  const verdictWord = clamp(value.verdict, 40);
  const failureClass = clamp(value.failureClass, 40);
  const citedRaw = Array.isArray(value.citedValues) ? value.citedValues : [];
  const cited = citedRaw
    .map((entry) => {
      const record = (entry ?? {}) as Record<string, unknown>;
      return {
        source: clamp(record.source, 120),
        metric: clamp(record.metric, 200),
        value: typeof record.value === 'number' ? record.value : Number.NaN,
        unit: clamp(record.unit, 60),
      };
    })
    .filter((entry) => entry.source && entry.metric && Number.isFinite(entry.value));

  // The boundary: every cited number must be one the platform actually has.
  // Matched by metric identifier, because the protocol hands out
  // `target_unseen_domain_top1_accuracy (held-out domain value, all samples, %)`
  // and an agent cites the clean identifier — raw-string matching would
  // discard a correct comparability finding for the same prose-vs-name reason
  // the metric guard was fixed, and the discard would be invisible.
  const key = (source: string, metric: string): string =>
    `${source}\u0000${metricIdentifier(metric)}`;
  const known = new Map(records.map((fact) => [key(fact.source, fact.metric), fact.value]));
  const unmatched = cited.filter(
    (entry) => known.get(key(entry.source, entry.metric)) !== entry.value,
  );
  if (cited.length === 0 || unmatched.length > 0) return null;

  const evidence = (Array.isArray(value.evidence) ? value.evidence : [])
    .map((line) => clamp(line, 300))
    .filter((line) => line.length > 0)
    .slice(0, 6);
  if (evidence.length === 0) {
    evidence.push('the agent quoted no protocol or record text for this verdict');
  }

  const candidate = {
    comparable: value.comparable === true,
    verdict: ['supported', 'inconclusive', 'rejected', 'invalid-run'].includes(verdictWord)
      ? verdictWord
      : 'inconclusive',
    failureClass: [
      'none',
      'engineering',
      'environment',
      'data',
      'resource',
      'metric',
      'hypothesis',
      'effect-insufficient',
      'unknown',
    ].includes(failureClass)
      ? failureClass
      : 'unknown',
    unitAssessment:
      redactSecrets(clamp(value.unitAssessment, 900)) || 'no unit assessment returned by the agent',
    reasoning: redactSecrets(clamp(value.reasoning, 1200)) || 'no reasoning returned by the agent',
    citedValues: cited.map((entry) => ({
      source: entry.source,
      metric: entry.metric,
      value: entry.value,
      ...(entry.unit ? { unit: entry.unit } : {}),
    })),
    evidence,
    recommendedNext: redactSecrets(clamp(value.recommendedNext, 400)),
    confidence:
      typeof value.confidence === 'number' ? Math.min(Math.max(value.confidence, 0), 1) : 0.5,
  };
  try {
    assertAgainstSchema(ANALYSIS_VERDICT_SCHEMA, candidate);
  } catch {
    return null;
  }
  // An agent that finds the numbers incomparable and still writes "rejected"
  // has contradicted its own finding, and "rejected" is the word that ends an
  // idea. Refusing the pair is the safe answer: the caller keeps its
  // deterministic verdict and reports that comparability was not established.
  if (candidate.comparable === false && candidate.verdict === 'rejected') return null;
  return {
    comparable: candidate.comparable,
    verdict: candidate.verdict as ComparativeVerdict['verdict'],
    failureClass: candidate.failureClass,
    unitAssessment: candidate.unitAssessment,
    reasoning: candidate.reasoning,
    citedValues: candidate.citedValues,
    evidence: candidate.evidence,
    recommendedNext: candidate.recommendedNext,
    confidence: candidate.confidence,
  };
}
