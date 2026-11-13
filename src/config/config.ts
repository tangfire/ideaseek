import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { IdeaseekError } from '../core/errors.js';
import type { ProjectPaths } from './paths.js';

/**
 * Resolved, versioned configuration snapshot (docs/CONFIG_SPEC.md).
 * Stored JSON-identically inside every run so a run stays auditable after the
 * user edits `research.yaml`. Never contains secrets.
 */
export interface ResolvedConfig {
  configVersion: number;
  project: { name: string; domain: string };
  research: {
    question: string;
    mode: string;
    ideaLimit: number;
    externalSearch: boolean;
  };
  inputs: {
    papersDir: string;
    datasetsDir: string;
    comparisonsDir: string;
    /** Absolute external dataset roots mounted read-only (never copied, never written). */
    readonlyDatasets: string[];
  };
  runtime: {
    profile: string;
    modelRoute: string;
    containerRuntime: string;
    allowNetwork: boolean;
    defaultDataScale: string;
    /** Optional local embedding layer; FTS is always the base retrieval. */
    useEmbeddings: boolean;
    embeddingModel: string;
    leaseTtlSeconds: number;
    heartbeatIntervalSeconds: number;
    maxAttempts: number;
    workerPollMs: number;
  };
  resources: {
    maxParallelAgents: number;
    maxParallelIdeas: number;
    maxGpuHours: number;
    maxModelCost: number;
    /** USD per million tokens (input/output). null = dollar ceiling not enforced. */
    modelRates: { inputPerMtok: number; outputPerMtok: number } | null;
    maxIterationRounds: number;
  };
  policy: {
    requireAllComparisons: boolean;
    requireUserConfirmationBeforeExperiments: boolean;
    allowPaperReimplementation: boolean;
    autoAcceptDiscoveredComparisons: boolean;
    /** guided (default) | autonomous | review-only — docs/AUTONOMY_POLICY.md */
    autonomyMode: string;
  };
}

export const CONFIG_VERSION = 1;

/** Where each effective value came from, keyed by dotted path. */
export type ConfigSource = 'default' | 'file';
export type ConfigSources = Record<string, ConfigSource>;

export interface LoadedConfig {
  resolved: ResolvedConfig;
  /** Blocking problems (unknown fields, bad types): `run` refuses to start. */
  errors: string[];
  /** Recoverable oddities reported by `doctor`. */
  warnings: string[];
  sources: ConfigSources;
  /** Migration notes, e.g. missing config_version stamped in memory. */
  migrationNotes: string[];
  existed: boolean;
  path: string;
}

export function defaultConfig(projectName: string): ResolvedConfig {
  return {
    configVersion: CONFIG_VERSION,
    project: { name: projectName, domain: '' },
    research: { question: '', mode: 'auto', ideaLimit: 1, externalSearch: false },
    inputs: {
      papersDir: 'papers',
      datasetsDir: 'datasets',
      comparisonsDir: 'comparisons',
      readonlyDatasets: [],
    },
    runtime: {
      profile: 'headless',
      modelRoute: 'default',
      containerRuntime: 'docker',
      allowNetwork: false,
      defaultDataScale: 'quick',
      useEmbeddings: true,
      embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2',
      leaseTtlSeconds: 30,
      heartbeatIntervalSeconds: 8,
      maxAttempts: 3,
      workerPollMs: 200,
    },
    resources: {
      maxParallelAgents: 8,
      maxParallelIdeas: 2,
      maxGpuHours: 20,
      maxModelCost: 50,
      modelRates: null,
      maxIterationRounds: 3,
    },
    policy: {
      requireAllComparisons: true,
      requireUserConfirmationBeforeExperiments: true,
      allowPaperReimplementation: true,
      autoAcceptDiscoveredComparisons: false,
      autonomyMode: 'guided',
    },
  };
}

/** Known research.yaml keys per section (docs/CONFIG_SPEC.md). */
const SHAPE: Record<string, readonly string[]> = {
  project: ['name', 'domain'],
  research: ['question', 'mode', 'idea_limit', 'external_search'],
  inputs: ['papers_dir', 'datasets_dir', 'comparisons_dir', 'readonly_datasets'],
  runtime: [
    'profile',
    'model_route',
    'container_runtime',
    'allow_network',
    'default_data_scale',
    'use_embeddings',
    'embedding_model',
    'lease_ttl_seconds',
    'heartbeat_interval_seconds',
    'max_attempts',
    'worker_poll_ms',
  ],
  resources: [
    'max_parallel_agents',
    'max_parallel_ideas',
    'max_gpu_hours',
    'max_model_cost',
    'model_rates',
    'max_iteration_rounds',
  ],
  policy: [
    'require_all_comparisons',
    'require_user_confirmation_before_experiments',
    'allow_paper_reimplementation',
    'auto_accept_discovered_comparisons',
    'autonomy_mode',
  ],
};

