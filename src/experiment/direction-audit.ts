import { sha256Of } from '../core/hash.js';
import { redactSecrets } from '../core/redact.js';
import { assertAgainstSchema } from '../core/schema/index.js';
import { metricIdentifier } from '../core/metric-id.js';
import type { LockedProtocol } from './protocol-source.js';
import type { HarnessAdapter } from '../dsh/adapter.js';

/**
 * Auditing declared metric directions against the metrics' own definitions.
 *
 * Direction is decided once, by a model, during `protocol propose`, and then
 * consumed everywhere as though it were measured fact: `adjustedDelta`, the
 * analysis ladder, ablation folding, paper claims. On the FDG protocol every
 * metric came out `higher` — including "principal-angle mismatch of per-client
 * separating bases", where ~79 degrees means near-orthogonal and is the worst
 * plausible outcome, and a separating-vs-nuisance prototype variance where the
 * whole idea wants the number to fall.
 *
 * There is no deterministic test for this. Catching it requires reading what
 * the metric measures, so the check is an agent question, in the shape that has
 * worked twice already (`diagnose.ts`, `metric-align.ts`): closed enums, quoted
 * evidence required, choices limited to what was handed over. What stays
 * deterministic is the consequence: the platform recomputes the inconsistent
 * list from the findings (a model that forgets one does not make it correct)
 * and refuses to let a flagged metric carry a scientific verdict.
 */
export const DIRECTION_AUDIT_SCHEMA = 'direction-audit-v1';

export interface DirectionFinding {
  metric: string;
  declared: 'higher' | 'lower' | 'unknown';
  consistent: boolean;
  expected: 'higher' | 'lower' | 'unknown' | null;
  reasoning: string;
  evidence: string[];
}

export interface DirectionAudit {
  findings: DirectionFinding[];
  inconsistent: string[];
  summary: string;
  auditHash: string;
}

const DIRECTION_INSTRUCTION = `You are the Metric Direction Auditor for a research platform. A protocol declares, for each
metric, whether higher or lower values are better. That declaration was written by another model and is
now trusted everywhere. Decide, per metric, whether the declared direction matches what the metric
actually measures.

Output exactly one JSON object:
{"findings": [{"metric": string, "declared": "higher"|"lower"|"unknown", "consistent": boolean,
  "expected": "higher"|"lower"|"unknown", "reasoning": string, "evidence": [string]}],
 "inconsistent": [string], "summary": string}

Rules:
- Judge from the definition text only. "mismatch", "error", "loss", "variance of a nuisance direction",
  "cost", "latency", "communication rounds" usually mean lower is better; "accuracy", "recall", "gain",
  "delta over baseline" usually mean higher is better — but the definition decides, not the noun:
  an "accuracy of the predicted variance ordering" is not the same measure as "accuracy".
- "evidence" must quote the definition as given. If the definition does not say which way is better,
  answer consistent=false with expected "unknown": an unspecified direction must not silently become
  "higher", because every downstream comparison will then read a worsening as an improvement.
- Do not correct the protocol's intent or propose new metrics. Report only whether each declared
  direction matches its own definition.
- "inconsistent" lists the metrics you found contradictory. The platform recomputes this list from
  "findings", so an omitted entry does not become correct.
- summary is for the researcher who has to re-lock the protocol: name the metrics, the direction each
  should carry, and what has been misread until then.`;

const clamp = (text: unknown, max: number): string =>
  String(text ?? '')
    .trim()
    .slice(0, max);

function protocolBlock(protocol: LockedProtocol): string {
  const line = (kind: string, metric: { name: string; direction: string }): string =>
    `- [${kind}] ${metric.name} — declared direction: ${metric.direction}`;
  return [
    ...protocol.primaryMetrics.map((metric) => line('primary', metric)),
    ...protocol.secondaryMetrics.map((metric) => line('secondary', metric)),
  ].join('\n');
}

/**
 * Ask the agent to audit the locked protocol's directions.
 *
 * Returns null when the answer cannot be used, so the caller reports that
 * directions were not verified instead of pretending they were.
 */
