import { afterEach, describe, expect, it } from 'vitest';
import { workerChildArgs } from '../src/commands/extract.js';
import { resolveHarnessKind } from '../src/commands/shared.js';

// extract (and run/full) spawn worker children with an explicit --harness.
// Hardcoding `opts.harness ?? 'fake'` there meant the documented "dsh when a
// key is configured" default never reached the worker: every PaperCard came
// back self-declared synthetic (harness.kind=fake, datasets=[]) even with a
// working credential — the acceptance STAGE 9 dead end.
describe('spawned worker harness kind', () => {
  const savedKey = process.env.DEEPSEEK_API_KEY;
  const savedHook = process.env.IDEASEEK_ASK_HARNESS;

  afterEach(() => {
    if (savedKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = savedKey;
    if (savedHook === undefined) delete process.env.IDEASEEK_ASK_HARNESS;
    else process.env.IDEASEEK_ASK_HARNESS = savedHook;
  });

  it('passes the resolved kind through to the worker argv (dsh with a key)', () => {
    delete process.env.IDEASEEK_ASK_HARNESS;
    // Presence only — resolveHarnessKind never reads or prints the value.
    process.env.DEEPSEEK_API_KEY = 'sk-test-presence-only';
    const kind = resolveHarnessKind(undefined);
    expect(kind).toBe('dsh');
    expect(workerChildArgs('run-test', kind)).toEqual([
      'worker',
      '--run',
      'run-test',
      '--harness',
      'dsh',
      '--idle-exit',
      '3000',
    ]);
  });

  it('resolves to fake only when no credential is configured at all', () => {
    delete process.env.IDEASEEK_ASK_HARNESS;
    delete process.env.DEEPSEEK_API_KEY;
    const kind = resolveHarnessKind(undefined);
    expect(kind).toBe('fake');
    expect(workerChildArgs('run-test', kind)).toContain('fake');
  });
});
