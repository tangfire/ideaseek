import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

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
