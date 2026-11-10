import type { Command } from 'commander';
import { startInteractive } from '../cli/repl.js';
import { runCli } from '../cli/runner.js';
import { action } from './shared.js';

/**
 * `ideaseek interactive` — forces the REPL even when stdin is not a TTY
 * (pipes/tests). Bare `ideaseek` starts it only on a real terminal; with
 * `--json` bare invocation prints a machine-readable snapshot instead.
 */
export function registerInteractiveCommand(program: Command): void {
  program
    .command('interactive')
    .description('start the interactive UI: banner, prompt, live events, approvals')
    .option('--plain', 'short mark, no colors, log-friendly output')
    .action(
      action(async (opts: { plain?: boolean }) => {
        const global = program.opts<{ plain?: boolean }>();
        return startInteractive({ plain: opts.plain === true || global.plain === true });
      }),
    );
}

/** Bare `ideaseek` entry: interactive on TTY, JSON snapshot with --json. */
export async function runBareInvocation(globalOpts: {
  plain?: boolean;
  json?: boolean;
}): Promise<number> {
  if (globalOpts.json) {
    // Reuse the real commands; output is one JSON object per line.
    const status = await runCli(['status', '--json']);
    process.stdout.write(status.stdout);
    let hasRun = false;
    try {
      const payload = JSON.parse(status.stdout.trim().split(/\r?\n/).pop() ?? '{}') as {
        run?: unknown;
      };
      hasRun = payload.run != null;
    } catch {
      hasRun = false;
    }
    if (hasRun) {
      const events = await runCli(['events', '--json']);
      process.stdout.write(events.stdout);
    }
    return status.code;
  }
  if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
    return startInteractive({ plain: globalOpts.plain === true });
  }
  process.stdout.write(
    'ideaseek: no command given. Run `ideaseek interactive` for the UI, `ideaseek --help` for commands.\n',
  );
  return 0;
}
