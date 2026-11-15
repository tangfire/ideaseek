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
