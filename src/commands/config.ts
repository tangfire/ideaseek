import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { loadConfig, type LoadedConfig } from '../config/config.js';
import { loadUserConfig, type LoadedUserConfig } from '../config/user-config.js';
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
    const resolvedSection = (config.resolved as unknown as Record<string, Record<string, unknown>>)[
      section
    ];
    for (const key of leaves) {
      const shortKey = key.slice(section.length + 1);
      // research.yaml uses snake_case; ResolvedConfig uses camelCase.
      const camelKey = shortKey.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
      const value = resolvedSection?.[shortKey] ?? resolvedSection?.[camelKey];
      const source = config.sources[key];
      process.stdout.write(
        `  ${key} = ${JSON.stringify(value)}${source === 'file' ? '  [file]' : '  [default]'}\n`,
      );
    }
  }
}

function printUserExplain(user: LoadedUserConfig): void {
  process.stdout.write(`user config: ${user.path}\n`);
  process.stdout.write(`  exists: ${user.existed ? 'yes' : 'no (built-in defaults)'}\n`);
  for (const error of user.errors) process.stdout.write(`  ✗ ${error}\n`);
  for (const [key, value] of Object.entries(user.config.models)) {
    const source = user.sources[`models.${key}`] ?? 'user-default';
    process.stdout.write(`  models.${key} = ${JSON.stringify(value)}  [${source}]\n`);
  }
  process.stdout.write(
    `  embeddings.cacheDir = ${JSON.stringify(user.config.embeddings.cacheDir)}  [${user.sources['embeddings.cacheDir'] ?? 'user-default'}]\n`,
  );
  process.stdout.write(
    `  notifications.enabled = ${String(user.config.notifications.enabled)}  [${user.sources['notifications.enabled'] ?? 'user-default'}]\n`,
  );
  process.stdout.write(
    '  boundary: project research.yaml cannot read or override user secrets; ' +
      'credentialRef resolves by name only\n',
  );
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
        const user = await loadUserConfig();
        const failed = loaded.errors.length > 0 || user.errors.length > 0;
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
              userConfig: {
                path: user.path,
                existed: user.existed,
                errors: user.errors,
                sources: user.sources,
                config: user.config,
                note: 'project research.yaml never contains or reads secrets; credentialRef is a name only',
              },
            }),
          );
          return failed ? 2 : 0;
        }
        printExplain(loaded);
        printUserExplain(user);
        return failed ? 2 : 0;
      }),
    );
}
