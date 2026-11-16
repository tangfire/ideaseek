/**
 * The identity of a metric, separated from the prose that describes it.
 *
 * Protocol metric names arrive as free text from `protocol propose` and often
 * carry their measurement definition in parentheses — `target_unseen_domain_
 * top1_accuracy (held-out domain value, all samples, %)`. That text is worth
 * keeping (it is what tells a reader which number was meant) but it is not part
 * of the name: comparing a protocol metric against a spec or a results record
 * by raw string equality asks every producer to reproduce the prose verbatim,
 * and the first real FDG run showed what happens instead — `idea experiment`
 * refused with "protocol primary/secondary metrics missing from the experiment
 * spec: target_unseen_domain_top1_accuracy (held-out domain value, all samples,
 * %)", which no config can ever satisfy.
 *
 * Lives in core because the comparison side and the experiment side both need
 * it; whichever one owns it, the other ends up importing the heavier module for
 * one string rule, and a second copy drifts (that duplication is what produced
 * the metricKey-vs-display-name bug the blueprint prompt had to fix).
 */

/** `name (prose)` → `name`: the identifier part of a protocol metric name. */
export function metricIdentifier(name: string): string {
  return name.replace(/\s*\(.*$/, '').trim();
}

/** Comparison key: identifier, lowercased, non-alphanumerics folded away. */
export function metricKey(name: string): string {
  return metricIdentifier(name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * The value domain a metric name declares, when it declares one.
 *
 * Protocol metric names carry their definition in parentheses, and that
 * definition is where the unit lives:
 * `target_unseen_domain_top1_accuracy (held-out domain value, all samples, %)`
 * says percent. Reading the declared unit out of the name is not a judgement —
 * it is parsing a contract the protocol itself wrote — and without it the
 * platform compared 0.1686 against 18.75 as if one were better than the other
 * and recorded a hypothesis as having lost (docs/PROGRESS 2026-11-16).
 *
 * Returns null when the name says nothing, because "unknown" must stay
 * unknown: guessing percent from a magnitude would quietly redefine whichever
 * number looked odd, which is the failure this exists to prevent.
 */
export type MetricUnit = 'percent' | 'fraction' | 'count' | 'ratio';

export function metricUnit(name: string): MetricUnit | null {
  const definition = name.includes('(') ? name.slice(name.indexOf('(') + 1) : '';
  const haystack = definition.toLowerCase();
  if (haystack.includes('%') || haystack.includes('percent')) return 'percent';
  // A metric that names a proportion without naming a percent is a fraction —
  // `ratio` is kept separate because ratios legitimately exceed 1 (speedup).
  if (/(^|[^a-z])fraction([^a-z]|$)/.test(haystack) || /\bin [01]\b/.test(haystack)) {
    return 'fraction';
  }
  if (/\bcount\b|\bnumber of\b|\brounds\b|\bitems?\b/.test(haystack)) return 'count';
  if (/\bratio\b|\bspeedup\b|\bmultiple[sd]?\b/.test(haystack)) return 'ratio';
  return null;
}

/**
 * Whether a recorded value contradicts the unit its own metric declares.
 *
 * Deliberately narrow: only percent and fraction have bounded ranges that make
 * a contradiction visible (a percent is >1 above 1%, a fraction is not a
 * probability above 1). `null` unit means no opinion, never a pass or a fail.
 */
export function unitViolation(unit: MetricUnit | null, value: number): string | null {
  if (!Number.isFinite(value)) return 'value is not finite';
  if (unit === 'percent' && value >= 0 && value <= 1 && value !== 0) {
    return `declared percent but the recorded value ${value} lies in the 0-1 fraction range`;
  }
  if (unit === 'fraction' && value > 1) {
    return `declared a 0-1 fraction but the recorded value ${value} exceeds it`;
  }
  return null;
}
