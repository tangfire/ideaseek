import type { Command } from 'commander';
import { basename } from 'node:path';
import { detectEnvironment } from '../runtime/detect.js';
import { initializeProject } from './init.js';
import { performScan } from './inputs.js';
import { performSetup } from './setup.js';
import { action, jsonLine } from './shared.js';

/**
 * `ideaseek start` — the one-stop bootstrap for new users (docs/plan.md §4):
 * initialize the project if needed, persist the research question, normalize
 * the config from auto-detection, build the first input manifest, then print
 * the environment summary and the exact next command. Phase 0 stops before
 * executing workflows; `run` remains the explicit, budget-relevant action.
 */
export function registerStartCommand(program: Command): void {
  program
    .command('start')
    .description('one-stop bootstrap: init + setup + first scan, then tell you what to do next')
    .option('-q, --question <text>', 'research question to persist into research.yaml')
    .option('--name <name>', 'project name when initializing (default: directory name)')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { question?: string; name?: string; json?: boolean }) => {
        const cwd = process.cwd();
        const init = await initializeProject(cwd, opts.name ?? basename(cwd));
        const setup = await performSetup(cwd, { question: opts.question });
        const scan = await performScan(cwd);
        const env = await detectEnvironment(cwd);

        const question = opts.question ?? '';
        const nextCommand =
          scan.files > 0 && !question
            ? 'ideaseek run'
            : `ideaseek run --question "${question || '你的研究问题'}"`;
        const guidance = scan.files
          ? '输入已就绪，可以创建工作流（demo 管线会先跑通恢复链路）'
          : '把论文放入 papers/、数据放入 datasets/（可选对比方法放 comparisons/），再启动 run';

        if (opts.json) {
          process.stdout.write(
            jsonLine({
              created: !init.already,
              alreadyInitialized: init.already,
              root: init.root,
              name: init.name,
              question: opts.question ?? null,
              setup: {
                wrote: setup.wrote,
                backupPath: setup.backupPath,
                changed: setup.changed,
                notes: setup.notes,
              },
              scan: {
                files: scan.files,
                groups: scan.groups,
                byRole: scan.byRole,
                manifest: scan.manifestPath,
              },
              environment: {
                node: env.node,
                python: env.python.available,
                container:
                  env.containerRuntimes.docker.available || env.containerRuntimes.podman.available,
                gpu: env.gpu.devices.length,
                cuda: env.gpu.cudaVersion,
              },
              next: nextCommand,
            }),
          );
          return 0;
        }

        process.stdout.write(`ideaseek start → ${init.root}\n`);
        process.stdout.write(
          `  project: ${init.name} ${init.already ? '(already initialized)' : '(created)'}\n`,
        );
        if (opts.question) process.stdout.write(`  question saved: ${opts.question}\n`);
        process.stdout.write(
          `  config: ${setup.configPath} ${setup.wrote ? '(normalized)' : '(unchanged)'}\n`,
        );
        for (const note of setup.notes) process.stdout.write(`  note: ${note}\n`);
        process.stdout.write(
          `  inputs: ${scan.files} file(s), ${scan.groups} candidate group(s) → ${scan.manifestPath}\n`,
        );
        process.stdout.write(
          `  environment: node ${env.node.version} · python ${
            env.python.available ? 'yes' : 'missing'
          } · container ${
            env.containerRuntimes.docker.available || env.containerRuntimes.podman.available
              ? 'yes'
              : 'missing'
          } · gpu ${env.gpu.devices.length}${env.gpu.cudaVersion ? ` · cuda ${env.gpu.cudaVersion}` : ''}\n`,
        );
        process.stdout.write(`  ${guidance}\n`);
        process.stdout.write(`next: ${nextCommand}\n`);
        return 0;
      }),
    );
}
