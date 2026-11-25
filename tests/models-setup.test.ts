import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { CLI_BIN } from './helpers.js';
import { resolveTestKey } from '../src/models/setup.js';

/**
 * `/models setup` + `models test` (docs/CLI_SPEC 模型配置, rule: hidden
 * input, connection test, redacted recovery. Owner ruling 2026-11-19: the
 * journey is "/models setup once, works everywhere" — a supplied value is
 * saved to the user credentials file (0600, beside the user config) and
 * loaded into env at CLI startup; config/git/logs/events stay value-free).
 * DSH_HOME and IDEASEEK_USER_CONFIG are redirected to temp dirs — the real
 * ~/.dsh and ~/.ideaseek are never touched. A local HTTP server stands in
 * for the provider.
 */

function runCli(
  args: string[],
  extraEnv: Record<string, string> = {},
  stdin?: string,
  timeoutMs = 60_000,
  cwd: string = process.cwd(),
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1', ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli ${args.join(' ')} timed out; stderr=${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    // Always close stdin (default stdio keeps it a non-null pipe).
    child.stdin.end(stdin ?? '');
  });
}

interface Harness {
  dshHome: string;
  userConfig: string;
  env: Record<string, string>;
}

async function makeHarness(): Promise<Harness> {
  const base = await mkdtemp(join(tmpdir(), 'ideaseek-models-'));
  const dshHome = join(base, 'dsh');
  const userConfig = join(base, 'config.yaml');
  await mkdir(dshHome, { recursive: true });
  return {
    dshHome,
    userConfig,
    env: { DSH_HOME: dshHome, IDEASEEK_USER_CONFIG: userConfig },
  };
}

const servers: Server[] = [];
afterAll(() => {
  for (const server of servers) server.close();
});

async function startProviderServer(): Promise<{
  url: string;
  authHeaders: string[];
}> {
  const authHeaders: string[] = [];
  const server = createServer((req, res) => {
    authHeaders.push(String(req.headers.authorization ?? ''));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'fake-model-a' }, { id: 'fake-model-b' }] }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, authHeaders };
}

