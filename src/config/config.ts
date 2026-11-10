import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
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
  inputs: { papersDir: string; datasetsDir: string; comparisonsDir: string };
  runtime: {
    profile: string;
    modelRoute: string;
    containerRuntime: string;
    allowNetwork: boolean;
    defaultDataScale: string;
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
    maxIterationRounds: number;
  };
  policy: {
    requireAllComparisons: boolean;
    requireUserConfirmationBeforeExperiments: boolean;
    allowPaperReimplementation: boolean;
    autoAcceptDiscoveredComparisons: boolean;
  };
}

export const CONFIG_VERSION = 1;

export function defaultConfig(projectName: string): ResolvedConfig {
  return {
    configVersion: CONFIG_VERSION,
    project: { name: projectName, domain: '' },
    research: { question: '', mode: 'auto', ideaLimit: 1, externalSearch: false },
    inputs: { papersDir: 'papers', datasetsDir: 'datasets', comparisonsDir: 'comparisons' },
    runtime: {
      profile: 'headless',
      modelRoute: 'default',
      containerRuntime: 'docker',
      allowNetwork: false,
      defaultDataScale: 'quick',
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
      maxIterationRounds: 3,
    },
    policy: {
      requireAllComparisons: true,
      requireUserConfirmationBeforeExperiments: true,
      allowPaperReimplementation: true,
      autoAcceptDiscoveredComparisons: false,
    },
  };
}

export interface LoadedConfig {
  resolved: ResolvedConfig;
  /** Non-fatal parse/shape problems; `ideaseek doctor` reports them later. */
  warnings: string[];
  existed: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pickNumber(
  source: Record<string, unknown>,
  key: string,
  fallback: number,
  warnings: string[],
  path: string,
) {
  const value = source[key];
  if (value === undefined) return fallback;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  warnings.push(`${path} should be a positive number, using ${fallback}`);
  return fallback;
}

function pickBoolean(source: Record<string, unknown>, key: string, fallback: boolean) {
  const value = source[key];
  return typeof value === 'boolean' ? value : fallback;
}

function pickString(source: Record<string, unknown>, key: string, fallback: string) {
  const value = source[key];
  return typeof value === 'string' ? value : fallback;
}

/**
 * Reads `research.yaml` and merges it over defaults. Unknown top-level keys
 * are reported as warnings (strict rejection happens in `doctor` later, per
 * CONFIG_SPEC: unknown fields must not silently become defaults).
 */
export async function loadConfig(
  paths: ProjectPaths,
  fallbackName?: string,
): Promise<LoadedConfig> {
  const warnings: string[] = [];
  const resolved = defaultConfig(fallbackName ?? 'project');
  let rawText: string;
  try {
    rawText = await readFile(paths.configFile, 'utf8');
  } catch {
    return { resolved, warnings, existed: false };
  }

  let raw: unknown;
  try {
    raw = parse(rawText);
  } catch (error) {
    warnings.push(`research.yaml failed to parse: ${(error as Error).message}`);
    return { resolved, warnings, existed: true };
  }
  const root = asRecord(raw);
  const knownTopLevel = ['project', 'research', 'inputs', 'runtime', 'resources', 'policy'];
  for (const key of Object.keys(root)) {
    if (!knownTopLevel.includes(key)) warnings.push(`unknown research.yaml section: ${key}`);
  }

  const project = asRecord(root.project);
  const research = asRecord(root.research);
  const runtime = asRecord(root.runtime);
  const resources = asRecord(root.resources);
  const policy = asRecord(root.policy);

  resolved.project.name = pickString(project, 'name', resolved.project.name);
  resolved.project.domain = pickString(project, 'domain', resolved.project.domain);
  resolved.research.question = pickString(research, 'question', resolved.research.question);
  resolved.research.mode = pickString(research, 'mode', resolved.research.mode);
  resolved.research.ideaLimit = pickNumber(
    research,
    'idea_limit',
    resolved.research.ideaLimit,
    warnings,
    'research.idea_limit',
  );
  resolved.research.externalSearch = pickBoolean(
    research,
    'external_search',
    resolved.research.externalSearch,
  );
  resolved.runtime.allowNetwork = pickBoolean(
    runtime,
    'allow_network',
    resolved.runtime.allowNetwork,
  );
  resolved.runtime.defaultDataScale = pickString(
    runtime,
    'default_data_scale',
    resolved.runtime.defaultDataScale,
  );
  resolved.runtime.leaseTtlSeconds = pickNumber(
    runtime,
    'lease_ttl_seconds',
    resolved.runtime.leaseTtlSeconds,
    warnings,
    'runtime.lease_ttl_seconds',
  );
  resolved.runtime.heartbeatIntervalSeconds = pickNumber(
    runtime,
    'heartbeat_interval_seconds',
    resolved.runtime.heartbeatIntervalSeconds,
    warnings,
    'runtime.heartbeat_interval_seconds',
  );
  resolved.runtime.maxAttempts = pickNumber(
    runtime,
    'max_attempts',
    resolved.runtime.maxAttempts,
    warnings,
    'runtime.max_attempts',
  );
  resolved.resources.maxParallelAgents = pickNumber(
    resources,
    'max_parallel_agents',
    resolved.resources.maxParallelAgents,
    warnings,
    'resources.max_parallel_agents',
  );
  resolved.resources.maxParallelIdeas = pickNumber(
    resources,
    'max_parallel_ideas',
    resolved.resources.maxParallelIdeas,
    warnings,
    'resources.max_parallel_ideas',
  );
  resolved.policy.requireAllComparisons = pickBoolean(
    policy,
    'require_all_comparisons',
    resolved.policy.requireAllComparisons,
  );

  return { resolved, warnings, existed: true };
}