const TOP_LEVEL = ['config_version', ...Object.keys(SHAPE)];

const ENUMS: Record<string, readonly string[]> = {
  'research.mode': ['auto', 'starter', 'standard', 'research'],
  'runtime.default_data_scale': ['smoke', 'quick', 'standard'],
  'policy.autonomy_mode': ['guided', 'autonomous', 'review-only'],
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

type CoerceResult<T> = { ok: true; value: T } | { ok: false; message: string };

function coerceString(path: string, raw: unknown): CoerceResult<string> {
  return typeof raw === 'string'
    ? { ok: true, value: raw }
    : { ok: false, message: `${path} must be a string` };
}

function coerceBoolean(path: string, raw: unknown): CoerceResult<boolean> {
  return typeof raw === 'boolean'
    ? { ok: true, value: raw }
    : { ok: false, message: `${path} must be true or false` };
}

function coercePositiveNumber(path: string, raw: unknown): CoerceResult<number> {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0
    ? { ok: true, value: raw }
    : { ok: false, message: `${path} must be a positive number` };
}

/**
 * Validates the raw tree against the schema. Unknown sections/keys and wrong
 * types are errors: per CONFIG_SPEC they must warn and refuse to run instead
 * of silently becoming defaults.
 */
export function validateRawConfig(raw: unknown): string[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return raw === undefined ? [] : ['research.yaml must contain a mapping at the top level'];
  }
  const errors: string[] = [];
  const root = raw as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (!TOP_LEVEL.includes(key)) errors.push(`unknown research.yaml key: ${key}`);
  }
  for (const [sectionName, knownKeys] of Object.entries(SHAPE)) {
    const sectionValue = root[sectionName];
    if (sectionValue === undefined) continue;
    if (typeof sectionValue !== 'object' || sectionValue === null || Array.isArray(sectionValue)) {
      errors.push(`${sectionName} must be a mapping`);
      continue;
    }
    for (const key of Object.keys(sectionValue as Record<string, unknown>)) {
      if (!knownKeys.includes(key)) errors.push(`unknown key: ${sectionName}.${key}`);
    }
  }
  if (root.config_version !== undefined && typeof root.config_version !== 'number') {
    errors.push('config_version must be a number');
  }
  for (const [path, allowed] of Object.entries(ENUMS)) {
    const dot = path.indexOf('.');
    const sectionName = path.slice(0, dot);
    const key = path.slice(dot + 1);
    const section = asRecord(root[sectionName]);
    const value = section[key];
    if (value !== undefined && (typeof value !== 'string' || !allowed.includes(value))) {
      errors.push(`${path} must be one of: ${allowed.join(', ')}`);
    }
  }
  return errors;
}

export interface MigrationOutcome {
  raw: Record<string, unknown>;
  notes: string[];
}

/**
 * Brings a config tree up to CONFIG_VERSION. Older/missing versions are
 * upgraded in memory (the file is rewritten only by an explicit setup run);
 * newer versions stop instead of guessing.
 */
export function migrateConfig(raw: unknown): MigrationOutcome {
  const root = { ...asRecord(raw) };
  const notes: string[] = [];
  const version = typeof root.config_version === 'number' ? root.config_version : 0;
  if (version > CONFIG_VERSION) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `research.yaml has config_version ${version}, but this ideaseek only understands up to ${CONFIG_VERSION}; upgrade ideaseek instead of guessing`,
      { fileVersion: version, supported: CONFIG_VERSION },
    );
  }
  if (version < CONFIG_VERSION) {
    notes.push(
      version === 0
        ? 'research.yaml has no config_version; treated as v1 in memory'
        : `migrated research.yaml from v${version} to v${CONFIG_VERSION} in memory`,
    );
    root.config_version = CONFIG_VERSION;
  }
  return { raw: root, notes };
}

/**
 * Reads `research.yaml`, migrates it in memory, validates it and merges it
 * over defaults. User-authored problems are returned (never thrown) so
 * `doctor` can explain them and `run` can refuse.
 */
