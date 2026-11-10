import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { IdeaseekError } from '../core/errors.js';
import { writeFileAtomic } from '../core/atomic.js';
import { CONFIG_VERSION, loadConfig, type LoadedConfig } from '../config/config.js';
import { isProjectRoot, projectPaths } from '../config/paths.js';
import { detectEnvironment, type EnvironmentReport } from '../runtime/detect.js';
import {
  DEFAULT_EMBEDDING_MODEL,
  embeddingCacheDir,
  installEmbeddingStack,
} from '../retrieval/embeddings.js';
import { action, jsonLine } from './shared.js';

/**
 * Maps ResolvedConfig back onto the research.yaml snake_case file shape so
 * `setup` can persist a normalized, versioned config without losing fields.
 */
function toFileShape(config: LoadedConfig['resolved']): Record<string, unknown> {
  return {
    config_version: CONFIG_VERSION,
    project: { name: config.project.name, domain: config.project.domain },
    research: {
      question: config.research.question,
      mode: config.research.mode,
      idea_limit: config.research.ideaLimit,
      external_search: config.research.externalSearch,
    },
    inputs: {
      papers_dir: config.inputs.papersDir,
      datasets_dir: config.inputs.datasetsDir,
      comparisons_dir: config.inputs.comparisonsDir,
      readonly_datasets: config.inputs.readonlyDatasets,
    },
    runtime: {
      profile: config.runtime.profile,
      model_route: config.runtime.modelRoute,
      container_runtime: config.runtime.containerRuntime,
      allow_network: config.runtime.allowNetwork,
      default_data_scale: config.runtime.defaultDataScale,
      use_embeddings: config.runtime.useEmbeddings,
      embedding_model: config.runtime.embeddingModel,
      lease_ttl_seconds: config.runtime.leaseTtlSeconds,
      heartbeat_interval_seconds: config.runtime.heartbeatIntervalSeconds,
      max_attempts: config.runtime.maxAttempts,
      worker_poll_ms: config.runtime.workerPollMs,
    },
    resources: {
      max_parallel_agents: config.resources.maxParallelAgents,
      max_parallel_ideas: config.resources.maxParallelIdeas,
      max_gpu_hours: config.resources.maxGpuHours,
      max_model_cost: config.resources.maxModelCost,
      max_iteration_rounds: config.resources.maxIterationRounds,
    },
    policy: {
      require_all_comparisons: config.policy.requireAllComparisons,
      require_user_confirmation_before_experiments:
        config.policy.requireUserConfirmationBeforeExperiments,
      allow_paper_reimplementation: config.policy.allowPaperReimplementation,
      auto_accept_discovered_comparisons: config.policy.autoAcceptDiscoveredComparisons,
    },
  };
}

const HEADER = `# IdeaSeek project configuration (docs/CONFIG_SPEC.md).
# Configuration expresses intent and resource bounds. Never store secrets here.
`;

function applyDetection(
  config: LoadedConfig['resolved'],
  env: EnvironmentReport,
): { changed: string[]; notes: string[] } {
  const changed: string[] = [];
  const notes: string[] = [];
  if (env.containerRuntimes.docker.available && config.runtime.containerRuntime !== 'docker') {
    config.runtime.containerRuntime = 'docker';
    changed.push('runtime.container_runtime = docker');
  } else if (
    !env.containerRuntimes.docker.available &&
    env.containerRuntimes.podman.available &&
    config.runtime.containerRuntime === 'docker'
  ) {
    config.runtime.containerRuntime = 'podman';
    changed.push('runtime.container_runtime = podman');
  }
  if (!env.containerRuntimes.docker.available && !env.containerRuntimes.podman.available) {
    notes.push('no container runtime detected; leaving runtime.container_runtime unchanged');
  }
  if (!env.python.available) {
    notes.push('python not detected; install it before Phase 2 paper workers');
  }
  if (!env.gpu.nvidiaSmi.available) {
    notes.push('no GPU visible; Phase 0 runs without one');
  }
  return { changed, notes };
}

export interface SetupOutcome {
  root: string;
  dryRun: boolean;
  wrote: boolean;
  backupPath: string | null;
  changed: string[];
  notes: string[];
  migrationNotes: string[];
  env: EnvironmentReport;
  configPath: string;
}

/**
 * Auto-detects the environment and persists a normalized research.yaml
 * (backup first when replacing an existing file). Shared by `setup` and
 * `start`. Refuses to touch a config with blocking problems.
 */