describe('ideaseek models setup (credential wiring without secret storage)', () => {
  it('wires NAME/ref into config and saves the value only to the credentials file', async () => {
    const h = await makeHarness();
    const provider = await startProviderServer();

    const result = await runCli(
      [
        'models',
        'setup',
        '--provider',
        'deepseek',
        '--base-url',
        provider.url,
        '--api-key-env',
        'MY_DEEPSEEK_KEY',
        '--api-key-stdin',
        '--test',
        '--json',
      ],
      h.env,
      'sk-test-value-123\n',
    );
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      apiKeyEnv: string;
      credentialRef: string;
      credentialsPath: string | null;
      tested: { ok: boolean; detail: string };
      wrote: string[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.apiKeyEnv).toBe('MY_DEEPSEEK_KEY');
    expect(payload.credentialRef).toBe('env:MY_DEEPSEEK_KEY');
    expect(payload.tested.ok).toBe(true);
    expect(payload.credentialsPath).toBe(join(dirname(h.userConfig), 'credentials.env'));

    // The provider saw a Bearer token (the key was used in-memory)…
    expect(provider.authHeaders[0]).toMatch(/^Bearer sk-test-value-123$/);

    // …but NO config file IdeaSeek controls contains the value…
    const settings = await readFile(join(h.dshHome, 'settings.yaml'), 'utf8');
    const userCfg = await readFile(h.userConfig, 'utf8');
    expect(settings).not.toContain('sk-test-value-123');
    expect(userCfg).not.toContain('sk-test-value-123');
    expect(result.stdout).not.toContain('sk-test-value-123');
    expect(result.stderr).not.toContain('sk-test-value-123');
    expect(settings).toContain('apiKeyEnv: MY_DEEPSEEK_KEY');
    expect(userCfg).toContain('credentialRef: env:MY_DEEPSEEK_KEY');
    expect(userCfg).toContain('provider: deepseek');

    // …and the value's single on-disk home is the 0600 credentials file.
    const credsPath = join(dirname(h.userConfig), 'credentials.env');
    expect(await readFile(credsPath, 'utf8')).toContain('MY_DEEPSEEK_KEY=sk-test-value-123');
    if (process.platform !== 'win32') {
      const { stat } = await import('node:fs/promises');
      expect((await stat(credsPath)).mode & 0o777).toBe(0o600);
    }
  }, 60_000);

  it('setup saves the key once and a fresh process picks it up without any export', async () => {
    // Owner ruling: the product journey is "/models setup, then it just
    // works" — no manual export. The saved value must be visible to a
    // LATER process purely through the 0600 credentials file.
    const h = await makeHarness();
    const provider = await startProviderServer();

    const setup = await runCli(
      [
        'models',
        'setup',
        '--provider',
        'deepseek',
        '--base-url',
        provider.url,
        '--api-key-env',
        'MY_DEEPSEEK_KEY',
        '--api-key-stdin',
        '--test',
      ],
      h.env,
      'sk-round-trip-key-98765\n',
    );
    expect(setup.code, setup.stdout + setup.stderr).toBe(0);
    expect(setup.stdout).toContain('key saved to');
    expect(setup.stdout).toContain('ideaseek models test');
    expect(setup.stdout).not.toContain('key lives in');
    expect(setup.stdout).not.toContain('sk-round-trip-key'); // value never printed

    // Fresh process: env still has NO key — only the credentials file does.
    // `models list` is project-scoped (no context → NOT_INITIALIZED is the
    // documented rule), so run it from a real project like a user would —
    // this checkout is a fresh clone with no .research/ at its root.
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-models-proj-'));
    expect((await runCli(['init'], h.env, undefined, 60_000, project)).code).toBe(0);
    const list = await runCli(['models', 'list', '--json'], h.env, undefined, 60_000, project);
    expect(list.code, list.stdout + list.stderr).toBe(0);
    const payload = JSON.parse(list.stdout) as {
      userConfig: { credentialPresence: string; credentialRef: string | null };
    };
    expect(payload.userConfig.credentialRef).toBe('env:MY_DEEPSEEK_KEY');
    expect(payload.userConfig.credentialPresence).toBe('configured');

    // …and the wiring is real: connection test against the mock provider.
    const retest = await runCli(['models', 'test', '--json'], h.env);
    expect(retest.code, retest.stdout + retest.stderr).toBe(0);
    expect(retest.stdout).not.toContain('sk-round-trip-key');
  }, 60_000);

  it('a stale .env in the working directory cannot shadow the saved key', async () => {
    // Startup ingests <cwd>/.env AND the credentials file. With first-writer
    // wins, a project-local .env holding an old value silently beat the key
    // /models setup just saved — later runs authenticated with the stale key.
    const h = await makeHarness();
    const provider = await startProviderServer();
    const setup = await runCli(
      [
        'models',
        'setup',
        '--provider',
        'deepseek',
        '--base-url',
        provider.url,
        '--api-key-env',
        'SHADOW_KEY',
        '--json',
      ],
      h.env,
    );
    expect(setup.code, setup.stdout + setup.stderr).toBe(0);
    await writeFile(
      join(dirname(h.userConfig), 'credentials.env'),
      'SHADOW_KEY=sk-from-credentials-file\n',
      'utf8',
    );
    const cwd = await mkdtemp(join(tmpdir(), 'ideaseek-shadow-'));
    await writeFile(join(cwd, '.env'), 'SHADOW_KEY=sk-stale-dotenv\n', 'utf8');

    const test = await runCli(
      ['models', 'test', '--json'],
      { ...h.env, SHADOW_KEY: '' }, // empty host var must not shadow either
      undefined,
      60_000,
      cwd,
    );
    expect(test.code, test.stdout + test.stderr).toBe(0);
    // The provider must see the credentials-file value, not the stale .env.
    expect(provider.authHeaders.at(-1)).toBe('Bearer sk-from-credentials-file');
    expect(test.stdout + test.stderr).not.toContain('sk-from-credentials-file');
    expect(test.stdout + test.stderr).not.toContain('sk-stale-dotenv');
  }, 60_000);

  it('resolveTestKey sees a credentials file written after the process started', async () => {
    // The "configure, then use immediately — no restart" contract: this
    // process began before the file existed; resolveTestKey must reload it
    // just in time (the TUI's own process is the motivating case).
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-late-key-'));
    const previous = process.env.IDEASEEK_USER_CONFIG;
    process.env.IDEASEEK_USER_CONFIG = join(dir, 'config.yaml');
    delete process.env.LATE_ARRIVAL_KEY;
    try {
      await writeFile(
        join(dir, 'credentials.env'),
        'LATE_ARRIVAL_KEY=sk-late-arrival-1234\n',
        'utf8',
      );
      const resolved = resolveTestKey(null, 'LATE_ARRIVAL_KEY');
      expect(resolved.present).toBe(true);
      expect(resolved.source).toBe('env');
      expect(resolved.value).toBe('sk-late-arrival-1234');
    } finally {
      if (previous === undefined) delete process.env.IDEASEEK_USER_CONFIG;
      else process.env.IDEASEEK_USER_CONFIG = previous;
      delete process.env.LATE_ARRIVAL_KEY;
    }
  }, 30_000);

  it('updates only apiKeyEnv on an existing provider and preserves other fields', async () => {
    const h = await makeHarness();
    await writeFile(
      join(h.dshHome, 'settings.yaml'),
      [
        '# user comments must survive',
        'llm-pi-ai:',
        '  providers:',
        '    zh-gateway:',
        '      displayName: zh-gateway',
        '      baseURL: https://relay.example/v1',
        '      api: openai-completions',
        '      apiKeyEnv: OLD_NAME',
        'other-tool:',
        '  keep: me',
        '',
      ].join('\n'),
      'utf8',
    );
    const result = await runCli(
      ['models', 'setup', '--provider', 'zh-gateway', '--api-key-env', 'NEW_GATEWAY_KEY', '--json'],
      h.env,
    );
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const settings = await readFile(join(h.dshHome, 'settings.yaml'), 'utf8');
    expect(settings).toContain('apiKeyEnv: NEW_GATEWAY_KEY');
    expect(settings).not.toContain('OLD_NAME');
    expect(settings).toContain('baseURL: https://relay.example/v1');
    expect(settings).toContain('other-tool');
    expect(settings).toContain('# user comments must survive');
  }, 60_000);

  it('reads the provider catalog DSH left behind as settings.yaml.imported', async () => {
    // DSH's settings loader imports settings.yaml once and renames it
    // (importLegacyDocument in @deepseek-ai/dsh-settings). Before this fix
    // every DSH boot made `models providers` report "not configured" and
    // pushed the researcher to re-run a setup that had already succeeded.
    const h = await makeHarness();
    await writeFile(
      join(h.dshHome, 'settings.yaml'),
      [
        'llm-pi-ai:',
        '  providers:',
        '    zh-gateway:',
        '      displayName: zh-gateway',
        '      baseURL: https://relay.example/v1',
        '      api: openai-completions',
        '      apiKeyEnv: SAVED_NAME',
        '',
      ].join('\n'),
      'utf8',
    );
    const { rename } = await import('node:fs/promises');
    await rename(
      join(h.dshHome, 'settings.yaml'),
      join(h.dshHome, 'settings.yaml.imported'),
    );

    // The catalog is still configured — read through the rename…
    const providers = await runCli(['models', 'providers', '--json'], h.env);
    expect(providers.code, providers.stdout + providers.stderr).toBe(0);
    const catalog = JSON.parse(providers.stdout) as {
      providers: Array<{ id: string; configured: boolean; apiKeyEnv: string | null }>;
    };
    const row = catalog.providers.find((entry) => entry.id === 'zh-gateway');
    expect(row?.configured).toBe(true);
    expect(row?.apiKeyEnv).toBe('SAVED_NAME');

    // …and a re-run seeds from the renamed file instead of dropping the
    // provider back to "create it from scratch".
    const rerun = await runCli(
      ['models', 'setup', '--provider', 'zh-gateway', '--api-key-env', 'ROTATED_NAME', '--json'],
      h.env,
    );
    expect(rerun.code, rerun.stdout + rerun.stderr).toBe(0);
    const rebuilt = await readFile(join(h.dshHome, 'settings.yaml'), 'utf8');
    expect(rebuilt).toContain('apiKeyEnv: ROTATED_NAME');
    expect(rebuilt).toContain('baseURL: https://relay.example/v1');
  }, 60_000);

  it('rejects secret-shaped env names and unknown providers without a base URL', async () => {
    const h = await makeHarness();
    const secretish = await runCli(
      ['models', 'setup', '--api-key-env', 'sk-abcdef123456', '--json'],
      h.env,
    );
    expect(secretish.code).not.toBe(0);
    expect(secretish.stderr).toContain('SECRET VALUE');

    const noBase = await runCli(
      ['models', 'setup', '--provider', 'mystery', '--api-key-env', 'PLAIN_NAME', '--json'],
      h.env,
    );
    expect(noBase.code).not.toBe(0);
    expect(noBase.stderr).toContain('--base-url');

    // Nothing was written for either failure.
    await expect(readFile(join(h.dshHome, 'settings.yaml'), 'utf8')).rejects.toThrow();
    await expect(readFile(h.userConfig, 'utf8')).rejects.toThrow();
  }, 60_000);

  it('assumes the well-known deepseek endpoint instead of demanding --base-url', async () => {
    const h = await makeHarness();
    // Hermetic key name: this dev machine may carry a real DEEPSEEK_API_KEY
    // in a local .env, and an empty var no longer shadows file-sourced keys
    // (env precedence fix) — point resolution at a name that exists nowhere.
    const result = await runCli(
      [
        'models',
        'setup',
        '--provider',
        'deepseek',
        '--api-key-env',
        'FRESH_NO_KEY_7',
        '--test',
        '--json',
      ],
      {
        ...h.env,
        DEEPSEEK_API_KEY: '',
      },
    );
    // Before, the connection test looked only at the DSH provider view and
    // threw here — on a fresh machine there is no provider entry to read.
    expect(result.stderr).not.toContain('no base URL known');
    // It got past base-url resolution and stopped at the missing key: still
    // offline, and nothing was written.
    expect(result.stderr).toContain('no key available');
    await expect(readFile(join(h.dshHome, 'settings.yaml'), 'utf8')).rejects.toThrow();
  }, 60_000);

  it('a failing connection test writes nothing (fail closed)', async () => {
    const h = await makeHarness();
    const result = await runCli(
      [
        'models',
        'setup',
        '--provider',
        'deepseek',
        '--base-url',
        'http://127.0.0.1:1',
        '--api-key-env',
        'MY_KEY',
        '--api-key-stdin',
        '--test',
        '--json',
      ],
      h.env,
      'sk-should-not-persist\n',
    );
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stdout) as { ok: boolean; wrote: unknown[] };
    expect(payload.ok).toBe(false);
    expect(payload.wrote).toEqual([]);
    await expect(readFile(join(h.dshHome, 'settings.yaml'), 'utf8')).rejects.toThrow();
    await expect(readFile(h.userConfig, 'utf8')).rejects.toThrow();
    expect(result.stdout + result.stderr).not.toContain('sk-should-not-persist');
  }, 60_000);

  it('refuses hidden prompt without a TTY (automation uses --api-key-stdin)', async () => {
    const h = await makeHarness();
    const result = await runCli(['models', 'setup', '--prompt-key', '--json'], h.env);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('TTY');
    expect(result.stderr).toContain('--api-key-stdin');
  }, 60_000);
});

