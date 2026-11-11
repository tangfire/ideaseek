import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { action, jsonLine } from './shared.js';

/**
 * `ideaseek monitor` — one-shot experiment monitoring snapshot (Phase
 * 4.5B, ARIS monitor-experiment contract): what is running (worker and
 * progress heartbeats with ages), recent log paths, host resources and
 * WAITING REASONS (paused/blocked run, admission queue). Advisory
 * snapshot — always exit 0; liveness verdicts belong to `watchdog`.
 */
export function registerMonitorCommand(program: Command): void {
  program
    .command('monitor')
    .description('snapshot running heartbeats, recent logs, host resources and waiting reasons')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { json?: boolean }) => {
        const { findProjectRoot } = await import('../config/paths.js');
        const root = await findProjectRoot(process.cwd());
        if (!root) {
          throw new IdeaseekError(
            'NOT_INITIALIZED',
            'no IdeaSeek project here; run: ideaseek init',
          );
        }
        const { collectMonitor } = await import('../runtime/monitor.js');
        const report = await collectMonitor(root);

        if (opts.json) {
          process.stdout.write(jsonLine(report));
          return 0;
        }
        if (report.run) {
          process.stdout.write(
            `run ${report.run.runId}: ${report.run.status} (${report.run.phase})` +
              `${report.run.blockReason ? ` — ${report.run.blockReason}` : ''}\n`,
          );
        } else {
          process.stdout.write('no run yet\n');
        }
        if (report.workers.length > 0) {
          process.stdout.write(`workers (${report.workers.length} active):\n`);
          for (const worker of report.workers) {
            process.stdout.write(
              `  ${worker.workerId} pid ${worker.pid} · heartbeat ${worker.ageSeconds}s ago\n`,
            );
          }
        }
        if (report.experiments.length > 0) {
          process.stdout.write(`in-flight experiments (${report.experiments.length}):\n`);
          for (const experiment of report.experiments) {
            process.stdout.write(
              `  ${experiment.specId} · heartbeat ${experiment.ageSeconds}s ago` +
                `${experiment.step !== null ? ` · step ${experiment.step}` : ''}\n`,
            );
          }
        }
        if (report.resources) {
          process.stdout.write(
            `resources: ${report.resources.gpus} GPU(s) · ` +
              `${report.resources.freeMemGiB ?? '?'} GiB free mem · ` +
              `${report.resources.diskFreeGiB ?? '?'} GiB free disk\n`,
          );
        }
        if (report.logs.length > 0) {
          process.stdout.write('recent logs:\n');
          for (const log of report.logs) {
            process.stdout.write(`  ${log.path} · ${log.ageSeconds}s ago · ${log.bytes} B\n`);
          }
        }
        if (report.waiting.length > 0) {
          process.stdout.write('waiting:\n');
          for (const entry of report.waiting) {
            process.stdout.write(`  [${entry.scope}] ${entry.reason}\n`);
          }
        } else {
          process.stdout.write('nothing waiting\n');
        }
        process.stdout.write(
          'next: ideaseek watchdog (liveness) · ideaseek queue (waves) · ideaseek logs <task>\n',
        );
        return 0;
      }),
    );
}
