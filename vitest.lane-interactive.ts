import { defineConfig } from 'vitest/config';

/**
 * The interactive lane: tests whose work is spawning the built CLI (and, in two
 * cases, the DSH runtime) under a real TTY-shaped surface.
 *
 * Why a separate lane rather than bigger timeouts: measured alone these files
 * take ~10s (idea-workspace), ~57s (ink-interactive) and ~9s (cli.e2e); in the
 * full 192-file parallel run they overran 180s and 40s budgets and failed, while
 * passing solo. That is a scheduling property, not a behaviour property, and the
 * honest response to a scheduling property is scheduling — the alternative was
 * inflating every deadline in the file until no assertion could ever notice a
 * hang, which is how suites end up green and blind.
 *
 * Nothing here changes an assertion, a wait condition or a budget: the same
 * tests run, with the machine capacity they were measured to need.
 */
export default defineConfig({
  test: {
    include: [
      'tests/ink-interactive.test.ts',
      'tests/cli.e2e.test.ts',
      'tests/idea-workspace.test.ts',
    ],
    globalSetup: ['tests/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    // Two at a time: each of these files already runs one or more child CLIs
    // concurrently of its own assertions, so the process count multiplies fast.
    maxWorkers: 2,
    minWorkers: 1,
  },
});
