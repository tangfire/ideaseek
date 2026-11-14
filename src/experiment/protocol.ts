/**
 * ExperimentalProtocolProposal contract (docs/DATA_CONTRACTS.md): every rule
 * carries its provenance source and confidence so the platform can tell
 * paper evidence from agent inference, and users only confirm what cannot be
 * safely inferred. Locking makes a confirmed protocol an immutable, hashed
 * version — later changes create a new version instead of mutating history.
 */
import type { SelectionSpec } from './selection.js';

export type ProtocolSource =
  'paper-evidence' | 'code' | 'data-probe' | 'adapter-rule' | 'agent-inference' | 'user';

export const PROTOCOL_SOURCES: readonly ProtocolSource[] = [
  'paper-evidence',
  'code',
  'data-probe',
  'adapter-rule',
  'agent-inference',
  'user',
];

export interface Sourced<T> {
  value: T;
  source: ProtocolSource;
  /** 0..1; agent inferences below 0.7 must be surfaced for user confirmation. */
  confidence: number;
  note?: string;
}

export interface MetricSpec {
  name: string;
  direction: 'higher' | 'lower';
  source: ProtocolSource;
  confidence: number;
}

export interface BaselineEntry {
  methodId: string;
  entry: string;
  source: ProtocolSource;
  confidence: number;
}

export interface ExperimentalProtocolProposal {
  /** proto-<contentHashPrefix>-v<version>. */
  protocolId: string;
  version: number;
  taskDefinition: Sourced<string>;
  sampleUnit: Sourced<string>;
  labelSemantics: Sourced<string>;
  splitRules: Sourced<string[]>;
  /**
   * Machine-readable split intent (docs/DATA_CONTRACTS.md). Optional so
   * proposals from before it existed stay readable; when present the slicer
   * expands it against the measured corpus instead of sampling rows at random.
   */
  slicing?: Sourced<SelectionSpec[]>;
  leakageChecks: string[];
  preprocessing: string[];
  baselineEntries: BaselineEntry[];
  primaryMetrics: MetricSpec[];
  secondaryMetrics: MetricSpec[];
  statisticalSummary: string[];
  smokeTest: Sourced<string>;
  resourceEstimate: Sourced<string>;
  ablations: string[];
  supportCriteria: string[];
  refuteCriteria: string[];
  invalidRunCriteria: string[];
  stopConditions: string[];
  generatedAt: number;
  /** Prompt/schema version of the generator (provenance for invalidation). */
  generator: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  /** Low-confidence agent inferences the user should confirm. */
  confirmations: string[];
}

function checkSourced(
  field: Sourced<unknown>,
  path: string,
  errors: string[],
  confirmations: string[],
): void {
  if (!field || typeof field !== 'object') {
    errors.push(`${path} must be a {value, source, confidence} object`);
    return;
  }
  if (!PROTOCOL_SOURCES.includes(field.source)) {
    errors.push(`${path}.source must be one of: ${PROTOCOL_SOURCES.join(', ')}`);
  }
  if (typeof field.confidence !== 'number' || field.confidence < 0 || field.confidence > 1) {
    errors.push(`${path}.confidence must be within [0, 1]`);
  } else if (field.source === 'agent-inference' && field.confidence < 0.7) {
    confirmations.push(
      `${path}: agent inference with confidence ${field.confidence.toFixed(2)} needs user confirmation`,
    );
  }
  if (field.value === undefined || field.value === null || field.value === '') {
    errors.push(`${path}.value must not be empty`);
  }
  if (Array.isArray(field.value) && field.value.length === 0) {
    errors.push(`${path}.value must not be an empty array`);
  }
}

function checkMetric(metric: MetricSpec, path: string, errors: string[]): void {
  if (!metric || typeof metric !== 'object') {
    errors.push(`${path} must be an object`);
    return;
  }
  if (typeof metric.name !== 'string' || !metric.name) {
    errors.push(`${path}.name must be a non-empty string`);
  }
  if (metric.direction !== 'higher' && metric.direction !== 'lower') {
    errors.push(`${path}.direction must be 'higher' or 'lower'`);
  }
  if (!PROTOCOL_SOURCES.includes(metric.source)) {
    errors.push(`${path}.source must be one of: ${PROTOCOL_SOURCES.join(', ')}`);
  }
}

/**
 * Structural validation of a proposal. Fails on missing provenance, invalid
 * source enums, out-of-range confidence and empty criteria; collects
 * confirmation items for low-confidence agent inferences (never silently
 * promotes them to confirmed rules).
 */
