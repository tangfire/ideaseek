import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { loadConfig, type LoadedConfig } from '../config/config.js';
import { findProjectRoot, projectPaths } from '../config/paths.js';
import { action, jsonLine } from './shared.js';

const SECTIONS = ['project', 'research', 'inputs', 'runtime', 'resources', 'policy'] as const;

function printExplain(config: LoadedConfig): void {
  process.stdout.write(`config: ${config.path}\n`);
  process.stdout.write(
    `  exists: ${config.existed ? 'yes' : 'no (all values are defaults)'}  version: v${config.resolved.configVersion}\n`,
  );
  for (const note of config.migrationNotes) process.stdout.write(`  migration: ${note}\n`);
  for (const error of config.errors) process.stdout.write(`  ✗ ${error}\n`);
  for (const warning of config.warnings) process.stdout.write(`  ⚠ ${warning}\n`);

  for (const section of SECTIONS) {
    process.stdout.write(`${section}:\n`);
    const leaves = Object.keys(config.sources)
      .filter((key) => key.startsWith(`${section}.`))
      .sort();
    for (const key of leaves) {
      const shortKey = key.slice(section.length + 1);
      const value = (config.resolved as unknown as Record<string, Record<string, unknown>>)[
        section
      ]?.[shortKey];
      const source = config.sources[key];
      process.stdout.write(
        `  ${key} = ${JSON.stringify(value)}${source === 'file' ? '  [file]' : '  [default]'}\n`,
      );
    }
  }
}

export function registerConfigCommand(program: Command): void {
  const config = program.command('config').description('inspect effective configuration');

  config
    .command('explain')
    .description('show every effective value and where it came from')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { json?: boolean }) => {
        const root = await findProjectRoot(process.cwd());
        if (!root) {
          throw new IdeaseekError(
            'NOT_INITIALIZED',
            'no IdeaSeek project here; run: ideaseek init',
          );
        }
        const loaded = await loadConfig(projectPaths(root), root.split(/[\\/]/).pop() ?? 'project');
        if (opts.json) {
          process.stdout.write(
            jsonLine({
              root,
              path: loaded.path,
              existed: loaded.existed,
              errors: loaded.errors,
              warnings: loaded.warnings,
              migrationNotes: loaded.migrationNotes,
              sources: loaded.sources,
              resolved: loaded.resolved,
            }),
          );
          return loaded.errors.length > 0 ? 2 : 0;
        }
        printExplain(loaded);
        return loaded.errors.length > 0 ? 2 : 0;
      }),
    );
}
