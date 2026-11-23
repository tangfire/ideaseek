#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import { IdeaseekError, exitCodeForError } from './core/errors.js';
import { loadLocalEnv, loadUserCredentials } from './core/env.js';
import { registerBaselineCommand } from './commands/baseline.js';
import { registerCapacityCommand } from './commands/capacity.js';
import { registerComparisonCommand } from './commands/comparison.js';
import { registerRepositoryCommand } from './commands/repository.js';
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
import { registerArisCommand } from './commands/aris.js';
import { registerAskCommand } from './commands/ask.js';
import { registerAgentCommand } from './commands/agent.js';
import { registerModeCommand } from './commands/mode.js';
import { registerOpenCommand } from './commands/open.js';
import { registerPendingCommand } from './commands/pending.js';
import { registerWikiCommand } from './commands/wiki.js';
import { registerRenderCommand } from './commands/render.js';
import { registerWatchdogCommand } from './commands/watchdog.js';
import { registerQueueCommand } from './commands/queue.js';
import { registerMonitorCommand } from './commands/monitor.js';
import { registerContextCommand } from './commands/context.js';
import { registerNotifyCommand } from './commands/notify.js';
import {
  registerIntakeCommand,
  registerOrganizeCommand,
  registerScanCommand,
} from './commands/inputs.js';
import { registerNextCommand } from './commands/next.js';
import { registerPlanCommand } from './commands/plan.js';
import { registerPrepareCommand } from './commands/prepare.js';
import { registerLiteratureCommand } from './commands/literature.js';
import { registerExplainCommand } from './commands/explain.js';
import { registerModelsCommand } from './commands/models.js';
import { registerMaintenanceCommands } from './commands/maintenance.js';
import { registerProjectsCommand } from './commands/projects.js';
import { registerPapersCommand } from './commands/papers.js';
import { registerLogsCommand } from './commands/logs.js';
import { registerDecisionCommand } from './commands/decision.js';
import { registerInteractiveCommand, runBareInvocation } from './commands/interactive.js';
import { registerProtocolCommand } from './commands/protocol.js';
import { registerPaperCommand } from './commands/paper.js';
import { registerFullCommand } from './commands/full.js';
import { registerStaleCommand } from './commands/stale.js';
import { registerAssessmentCommand } from './commands/assessment.js';
import { registerUpdateCommands } from './commands/update.js';
import { registerReportCommand } from './commands/report.js';
import { registerRunCommand } from './commands/run.js';
import { registerSetupCommand } from './commands/setup.js';
import { registerSynthesizeCommand } from './commands/synthesize.js';
import { registerSearchCommand } from './commands/search.js';
import { registerCloudCommand } from './commands/cloud.js';
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
    .description(
      'Evidence-grounded research platform: read your papers, design the protocol, run and audit the experiments, write the paper',
    )
    .version(readVersion())
    .showHelpAfterError()
    // Global --plain/--json must precede the subcommand; subcommand flags
    // (e.g. `status --json`) keep parsing as their own options.
    .enablePositionalOptions()
    .configureOutput({
      writeErr: (text) => process.stderr.write(text),
    })
    // Without this, commander answers usage errors by calling process.exit
    // itself: the documented exit codes never pass through the mapping below,
    // and an embedder (the TUI, a test, anything importing runCli) gets killed
    // by a forgotten flag instead of being told about it. Subcommands inherit
    // this setting when they are created.
    .exitOverride();

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
  registerArisCommand(program);
  registerAskCommand(program);
  registerAgentCommand(program);
  registerModeCommand(program);
  registerOpenCommand(program);
  registerPendingCommand(program);
  registerWikiCommand(program);
  registerRenderCommand(program);
  registerWatchdogCommand(program);
  registerQueueCommand(program);
  registerMonitorCommand(program);
  registerContextCommand(program);
  registerNotifyCommand(program);
  registerRunCommand(program);
  registerWorkerCommand(program);
  registerStatusCommand(program);
  registerNextCommand(program);
  registerPlanCommand(program);
  registerPrepareCommand(program);
  registerLiteratureCommand(program);
  registerExplainCommand(program);
  registerModelsCommand(program);
  registerEventsCommand(program);
  registerSearchCommand(program);
  registerCloudCommand(program);
  registerStreamCommands(program);
  registerSuperviseCommand(program);
  registerPaperCommand(program);
  registerFullCommand(program);
  registerStaleCommand(program);
  registerAssessmentCommand(program);
  registerUpdateCommands(program);
  registerReportCommand(program);
  registerControlCommands(program);
  registerComparisonCommand(program);
  registerRepositoryCommand(program);
  registerBaselineCommand(program);
  registerCapacityCommand(program);
  registerMaintenanceCommands(program);
  registerProjectsCommand(program);
  registerPapersCommand(program);
  registerLogsCommand(program);
  registerDecisionCommand(program);
  registerInteractiveCommand(program);
  groupCommands(program);

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

