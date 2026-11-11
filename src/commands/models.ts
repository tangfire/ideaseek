import type { Command } from 'commander';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IdeaseekError } from '../core/errors.js';
import { action, jsonLine } from './shared.js';
import { credentialStatus, describeTierBindings } from '../models/routing.js';

/**
 * `ideaseek models` / `/models` (docs/MODEL_ROUTING.md 用户交互): shows the
 * fast/balanced/deep/deterministic tier bindings, the roles each tier serves,
 * credential PRESENCE only (never values) and the pinned DSH runtime.
 * `models use <route>` rewrites research.yaml runtime.model_route and always
 * records a Decision/Event (guided mode needs --confirm); running tasks keep
 * their run snapshot.
 */

async function readDshPin(): Promise<string | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    const here = dirname(fileURLToPath(import.meta.url));
    const lockPath = join(here, '..', '..', 'runtime-lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8')) as {
      dsh?: { commit?: string };
    };
    return lock.dsh?.commit ?? null;
  } catch {
    return null;
  }
}

export function registerModelsCommand(program: Command): void {
  const models = program
    .command('models')
    .description('model tier routes, role bindings and credential presence (never values)');

  models
    .command('list', { isDefault: true })
    .description('show tier bindings, roles, credential presence and DSH pin')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { json?: boolean }) => {
        const { findProjectRoot, projectPaths } = await import('../config/paths.js');
        const root = await findProjectRoot(process.cwd());
        if (!root) {
          throw new IdeaseekError(
            'NOT_INITIALIZED',
            'no IdeaSeek project here; run: ideaseek init',
          );
        }
        const { loadConfig } = await import('../config/config.js');
        const config = await loadConfig(projectPaths(root));
        const bindings = describeTierBindings();
        const credentials = credentialStatus();
        const dshPin = await readDshPin();

        const payload = {
          projectRoute: config.resolved.runtime.modelRoute,
          dshCommit: dshPin,
          credentials,
          tiers: bindings,
          rules: [
            'Agent cannot read or modify API keys — presence is reported only',
            'deterministic tier never calls a model',
            'switching routes records a Decision/Event; running tasks keep their snapshot',
          ],
        };
        if (opts.json) {
          // Redaction belt: never emit a key-shaped value, whatever happens upstream.
          if (/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/.test(JSON.stringify(payload))) {
            throw new IdeaseekError('INTERNAL', 'refusing to emit a key-shaped value');
          }
          process.stdout.write(jsonLine(payload));
          return 0;
        }
        process.stdout.write(
          `project route: ${payload.projectRoute} · DSH pin: ${payload.dshCommit ?? 'missing'}\n`,
        );
        process.stdout.write(
          `credentials: deepseek api key ${credentials.deepseekApiKey} (presence only)\n`,
        );
        for (const tier of bindings) {
          const binding =
            tier.model === null
              ? 'no model (deterministic)'
              : `${tier.provider}/${tier.model}${tier.overrideEnv ? ` (override: ${tier.overrideEnv})` : ''}`;
          process.stdout.write(`  ${tier.tier.padEnd(14)} ${binding}\n`);
          process.stdout.write(`    roles: ${tier.roles.join(', ') || '(none)'}\n`);
          process.stdout.write(
            `    tools: ${tier.capabilities.toolCalling} · structured: ${tier.capabilities.structuredOutput}\n`,
          );
        }
        process.stdout.write('next: ideaseek doctor   (verify the pinned DSH runtime)\n');
        return 0;
      }),
    );

  models
    .command('use')
    .description(
      'switch the project model route (records a Decision/Event; guided needs --confirm)',
    )
    .argument('<route>', 'route name recorded in research.yaml (runtime.model_route)')
    .option('--confirm', 'guided-mode confirmation for the protected route change')
    .option('--json', 'machine-readable output')
    .action(
      action(async (route: string, opts: { confirm?: boolean; json?: boolean }) => {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(route)) {
          throw new IdeaseekError('INVALID_ARGUMENT', 'route must be kebab-case');
        }
        const root = await findRoot();
        const { readFile, writeFile } = await import('node:fs/promises');
        const { projectPaths } = await import('../config/paths.js');
        const configPath = projectPaths(root).configFile;
        const raw = await readFile(configPath, 'utf8');
        if (!raw.includes('model_route:')) {
          throw new IdeaseekError('INVALID_STATE', 'research.yaml has no model_route key');
        }

        // Protected change: route switch needs the mode's approval first.
        const { assertAutonomy, parseAutonomyMode, recordDecision } =
          await import('../workflow/autonomy.js');
        const { ProjectRuntime } = await import('../workflow/runtime.js');
        const runtime = await ProjectRuntime.open({ cwd: root });
        let decisionSeq: number | null = null;
        try {
          const mode = parseAutonomyMode(runtime.config.policy.autonomyMode);
          assertAutonomy(mode, 'change-model-route', { confirmed: opts.confirm });
          await writeFile(
            configPath,
            raw.replace(/model_route:.*$/m, `model_route: ${route}`),
            'utf8',
          );
          const decision = await recordDecision(runtime.db, runtime.project.id, {
            action: 'change-model-route',
            target: `model_route=${route}`,
            mode,
            reason: 'ideaseek models use',
          });
          decisionSeq = decision?.seq ?? null;
        } finally {
          await runtime.close();
        }
        if (opts.json) {
          process.stdout.write(jsonLine({ route, decisionSeq }));
        } else {
          process.stdout.write(`model_route → ${route}\n`);
          process.stdout.write(
            decisionSeq
              ? `  decision recorded (event #${decisionSeq}); running tasks keep their snapshot\n`
              : '  decision not recorded (no run exists yet); running tasks keep their snapshot\n',
          );
        }
        return 0;
      }),
    );
}

async function findRoot(): Promise<string> {
  const { findProjectRoot } = await import('../config/paths.js');
  const root = await findProjectRoot(process.cwd());
  if (!root) {
    throw new IdeaseekError('NOT_INITIALIZED', 'no IdeaSeek project here; run: ideaseek init');
  }
  return root;
}
