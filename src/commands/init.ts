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

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('initialize project directories, config template and workflow database')
    .option('--json', 'machine-readable output')
    .option('--name <name>', 'project name (default: directory name)')
    .action(
      action(async (opts: { json?: boolean; name?: string }) => {
        const cwd = process.cwd();
        const paths = projectPaths(cwd);
        const name = opts.name ?? basename(cwd);

        if (await isProjectRoot(cwd)) {
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

        const createdDirs: string[] = [];
        for (const dir of WORKSPACE_DIRS) {
          await ensureDir(join(cwd, dir));
          createdDirs.push(dir);
        }

        const createdFiles: string[] = [];
        if (await writeIfAbsent(paths.configFile, researchYaml(name)))
          createdFiles.push('research.yaml');
        if (await writeIfAbsent(paths.readmeFile, readmeMd(name))) createdFiles.push('README.md');
        if (await writeIfAbsent(paths.gitignoreFile, PROJECT_GITIGNORE))
          createdFiles.push('.gitignore');

        const db = new SqliteWorkflowDb(paths.dbFile);
        try {
          await db.ensureProject({ root: cwd, name });
        } finally {
          await db.close();
        }

        if (opts.json) {
          process.stdout.write(
            jsonLine({
              initialized: true,
              root: cwd,
              name,
              createdDirs,
              createdFiles,
              db: paths.dbFile,
            }),
          );
        } else {
          process.stdout.write(`initialized IdeaSeek project "${name}" in ${cwd}\n`);
          process.stdout.write(`  directories: ${createdDirs.length}\n`);
          process.stdout.write(
            `  created: ${createdFiles.length ? createdFiles.join(', ') : '(kept existing files)'}\n`,
          );
          process.stdout.write('next: ideaseek run --question "your research question"\n');
        }
        return 0;
      }),
    );
}

export const initInternals = { WORKSPACE_DIRS, researchYaml, readmeMd, PROJECT_GITIGNORE };
