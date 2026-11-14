import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultUserConfig,
  loadUserConfig,
  resolveCredentialPresence,
  validateUserConfig,
} from '../src/config/user-config.js';
import { CLI_BIN } from './helpers.js';

/**
 * User-level config layering (PRODUCT_GAPS #3): provider/credential
 * REFERENCES and preferences live in ~/.ideaseek/config.yaml (redirected to
 * temp files here), project research.yaml never reads them, and secret
 * VALUES are hard errors in either layer.
 */

let previousUserConfig: string | undefined;

afterEach(() => {
  if (previousUserConfig === undefined) delete process.env.IDEASEEK_USER_CONFIG;
  else process.env.IDEASEEK_USER_CONFIG = previousUserConfig;
  previousUserConfig = undefined;
});

async function isolatedUserConfig(content?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ideaseek-usercfg-'));
  const path = join(dir, 'config.yaml');
  if (content !== undefined) await writeFile(path, content, 'utf8');
  previousUserConfig = process.env.IDEASEEK_USER_CONFIG;
  process.env.IDEASEEK_USER_CONFIG = path;
  return path;
}

function runCli(
  cwd: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: {
        ...process.env,
        IDEASEEK_CLI: '1',
        ...(process.env.IDEASEEK_USER_CONFIG
          ? { IDEASEEK_USER_CONFIG: process.env.IDEASEEK_USER_CONFIG }
          : {}),
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli ${args.join(' ')} timed out`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

describe('validateUserConfig (unit)', () => {
  it('returns built-in defaults for an empty config', () => {
    const result = validateUserConfig(null);
    expect(result.errors).toEqual([]);
    expect(result.config).toEqual(defaultUserConfig());
    expect(result.sources['models.provider']).toBe('user-default');
  });

  it('accepts references, routes and preferences from a user file', () => {
    const result = validateUserConfig({
      version: 1,
      models: {
        provider: 'deepseek-official',
        defaultRoute: 'deep',
        credentialRef: 'env:DEEPSEEK_API_KEY',
      },
      notifications: { enabled: true, webhook: 'https://hooks.example.com/notify' },
    });
    expect(result.errors).toEqual([]);
    expect(result.config.models.credentialRef).toBe('env:DEEPSEEK_API_KEY');
    expect(result.config.models.defaultRoute).toBe('deep');
    expect(result.config.notifications.enabled).toBe(true);
    expect(result.sources['models.credentialRef']).toBe('user-file');
    expect(result.sources['models.defaultRoute']).toBe('user-file');
  });

  it('refuses secret VALUES and malformed references', () => {
    const secret = validateUserConfig({
      models: { credentialRef: 'sk-abcdef1234567890abcdef' },
    });
    expect(secret.errors.join(' ')).toContain('SECRET VALUE');

    const badFormat = validateUserConfig({ models: { credentialRef: 'my-password-here' } });
    expect(badFormat.errors.join(' ')).toContain('env:NAME or dsh:id');

    const embeddedToken = validateUserConfig({
      notifications: { webhook: 'https://x.example/hook?token=abc123secret' },
    });
    expect(embeddedToken.errors.join(' ')).toContain('must not embed tokens');
  });

  it('rejects unknown fields and bad types (typos never become defaults)', () => {
    const unknown = validateUserConfig({ models: { defualtRoute: 'fast' } });
    expect(unknown.errors.join(' ')).toContain('unknown key: models.defualtRoute');

    const badRoute = validateUserConfig({ models: { defaultRoute: 'Fast Route' } });
    expect(badRoute.errors.join(' ')).toContain('kebab-case');

    const badVersion = validateUserConfig({ version: 2 });
    expect(badVersion.errors.join(' ')).toContain('unsupported user config version');
  });
});

describe('loadUserConfig and credential presence', () => {
  it('missing file → defaults with no errors; bad YAML → returned errors, no throw', async () => {
    await isolatedUserConfig(); // path exists but file does not
    const missing = await loadUserConfig();
    expect(missing.existed).toBe(false);
    expect(missing.errors).toEqual([]);
    expect(missing.config.models.provider).toBe('deepseek-official');

    await isolatedUserConfig('models: [broken');
    const broken = await loadUserConfig();
    expect(broken.existed).toBe(true);
    expect(broken.errors.join(' ')).toContain('not valid YAML');
  });

  it('resolves credential references to presence only — never a value', () => {
    expect(resolveCredentialPresence(null)).toEqual({
      ref: null,
      presence: 'not-configured',
    });
    expect(resolveCredentialPresence('dsh:deepseek')).toEqual({
      ref: 'dsh:deepseek',
      presence: 'store',
    });
    process.env.IDEASEEK_TEST_CRED = 'super-secret-value';
    try {
      expect(resolveCredentialPresence('env:IDEASEEK_TEST_CRED')).toEqual({
        ref: 'env:IDEASEEK_TEST_CRED',
        presence: 'configured',
      });
      expect(resolveCredentialPresence('env:IDEASEEK_TEST_CRED_MISSING')).toEqual({
        ref: 'env:IDEASEEK_TEST_CRED_MISSING',
        presence: 'missing',
      });
      // The result structure can never carry the secret itself.
      expect(JSON.stringify(resolveCredentialPresence('env:IDEASEEK_TEST_CRED'))).not.toContain(
        'super-secret-value',
      );
    } finally {
      delete process.env.IDEASEEK_TEST_CRED;
    }
  });
});

describe('user/project config layering (CLI)', () => {
  it('config explain surfaces the user layer and its boundary note', async () => {
    const path = await isolatedUserConfig(
      [
        'version: 1',
        'models:',
        '  provider: deepseek-official',
        '  defaultRoute: deep',
        '  credentialRef: env:DEEPSEEK_API_KEY',
        'notifications:',
        '  enabled: true',
        '',
      ].join('\n'),
    );
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-ucfg-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    const projectConfigBefore = await readFile(join(project, 'research.yaml'), 'utf8');

    const json = await runCli(project, ['config', 'explain', '--json']);
    expect(json.code, json.stdout + json.stderr).toBe(0);
    const payload = JSON.parse(json.stdout) as {
      userConfig: {
        path: string;
        existed: boolean;
        errors: string[];
        config: { models: { credentialRef: string; defaultRoute: string } };
        note: string;
      };
    };
    expect(payload.userConfig.existed).toBe(true);
    expect(payload.userConfig.errors).toEqual([]);
    expect(payload.userConfig.config.models.credentialRef).toBe('env:DEEPSEEK_API_KEY');
    expect(payload.userConfig.config.models.defaultRoute).toBe('deep');
    expect(payload.userConfig.note).toContain('never contains or reads secrets');

    const plain = await runCli(project, ['config', 'explain']);
    expect(plain.stdout).toContain('user config:');
    expect(plain.stdout).toContain('boundary: project research.yaml cannot read');
    expect(plain.stdout).toContain('credentialRef = "env:DEEPSEEK_API_KEY"');

    // Project config is untouched by the user layer (no writes, no merge-back).
    expect(await readFile(join(project, 'research.yaml'), 'utf8')).toBe(projectConfigBefore);
    // The user file itself was not modified by reading it.
    expect(await readFile(path, 'utf8')).toContain('credentialRef: env:DEEPSEEK_API_KEY');
  }, 60_000);

  it('config explain fails loudly on a secret-shaped user config', async () => {
    await isolatedUserConfig('models:\n  credentialRef: sk-deadbeefcafe123456\n');
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-ucfg-'));
    expect((await runCli(project, ['init'])).code).toBe(0);

    const explain = await runCli(project, ['config', 'explain']);
    expect(explain.code).toBe(2);
    expect(explain.stdout).toContain('SECRET VALUE');
    // The secret itself is never echoed.
    expect(explain.stdout).not.toContain('sk-deadbeefcafe123456');
    expect(explain.stderr).not.toContain('sk-deadbeefcafe123456');
  }, 60_000);

  it('models list and doctor report the user layer', async () => {
    await isolatedUserConfig(
      ['version: 1', 'models:', '  credentialRef: env:DEEPSEEK_API_KEY', ''].join('\n'),
    );
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-ucfg-'));
    expect((await runCli(project, ['init'])).code).toBe(0);

    const models = await runCli(project, ['models', 'list', '--json']);
    expect(models.code).toBe(0);
    const payload = JSON.parse(models.stdout) as {
      userConfig: { credentialRef: string; credentialPresence: string; provider: string };
    };
    expect(payload.userConfig.credentialRef).toBe('env:DEEPSEEK_API_KEY');
    expect(['configured', 'missing']).toContain(payload.userConfig.credentialPresence);
    expect(payload.userConfig.provider).toBe('deepseek-official');
    expect(models.stdout).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);

    const doctor = await runCli(project, ['doctor']);
    expect(doctor.code === 0 || doctor.code === 2).toBe(true);
    expect(doctor.stdout).toContain('user-config');
    expect(doctor.stdout).toContain('credentialRef=env:DEEPSEEK_API_KEY');
  }, 90_000);
});
