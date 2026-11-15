import type { Command } from 'commander';
import { basename } from 'node:path';
import { detectEnvironment } from '../runtime/detect.js';
import { ProjectRuntime } from '../workflow/runtime.js';
import { adviseNext } from './next.js';
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
        // Ask the same advisor `ideaseek start`'s own help line would: this
        // command used to hardcode `ideaseek run` (the fake-worker demo
        // pipeline) as the next step for a project that had just been shown to
        // contain papers. Two guidance sources meant the two could drift, and
        // this one did.
        let guidance = scan.files
          ? '输入已就绪，平台先读一遍：解析、建索引、给出缺口评估'
          : '把论文放入 papers/、数据放入 datasets/（可选对比方法放 comparisons/），再回来跑 ideaseek start';
        let nextCommand = question
          ? `ideaseek prepare --question "${question}"`
          : 'ideaseek prepare --question "你的研究问题"';
        try {
          const runtime = await ProjectRuntime.open({ cwd });
          try {
            const run = await runtime.db.getLatestRun(runtime.project.id);
            const advice = await adviseNext(runtime, run);
            guidance = advice.suggestion;
            nextCommand = advice.command;
          } finally {
            await runtime.close();
          }
        } catch {
          // A guidance read must never fail a bootstrap that already succeeded.
        }

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