export function validateProtocolProposal(value: unknown): ValidationResult {
  const errors: string[] = [];
  const confirmations: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['protocol proposal must be an object'], confirmations };
  }
  const p = value as Record<string, unknown>;

  if (typeof p.protocolId !== 'string' || !p.protocolId.startsWith('proto-')) {
    errors.push('protocolId must start with proto-');
  }
  if (typeof p.version !== 'number' || p.version < 1) {
    errors.push('version must be a positive number');
  }
  if (typeof p.generator !== 'string' || !p.generator) {
    errors.push('generator (prompt/schema version) is required');
  }
  if (typeof p.generatedAt !== 'number') {
    errors.push('generatedAt must be a timestamp');
  }

  for (const key of [
    'taskDefinition',
    'sampleUnit',
    'labelSemantics',
    'splitRules',
    'smokeTest',
    'resourceEstimate',
  ] as const) {
    checkSourced(p[key] as Sourced<unknown>, key, errors, confirmations);
  }

  if (p.slicing !== undefined) {
    checkSourced(p.slicing as Sourced<unknown>, 'slicing', errors, confirmations);
    const specs = (p.slicing as Sourced<unknown>).value as unknown;
    if (!Array.isArray(specs) || specs.length === 0) {
      errors.push('slicing.value must be a non-empty array of selection specs');
    } else {
      for (const [index, raw] of specs.entries()) {
        const spec = raw as Partial<SelectionSpec>;
        const where = `slicing.value[${index}]`;
        if (!spec || typeof spec !== 'object') {
          errors.push(`${where} must be an object`);
          continue;
        }
        if (typeof spec.fold !== 'string' || !spec.fold.trim()) {
          errors.push(`${where}.fold must be a non-empty label`);
        }
        if (spec.holdoutColumn !== null && typeof spec.holdoutColumn !== 'string') {
          errors.push(`${where}.holdoutColumn must be a column name or null`);
        }
        if (!Array.isArray(spec.holdoutValues)) {
          errors.push(`${where}.holdoutValues must be an array`);
        }
        if (!Number.isInteger(spec.seed)) {
          errors.push(`${where}.seed must be an integer`);
        }
      }
    }
  }

  for (const key of [
    'leakageChecks',
    'preprocessing',
    'statisticalSummary',
    'ablations',
    'supportCriteria',
    'refuteCriteria',
    'invalidRunCriteria',
    'stopConditions',
  ] as const) {
    const list = p[key];
    if (
      !Array.isArray(list) ||
      list.length === 0 ||
      list.some((item) => typeof item !== 'string' || !item)
    ) {
      errors.push(`${key} must be a non-empty array of strings`);
    }
  }

  const primaries = p.primaryMetrics;
  if (!Array.isArray(primaries) || primaries.length === 0) {
    errors.push('primaryMetrics must contain at least one metric');
  } else {
    primaries.forEach((metric, index) =>
      checkMetric(metric as MetricSpec, `primaryMetrics[${index}]`, errors),
    );
  }
  const secondaries = p.secondaryMetrics;
  if (!Array.isArray(secondaries)) {
    errors.push('secondaryMetrics must be an array (may be empty)');
  } else {
    secondaries.forEach((metric, index) =>
      checkMetric(metric as MetricSpec, `secondaryMetrics[${index}]`, errors),
    );
  }

  const baselines = p.baselineEntries;
  if (!Array.isArray(baselines) || baselines.length === 0) {
    errors.push('baselineEntries must contain at least one entry');
  } else {
    baselines.forEach((entry, index) => {
      const typed = entry as BaselineEntry;
      if (!typed || typeof typed.methodId !== 'string' || typeof typed.entry !== 'string') {
        errors.push(`baselineEntries[${index}] needs methodId and entry`);
        return;
      }
      if (!PROTOCOL_SOURCES.includes(typed.source)) {
        errors.push(`baselineEntries[${index}].source invalid`);
      }
    });
  }

  return { ok: errors.length === 0, errors, confirmations };
}

/** Stable content hash of a proposal (canonical JSON, version-independent). */
export async function computeProtocolHash(value: unknown): Promise<string> {
  const { sha256OfJson } = await import('../core/hash.js');
  return sha256OfJson(value);
}

export interface ProtocolLock {
  protocolId: string;
  protocolHash: string;
  lockedAt: number;
  confirmedBy: string;
}

/**
 * Locks a validated proposal: produces an immutable record. Locking rejects
 * invalid proposals and records who confirmed it (user or unattended
 * policy), so reports can distinguish confirmed protocols from drafts.
 */
export async function lockProtocolProposal(
  value: unknown,
  opts: { confirmedBy: string; now: number },
): Promise<ProtocolLock> {
  const validation = validateProtocolProposal(value);
  if (!validation.ok) {
    throw new Error(`cannot lock invalid protocol: ${validation.errors[0]}`);
  }
  const proposal = value as ExperimentalProtocolProposal;
  return {
    protocolId: proposal.protocolId,
    protocolHash: await computeProtocolHash(value),
    lockedAt: opts.now,
    confirmedBy: opts.confirmedBy,
  };
}
