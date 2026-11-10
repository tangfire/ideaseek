import type { Command } from 'commander';
import { access } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ensureDir, writeFileAtomic } from '../core/atomic.js';
import { SqliteWorkflowDb } from '../workflow/sqlite.js';
import { isProjectRoot, projectPaths } from '../config/paths.js';
import { action, jsonLine } from './shared.js';

const WORKSPACE_DIRS = [
  'papers',
  'datasets',
  'comparisons',
  'incoming',
  'knowledge',
  'ideas',
  'reports',
  '.research/artifacts/tmp',
  '.research/logs',
] as const;

function researchYaml(name: string): string {
  return `# IdeaSeek project configuration (docs/CONFIG_SPEC.md).
# Configuration expresses intent and resource bounds. Never store secrets here.
config_version: 1
project:
  name: ${name}
  domain: ""
research:
  question: ""
  mode: auto
  idea_limit: 1
  external_search: false
inputs:
  papers_dir: papers
  datasets_dir: datasets
  comparisons_dir: comparisons
runtime:
  profile: headless
  model_route: default
  container_runtime: docker
  allow_network: false
  default_data_scale: quick
  lease_ttl_seconds: 30
  heartbeat_interval_seconds: 8
  max_attempts: 3
  worker_poll_ms: 200
resources:
  max_parallel_agents: 8
  max_parallel_ideas: 2
  max_gpu_hours: 20
  max_model_cost: 50
  max_iteration_rounds: 3
policy:
  require_all_comparisons: true
  require_user_confirmation_before_experiments: true
  allow_paper_reimplementation: true
  auto_accept_discovered_comparisons: false
`;
}

function readmeMd(name: string): string {
  return `# ${name}

IdeaSeek research workspace.

## Layout

- \`papers/\` — put PDFs here (read-only input)
- \`datasets/\` — datasets or symlinks to existing datasets (read-only)
- \`comparisons/<method-id>/\` — comparison papers and optional code
- \`incoming/\` — drop files of unknown type here, then run \`ideaseek scan\`
- \`knowledge/\`, \`ideas/\`, \`reports/\` — platform outputs
- \`.research/\` — workflow database, artifacts, logs (do not edit by hand)

## Commands

\`\`\`bash
ideaseek run --question "your research question"
ideaseek status
ideaseek next
ideaseek pause / resume / continue / cancel
\`\`\`
`;
}

const PROJECT_GITIGNORE = `# IdeaSeek runtime state (database, artifacts, logs)
.research/

# Never commit credentials
.env
.env.*
*.pem
`;
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeIfAbsent(path: string, content: string): Promise<boolean> {
  if (await exists(path)) return false;
  await writeFileAtomic(path, content);
  return true;
}

export interface InitOutcome {
  already: boolean;
  root: string;
  name: string;
  createdDirs: string[];
  createdFiles: string[];
  dbPath: string;
}

/**
 * Idempotent project bootstrap shared by `init` and `start`: creates the
 * workspace directories, writes templates only when absent and registers the
 * project row. Never overwrites user-edited files.
 */
export async function initializeProject(cwd: string, name?: string): Promise<InitOutcome> {
  const paths = projectPaths(cwd);
  const projectName = name ?? basename(cwd);
  if (await isProjectRoot(cwd)) {
    return {
      already: true,
      root: cwd,
      name: projectName,
      createdDirs: [],
      createdFiles: [],
      dbPath: paths.dbFile,
    };
  }

  const createdDirs: string[] = [];
  for (const dir of WORKSPACE_DIRS) {
    await ensureDir(join(cwd, dir));
    createdDirs.push(dir);
  }

  const createdFiles: string[] = [];
  if (await writeIfAbsent(paths.configFile, researchYaml(projectName)))
    createdFiles.push('research.yaml');
  if (await writeIfAbsent(paths.readmeFile, readmeMd(projectName))) createdFiles.push('README.md');
  if (await writeIfAbsent(paths.gitignoreFile, PROJECT_GITIGNORE)) createdFiles.push('.gitignore');

  const db = new SqliteWorkflowDb(paths.dbFile);
  try {
    await db.ensureProject({ root: cwd, name: projectName });
  } finally {
    await db.close();
  }
  return {
    already: false,
    root: cwd,
    name: projectName,
    createdDirs,
    createdFiles,
    dbPath: paths.dbFile,
  };
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('initialize project directories, config template and workflow database')
    .option('--json', 'machine-readable output')
    .option('--name <name>', 'project name (default: directory name)')
    .action(
      action(async (opts: { json?: boolean; name?: string }) => {
        const cwd = process.cwd();
        const outcome = await initializeProject(cwd, opts.name);

        if (outcome.already) {
          // Idempotent: never overwrite existing files or schema.
          if (opts.json) {
            process.stdout.write(
              jsonLine({ initialized: false, root: cwd, reason: 'already initialized' }),
            );
          } else {
            process.stdout.write(`already initialized: ${cwd}\n`);
          }
          return 0;
        }

        if (opts.json) {
          process.stdout.write(
            jsonLine({
              initialized: true,
              root: outcome.root,
              name: outcome.name,
              createdDirs: outcome.createdDirs,
              createdFiles: outcome.createdFiles,
              db: outcome.dbPath,
            }),
          );
        } else {
          process.stdout.write(`initialized IdeaSeek project "${outcome.name}" in ${cwd}\n`);
          process.stdout.write(`  directories: ${outcome.createdDirs.length}\n`);
          process.stdout.write(
            `  created: ${outcome.createdFiles.length ? outcome.createdFiles.join(', ') : '(kept existing files)'}\n`,
          );
          process.stdout.write('next: ideaseek run --question "your research question"\n');
        }
        return 0;
      }),
    );
}

export const initInternals = { WORKSPACE_DIRS, researchYaml, readmeMd, PROJECT_GITIGNORE };
