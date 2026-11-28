import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DSH_MAX_TOKENS,
  DEFAULT_DSH_INITIALIZE_ATTEMPTS,
  DSH_SDK_VERSION,
  DshHarnessAdapter,
  dshHandshakeFailureMessage,
  dshInitializeAttempts,
  describeJsonFailure,
  extractJson,
  findLlmFailure,
  handshakeAttempts,
  mapLlmFailureCode,
} from '../src/dsh/dsh-adapter.js';
import { REPO_ROOT } from './helpers.js';

describe('DSH failure mapping (stable LlmFailure.code contract)', () => {
  it('maps quota/auth/network codes to typed blocks', () => {
    expect(mapLlmFailureCode('QUOTA')).toEqual({
      kind: 'block',
      block: 'QUOTA_EXHAUSTED',
    });
    expect(mapLlmFailureCode('ACCOUNT_QUOTA')).toEqual({
      kind: 'block',
      block: 'QUOTA_EXHAUSTED',
    });
    expect(mapLlmFailureCode('AUTH')).toEqual({ kind: 'block', block: 'AUTH_REQUIRED' });
    expect(mapLlmFailureCode('MISSING_CREDENTIAL')).toEqual({
      kind: 'block',
      block: 'AUTH_REQUIRED',
    });
    expect(mapLlmFailureCode('INVALID_CREDENTIAL')).toEqual({
      kind: 'block',
      block: 'AUTH_REQUIRED',
    });
    expect(mapLlmFailureCode('TRANSPORT')).toEqual({ kind: 'block', block: 'NETWORK_BLOCKED' });
  });

  it('maps transient codes to retryable and scope codes to permanent', () => {
    for (const code of ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'EMPTY_RESPONSE', 'WHATEVER']) {
      expect(mapLlmFailureCode(code)).toEqual({ kind: 'retryable' });
    }
    expect(mapLlmFailureCode('CONTEXT_WINDOW_EXCEEDED')).toEqual({ kind: 'permanent' });
    expect(mapLlmFailureCode('IMAGE_OFFLOAD_REQUIRED')).toEqual({ kind: 'permanent' });
  });
});

describe('RunResult interpretation', () => {
  it('finds the typed failure on turn/end events', () => {
    const result = {
      sessionId: 's1',
      finalResponse: 'something exploded',
      finishReason: 'error',
      events: [
        { type: 'turn/start', data: {} },
        {
          type: 'turn/end',
          data: { reason: { kind: 'error', error: { code: 'QUOTA', message: 'limit hit' } } },
        },
      ],
      notifications: [],
    } as never;
    expect(findLlmFailure(result)).toEqual({ code: 'QUOTA', message: 'limit hit' });
  });

  it('falls back to a code token in the diagnostic text', () => {
    const result = {
      sessionId: 's1',
      finalResponse: 'request failed with MISSING_CREDENTIAL for provider',
      finishReason: 'error',
      events: [],
      notifications: [],
    } as never;
    expect(findLlmFailure(result)?.code).toBe('MISSING_CREDENTIAL');
  });

  it('returns null when no failure is present', () => {
    const result = {
      sessionId: 's1',
      finalResponse: 'all good',
      finishReason: 'stop',
      events: [],
      notifications: [],
    } as never;
    expect(findLlmFailure(result)).toBeNull();
  });

  it('extracts JSON from plain, fenced and prose-wrapped responses', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('Here is the card:\n{"a":1}\nHope it helps')).toBe('{"a":1}');
    expect(extractJson('no json at all')).toBeNull();
    expect(extractJson('{broken json')).toBeNull();
  });
});

