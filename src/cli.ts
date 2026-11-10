#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import { loadLocalEnv } from './core/env.js';
import { registerConfigCommand } from './commands/config.js';
import { registerConfirmCommand } from './commands/confirm.js';
import { registerDataCommand } from './commands/data.js';
import { registerControlCommands } from './commands/control.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerEventsCommand } from './commands/events.js';
import { registerEvaluateCommand } from './commands/evaluate.js';
import { registerExtractCommand } from './commands/extract.js';
import { registerInitCommand } from './commands/init.js';
import { registerIngestCommand } from './commands/ingest.js';
import {
  registerIntakeCommand,
  registerOrganizeCommand,
  registerScanCommand,
} from './commands/inputs.js';
import { registerNextCommand } from './commands/next.js';
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
  registerRunCommand(program);
  registerWorkerCommand(program);
  registerStatusCommand(program);
  registerNextCommand(program);
  registerEventsCommand(program);
  registerSearchCommand(program);
  registerStreamCommands(program);
  registerSuperviseCommand(program);
  registerReportCommand(program);
  registerControlCommands(program);
  return program;
}

export async function runCli(argv: string[]): Promise<number> {
  loadLocalEnv(); // names-only, never overrides host env, never logs values
  try {
    await buildProgram().parseAsync(argv);
    const code = process.exitCode;
    return typeof code === 'number' ? code : 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      // Help/version requests exit 0; misuse exits with commander's code.
      return typeof error.exitCode === 'number' ? error.exitCode : 1;
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
