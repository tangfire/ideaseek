import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { CLI_BIN } from './helpers.js';

/**
 * `/models setup` + `models test` (docs/CLI_SPEC 模型配置, rule: hidden
 * input, DSH credential store wiring, connection test, redacted recovery,
 * NEVER store the key value). DSH_HOME and IDEASEEK_USER_CONFIG are
 * redirected to temp dirs — the real ~/.dsh and ~/.ideaseek are never
 * touched. A local HTTP server stands in for the provider.
 */

function runCli(
  args: string[],
  extraEnv: Record<string, string> = {},
  stdin?: string,
  timeoutMs = 60_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd: process.cwd(),
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
  it('writes apiKeyEnv NAME to DSH settings and credentialRef to user config — never the value', async () => {
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
      tested: { ok: boolean; detail: string };
      wrote: string[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.apiKeyEnv).toBe('MY_DEEPSEEK_KEY');
    expect(payload.credentialRef).toBe('env:MY_DEEPSEEK_KEY');
    expect(payload.tested.ok).toBe(true);

    // The provider saw a Bearer token (the key was used in-memory)…
    expect(provider.authHeaders[0]).toMatch(/^Bearer sk-test-value-123$/);

    // …but NO file IdeaSeek controls contains the value.
    const settings = await readFile(join(h.dshHome, 'settings.yaml'), 'utf8');
    const userCfg = await readFile(h.userConfig, 'utf8');
    expect(settings).not.toContain('sk-test-value-123');
    expect(userCfg).not.toContain('sk-test-value-123');
    expect(result.stdout).not.toContain('sk-test-value-123');
    expect(result.stderr).not.toContain('sk-test-value-123');
    expect(settings).toContain('apiKeyEnv: MY_DEEPSEEK_KEY');
    expect(userCfg).toContain('credentialRef: env:MY_DEEPSEEK_KEY');
    expect(userCfg).toContain('provider: deepseek');
  }, 60_000);

  it('a test-only hidden key points at the export step instead of implying storage', async () => {
    // The old next-line said "key lives in … credential store" even when the
    // value existed nowhere persistent — new users then skipped the env
    // export and hit "no key" in the next shell (observed in the server
    // acceptance run). The message must teach the persist step instead.
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
      ],
      h.env,
      'sk-test-value-123\n',
    );
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('used for the test only');
    expect(result.stdout).toContain('export MY_DEEPSEEK_KEY=***');
    expect(result.stdout).toContain('ideaseek models test');
    expect(result.stdout).not.toContain('key lives in');
    // …and the value still appears nowhere.
    expect(result.stdout).not.toContain('sk-test-value-123');
  }, 60_000);

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
    const result = await runCli(['models', 'setup', '--provider', 'deepseek', '--test', '--json'], {
      ...h.env,
      DEEPSEEK_API_KEY: '',
    });
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