describe('describeJsonFailure (the cause is stated only as far as the evidence goes)', () => {
  it('names truncation and the ceiling when the finish reason says length', () => {
    const truncated = '{"methodId":"fedavg","paperExplicit":[{"statement":"x"';
    const message = describeJsonFailure(truncated, DEFAULT_DSH_MAX_TOKENS, 'length');
    expect(message).toContain('cut off at the output cap');
    expect(message).toContain(`maxTokens=${DEFAULT_DSH_MAX_TOKENS}`);
    expect(message).toContain(`${truncated.length} characters`);
    expect(message).toContain('ends mid-structure');
  });

  it('does not blame the token cap when the harness reported a normal end', () => {
    // The real shape that started this: 20205 characters, finishReason
    // completed. The old text called that "most likely truncated at the
    // harness output limit" and named a number, which sent the reader to raise
    // a cap that was never the problem.
    const complete = `{"candidates": [{"ideaId": "x", "hypothesis": {"statement": "unterminated`;
    const message = describeJsonFailure(complete, DEFAULT_DSH_MAX_TOKENS, 'completed');
    expect(message).not.toContain('most likely truncated');
    expect(message).not.toContain('cut off at the output cap');
    expect(message).toContain('harness reported no length limit');
    expect(message).toContain('finishReason=completed');
    // Both ends are shown: trailing prose and an unterminated string are
    // distinguishable only if you can see them.
    expect(message).toContain('head:');
    expect(message).toContain('tail:');
    expect(message).toContain('unescaped quote or newline');
  });

  it('says plainly when there is no JSON at all', () => {
    expect(describeJsonFailure('I could not complete this task.', 8192)).toContain(
      'contains no JSON object',
    );
  });

  it('pins the ceiling used by the harness and the one named in failures', async () => {
    // The message is only honest if it quotes the number actually configured.
    const source = await readFile(join('src', 'dsh', 'dsh-adapter.ts'), 'utf8');
    expect(source).toContain('this.opts.maxOutputTokens ?? DEFAULT_DSH_MAX_TOKENS');
    expect(source).toContain('this.opts.maxOutputTokens ?? DEFAULT_DSH_MAX_TOKENS,');
  });
});