export async function loadConfig(
  paths: ProjectPaths,
  fallbackName?: string,
): Promise<LoadedConfig> {
  const path = paths.configFile;
  const resolved = defaultConfig(fallbackName ?? 'project');
  const sources: ConfigSources = {};
  const warnings: string[] = [];
  const errors: string[] = [];
  const migrationNotes: string[] = [];

  const fillDefaults = () => {
    for (const sectionName of Object.keys(SHAPE)) {
      for (const key of SHAPE[sectionName] ?? []) {
        sources[`${sectionName}.${key}`] = 'default';
      }
    }
  };

  let rawText: string;
  try {
    rawText = await readFile(path, 'utf8');
  } catch {
    fillDefaults();
    return {
      resolved,
      warnings,
      errors,
      sources,
      migrationNotes,
      existed: false,
      path,
    };
  }

  let parsed: unknown;
  try {
    parsed = parse(rawText);
  } catch (error) {
    return {
      resolved,
      warnings,
      errors: [`research.yaml failed to parse: ${(error as Error).message}`],
      sources,
      migrationNotes,
      existed: true,
      path,
    };
  }

  errors.push(...validateRawConfig(parsed));
  let migrated: MigrationOutcome;
  try {
    migrated = migrateConfig(parsed);
  } catch (error) {
    errors.push((error as Error).message);
    return { resolved, warnings, errors, sources, migrationNotes, existed: true, path };
  }
  migrationNotes.push(...migrated.notes);

  const root = migrated.raw;
  const sections = {
    project: asRecord(root.project),
    research: asRecord(root.research),
    inputs: asRecord(root.inputs),
    runtime: asRecord(root.runtime),
    resources: asRecord(root.resources),
    policy: asRecord(root.policy),
  };

  /** Reads one leaf, records its source, and pushes type errors. */
  const take = <T>(
    section: keyof typeof sections,
    key: string,
    fallback: T,
    coerce: (path: string, raw: unknown) => CoerceResult<T>,
  ): T => {
    const fullPath = `${section}.${key}`;
    const raw = sections[section][key];
    if (raw === undefined) {
      sources[fullPath] = 'default';
      return fallback;
    }
    sources[fullPath] = 'file';
    const result = coerce(fullPath, raw);
    if (!result.ok) {
      errors.push(result.message);
      return fallback;
    }
    return result.value;
  };

  resolved.project.name = take('project', 'name', resolved.project.name, coerceString);
  resolved.project.domain = take('project', 'domain', resolved.project.domain, coerceString);
  resolved.research.question = take(
    'research',
    'question',
    resolved.research.question,
    coerceString,
  );
  resolved.research.mode = take('research', 'mode', resolved.research.mode, (path, raw) => {
    const base = coerceString(path, raw);
    if (!base.ok) return base;
    return ENUMS['research.mode']!.includes(base.value)
      ? base
      : { ok: false, message: `${path} must be one of: ${ENUMS['research.mode']!.join(', ')}` };
  });
  resolved.research.ideaLimit = take(
    'research',
    'idea_limit',
    resolved.research.ideaLimit,
    coercePositiveNumber,
  );
  resolved.research.externalSearch = take(
    'research',
    'external_search',
    resolved.research.externalSearch,
    coerceBoolean,
  );

  const readonlyRaw = sections.inputs.readonly_datasets;
  if (readonlyRaw === undefined) {
    sources['inputs.readonly_datasets'] = 'default';
  } else if (
    Array.isArray(readonlyRaw) &&
    readonlyRaw.every((item) => typeof item === 'string' && item.length > 0)
  ) {
    sources['inputs.readonly_datasets'] = 'file';
    resolved.inputs.readonlyDatasets = readonlyRaw as string[];
  } else {
    sources['inputs.readonly_datasets'] = 'file';
    errors.push('inputs.readonly_datasets must be an array of non-empty absolute paths');
  }
  resolved.inputs.papersDir = take('inputs', 'papers_dir', resolved.inputs.papersDir, coerceString);
  resolved.inputs.datasetsDir = take(
    'inputs',
    'datasets_dir',
    resolved.inputs.datasetsDir,
    coerceString,
  );
  resolved.inputs.comparisonsDir = take(
    'inputs',
    'comparisons_dir',
    resolved.inputs.comparisonsDir,
    coerceString,
  );

  resolved.runtime.profile = take('runtime', 'profile', resolved.runtime.profile, coerceString);
  resolved.runtime.modelRoute = take(
    'runtime',
    'model_route',
    resolved.runtime.modelRoute,
    coerceString,
  );
  resolved.runtime.containerRuntime = take(
    'runtime',
    'container_runtime',
    resolved.runtime.containerRuntime,
    coerceString,
  );
  resolved.runtime.allowNetwork = take(
    'runtime',
    'allow_network',
    resolved.runtime.allowNetwork,
    coerceBoolean,
  );
  resolved.runtime.defaultDataScale = take(
    'runtime',
    'default_data_scale',
    resolved.runtime.defaultDataScale,
    (path, raw) => {
      const base = coerceString(path, raw);
      if (!base.ok) return base;
      return ENUMS['runtime.default_data_scale']!.includes(base.value)
        ? base
        : {
            ok: false,
            message: `${path} must be one of: ${ENUMS['runtime.default_data_scale']!.join(', ')}`,
          };
    },
  );
  resolved.runtime.useEmbeddings = take(
    'runtime',
    'use_embeddings',
    resolved.runtime.useEmbeddings,
    coerceBoolean,
  );
  resolved.runtime.embeddingModel = take(
    'runtime',
    'embedding_model',
    resolved.runtime.embeddingModel,
    coerceString,
  );
  resolved.runtime.leaseTtlSeconds = take(
    'runtime',
    'lease_ttl_seconds',
    resolved.runtime.leaseTtlSeconds,
    coercePositiveNumber,
  );
  resolved.runtime.heartbeatIntervalSeconds = take(
    'runtime',
    'heartbeat_interval_seconds',
    resolved.runtime.heartbeatIntervalSeconds,
    coercePositiveNumber,
  );
  resolved.runtime.maxAttempts = take(
    'runtime',
    'max_attempts',
    resolved.runtime.maxAttempts,
    coercePositiveNumber,
  );
  resolved.runtime.workerPollMs = take(
    'runtime',
    'worker_poll_ms',
    resolved.runtime.workerPollMs,
    coercePositiveNumber,
  );

  resolved.resources.maxParallelAgents = take(
    'resources',
    'max_parallel_agents',
    resolved.resources.maxParallelAgents,
    coercePositiveNumber,
  );
  resolved.resources.maxParallelIdeas = take(
    'resources',
    'max_parallel_ideas',
    resolved.resources.maxParallelIdeas,
    coercePositiveNumber,
  );
  resolved.resources.maxGpuHours = take(
    'resources',
    'max_gpu_hours',
    resolved.resources.maxGpuHours,
    coercePositiveNumber,
  );
  resolved.resources.maxModelCost = take(
    'resources',
    'max_model_cost',
    resolved.resources.maxModelCost,
    coercePositiveNumber,
  );
  const ratesRaw = sections.resources.model_rates;
  if (ratesRaw === undefined || ratesRaw === null) {
    resolved.resources.modelRates = null;
    sources['resources.model_rates'] = 'default';
  } else if (typeof ratesRaw === 'object' && !Array.isArray(ratesRaw)) {
    const input = (ratesRaw as Record<string, unknown>).input_per_mtok;
    const output = (ratesRaw as Record<string, unknown>).output_per_mtok;
    if (
      typeof input === 'number' &&
      Number.isFinite(input) &&
      input >= 0 &&
      typeof output === 'number' &&
      Number.isFinite(output) &&
      output >= 0
    ) {
      resolved.resources.modelRates = { inputPerMtok: input, outputPerMtok: output };
      sources['resources.model_rates'] = 'file';
    } else {
      resolved.resources.modelRates = null;
      sources['resources.model_rates'] = 'file';
      errors.push(
        'resources.model_rates must be {input_per_mtok: number >= 0, output_per_mtok: number >= 0}',
      );
    }
  } else {
    resolved.resources.modelRates = null;
    sources['resources.model_rates'] = 'file';
    errors.push('resources.model_rates must be a mapping or null');
  }
  resolved.resources.maxIterationRounds = take(
    'resources',
    'max_iteration_rounds',
    resolved.resources.maxIterationRounds,
    coercePositiveNumber,
  );

  resolved.policy.requireAllComparisons = take(
    'policy',
    'require_all_comparisons',
    resolved.policy.requireAllComparisons,
    coerceBoolean,
  );
  resolved.policy.requireUserConfirmationBeforeExperiments = take(
    'policy',
    'require_user_confirmation_before_experiments',
    resolved.policy.requireUserConfirmationBeforeExperiments,
    coerceBoolean,
  );
  resolved.policy.allowPaperReimplementation = take(
    'policy',
    'allow_paper_reimplementation',
    resolved.policy.allowPaperReimplementation,
    coerceBoolean,
  );
  resolved.policy.autoAcceptDiscoveredComparisons = take(
    'policy',
    'auto_accept_discovered_comparisons',
    resolved.policy.autoAcceptDiscoveredComparisons,
    coerceBoolean,
  );
  resolved.policy.autonomyMode = take(
    'policy',
    'autonomy_mode',
    resolved.policy.autonomyMode,
    (path, raw) => {
      const base = coerceString(path, raw);
      if (!base.ok) return base;
      return ENUMS['policy.autonomy_mode']!.includes(base.value)
        ? base
        : {
            ok: false,
            message: `${path} must be one of: ${ENUMS['policy.autonomy_mode']!.join(', ')}`,
          };
    },
  );

  resolved.configVersion = CONFIG_VERSION;
  sources['config_version'] = migrationNotes.length > 0 ? 'default' : 'file';

  // Enums are checked both structurally and leaf-wise; report each once.
  return {
    resolved,
    warnings,
    errors: [...new Set(errors)],
    sources,
    migrationNotes,
    existed: true,
    path,
  };
}

/** True when the config is safe for `run`/`worker` to execute. */
export function configIsUsable(config: LoadedConfig): boolean {
  return config.errors.length === 0;
}
