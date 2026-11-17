import { sha256Of, type ContentHash } from '../core/hash.js';

/**
 * Unified ExperimentSpec / RunResult contract (docs/DATA_CONTRACTS.md).
 * Every baseline, ablation and idea run records a spec before execution and
 * a result after it, in one shape — so the required-comparison gate and the
 * later idea pipeline consume the same records. The workflow DB is
 * authoritative; files are import/export carriers.
 */

export type ExperimentStatus = 'planned' | 'succeeded' | 'failed' | 'partial' | 'invalid';

export type RunFailureCategory =
  | 'environment'
  | 'dependency'
  | 'data'
  | 'timeout'
  | 'resource'
  | 'code'
  | 'invalid-result'
  | 'unknown';

export interface MetricTarget {
  name: string;
  direction: 'higher' | 'lower';
}

export interface ExperimentEnvironment {
  /** Container image reference, if the run is containerized. */
  image?: string;
  python?: string;
  notes?: string[];
}

export interface ExperimentResources {
  gpus?: number;
  memoryGiB?: number;
}

export interface ExperimentBudget {
  maxMinutes?: number;
  maxRuns?: number;
}

export interface ExperimentSpec {
  /** Stable kebab-case id; version bumps bump the spec in place. */
  specId: string;
  version: number;
  /** Phase 5 idea binding; null for baseline/protocol runs. */
  idea: { ideaId: string; version: number } | null;
  /** Comparison methods this run evaluates (gate input). */
  comparisonIds: string[];
  /** Code provenance: commit sha, or null when uncommitted/local. */
  codeCommit: string | null;
  /** Dataset snapshot identity (dataset-manifest rootHash or snapshot id). */
  dataSnapshotId: string;
  /** Dataset slice refs this run consumes (smoke/quick/standard). */
  sliceIds: string[];
  environment: ExperimentEnvironment;
  /** Argv command executed in the isolated workspace. */
  command: string[];
  metrics: MetricTarget[];
  /** Non-empty seed list (reproducibility). */
  seeds: number[];
  resources: ExperimentResources;
  budget: ExperimentBudget;
  /** Protocol lock binding, when the run belongs to a locked protocol. */
  protocolId: string | null;
  createdAt: number;
}

export interface ResultMetricValue {
  name: string;
  value: number;
  stdev?: number;
  n?: number;
}

/**
 * A control method measured inside the same run: same code, same slice, same
 * seeds as the subject.
 *
 * Idea entries already compute these — the FDG prototype prints
 * `report["baselines"]` — and the platform threw the numbers away, because a
 * baseline could only come from a separate `repro-*` experiment. That left
 * comparisons with one legal source and no data in it ("no same-scale baseline
 * comparison available"), while the run's own control group went unrecorded.
 * An in-run control is admissible evidence precisely because it shares the
 * run's scale; it is NOT the case #23 refused, where another idea's *subject*
 * metric was relabelled as a baseline.
 */
export interface RunBaselineValue {
  methodId: string;
  metric: string;
  value: number;
  stdev?: number;
}

export interface RunFailure {
  category: RunFailureCategory;
  summary: string;
}

export interface RunResult {
  specId: string;
  status: 'succeeded' | 'failed' | 'partial' | 'invalid';
  /** Log references (paths or artifact hashes). */
  logRefs: string[];
  /** Artifact references (hashes or paths). */
  artifactRefs: string[];
  metrics: ResultMetricValue[];
  /** Controls measured by this very run; see `RunBaselineValue`. */
  baselines?: RunBaselineValue[];
  resourcesUsed: { gpuMinutes?: number; peakMemoryGiB?: number };
  /** Required when status is failed/partial/invalid. */
  failure: RunFailure | null;
  startedAt: number;
  finishedAt: number;
  explanation?: string;
}

