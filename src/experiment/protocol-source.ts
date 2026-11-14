import { IdeaseekError } from '../core/errors.js';

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
  primaryMetrics: { name: string; direction: string }[];
  secondaryMetrics: { name: string; direction: string }[];
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

function metricNames(value: unknown): { name: string; direction: string }[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((metric) => {
      const record = (metric ?? {}) as Record<string, unknown>;
      return typeof record.name === 'string' && record.name.trim()
        ? { name: record.name.trim(), direction: String(record.direction ?? 'higher') }
        : null;
    })
    .filter((metric): metric is { name: string; direction: string } => metric !== null);
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
