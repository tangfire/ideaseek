import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { startInteractive } from '../cli/repl.js';
import { runCli } from '../cli/runner.js';
import { action } from './shared.js';

/**
 * `ideaseek interactive` — forces the REPL even when stdin is not a TTY
 * (pipes/tests). Bare `ideaseek` starts it only on a real terminal; with
 * `--json` bare invocation prints a machine-readable snapshot instead.
 * `--mode research|agent` sets the session mode before the UI starts
 * (docs/MODES.md).
 */
export function registerInteractiveCommand(program: Command): void {
  program
    .command('interactive')
    .description('start the interactive UI: banner, prompt, live events, approvals')
    .option('--plain', 'short mark, no colors, log-friendly output')
    .option('--mode <mode>', 'session mode for this project: research | agent')
    .action(
      action(async (opts: { plain?: boolean; mode?: string }) => {
        const global = program.opts<{ plain?: boolean }>();
        if (opts.mode) {
          const { parseSessionMode, readSessionMode, writeSessionMode, SESSION_MODES } =
            await import('../session/mode.js');
          const mode = parseSessionMode(opts.mode);
          if (!mode) {
            throw new IdeaseekError(
              'INVALID_ARGUMENT',
              `mode must be one of: ${SESSION_MODES.join(' | ')}`,
            );
          }
          const { findProjectRoot } = await import('../config/paths.js');
          const root = await findProjectRoot(process.cwd());
          if (!root) {
            throw new IdeaseekError(
              'NOT_INITIALIZED',
              'no IdeaSeek project here; run: ideaseek init',
            );
          }
          if ((await readSessionMode(root)) !== mode) await writeSessionMode(root, mode);
        }
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
