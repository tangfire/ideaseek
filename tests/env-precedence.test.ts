import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadLocalEnv, loadUserCredentials } from '../src/core/env.js';
import { resolveTestKey } from '../src/models/setup.js';

/**
 * Ingestion precedence (src/core/env.ts): a non-empty value we never wrote
 * is the real host env and wins; among files the credentials file outranks
 * a local .env regardless of load order; a re-read of the credentials file
 * refreshes a rotated key. Pins the "/models setup once, works everywhere"
 * ruling — a stale .env in a project must not shadow the saved key, and an
 * empty `KEY=` line must not either.
 */

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function writePair(
  dotenvText: string,
  credsText: string,
): Promise<{ dir: string; credsHome: string }> {
  const dir = await makeDir('ideaseek-prec-');
  const credsHome = await makeDir('ideaseek-prec-creds-');
  await writeFile(join(dir, '.env'), dotenvText, 'utf8');
  await writeFile(join(credsHome, 'credentials.env'), credsText, 'utf8');
  return { dir, credsHome };
}

describe('credential vs .env ingestion precedence', () => {
  it('the credentials file wins over a stale .env even when .env loads first', async () => {
    const { dir, credsHome } = await writePair(
      'IDEASEEK_TEST_PREC_A=sk-dotenv-a\n',
      'IDEASEEK_TEST_PREC_A=sk-creds-a\n',
    );
    await withEnv({ IDEASEEK_USER_CONFIG: join(credsHome, 'config.yaml') }, async () => {
      // The old startup order: .env first, credentials second.
      loadLocalEnv(dir);
      expect(process.env.IDEASEEK_TEST_PREC_A).toBe('sk-dotenv-a');
      loadUserCredentials();
      expect(process.env.IDEASEEK_TEST_PREC_A).toBe('sk-creds-a');
    });
    delete process.env.IDEASEEK_TEST_PREC_A;
  });

  it('a local .env never clobbers a credentials value loaded first', async () => {
    const { dir, credsHome } = await writePair(
      'IDEASEEK_TEST_PREC_B=sk-dotenv-b\n',
      'IDEASEEK_TEST_PREC_B=sk-creds-b\n',
    );
    await withEnv({ IDEASEEK_USER_CONFIG: join(credsHome, 'config.yaml') }, async () => {
      loadUserCredentials();
      loadLocalEnv(dir);
      expect(process.env.IDEASEEK_TEST_PREC_B).toBe('sk-creds-b');
    });
    delete process.env.IDEASEEK_TEST_PREC_B;
  });

  it('a non-empty host env value beats both files', async () => {
    const { dir, credsHome } = await writePair(
      'IDEASEEK_TEST_PREC_HOST=sk-dotenv-host\n',
      'IDEASEEK_TEST_PREC_HOST=sk-creds-host\n',
    );
    await withEnv(
      {
        IDEASEEK_USER_CONFIG: join(credsHome, 'config.yaml'),
        IDEASEEK_TEST_PREC_HOST: 'sk-real-host',
      },
      async () => {
        loadLocalEnv(dir);
        loadUserCredentials();
        expect(process.env.IDEASEEK_TEST_PREC_HOST).toBe('sk-real-host');
      },
    );
    delete process.env.IDEASEEK_TEST_PREC_HOST;
  });

  it('an empty host env var does not shadow the credentials key', async () => {
    const { credsHome } = await writePair('', 'IDEASEEK_TEST_PREC_EMPTY=sk-from-file\n');
    await withEnv(
      { IDEASEEK_USER_CONFIG: join(credsHome, 'config.yaml'), IDEASEEK_TEST_PREC_EMPTY: '' },
      async () => {
        loadUserCredentials();
        expect(process.env.IDEASEEK_TEST_PREC_EMPTY).toBe('sk-from-file');
      },
    );
    delete process.env.IDEASEEK_TEST_PREC_EMPTY;
  });

  it('re-reading the credentials file picks up a rotated key (resolveTestKey)', async () => {
    // The "configure, then use immediately" journey also covers rotation:
    // another process rewrites the key; this process must see the new value
    // on the next check without a restart.
    const credsHome = await makeDir('ideaseek-prec-rotate-');
    const configPath = join(credsHome, 'config.yaml');
    await writeFile(
      join(credsHome, 'credentials.env'),
      'IDEASEEK_TEST_PREC_ROTATE=sk-rotate-old\n',
      'utf8',
    );
    await withEnv({ IDEASEEK_USER_CONFIG: configPath }, async () => {
      const first = resolveTestKey(null, 'IDEASEEK_TEST_PREC_ROTATE');
      expect(first.present).toBe(true);
      expect(first.value).toBe('sk-rotate-old');

      await writeFile(
        join(credsHome, 'credentials.env'),
        'IDEASEEK_TEST_PREC_ROTATE=sk-rotate-new\n',
        'utf8',
      );
      const second = resolveTestKey(null, 'IDEASEEK_TEST_PREC_ROTATE');
      expect(second.present).toBe(true);
      expect(second.value).toBe('sk-rotate-new');
    });
    delete process.env.IDEASEEK_TEST_PREC_ROTATE;
  });

  it('still refuses to report a present key when neither host env nor file has one', async () => {
    const credsHome = await makeDir('ideaseek-prec-absent-');
    await withEnv(
      { IDEASEEK_USER_CONFIG: join(credsHome, 'config.yaml'), IDEASEEK_TEST_PREC_ABSENT: '' },
      async () => {
        const resolved = resolveTestKey(null, 'IDEASEEK_TEST_PREC_ABSENT');
        expect(resolved.present).toBe(false);
        expect(resolved.value).toBeNull();
      },
    );
    delete process.env.IDEASEEK_TEST_PREC_ABSENT;
  });
});
