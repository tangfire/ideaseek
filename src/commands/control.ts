import type { Command } from 'commander';
import { ProjectRuntime } from '../workflow/runtime.js';
import { action, jsonLine, resolveRun } from './shared.js';

async function control(
  verb: 'pause' | 'resume' | 'continue' | 'cancel',
  opts: { run?: string; hard?: boolean; json?: boolean },
): Promise<number> {
  const runtime = await ProjectRuntime.open({ cwd: process.cwd() });
  try {
    const run = await resolveRun(runtime, opts.run);
    let updated;
    switch (verb) {
      case 'pause':
        updated = await runtime.db.pauseRun(run.runId, { hard: opts.hard ?? false });
        break;
      case 'resume':
        updated = await runtime.db.resumeRun(run.runId);
        break;
      case 'continue':
        updated = await runtime.db.continueRun(run.runId);
        break;
      case 'cancel':
        updated = await runtime.db.cancelRun(run.runId);
        break;
    }
    if (opts.json) {
      process.stdout.write(
        jsonLine({
          action: verb,
          runId: updated.runId,
          status: updated.status,
          blockReason: updated.blockReason,
        }),
      );
    } else {
      process.stdout.write(
        `${verb} → run ${updated.runId} is now ${updated.status}${
          updated.blockReason ? ` (${updated.blockReason})` : ''
        }\n`,
      );
      if (verb === 'pause') process.stdout.write('next: ideaseek resume\n');
      if (verb === 'continue') process.stdout.write('next: ideaseek run\n');
    }
    return verb === 'cancel' ? 4 : 0;
  } finally {
    await runtime.close();
  }
}

export function registerControlCommands(program: Command): void {
  program
    .command('pause')
    .description('stop claiming new tasks; in-flight tasks finish at a safe checkpoint')
    .option('--hard', 'also abort interruptible in-flight tasks back to the queue')
    .option('--run <runId>', 'run id (default: latest)')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { run?: string; hard?: boolean; json?: boolean }) =>
        control('pause', opts),
      ),
    );

  program
    .command('resume')
    .description('resume a paused run from its queued tasks')
    .option('--run <runId>', 'run id (default: latest)')
    .option('--json', 'machine-readable output')
    .action(action(async (opts: { run?: string; json?: boolean }) => control('resume', opts)));

  program
    .command('continue')
    .description('continue a run blocked on quota/auth/network without redoing successes')
    .option('--run <runId>', 'run id (default: latest)')
    .option('--json', 'machine-readable output')
    .action(action(async (opts: { run?: string; json?: boolean }) => control('continue', opts)));

  program
    .command('cancel')
    .description('cancel the run; committed artifacts, events and checkpoints are preserved')
    .option('--run <runId>', 'run id (default: latest)')
    .option('--json', 'machine-readable output')
    .action(action(async (opts: { run?: string; json?: boolean }) => control('cancel', opts)));
}
