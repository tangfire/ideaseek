import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { action, jsonLine, resolveRun } from './shared.js';

/**
 * `ideaseek reject <reason>` — records a user rejection as a persisted
 * decision RunEvent bound to the current run (docs/TERMINAL_UX 审批界面:
 * 批准动作写入 Decision/Event). Approvals of protocol proposals go through
 * `ideaseek confirm protocol`, which appends the matching decision event.
 */
export function registerDecisionCommand(program: Command): void {
  program
    .command('reject')
    .description('record a user rejection decision against the current run')
    .argument('<reason>', 'why the pending proposal/gate is rejected')
    .option('--run <runId>', 'run id (default: latest)')
    .option('--json', 'machine-readable output')
    .action(
      action(async (reason: string, opts: { run?: string; json?: boolean }) => {
        if (!reason || !reason.trim()) {
          throw new IdeaseekError('INVALID_ARGUMENT', 'reject requires a non-empty reason');
        }
        const { ProjectRuntime } = await import('../workflow/runtime.js');
        const runtime = await ProjectRuntime.open({ cwd: process.cwd() });
        try {
          const run = await resolveRun(runtime, opts.run);
          const event = await runtime.db.appendEvent({
            runId: run.runId,
            phase: run.phase,
            objectId: null,
            role: 'user',
            eventType: 'decision',
            summary: `rejected: ${reason.trim()}`,
            status: 'rejected',
          });
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                decision: 'rejected',
                runId: run.runId,
                seq: event.seq,
                reason: reason.trim(),
              }),
            );
          } else {
            process.stdout.write(
              `recorded rejection on ${run.runId} [#${event.seq}]: ${reason.trim()}\n`,
            );
            process.stdout.write('the proposal stays unlocked; inspect it with ideaseek events\n');
          }
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );
}
