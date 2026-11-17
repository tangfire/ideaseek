import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Spawned-process suites live in their own lane with the capacity they were
    // measured to need (see vitest.lane-interactive.ts): in this parallel lane
    // they overran their budgets while passing solo, which is a scheduling
    // property being paid for as a test failure.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'tests/ink-interactive.test.ts',
      'tests/cli.e2e.test.ts',
      'tests/idea-workspace.test.ts',
    ],
    // CLI end-to-end tests spawn dist/cli.js; build once before the suite.
    globalSetup: ['tests/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
});
