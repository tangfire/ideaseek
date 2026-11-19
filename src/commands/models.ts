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
        const { loadUserConfig, resolveCredentialPresence } =
          await import('../config/user-config.js');
        const user = await loadUserConfig();
        const credentialPresence = resolveCredentialPresence(user.config.models.credentialRef);

        const payload = {
          projectRoute: config.resolved.runtime.modelRoute,
          dshCommit: dshPin,
          credentials,
          userConfig: {
            path: user.path,
            existed: user.existed,
            errors: user.errors,
            provider: user.config.models.provider,
            defaultRoute: user.config.models.defaultRoute,
            credentialRef: credentialPresence.ref,
            credentialPresence: credentialPresence.presence,
            notificationsEnabled: user.config.notifications.enabled,
          },
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
        process.stdout.write(
          `user config: ${payload.userConfig.path} (${payload.userConfig.existed ? 'loaded' : 'defaults'}) · ` +
            `provider=${payload.userConfig.provider} · credentialRef=${payload.userConfig.credentialRef ?? 'none'} ` +
            `[${payload.userConfig.credentialPresence}]\n`,
        );
        for (const error of payload.userConfig.errors) {
          process.stdout.write(`  ✗ ${error}\n`);
        }
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

  models
    .command('providers')
    .description(
      'list configurable providers: known defaults plus entries already in DSH settings (names and endpoints only)',
    )
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { json?: boolean }) => {
        const { listProviders } = await import('../models/setup.js');
        const rows = await listProviders();
        if (opts.json) {
          process.stdout.write(jsonLine({ providers: rows }));
          return 0;
        }
        process.stdout.write('configurable providers:\n');
        for (const row of rows) {
          process.stdout.write(
            `  ${row.id.padEnd(14)}${row.baseUrl ?? '(--base-url required)'}  ` +
              `${row.configured ? 'configured' : 'not configured'}${row.apiKeyEnv ? ` · ${row.apiKeyEnv}` : ''}\n`,
          );
        }
        process.stdout.write(
          'next: ideaseek models setup --provider <id> --test  (an id outside this list must pass --base-url)\n',
        );
        return 0;
      }),
    );

  models
    .command('setup')
    .description(
      'interactive provider/API key wiring: hidden input, DSH credential store (apiKeyEnv NAME), connection test — never stores the key value',
    )
    .option('--provider <id>', 'DSH provider id (kebab-case)', 'deepseek')
    .option(
      '--api-key-env <name>',
      'environment VARIABLE NAME holding the key (never the value itself)',
      'DEEPSEEK_API_KEY',
    )
    .option('--base-url <url>', 'provider base URL (required when creating a new provider)')
    .option('--api-key-stdin', 'read the key from stdin (hidden automation path; never argv)')
    .option(
      '--prompt-key',
      'prompt for the key with hidden input (TTY only; value stays in memory)',
    )
    .option('--test', 'run the minimal connection test before writing anything')
    .option('--no-dsh', 'skip the DSH settings write (only user-config credentialRef)')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (opts: {
          provider: string;
          apiKeyEnv: string;
          baseUrl?: string;
          apiKeyStdin?: boolean;
          promptKey?: boolean;
          test?: boolean;
          dsh?: boolean;
          json?: boolean;
        }) => {
          const {
            assertEnvName,
            assertProviderId,
            readDshProvider,
            writeDshApiKeyEnv,
            connectionTest,
            knownBaseUrl,
            normalizeSuppliedKey,
            resolveTestKey,
            dshHome,
          } = await import('../models/setup.js');
          assertProviderId(opts.provider);
          assertEnvName(opts.apiKeyEnv);

          // Key acquisition: stdin (automation) or hidden TTY prompt.
          // The value NEVER touches argv, config files, logs or events.
          let supplied: string | null = null;
          if (opts.apiKeyStdin) {
            const chunks: Buffer[] = [];
            for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
            supplied = Buffer.concat(chunks).toString('utf8');
            if (!supplied.trim()) {
              throw new IdeaseekError(
                'USER_INPUT_REQUIRED',
                '--api-key-stdin was given but stdin was empty',
              );
            }
          } else if (opts.promptKey) {
            if (!process.stdin.isTTY) {
              throw new IdeaseekError(
                'ENV_UNSUPPORTED',
                '--prompt-key needs an interactive TTY — use --api-key-stdin in automation',
              );
            }
            supplied = await promptHidden('API key (input hidden): ');
            if (!supplied.trim()) {
              throw new IdeaseekError('USER_INPUT_REQUIRED', 'empty API key');
            }
          }
          if (supplied !== null) {
            const normalized = normalizeSuppliedKey(supplied);
            if (!normalized.ok) {
              throw new IdeaseekError(
                'INVALID_ARGUMENT',
                `supplied API key rejected (${normalized.reason}) — nothing was written`,
              );
            }
            supplied = normalized.value;
          }

          // Connection test FIRST (when requested): a failing test writes
          // nothing, so a bad key never leaves partial wiring behind.
          let tested: { ok: boolean; status: number | null; detail: string } | null = null;
          if (opts.test) {
            const providerView = await readDshProvider(opts.provider);
            // Same well-known default the write path uses: a fresh machine has
            // no DSH provider entry yet, and asking for --base-url there was
            // pure friction.
            const baseUrl = opts.baseUrl ?? providerView.baseURL ?? knownBaseUrl(opts.provider);
            if (!baseUrl) {
              throw new IdeaseekError(
                'USER_INPUT_REQUIRED',
                `no base URL known for provider "${opts.provider}" — pass --base-url`,
              );
            }
            const resolved = resolveTestKey(supplied, opts.apiKeyEnv);
            if (!resolved.present || resolved.value === null) {
              throw new IdeaseekError(
                'USER_INPUT_REQUIRED',
                `no key available for the test — export ${opts.apiKeyEnv} or pipe the key via --api-key-stdin (the value is never stored)`,
              );
            }
            tested = await connectionTest(baseUrl, resolved.value);
            // Drop the in-memory copy before any writes.
            // Report where the key came from and how long it is before
            // dropping the value: a 401 from a hidden paste is usually a
            // truncated or padded clipboard, and length is the only honest
            // clue that costs no secret.
            const keyHint =
              supplied !== null
                ? `key came from the hidden capture (${supplied.length} chars)`
                : `key came from ${opts.apiKeyEnv} (${(process.env[opts.apiKeyEnv] ?? '').trim().length} chars)`;
            supplied = null;
            if (!tested.ok) {
              if (opts.json) {
                process.stdout.write(
                  jsonLine({ ok: false, stage: 'connection-test', tested, wrote: [] }),
                );
                return 1;
              }
              process.stderr.write(`connection test FAILED: ${tested.detail}\n`);
              process.stderr.write(`  ${keyHint}\n`);
              process.stderr.write(
                'next: a length that looks wrong means the paste was cut short — re-enter it, or pipe it ' +
                  `with: ideaseek models setup --provider ${opts.provider} --test --api-key-stdin\n`,
              );
              return 1;
            }
          }

          const wrote: string[] = [];
          let dshWrite: { path: string; created: boolean } | null = null;
          if (opts.dsh !== false) {
            const result = await writeDshApiKeyEnv(opts.provider, opts.apiKeyEnv, {
              baseUrl: opts.baseUrl,
            });
            dshWrite = { path: result.path, created: result.created };
            wrote.push(`dsh-settings:${result.path} (providers.${opts.provider}.apiKeyEnv)`);
          }
          const credentialRef =
            opts.dsh === false ? `env:${opts.apiKeyEnv}` : `env:${opts.apiKeyEnv}`;
          const { saveUserModelsPatch } = await import('../config/user-config.js');
          const saved = await saveUserModelsPatch({
            provider: opts.provider,
            credentialRef,
          });
          wrote.push(`user-config:${saved.path} (${saved.changed.join(', ')})`);

          const payload = {
            ok: true,
            provider: opts.provider,
            apiKeyEnv: opts.apiKeyEnv,
            credentialRef,
            dshHome: dshHome(),
            dsh: dshWrite,
            tested,
            wrote,
          };
          if (opts.json) {
            process.stdout.write(jsonLine(payload));
            return 0;
          }
          process.stdout.write(
            `models setup: provider=${opts.provider} apiKeyEnv=${opts.apiKeyEnv} credentialRef=${credentialRef}\n`,
          );
          if (dshWrite) {
            process.stdout.write(
              `  DSH credential store: ${dshWrite.path} → providers.${opts.provider}.apiKeyEnv (NAME only — no value stored)\n`,
            );
          }
          if (tested) {
            process.stdout.write(`  connection: ${tested.detail}\n`);
          }
          process.stdout.write(`  wrote: ${wrote.join('; ')}\n`);
          if ((process.env[opts.apiKeyEnv] ?? '').trim()) {
            process.stdout.write(
              `next: ideaseek models test  (key read from env ${opts.apiKeyEnv}; ` +
                `IdeaSeek holds only that NAME)\n`,
            );
          } else {
            // The hidden input was test-only: without an env/secret-manager
            // value the NEXT shell has nothing to read. Saying "key lives in
            // the credential store" here implied storage that never happened
            // (user confusion observed in the server acceptance).
            process.stdout.write(
              `note: the hidden key was used for the test only — per the no-store boundary ` +
                `IdeaSeek keeps the NAME "${opts.apiKeyEnv}", not the value.\n`,
            );
            process.stdout.write(
              `next: persist it in your shell config yourself, then re-test:\n` +
                `  echo 'export ${opts.apiKeyEnv}=***' >> ~/.bashrc && source ~/.bashrc\n` +
                `  ideaseek models test\n`,
            );
          }
          process.stdout.write(
            'boundary: IdeaSeek never writes the key value to config, git, prompts, events or logs\n',
          );
          return 0;
        },
      ),
    );

  models
    .command('test')
    .description(
      'minimal connectivity check for the configured credential reference (presence + GET /models; never prints the key)',
    )
    .option('--base-url <url>', 'override the provider base URL')
    .option('--timeout <ms>', 'request timeout', (value) => Number(value), 10_000)
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { baseUrl?: string; timeout: number; json?: boolean }) => {
        const { loadUserConfig, resolveCredentialPresence } =
          await import('../config/user-config.js');
        const { readDshProvider, connectionTest, knownBaseUrl, resolveTestKey } =
          await import('../models/setup.js');
        const user = await loadUserConfig();
        if (user.errors.length > 0) {
          throw new IdeaseekError(
            'INVALID_STATE',
            `user config errors: ${user.errors.join('; ')} — fix ${user.path}`,
          );
        }
        const ref = user.config.models.credentialRef;
        const presence = resolveCredentialPresence(ref);
        let envName: string | null = null;
        if (ref?.startsWith('env:')) envName = ref.slice(4);
        else if (ref?.startsWith('dsh:')) {
          // dsh:<id> resolves through the provider's apiKeyEnv NAME (the
          // pinned DSH credential mechanism) — value still comes from env.
          const view = await readDshProvider(ref.slice(4));
          envName = view.apiKeyEnv;
        }
        const resolved = envName
          ? resolveTestKey(null, envName)
          : { present: false, value: null, source: 'none' as const };
        if (!opts.baseUrl && !envName) {
          const payload = {
            ok: false,
            stage: 'resolve',
            ref,
            presence: presence.presence,
            detail: 'no credential reference or provider apiKeyEnv configured',
          };
          if (opts.json) process.stdout.write(jsonLine(payload));
          else {
            process.stderr.write(`models test: ${payload.detail}\n`);
            process.stderr.write('next: ideaseek models setup --api-key-env <NAME> --test\n');
          }
          return 2;
        }
        if (!resolved.present || resolved.value === null) {
          const payload = {
            ok: false,
            stage: 'key-present',
            ref,
            presence: presence.presence,
            envName,
            detail: `key value not present in environment (${envName ?? 'unknown NAME'}) — export it or use your secret manager`,
          };
          if (opts.json) process.stdout.write(jsonLine(payload));
          else {
            process.stderr.write(`models test: ${payload.detail}\n`);
            process.stderr.write(`next: export ${envName ?? 'DEEPSEEK_API_KEY'}=<your key>\n`);
          }
          return 2;
        }
        const providerView = envName ? await readDshProvider(user.config.models.provider) : null;
        // DSH consumes ~/.dsh/settings.yaml as an import source and renames it
        // afterwards, so the provider view is often gone by the next run. The
        // catalog default is the durable answer.
        const baseUrl =
          opts.baseUrl ?? providerView?.baseURL ?? knownBaseUrl(user.config.models.provider);
        if (!baseUrl) {
          const payload = {
            ok: false,
            stage: 'base-url',
            detail: `no base URL known for provider "${user.config.models.provider}" — pass --base-url`,
          };
          if (opts.json) process.stdout.write(jsonLine(payload));
          else process.stderr.write(`models test: ${payload.detail}\n`);
          return 2;
        }
        const result = await connectionTest(baseUrl, resolved.value, opts.timeout);
        const payload = {
          ok: result.ok,
          ref,
          presence: presence.presence,
          envName,
          keySource: resolved.source,
          baseUrl,
          status: result.status,
          detail: result.detail,
        };
        if (opts.json) process.stdout.write(jsonLine(payload));
        else {
          process.stdout.write(`models test: ${result.ok ? 'OK' : 'FAILED'} — ${result.detail}\n`);
          process.stdout.write(
            `  ref=${ref ?? 'none'} [${presence.presence}] env=${envName ?? 'none'} (value never printed)\n`,
          );
          if (!result.ok) {
            process.stderr.write(
              'next: check the key value, provider baseURL and network; retry ideaseek models test\n',
            );
          }
        }
        return result.ok ? 0 : 1;
      }),
    );
}

/** Hidden input: the prompt is shown, typed characters are never echoed. */
async function promptHidden(question: string): Promise<string> {
  const readline = await import('node:readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  const out = process.stdout;
  const originalWrite = out.write.bind(out);
  out.write = ((chunk: unknown, ...rest: unknown[]) => {
    const text = String(chunk);
    // Echo the prompt itself; swallow everything else (the secret).
    if (text.includes(question)) return originalWrite(chunk as never, ...(rest as never[]));
    return true;
  }) as typeof out.write;
  try {
    return await new Promise<string>((resolve) => {
      rl.question('', (answer) => resolve(answer));
    });
  } finally {
    out.write = originalWrite;
    rl.close();
  }
}

async function findRoot(): Promise<string> {
  const { findProjectRoot } = await import('../config/paths.js');
  const root = await findProjectRoot(process.cwd());
  if (!root) {
    throw new IdeaseekError('NOT_INITIALIZED', 'no IdeaSeek project here; run: ideaseek init');
  }
  return root;
}
