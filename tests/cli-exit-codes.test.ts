import { describe, expect, it } from 'vitest';
import { runCli, suggestCommand } from '../src/cli.js';

/**
 * With about fifty commands, a mistyped name is the most common user error.
 * The root command carries an action (bare `ideaseek` opens the UI), so
 * commander reports an unknown command as "too many arguments. Expected 0
 * arguments but got 1: statut" — true, unhelpful, and with no suggestion.
 */
describe('command suggestions', () => {
  const NAMES = ['status', 'scan', 'search', 'start', 'setup', 'idea', 'init', 'extract'];

  it('finds the nearest command for a typo', () => {
    expect(suggestCommand('statut', NAMES)).toBe('status');
    expect(suggestCommand('iead', NAMES)).toBe('idea');
    expect(suggestCommand('star', NAMES)).toBe('start');
  });

  it('does not invent a command for unrelated input', () => {
    expect(suggestCommand('zzzzz', NAMES)).toBeNull();
    expect(suggestCommand('', NAMES)).toBeNull();
  });

  it('a mistyped command exits 2 with a copyable suggestion', async () => {
    const stderr: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let code = 0;
    try {
      code = await runCli(['node', 'ideaseek', 'statut']);
    } finally {
      process.stderr.write = original;
    }
    expect(code).toBe(2);
    expect(stderr.join('')).toContain('Did you mean: ideaseek status?');
  }, 60_000);
});

/**
 * docs/CLI_SPEC assigns 2 to "user input, configuration or credentials are
 * missing". Commander reports its own usage errors as 1, which is the code the
 * runner maps to a task failure — so a forgotten flag was indistinguishable
 * from a crashed experiment for anything scripting the CLI, including the
 * recovery paths that decide whether to retry.
 */
describe('CLI misuse exit codes', () => {
  it('a missing required option is an input error, not a task failure', async () => {
    expect(await runCli(['node', 'ideaseek', 'idea', 'generate'])).toBe(2);
  }, 60_000);

  it('an unknown option is an input error', async () => {
    expect(await runCli(['node', 'ideaseek', 'ideate', '--nonsense'])).toBe(2);
  }, 60_000);

  it('help still exits 0', async () => {
    expect(await runCli(['node', 'ideaseek', 'ideate', '--help'])).toBe(0);
  }, 60_000);
});
