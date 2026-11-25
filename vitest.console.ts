import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['web/console/test/**/*.test.tsx'],
    environment: 'node',
  },
  oxc: { jsx: { runtime: 'automatic' } },
});