export async function performSetup(
  cwd: string,
  opts: { dryRun?: boolean; question?: string } = {},
): Promise<SetupOutcome> {
  if (!(await isProjectRoot(cwd))) {
    throw new IdeaseekError('NOT_INITIALIZED', 'no IdeaSeek project here; run: ideaseek init');
  }
  const paths = projectPaths(cwd);
  const configLoad = await loadConfig(paths, cwd.split(/[\\/]/).pop() ?? 'project');
  if (configLoad.errors.length > 0) {
    throw new IdeaseekError(
      'USER_INPUT_REQUIRED',
      `research.yaml has blocking problems; fix them first (ideaseek config explain): ${configLoad.errors[0]}`,
    );
  }
  if (opts.question) {
    configLoad.resolved.research.question = opts.question;
  }

  const env = await detectEnvironment(cwd);
  const detection = applyDetection(configLoad.resolved, env);
  const normalized = `${HEADER}${stringify(toFileShape(configLoad.resolved)).trimEnd()}\n`;
  const currentFile = configLoad.existed ? await readFile(paths.configFile, 'utf8') : null;
  const needsWrite = currentFile !== normalized;

  let backupPath: string | null = null;
  let wrote = false;
  if (needsWrite && !opts.dryRun) {
    if (currentFile !== null) {
      backupPath = `${paths.configFile}.bak-${Date.now()}`;
      await writeFileAtomic(backupPath, currentFile);
    }
    await writeFileAtomic(paths.configFile, normalized);
    wrote = true;
  }

  return {
    root: cwd,
    dryRun: Boolean(opts.dryRun),
    wrote,
    backupPath,
    changed: detection.changed,
    notes: detection.notes,
    migrationNotes: configLoad.migrationNotes,
    env,
    configPath: paths.configFile,
  };
}

export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('auto-detect the environment and persist a normalized research.yaml')
    .option('--dry-run', 'show what would change without writing')
    .option('--question <text>', 'persist this research question into research.yaml')
    .option(
      '--install-embeddings',
      'install the pinned local embedding stack (network required once)',
    )
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (opts: {
          dryRun?: boolean;
          question?: string;
          installEmbeddings?: boolean;
          json?: boolean;
        }) => {
          const cwd = process.cwd();
          const outcome = await performSetup(cwd, opts);
          let embedding: {
            model: string;
            license: string;
            fingerprint: string;
            cacheDir: string;
          } | null = null;
          let embeddingError: string | null = null;
          if (opts.installEmbeddings) {
            try {
              const installed = await installEmbeddingStack({
                knowledgeDir: join(cwd, 'knowledge'),
                modelId: DEFAULT_EMBEDDING_MODEL,
              });
              embedding = installed.manifest;
            } catch (error) {
              embeddingError = `${(error as Error).message} — search keeps using BM25/FTS fallback`;
            }
          }
          const env = outcome.env;

          if (opts.json) {
            process.stdout.write(
              jsonLine({
                root: outcome.root,
                dryRun: outcome.dryRun,
                wrote: outcome.wrote,
                backupPath: outcome.backupPath,
                changed: outcome.changed,
                notes: outcome.notes,
                migrationNotes: outcome.migrationNotes,
                environment: env,
                configPath: outcome.configPath,
                embedding,
                embeddingError,
                embeddingCache: embeddingCacheDir(),
              }),
            );
            return 0;
          }

          process.stdout.write(`setup: ${cwd}\n`);
          process.stdout.write(
            outcome.wrote
              ? `  wrote ${outcome.configPath}${outcome.backupPath ? ` (backup: ${outcome.backupPath})` : ' (created)'}\n`
              : outcome.dryRun
                ? `  would write ${outcome.configPath} (dry-run)\n`
                : `  ${outcome.configPath} already normalized\n`,
          );
          for (const change of outcome.changed) process.stdout.write(`  changed: ${change}\n`);
          for (const note of outcome.notes) process.stdout.write(`  note: ${note}\n`);
          for (const note of outcome.migrationNotes) process.stdout.write(`  migration: ${note}\n`);
          process.stdout.write(
            `  environment: node ${env.node.version} · python ${
              env.python.available ? (env.python.version ?? 'yes') : 'missing'
            } · container ${
              env.containerRuntimes.docker.available || env.containerRuntimes.podman.available
                ? 'yes'
                : 'missing'
            } · gpu ${env.gpu.devices.length}\n`,
          );
          process.stdout.write('  credentials: not configured (Phase 1 wires DSH providers)\n');
          process.stdout.write('next: ideaseek doctor\n');
          return 0;
        },
      ),
    );
}