export async function auditMetricDirections(opts: {
  harness: HarnessAdapter;
  protocol: LockedProtocol;
  runId: string;
}): Promise<DirectionAudit | null> {
  const declared = new Map<string, string>();
  const declaredIdentifiers = new Set<string>();
  for (const metric of [...opts.protocol.primaryMetrics, ...opts.protocol.secondaryMetrics]) {
    declared.set(metricIdentifier(metric.name), metric.direction);
    declared.set(metric.name, metric.direction);
    declaredIdentifiers.add(metricIdentifier(metric.name));
  }
  if (declared.size === 0) return null;
  const context = [
    `Protocol ${opts.protocol.protocolId ?? '(unknown)'} — metric definitions as recorded:`,
    protocolBlock(opts.protocol),
    `Split rules: ${(opts.protocol.splitRules ?? []).join('; ') || '(none)'}`,
  ].join('\n');

  const result = await opts.harness.runTask({
    runId: opts.runId,
    taskId: 'direction-audit',
    profile: 'demo',
    instruction: DIRECTION_INSTRUCTION,
    inputs: [{ kind: 'text', name: 'protocol-metrics', content: context }],
    outputSchema: DIRECTION_AUDIT_SCHEMA,
    budget: { timeoutMs: 180_000, maxOutputTokens: 3_000 },
    idempotencyKey: `directions:${opts.protocol.protocolId ?? 'na'}:${sha256Of(context).slice(7, 23)}`,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.output) as unknown;
  } catch {
    return null;
  }
  const value = (parsed ?? {}) as Record<string, unknown>;
  const findings: DirectionFinding[] = [];
  for (const entry of (Array.isArray(value.findings) ? value.findings : []).slice(0, 32)) {
    const record = (entry ?? {}) as Record<string, unknown>;
    const metric = clamp(record.metric, 200);
    if (!metric) continue;
    const evidence = (Array.isArray(record.evidence) ? record.evidence : [])
      .map((line) => clamp(line, 300))
      .filter((line) => line.length > 0)
      .slice(0, 4);
    const declaredWord = clamp(record.declared, 10);
    const expectedWord = clamp(record.expected, 10);
    findings.push({
      metric,
      declared: ['higher', 'lower'].includes(declaredWord)
        ? (declaredWord as 'higher' | 'lower')
        : 'unknown',
      // A finding with no quote is a guess about the definition, and guesses
      // about definitions are exactly what produced this bug. Refuse it, but do
      // not let the refusal read as "consistent": unverified stays unverified.
      consistent: record.consistent === true && evidence.length > 0,
      expected: ['higher', 'lower'].includes(expectedWord)
        ? (expectedWord as 'higher' | 'lower')
        : evidence.length > 0
          ? 'unknown'
          : null,
      reasoning:
        redactSecrets(clamp(record.reasoning, 700)) || 'no reasoning returned by the audit',
      evidence:
        evidence.length > 0
          ? evidence.map(redactSecrets)
          : ['the audit quoted no definition text, so this direction is unverified'],
    });
  }

  // Recompute the inconsistent set from the findings rather than trusting the
  // model's own list, and add anything the audit did not cover at all: an
  // unexamined declared direction is not a verified one.
  const inconsistent = new Set(
    findings.filter((finding) => !finding.consistent).map((finding) => finding.metric),
  );
  const mentioned = new Set(
    findings.flatMap((finding) => [finding.metric, metricIdentifier(finding.metric)]),
  );
  // Any declared direction the audit never spoke of is unverified, and
  // unverified is not correct. Compared by identifier: the protocol name
  // carries its definition prose and the agent quotes the clean identifier, so
  // matching raw strings would report every examined metric as skipped.
  for (const identifier of declaredIdentifiers) {
    if (!mentioned.has(identifier)) inconsistent.add(identifier);
  }

  const candidate = {
    findings,
    inconsistent: [...inconsistent],
    summary: redactSecrets(clamp(value.summary, 900)) || 'the direction audit returned no summary',
  };
  try {
    assertAgainstSchema(DIRECTION_AUDIT_SCHEMA, candidate);
  } catch {
    return null;
  }
  return {
    findings,
    inconsistent: candidate.inconsistent,
    summary: candidate.summary,
    auditHash: sha256Of(JSON.stringify(candidate)),
  };
}

/** True when the audit flags this metric's declared direction as wrong. */
export function directionIsFlagged(audit: DirectionAudit, metricName: string): boolean {
  const identifier = metricIdentifier(metricName);
  return audit.inconsistent.some(
    (name) => name === metricName || metricIdentifier(name) === identifier,
  );
}
