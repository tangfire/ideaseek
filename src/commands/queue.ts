import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { action, jsonLine } from './shared.js';

/**
 * `ideaseek queue` — experiment-queue view (Phase 4.5B): dependency
 * waves + waitingOn for depends_on transparency, stale queued leftovers
 * on terminal runs (`--cleanup` cancels them with an event), and the
 * capacity admission plan for fair ordering. Advisory like `capacity`;
 * exit 2 only when stale queued tasks await cleanup.
 */
export function registerQueueCommand(program: Command): void {
  program
    .command('queue')
    .description(
      'show dependency waves, waiting tasks, stale queue leftovers and the admission plan',
    )
    .option('--cleanup', 'cancel stale queued tasks left on a terminal run')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { cleanup?: boolean; json?: boolean }) => {
        const { findProjectRoot } = await import('../config/paths.js');
        const root = await findProjectRoot(process.cwd());
        if (!root) {
          throw new IdeaseekError(
            'NOT_INITIALIZED',
            'no IdeaSeek project here; run: ideaseek init',
          );
        }

        if (opts.cleanup) {
          const { cleanupStaleQueue } = await import('../runtime/queue.js');
          const result = await cleanupStaleQueue(root);
          if (opts.json) {
            process.stdout.write(jsonLine({ cleaned: result.cleaned, runId: result.runId }));
            return 0;
          }
          process.stdout.write(
            result.cleaned > 0
              ? `cleaned ${result.cleaned} stale queued task(s) on ${result.runId}\n`
              : `nothing to clean on ${result.runId} (no stale queued tasks)\n`,
          );
          return 0;
        }

        const { collectQueue } = await import('../runtime/queue.js');
        const report = await collectQueue(root);

        if (opts.json) {
          process.stdout.write(jsonLine(report));
          return report.staleQueued.length > 0 ? 2 : 0;
        }
        if (!report.runId) {
          process.stdout.write('no run yet — nothing queued\n');
          return 0;
        }
        process.stdout.write(
          `queue for ${report.runId} (${report.runStatus})${report.terminal ? ' [terminal]' : ''}\n`,
        );
        if (report.waves.length === 0) {
          process.stdout.write('  no unfinished tasks\n');
        }
        for (const wave of report.waves) {
          process.stdout.write(`  wave ${wave.wave + 1} (${wave.tasks.length} task(s)):\n`);
          for (const task of wave.tasks) {
            const waiting =
              task.waitingOn.length > 0 ? `  waiting on: ${task.waitingOn.join(', ')}` : '';
            process.stdout.write(
              `    ${task.status.padEnd(8)} ${task.type} ${task.taskId}${waiting}\n`,
            );
          }
        }
        if (report.staleQueued.length > 0) {
          process.stdout.write(
            `  STALE: ${report.staleQueued.length} queued task(s) on a terminal run\n`,
          );
          process.stdout.write('next: ideaseek queue --cleanup\n');
        }
        if (report.admission) {
          process.stdout.write(
            `admission: ${report.admission.admitted.length} admitted / ` +
              `${report.admission.queued.length} waiting (limit ${report.admission.parallelLimit})\n`,
          );
          for (const entry of report.admission.queued) {
            process.stdout.write(`  wait ${entry.ideaId}: ${entry.reason}\n`);
          }
          for (const constraint of report.admission.constraints) {
            process.stdout.write(`  constraint: ${constraint}\n`);
          }
        }
        return report.staleQueued.length > 0 ? 2 : 0;
      }),
    );
}
