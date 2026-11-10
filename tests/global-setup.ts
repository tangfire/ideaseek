import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadLocalEnv } from '../src/core/env.js';

/**
 * CLI end-to-end tests spawn `dist/cli.js`; build once per test run so unit
 * tests (which import `src/` directly) and e2e tests share one command.
 */
export default function globalSetup(): void {
  loadLocalEnv(); // keyed integration tests read DEEPSEEK_API_KEY from the gitignored .env
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  execSync('node node_modules/typescript/bin/tsc -p tsconfig.build.json', {
    cwd: root,
    stdio: 'inherit',
  });
}