export interface SpecValidation {
  ok: boolean;
  errors: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pushType(
  errors: string[],
  field: string,
  value: unknown,
  type: 'string' | 'number' | 'boolean',
): boolean {
  if (typeof value !== type || (type === 'number' && !Number.isFinite(value))) {
    errors.push(`${field} must be a ${type}`);
    return false;
  }
  return true;
}

/** Structural validation for an ExperimentSpec (never persists invalid specs). */
export function validateExperimentSpec(value: unknown): SpecValidation {
  const errors: string[] = [];
  if (!isObject(value)) {
    return { ok: false, errors: ['spec must be an object'] };
  }
  if (typeof value.specId !== 'string') {
    errors.push('specId must be a string');
  } else if (!/^[a-z0-9][a-z0-9-]*$/.test(value.specId)) {
    errors.push('specId must be kebab-case');
  }
  if (typeof value.version !== 'number' || !Number.isInteger(value.version) || value.version < 1) {
    errors.push('version must be an integer >= 1');
  }

  if (value.idea !== null && value.idea !== undefined) {
    const idea = value.idea;
    if (!isObject(idea)) {
      errors.push('idea must be null or { ideaId, version }');
    } else {
      pushType(errors, 'idea.ideaId', idea.ideaId, 'string');
      pushType(errors, 'idea.version', idea.version, 'number');
    }
  }

  if (!Array.isArray(value.comparisonIds)) {
    errors.push('comparisonIds must be an array');
  } else if (value.comparisonIds.some((id) => typeof id !== 'string')) {
    errors.push('comparisonIds entries must be strings');
  }

  if (value.codeCommit !== null && typeof value.codeCommit !== 'string') {
    errors.push('codeCommit must be a string or null');
  }
  pushType(errors, 'dataSnapshotId', value.dataSnapshotId, 'string');

  if (!Array.isArray(value.sliceIds)) {
    errors.push('sliceIds must be an array');
  } else if (value.sliceIds.some((id) => typeof id !== 'string')) {
    errors.push('sliceIds entries must be strings');
  }

  if (!isObject(value.environment)) errors.push('environment must be an object');

  if (!Array.isArray(value.command)) {
    errors.push('command must be an argv array');
  } else if (value.command.length === 0 || value.command.some((c) => typeof c !== 'string')) {
    errors.push('command must be a non-empty array of strings');
  }

  if (!Array.isArray(value.metrics)) {
    errors.push('metrics must be an array');
  } else {
    if (value.metrics.length === 0) errors.push('metrics must not be empty');
    for (const [i, metric] of value.metrics.entries()) {
      if (!isObject(metric)) {
        errors.push(`metrics[${i}] must be an object`);
        continue;
      }
      if (typeof metric.name !== 'string' || !metric.name) {
        errors.push(`metrics[${i}].name must be a non-empty string`);
      }
      if (metric.direction !== 'higher' && metric.direction !== 'lower') {
        errors.push(`metrics[${i}].direction must be higher | lower`);
      }
    }
  }

  if (!Array.isArray(value.seeds)) {
    errors.push('seeds must be an array');
  } else if (
    value.seeds.length === 0 ||
    value.seeds.some((s) => typeof s !== 'number' || !Number.isInteger(s))
  ) {
    errors.push('seeds must be a non-empty array of integers');
  }

  if (!isObject(value.resources)) errors.push('resources must be an object');
  if (!isObject(value.budget)) errors.push('budget must be an object');

  if (
    value.protocolId !== null &&
    value.protocolId !== undefined &&
    typeof value.protocolId !== 'string'
  ) {
    errors.push('protocolId must be a string or null');
  }
  pushType(errors, 'createdAt', value.createdAt, 'number');

  return { ok: errors.length === 0, errors };
}

const FAILURE_REQUIRED: readonly RunResult['status'][] = ['failed', 'partial', 'invalid'];

/** Structural validation for a RunResult. */
export function validateRunResult(value: unknown): SpecValidation {
  const errors: string[] = [];
  if (!isObject(value)) {
    return { ok: false, errors: ['result must be an object'] };
  }
  pushType(errors, 'specId', value.specId, 'string');

  const statuses = ['succeeded', 'failed', 'partial', 'invalid'];
  if (typeof value.status !== 'string' || !statuses.includes(value.status)) {
    errors.push(`status must be one of ${statuses.join(' | ')}`);
  }

  for (const field of ['logRefs', 'artifactRefs'] as const) {
    if (!Array.isArray(value[field])) {
      errors.push(`${field} must be an array`);
    } else if (value[field].some((r) => typeof r !== 'string')) {
      errors.push(`${field} entries must be strings`);
    }
  }

  if (!Array.isArray(value.metrics)) {
    errors.push('metrics must be an array');
  } else {
    for (const [i, metric] of value.metrics.entries()) {
      if (!isObject(metric)) {
        errors.push(`metrics[${i}] must be an object`);
        continue;
      }
      if (typeof metric.name !== 'string' || !metric.name) {
        errors.push(`metrics[${i}].name must be a non-empty string`);
      }
      if (typeof metric.value !== 'number' || !Number.isFinite(metric.value)) {
        errors.push(`metrics[${i}].value must be a finite number`);
      }
      if (metric.stdev !== undefined && (typeof metric.stdev !== 'number' || metric.stdev < 0)) {
        errors.push(`metrics[${i}].stdev must be a non-negative number`);
      }
      if (metric.n !== undefined && (!Number.isInteger(metric.n) || (metric.n as number) < 1)) {
        errors.push(`metrics[${i}].n must be an integer >= 1`);
      }
    }
  }

  if (!isObject(value.resourcesUsed)) errors.push('resourcesUsed must be an object');

  // Optional, and strict when present: an in-run control that is not a finite
  // number under a method name would become a baseline the ladder ranks.
  if (value.baselines !== undefined) {
    if (!Array.isArray(value.baselines)) {
      errors.push('baselines must be an array');
    } else {
      // The same ceiling the schema carries, so the two layers cannot disagree
      // about a 25th control (a validator that accepts what the schema rejects
      // breaks the decision-parity rule for this contract).
      if (value.baselines.length > 24) errors.push('baselines must hold at most 24 entries');
      for (const [i, entry] of value.baselines.entries()) {
        if (!isObject(entry)) {
          errors.push(`baselines[${i}] must be an object`);
          continue;
        }
        if (typeof entry.methodId !== 'string' || !entry.methodId.trim()) {
          errors.push(`baselines[${i}].methodId must be a non-empty string`);
        }
        if (typeof entry.metric !== 'string' || !entry.metric.trim()) {
          errors.push(`baselines[${i}].metric must be a non-empty string`);
        }
        if (typeof entry.value !== 'number' || !Number.isFinite(entry.value)) {
          errors.push(`baselines[${i}].value must be a finite number`);
        }
        if (entry.stdev !== undefined && (typeof entry.stdev !== 'number' || entry.stdev < 0)) {
          errors.push(`baselines[${i}].stdev must be a non-negative number`);
        }
      }
    }
  }

  const status = typeof value.status === 'string' ? (value.status as RunResult['status']) : null;
  if (value.failure === null || value.failure === undefined) {
    if (status && FAILURE_REQUIRED.includes(status)) {
      errors.push('failure is required when status is failed | partial | invalid');
    }
  } else if (!isObject(value.failure)) {
    errors.push('failure must be null or { category, summary }');
  } else {
    const categories: RunFailureCategory[] = [
      'environment',
      'dependency',
      'data',
      'timeout',
      'resource',
      'code',
      'invalid-result',
      'unknown',
    ];
    if (
      typeof value.failure.category !== 'string' ||
      !categories.includes(value.failure.category as never)
    ) {
      errors.push(`failure.category must be one of ${categories.join(' | ')}`);
    }
    if (typeof value.failure.summary !== 'string' || !value.failure.summary.trim()) {
      errors.push('failure.summary must be a non-empty string');
    }
  }

  const startedOk = pushType(errors, 'startedAt', value.startedAt, 'number');
  const finishedOk = pushType(errors, 'finishedAt', value.finishedAt, 'number');
  if (startedOk && finishedOk && (value.finishedAt as number) < (value.startedAt as number)) {
    errors.push('finishedAt must be >= startedAt');
  }

  if (value.explanation !== undefined && typeof value.explanation !== 'string') {
    errors.push('explanation must be a string when present');
  }

  return { ok: errors.length === 0, errors };
}

/** Recursively key-sorted JSON so hashes do not depend on key order. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Version identity of a spec: key-order-independent content hash. */
export function computeSpecHash(spec: ExperimentSpec): ContentHash {
  return sha256Of(stableJson(spec));
}

/** Maps a validated result status onto the experiment registry status. */
export function experimentStatusForResult(result: RunResult): ExperimentStatus {
  return result.status;
}