/**
 * Help is grouped by what the user is trying to do.
 *
 * Sixty-two top-level commands in registration order is a list, not a map:
 * `status`, `next`, `plan`, `prepare`, `assessment` and `queue` all answer
 * different questions and sat five characters apart. Grouping is by journey
 * stage, and the names are matched from a table so an unregistered or renamed
 * command shows up in the residual group instead of disappearing from help.
 */
const HELP_GROUPS: { title: string; commands: string[] }[] = [
  {
    title: '开始与配置',
    commands: [
      'interactive',
      'init',
      'start',
      'setup',
      'doctor',
      'config',
      'models',
      'mode',
      'open',
      'projects',
      'version',
      'update',
    ],
  },
  {
    title: '读懂已有输入',
    commands: [
      'prepare',
      'scan',
      'ingest',
      'extract',
      'synthesize',
      'evaluate',
      'mech',
      'wiki',
      'search',
      'papers',
      'intake',
      'organize',
      'assessment',
      'literature',
    ],
  },
  {
    title: '数据与实验协议',
    commands: [
      'datasets',
      'data',
      'protocol',
      'confirm',
      'reject',
      'decision',
      'pending',
      'stale',
      'comparison',
      'baseline',
      'repo',
      'capacity',
    ],
  },
  {
    title: '想法与推进',
    commands: ['ideate', 'rounds', 'idea', 'consolidate', 'feedback', 'experiment', 'explain'],
  },
  {
    title: '交付',
    commands: [
      'paper',
      'full',
      'report',
      'render',
      'export',
      'archive',
      'backup',
      'restore',
      'cleanup',
      'logs',
      'cloud',
    ],
  },
  {
    title: '运行、观察与恢复',
    commands: [
      'next',
      'plan',
      'status',
      'events',
      'watch',
      'attach',
      'monitor',
      'queue',
      'watchdog',
      'context',
      'notify',
      'run',
      'worker',
      'supervise',
      'pause',
      'resume',
      'continue',
      'cancel',
      'agent',
      'ask',
      'aris',
    ],
  },
];

function groupCommands(program: Command): void {
  const grouped = new Map<string, string>();
  for (const group of HELP_GROUPS) {
    for (const name of group.commands) grouped.set(name, group.title);
  }
  for (const command of program.commands) {
    command.helpGroup(grouped.get(command.name()) ?? '其他');
  }
}

/** The name→group table, exposed so its completeness can be tested. */
export function helpGroupsOf(): Map<string, string> {
  const grouped = new Map<string, string>();
  for (const group of HELP_GROUPS) {
    for (const name of group.commands) grouped.set(name, group.title);
  }
  return grouped;
}

/** Commander failures that mean "the caller did not say what to run". */
const COMMANDER_INPUT_ERRORS = new Set([
  'commander.missingMandatoryOptionValue',
  'commander.missingArgument',
  'commander.unknownOption',
  'commander.excessArguments',
  'commander.invalidArgument',
]);

/**
 * "Did you mean `status`?" for a mistyped command.
 *
 * The root has an action (bare invocation opens the TUI), so commander reports
 * an unknown command as "too many arguments. Expected 0 arguments but got 1"
 * — which is technically true and useless to a user with about fifty commands
 * to choose from. The closest name is computed here rather than by commander
 * because by the time the error is raised the command context is gone.
 */
