import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  DSH_SDK_VERSION,
  DshHarnessAdapter,
  extractJson,
  findLlmFailure,
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
  it('spawns the pinned DSH runtime, reports credential state without reading secrets, and shuts down', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'ideaseek-dsh-home-'));
    const adapter = new DshHarnessAdapter({ dshHome, initializeTimeoutMs: 30_000 });

    const keySet = Boolean(process.env.DEEPSEEK_API_KEY);
    try {
      await adapter.initialize();
      const health = await adapter.health();
      expect(health.reachable).toBe(true);
      expect(health.models).toHaveLength(1);
      expect(health.models[0]!.available).toBe(keySet);
      expect(health.blocked).toBe(!keySet);
      if (!keySet) {
        expect(health.blockReason).toContain('DEEPSEEK_API_KEY');
        // The reason must never contain an actual secret value.
        expect(health.blockReason ?? '').not.toMatch(/[A-Za-z0-9_-]{20,}/);
      }
      // Re-initialize is idempotent while alive.
      await adapter.initialize();
      expect(adapter.version).toBe(`dsh-sdk@${DSH_SDK_VERSION}`);
    } finally {
      await adapter.shutdown();
    }
    // Shutdown is idempotent.
    await adapter.shutdown();
  }, 90_000);

  it('surfaces a typed AUTH block when the model call has no credentials', async () => {
    if (process.env.DEEPSEEK_API_KEY) {
      // With a real key present this negative test is not applicable.
      return;
    }
    const dshHome = await mkdtemp(join(tmpdir(), 'ideaseek-dsh-home-'));
    const adapter = new DshHarnessAdapter({ dshHome, initializeTimeoutMs: 30_000 });
    try {
      await expect(
        adapter.runTask({
          runId: 'run-test',
          taskId: 'task-test',
          profile: 'paper-extractor',
          instruction: 'Extract a JSON card.',
          inputs: [{ kind: 'text', name: 'paper', content: 'Some paper text.' }],
          outputSchema: 'papercard-lite-v1',
          budget: { timeoutMs: 60_000 },
          idempotencyKey: 'dsh-no-key-test',
        }),
      ).rejects.toSatisfy((error: unknown) => {
        // Either a typed AUTH/QUOTA block or a clearly-marked retryable DSH
        // error is acceptable keyless behavior — never a silent success and
        // never an unmapped crash.
        const name = (error as Error).name;
        const message = (error as Error).message ?? '';
        return (
          name === 'HarnessBlockError' ||
          message.includes('dsh ') ||
          message.includes('failed to start DSH')
        );
      });
    } finally {
      await adapter.shutdown();
    }
  }, 120_000);
});
