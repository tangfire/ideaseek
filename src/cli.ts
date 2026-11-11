#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import { IdeaseekError, exitCodeForError } from './core/errors.js';
import { loadLocalEnv } from './core/env.js';
import { registerBaselineCommand } from './commands/baseline.js';
import { registerCapacityCommand } from './commands/capacity.js';
import { registerComparisonCommand } from './commands/comparison.js';
import { registerConfigCommand } from './commands/config.js';
import { registerConfirmCommand } from './commands/confirm.js';
import { registerDataCommand } from './commands/data.js';
import { registerControlCommands } from './commands/control.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerEventsCommand } from './commands/events.js';
import { registerEvaluateCommand } from './commands/evaluate.js';
import { registerExperimentCommand } from './commands/experiment.js';
import { registerExtractCommand } from './commands/extract.js';
import { registerInitCommand } from './commands/init.js';
import { registerIngestCommand } from './commands/ingest.js';
import { registerIdeaCommand } from './commands/idea.js';
import { registerIdeateCommands } from './commands/ideate.js';
import { registerAskCommand } from './commands/ask.js';
import { registerModeCommand } from './commands/mode.js';
import { registerOpenCommand } from './commands/open.js';
import {
  registerIntakeCommand,
  registerOrganizeCommand,
  registerScanCommand,
} from './commands/inputs.js';
import { registerNextCommand } from './commands/next.js';
import { registerPlanCommand } from './commands/plan.js';
import { registerExplainCommand } from './commands/explain.js';
import { registerModelsCommand } from './commands/models.js';
import { registerMaintenanceCommands } from './commands/maintenance.js';
import { registerProjectsCommand } from './commands/projects.js';
import { registerPapersCommand } from './commands/papers.js';
import { registerLogsCommand } from './commands/logs.js';
import { registerDecisionCommand } from './commands/decision.js';
import { registerInteractiveCommand, runBareInvocation } from './commands/interactive.js';
import { registerProtocolCommand } from './commands/protocol.js';
import { registerReportCommand } from './commands/report.js';
import { registerRunCommand } from './commands/run.js';
import { registerSetupCommand } from './commands/setup.js';
import { registerSynthesizeCommand } from './commands/synthesize.js';
import { registerSearchCommand } from './commands/search.js';
import { registerStartCommand } from './commands/start.js';
import { registerStatusCommand } from './commands/status.js';
import { registerStreamCommands } from './commands/stream.js';
import { registerSuperviseCommand } from './commands/supervise.js';
import { registerWorkerCommand } from './commands/worker.js';
import { action } from './commands/shared.js';

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('ideaseek')
    .description('DSH-based multi-agent research workflow platform (Phase 0: recoverable skeleton)')
    .version(readVersion())
    .showHelpAfterError()
    // Global --plain/--json must precede the subcommand; subcommand flags
    // (e.g. `status --json`) keep parsing as their own options.
    .enablePositionalOptions()
    .configureOutput({
      writeErr: (text) => process.stderr.write(text),
    });

  registerInitCommand(program);
  registerStartCommand(program);
  registerScanCommand(program);
  registerIngestCommand(program);
  registerExtractCommand(program);
  registerEvaluateCommand(program);
  registerSynthesizeCommand(program);
  registerProtocolCommand(program);
  registerIntakeCommand(program);
  registerOrganizeCommand(program);
  registerSetupCommand(program);
  registerDoctorCommand(program);
  registerConfigCommand(program);
  registerDataCommand(program);
  registerConfirmCommand(program);
  registerExperimentCommand(program);
  registerIdeaCommand(program);
  registerIdeateCommands(program);
  registerAskCommand(program);
  registerModeCommand(program);
  registerOpenCommand(program);
  registerRunCommand(program);
  registerWorkerCommand(program);
  registerStatusCommand(program);
  registerNextCommand(program);
  registerPlanCommand(program);
  registerExplainCommand(program);
  registerModelsCommand(program);
  registerEventsCommand(program);
  registerSearchCommand(program);
  registerStreamCommands(program);
  registerSuperviseCommand(program);
  registerReportCommand(program);
  registerControlCommands(program);
  registerComparisonCommand(program);
  registerBaselineCommand(program);
  registerCapacityCommand(program);
  registerMaintenanceCommands(program);
  registerProjectsCommand(program);
  registerPapersCommand(program);
  registerLogsCommand(program);
  registerDecisionCommand(program);
  registerInteractiveCommand(program);

  // Global display modes (docs/TERMINAL_UX 三种显示模式). They apply to the
  // bare invocation; subcommands keep their own --json flags.
  program.option('--plain', 'short mark, no colors, log-friendly output');
  program.option('--json', 'machine-readable status/events snapshot (bare invocation)');
  program.action(
    action(async () => {
      const opts = program.opts<{ plain?: boolean; json?: boolean }>();
      return runBareInvocation(opts);
    }),
  );
  return program;
}

/**
 * Global `--project <path>` (docs/CLI_SPEC, USER_GUIDE): selects the
 * project for this process before any command resolves paths, in any argv
 * position (before or after the subcommand). Extracted here so every
 * command gains it without per-command flags; commands that already
 * resolve from cwd keep working unchanged.
 */
async function extractProjectOverride(argv: string[]): Promise<string[]> {
  const out = [...argv];
  for (let i = 2; i < out.length; i++) {
    const arg = out[i]!;
    let value: string | null = null;
    if (arg === '--project') {
      const next = out[i + 1];
      if (!next || next.startsWith('-')) {
        throw new IdeaseekError('INVALID_ARGUMENT', '--project requires a path');
      }
      value = next;
      out.splice(i, 2);
      i--; // the element after the value shifted onto i
    } else if (arg.startsWith('--project=')) {
      value = arg.slice('--project='.length);
      out.splice(i, 1);
      i--;
    }
    if (value === null) continue;
    if (!value.trim()) {
      throw new IdeaseekError('INVALID_ARGUMENT', '--project requires a path');
    }
    const { resolve } = await import('node:path');
    const { stat } = await import('node:fs/promises');
    const target = resolve(value);
    const info = await stat(target).catch(() => null);
    if (!info?.isDirectory()) {
      throw new IdeaseekError('FILE_NOT_FOUND', `--project path not found: ${value}`);
    }
    process.chdir(target);
  }
  return out;
}

export async function runCli(argv: string[]): Promise<number> {
  loadLocalEnv(); // names-only, never overrides host env, never logs values
  try {
    await buildProgram().parseAsync(await extractProjectOverride(argv));
    const code = process.exitCode;
    return typeof code === 'number' ? code : 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      // Help/version requests exit 0; misuse exits with commander's code.
      return typeof error.exitCode === 'number' ? error.exitCode : 1;
    }
    if (error instanceof IdeaseekError) {
      process.stderr.write(`error: [${error.code}] ${error.message}\n`);
      return exitCodeForError(error);
    }
    process.stderr.write(`error: ${(error as Error).stack ?? String(error)}\n`);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (invokedDirectly || process.env.IDEASEEK_CLI === '1') {
  runCli(process.argv).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`error: ${(error as Error).stack ?? String(error)}\n`);
      process.exit(1);
    },
  );
}