describe('DSH handshake retry (a busy machine is not a missing install)', () => {
  it('gives a timed-out handshake a second attempt and returns the live client', async () => {
    const started: number[] = [];
    const cleaned: number[] = [];
    const waited: number[] = [];
    let serial = 0;
    const outcome = await handshakeAttempts({
      attempts: 3,
      create: () => ++serial,
      start: (client) => {
        started.push(client);
        if (client < 2) return Promise.reject(new Error('initialize timed out after 30000ms'));
        return Promise.resolve();
      },
      cleanup: (client) => {
        cleaned.push(client);
        return Promise.resolve();
      },
      wait: (ms) => {
        waited.push(ms);
        return Promise.resolve();
      },
    });
    expect(outcome).toEqual({ ok: true, client: 2 });
    // The failed runtime is reaped before the next one spawns: two attempts,
    // one cleanup, one backoff.
    expect(started).toEqual([1, 2]);
    expect(cleaned).toEqual([1]);
    expect(waited).toHaveLength(1);
  });

  it('reports the last error when every attempt failed, and settles null between them', async () => {
    const settled: (number | null)[] = [];
    const outcome = await handshakeAttempts({
      attempts: 2,
      create: () => 1,
      start: () => Promise.reject(new Error('initialize timed out after 30000ms')),
      cleanup: () => Promise.resolve(),
      settle: (client) => settled.push(client),
      wait: () => Promise.resolve(),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.lastError.message).toContain('timed out');
    expect(settled).toEqual([1, null, 1, null]);
  });

  it('names the observed cause in the failure text, not the one it guessed', () => {
    const timeout = dshHandshakeFailureMessage({
      sdkVersion: '0.2.2',
      timeoutMs: 30_000,
      attempts: 2,
      lastError: 'initialize timed out after 30000ms waiting for dsh profile "sdk"',
    });
    // The old text asked only about installation; a timeout does not mean the
    // dependency is missing, and sending the reader to reinstall wastes a run.
    expect(timeout).toContain('IDEASEEK_DSH_INIT_TIMEOUT_MS');
    expect(timeout).toContain('loaded or slow machine');
    expect(timeout).toContain('2 attempts');
    expect(timeout).not.toContain('is @deepseek-ai/dsh');

    const spawnFailure = dshHandshakeFailureMessage({
      sdkVersion: '0.2.2',
      timeoutMs: 30_000,
      attempts: 2,
      lastError: 'spawn dsh ENOENT',
    });
    expect(spawnFailure).toContain('installed');
  });

  it('reads the attempt count from the environment inside sane bounds', () => {
    expect(dshInitializeAttempts({})).toBe(DEFAULT_DSH_INITIALIZE_ATTEMPTS);
    expect(dshInitializeAttempts({ IDEASEEK_DSH_INIT_ATTEMPTS: '4' })).toBe(4);
    // An out-of-range or unparseable value must not turn into 0 attempts (no
    // runtime at all) or an unbounded loop.
    expect(dshInitializeAttempts({ IDEASEEK_DSH_INIT_ATTEMPTS: '0' })).toBe(
      DEFAULT_DSH_INITIALIZE_ATTEMPTS,
    );
    expect(dshInitializeAttempts({ IDEASEEK_DSH_INIT_ATTEMPTS: '99' })).toBe(
      DEFAULT_DSH_INITIALIZE_ATTEMPTS,
    );
    expect(dshInitializeAttempts({ IDEASEEK_DSH_INIT_ATTEMPTS: 'abc' })).toBe(
      DEFAULT_DSH_INITIALIZE_ATTEMPTS,
    );
  });
});

describe('DSH SDK version pin', () => {
  it('matches the installed @deepseek-ai/dsh-sdk-client package', async () => {
    const pkg = JSON.parse(
      await readFile(
        join(REPO_ROOT, 'node_modules', '@deepseek-ai', 'dsh-sdk-client', 'package.json'),
        'utf8',
      ),
    ) as { version: string };
    expect(pkg.version).toBe(DSH_SDK_VERSION);

    const lock = JSON.parse(await readFile(join(REPO_ROOT, 'runtime-lock.json'), 'utf8')) as {
      dsh: { gitDescribe: string; commit: string };
    };
    expect(lock.dsh.gitDescribe).toContain('dsh-v0.2.2-rc.1');
    expect(lock.dsh.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('DshHarnessAdapter real runtime (keyless)', () => {
  /**
   * The (keyless) contract must hold on every machine, not only ones whose
   * host shell happens to export the key. `initialize()` loads
   * `~/.ideaseek/credentials.env` into process.env by design ("save once with
   * /models setup, works in every later shell"), so comparing a pre-init env
   * snapshot against post-init health failed on any machine where the key
   * lives in the credentials file: available came back true while the test's
   * keySet was false. Isolate BOTH credential sources (env var + the
   * user-config-relative credentials file) for the duration of the test.
   */
  async function withKeylessCredentials<T>(fn: () => Promise<T>): Promise<T> {
    const prevKey = process.env.DEEPSEEK_API_KEY;
    const prevUserConfig = process.env.IDEASEEK_USER_CONFIG;
    const prevProfile = process.env.USERPROFILE;
    const prevHome = process.env.HOME;
    const isolated = await mkdtemp(join(tmpdir(), 'ideaseek-user-config-'));
    process.env.IDEASEEK_USER_CONFIG = join(isolated, 'config.yaml');
    delete process.env.DEEPSEEK_API_KEY;
    // The DSH runtime ALSO has a global home (~/.dsh: legacy credentials,
    // sessions, imported settings) shared with every keyed test on this
    // machine. Under full-suite load the runtime picked working auth up from
    // that global state and the keyless contract silently became keyed — the
    // test resolved a REAL model response instead of rejecting. Redirect the
    // process homedir for the duration (the spawned child inherits it), which
    // also stops these runs from writing session state into the real ~/.dsh.
    const isolatedHome = await mkdtemp(join(tmpdir(), 'ideaseek-dsh-global-'));
    process.env.USERPROFILE = isolatedHome;
    process.env.HOME = isolatedHome;
    try {
      return await fn();
    } finally {
      if (prevKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = prevKey;
      if (prevUserConfig === undefined) delete process.env.IDEASEEK_USER_CONFIG;
      else process.env.IDEASEEK_USER_CONFIG = prevUserConfig;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  }

  it('spawns the pinned DSH runtime, reports credential state without reading secrets, and shuts down', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'ideaseek-dsh-home-'));
    const adapter = new DshHarnessAdapter({ dshHome, initializeTimeoutMs: 30_000 });

    await withKeylessCredentials(async () => {
      try {
        await adapter.initialize();
        const health = await adapter.health();
        expect(health.reachable).toBe(true);
        expect(health.models).toHaveLength(1);
        // With both credential sources isolated, health must report the
        // keyless truth — never a value loaded from a stored credentials file.
        expect(health.models[0]!.available).toBe(false);
        expect(health.blocked).toBe(true);
        expect(health.blockReason).toContain('DEEPSEEK_API_KEY');
        // The reason must never contain an actual secret value.
        expect(health.blockReason ?? '').not.toMatch(/[A-Za-z0-9_-]{20,}/);
        // Re-initialize is idempotent while alive.
        await adapter.initialize();
        expect(adapter.version).toBe(`dsh-sdk@${DSH_SDK_VERSION}`);
      } finally {
        await adapter.shutdown();
      }
      // Shutdown is idempotent.
      await adapter.shutdown();
    });
  }, 90_000);

  it('surfaces a typed AUTH block when the model call has no credentials', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'ideaseek-dsh-home-'));
    const adapter = new DshHarnessAdapter({ dshHome, initializeTimeoutMs: 30_000 });
    await withKeylessCredentials(async () => {
      // Diagnostic snapshot (existence only, never values): when the keyless
      // contract unexpectedly resolves a REAL model response, the failure
      // must name which credential channels were live at that moment.
      const { existsSync } = await import('node:fs');
      const { userCredentialsPath } = await import('../src/core/env.js');
      const diag = JSON.stringify({
        envKey: Boolean(process.env.DEEPSEEK_API_KEY),
        userConfig: process.env.IDEASEEK_USER_CONFIG ?? null,
        credsFileExists: existsSync(userCredentialsPath()),
        home: process.env.HOME ?? null,
        userProfile: process.env.USERPROFILE ?? null,
      });
      try {
        const outcome = await adapter
          .runTask({
            runId: 'run-test',
            taskId: 'task-test',
            profile: 'paper-extractor',
            instruction: 'Extract a JSON card.',
            inputs: [{ kind: 'text', name: 'paper', content: 'Some paper text.' }],
            outputSchema: 'papercard-lite-v1',
            budget: { timeoutMs: 60_000 },
            idempotencyKey: 'dsh-no-key-test',
          })
          .then(
            (value) => ({ ok: true as const, value }),
            (error) => ({ ok: false as const, error }),
          );
        if (outcome.ok) {
          const output = String((outcome.value as { output?: string }).output ?? '').slice(0, 160);
          throw new Error(
            `keyless run SUCCEEDED (credential leak) — diag=${diag} output=${output}`,
          );
        }
        // Either a typed AUTH/QUOTA block or a clearly-marked retryable DSH
        // error is acceptable keyless behavior — never a silent success and
        // never an unmapped crash.
        const name = (outcome.error as Error).name;
        const message = (outcome.error as Error).message ?? '';
        expect(
          name === 'HarnessBlockError' ||
            message.includes('dsh ') ||
            message.includes('failed to start DSH'),
          `unexpected rejection (diag=${diag}): ${name}: ${message.slice(0, 200)}`,
        ).toBe(true);
      } finally {
        await adapter.shutdown();
      }
    });
  }, 120_000);
});

describe('capability patch generation', () => {
  it('writes absolute-path plugin rows, the default preset and an existing plugin file', async () => {
    const { writeCapabilityPatch, EXTRACTOR_PRESET_ID } = await import('../src/dsh/capability.js');
    const { access, readFile: rf } = await import('node:fs/promises');
    const dshHome = await mkdtemp(join(tmpdir(), 'ideaseek-cap-'));
    const patch = await writeCapabilityPatch({ dshHome });

    expect(patch.patchPath.endsWith('ideaseek.cordis.yml')).toBe(true);
    const yaml = await rf(patch.patchPath, 'utf8');
    expect(yaml).toContain('ideaseek-research-tools');
    expect(yaml).toContain('ideaseek-agent-preset-registry');
    expect(yaml).toContain(`default: ${EXTRACTOR_PRESET_ID}`);
    expect(yaml).toContain('ideaseek-preset-ideaseek-extractor');

    // Plugin files must exist where the patch points (absolute paths), and the
    // research tool plugin really registers the restricted reader.
    await access(patch.pluginPaths.researchTools);
    await access(patch.pluginPaths.extractorProfile);
    const pluginSource = await rf(patch.pluginPaths.researchTools, 'utf8');
    expect(pluginSource).toContain('project_read');
    expect(pluginSource).toContain('IDEASEEK_WORKSPACE_ROOT');
    expect(patch.yaml).toBe(yaml);

    // Overwriting is idempotent.
    const again = await writeCapabilityPatch({ dshHome });
    expect(again.patchPath).toBe(patch.patchPath);
  });
});

describe('describeTruncation (a cap cut is its own failure mode)', () => {
  it('names the reason, the cap and the way out', async () => {
    const { describeTruncation } = await import('../src/dsh/dsh-adapter.js');
    const text = describeTruncation('max-tokens', 16_384);
    expect(text).toContain('finishReason=max-tokens');
    expect(text).toContain('maxTokens=16384');
    // The actionable half: this artifact shape is the problem, not the
    // provider, and "retry" would teach the reader to retry forever.
    expect(text).toContain('does not fit in one response');
    expect(text).toContain('write files instead of returning them');
  });

  it('is the same wording the pre-JSON path reports', async () => {
    // Two messages for one cause drift apart, and then the log contradicts
    // itself about which limit was hit.
    const { describeTruncation, DEFAULT_DSH_MAX_TOKENS } =
      await import('../src/dsh/dsh-adapter.js');
    expect(describeTruncation('length', DEFAULT_DSH_MAX_TOKENS)).toContain('finishReason=length');
    expect(describeTruncation('length', 8_192)).toContain('maxTokens=8192');
  });
});