export function suggestCommand(token: string, names: string[]): string | null {
  if (!token || token.startsWith('-')) return null;
  const target = token.toLowerCase();
  let best: { name: string; distance: number; prefix: boolean } | null = null;
  for (const name of names) {
    const candidate = name.toLowerCase();
    const prefix = candidate.startsWith(target.slice(0, Math.max(3, target.length - 2)));
    const distance = editDistance(target, candidate);
    if (distance > Math.max(2, Math.floor(candidate.length / 3)) && !prefix) continue;
    if (!best || distance < best.distance || (prefix && distance === best.distance)) {
      best = { name, distance, prefix };
    }
  }
  return best?.name ?? null;
}

function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_, i) => i);
  for (let i = 1; i < rows; i += 1) {
    const current = [i];
    for (let j = 1; j < cols; j += 1) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[cols - 1]!;
}

/**
 * The first positional token of a root-level invocation, if it is not a known
 * command.
 *
 * Checked before parsing because the root carries an action (bare `ideaseek`
 * opens the UI), so commander sees a mistyped command as "too many arguments"
 * and cannot suggest anything. A token that is neither a known command nor a
 * flag is a typo, and with about fifty commands the nearest name is the only
 * useful answer.
 */
function unknownRootCommand(argv: string[], program: Command): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === '--project') {
      i += 1; // its value is a path, not a command
      continue;
    }
    if (token.startsWith('-')) continue;
    const names = program.commands.map((command) => command.name());
    return names.includes(token) ? null : token;
  }
  return null;
}

export async function runCli(argv: string[]): Promise<number> {
  loadLocalEnv(); // names-only, never overrides host env, never logs values
  loadUserCredentials(); // /models setup's saved key — same contract, host env still wins
  const program = buildProgram();
  const extracted = await extractProjectOverride(argv);
  // The two prefixes are skipped only for the typo check: parseAsync expects
  // the process.argv shape and drops them itself.
  const mistyped = unknownRootCommand(extracted.slice(2), program);
  if (mistyped) {
    const names = program.commands.map((command) => command.name());
    const suggestion = suggestCommand(mistyped, names);
    process.stderr.write(
      suggestion
        ? `ideaseek: unknown command "${mistyped}". Did you mean: ideaseek ${suggestion}?\n`
        : `ideaseek: unknown command "${mistyped}". Run \`ideaseek --help\` for the command list.\n`,
    );
    return 2;
  }
  try {
    await program.parseAsync(extracted);
    const code = process.exitCode;
    return typeof code === 'number' ? code : 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (COMMANDER_INPUT_ERRORS.has(error.code)) {
        // Commander's own wording is kept here: reaching this branch means a
        // subcommand was found and its arguments were wrong ("ideaseek status
        // extra"), which is a different mistake from a mistyped command and is
        // already described accurately. The typo case is answered earlier,
        // before parsing, because the root's own action makes commander call
        // it "too many arguments" with nothing to suggest.
        return 2;
      }
      // Help and version requests are successful output, not failures.
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

// Direct-invocation guard: npm link / ln -s hands node a SYMLINK path, so
// argv[1] keeps the link while import.meta.url is the resolved file — a raw
// string compare made every symlinked install silently no-op (modules load,
// warning prints, exit 0, zero output — observed on the Linux server).
// Compare realpaths; fall back to the literal path when the file is gone.
const invokedDirectly = ((): boolean => {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return import.meta.url === pathToFileURL(argv1).href;
  }
})();

if (invokedDirectly || process.env.IDEASEEK_CLI === '1') {
  // `process.exit()` tears the event loop down while a finished HTTPS fetch
  // still has closing libuv handles, which on Windows aborts the process with
  // `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c`
  // instead of exiting. Drain naturally; only force-exit if something keeps
  // the loop alive, so the CLI can never hang.
  const finish = (code: number): void => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 2_000).unref();
  };
  runCli(process.argv).then(finish, (error) => {
    process.stderr.write(`error: ${(error as Error).stack ?? String(error)}\n`);
    finish(1);
  });
}