describe('ideaseek models test (minimal connectivity, presence only)', () => {
  it('passes with the env key present and never prints the value', async () => {
    const h = await makeHarness();
    const provider = await startProviderServer();
    // Wire the provider first (names only, no test).
    const setup = await runCli(
      [
        'models',
        'setup',
        '--provider',
        'deepseek',
        '--base-url',
        provider.url,
        '--api-key-env',
        'TEST_KEY',
        '--json',
      ],
      h.env,
    );
    expect(setup.code, setup.stdout + setup.stderr).toBe(0);

    const ok = await runCli(['models', 'test', '--json'], {
      ...h.env,
      TEST_KEY: 'sk-env-only-value',
    });
    expect(ok.code, ok.stdout + ok.stderr).toBe(0);
    const payload = JSON.parse(ok.stdout) as {
      ok: boolean;
      keySource: string;
      detail: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.keySource).toBe('env');
    expect(payload.detail).toContain('200');
    expect(ok.stdout).not.toContain('sk-env-only-value');
    expect(ok.stderr).not.toContain('sk-env-only-value');
    expect(provider.authHeaders.at(-1)).toBe('Bearer sk-env-only-value');
  }, 60_000);

  it('reports a missing key honestly with recovery (exit 2)', async () => {
    const h = await makeHarness();
    const setup = await runCli(
      [
        'models',
        'setup',
        '--provider',
        'deepseek',
        '--base-url',
        'http://127.0.0.1:9',
        '--api-key-env',
        'ABSENT_KEY',
        '--json',
      ],
      h.env,
    );
    expect(setup.code, setup.stdout + setup.stderr).toBe(0);
    const missing = await runCli(['models', 'test', '--json'], h.env);
    expect(missing.code).toBe(2);
    const payload = JSON.parse(missing.stdout) as { ok: boolean; detail: string };
    expect(payload.ok).toBe(false);
    expect(payload.detail).toContain('ABSENT_KEY');
    expect(missing.stdout + missing.stderr).not.toMatch(/sk-[A-Za-z0-9]{6,}/);
  }, 60_000);
});
