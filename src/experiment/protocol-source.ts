import { IdeaseekError } from '../core/errors.js';
import {
  metricIdentifier,
  metricUnit,
  METRIC_UNITS,
  type DeclaredMetric,
  type MetricUnit,
} from '../core/metric-id.js';
export { declaredMetric, type DeclaredMetric } from '../core/metric-id.js';

/**
 * Single reader for the project's experimental protocol.
 *
 * Nine call sites each parsed the protocol their own way — from the
 * `protocol-proposal` artifact, from `slicing.value`, from a
 * `knowledge/protocol-lock.json` file that nothing ever writes. The last one
 * made blueprint authoring permanently believe no protocol was locked, so it
 * invented metric names that `baseline reproduce` then correctly refused. One
 * reader removes the whole class: the protocol exists in exactly one place.
 */

export interface LockedProtocol {
  protocolId: string | null;
  /** True when the protocol is confirmed in the lock table, not merely proposed. */
  locked: boolean;
  /**
   * A declared metric, with its identity and unit as FIELDS.
   *
   * The unit used to travel only inside the metric's name — `…top1_accuracy
   * (held-out domain value, all samples, %)` — and every consumer that needed
   * it had to re-read that sentence (`metricUnit`), which is why a comparison
   * could be recorded in percent and judged as a fraction, and why the check
   * that caught it was prose parsing rather than a contract check. The proposal
   * may now declare `unit` explicitly; when it does not, the value is derived
   * from the name and `unitDeclared` says so, because "we inferred your unit"
   * and "you stated your unit" are different facts and the ladder's confidence
   * should depend on which one happened.
   */
  primaryMetrics: DeclaredMetric[];
  secondaryMetrics: DeclaredMetric[];
  splitRules: string[];
  /** Declarative slicing, the input `data slices --from-protocol` expands. */
  slicing: Record<string, unknown>[];
}

export interface ProtocolSourceRuntime {
  db: {
    listArtifactsByKind(kind: string): Promise<{ contentHash: string }[]>;
    getProtocolLock(protocolId: string): Promise<unknown>;
  };
  store: { readFinalText(contentHash: string): Promise<string> };
}

function metricNames(value: unknown): DeclaredMetric[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((metric) => {
      const record = (metric ?? {}) as Record<string, unknown>;
      if (typeof record.name !== 'string' || !record.name.trim()) return null;
      const name = record.name.trim();
      const declared =
        typeof record.unit === 'string' ? (record.unit.trim().toLowerCase() as MetricUnit) : null;
      const unit = declared && METRIC_UNITS.includes(declared) ? declared : metricUnit(name);
      return {
        name,
        direction: String(record.direction ?? 'higher'),
        identifier: metricIdentifier(name),
        unit,
        unitDeclared: declared !== null && METRIC_UNITS.includes(declared),
      };
    })
    .filter((metric): metric is DeclaredMetric => metric !== null);
}

/** The newest proposal wins: protocols are append-only, the last one is current. */
export async function readLockedProtocol(
  runtime: ProtocolSourceRuntime,
): Promise<LockedProtocol | null> {
  const artifacts = await runtime.db.listArtifactsByKind('protocol-proposal');
  const chosen = artifacts[artifacts.length - 1];
  if (!chosen) return null;
  let proposal: Record<string, unknown>;
  try {
    proposal = JSON.parse(await runtime.store.readFinalText(chosen.contentHash)) as Record<
      string,
      unknown
    >;
  } catch (error) {
    throw new IdeaseekError(
      'INVALID_ARTIFACT',
      `the stored protocol-proposal artifact cannot be read: ${(error as Error).message}`,
    );
  }
  const protocolId = typeof proposal.protocolId === 'string' ? proposal.protocolId : null;
  const lockLookup = runtime.db.getProtocolLock?.call(runtime.db, protocolId ?? '');
  const lock = lockLookup ? await lockLookup : null;
  const rules = Array.isArray(proposal.splitRules) ? proposal.splitRules : [];
  const slicing = Array.isArray(proposal.slicing)
    ? ((proposal.slicing as { value?: unknown }).value ?? proposal.slicing)
    : ((proposal.slicing as { value?: unknown } | undefined)?.value ?? []);
  return {
    protocolId,
    locked: protocolId !== null && lock !== null,
    primaryMetrics: metricNames(proposal.primaryMetrics),
    secondaryMetrics: metricNames(proposal.secondaryMetrics),
    splitRules: rules.map(String),
    slicing: Array.isArray(slicing) ? (slicing as Record<string, unknown>[]) : [],
  };
}

export function protocolMetricNames(protocol: LockedProtocol | null): string[] {
  if (!protocol) return [];
  return [
    ...new Set([
      ...protocol.primaryMetrics.map((metric) => metric.name),
      ...protocol.secondaryMetrics.map((metric) => metric.name),
    ]),
  ];
}
