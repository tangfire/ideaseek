import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadLocalEnv } from '../src/core/env.js';

/**
 * CLI end-to-end tests spawn `dist/cli.js`; build once per test run so unit
 * tests (which import `src/` directly) and e2e tests share one command.
 */
export default function globalSetup(): void {
  loadLocalEnv(); // keyed integration tests read DEEPSEEK_API_KEY from the gitignored .env
  // Keep the user-level project registry out of the developer's real ~/.ideaseek.
  process.env.IDEASEEK_REGISTRY_PATH = join(tmpdir(), 'ideaseek-test-projects.json');
  // Deterministic supervisor for `ideaseek ask` in tests (never the real model).
  process.env.IDEASEEK_ASK_HARNESS = 'fake';
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  // Locked build (scripts/build.mjs): parallel sessions tearing dist by
  // running two tsc instances at once was observed repeatedly.
  execSync('node scripts/build.mjs', {
    cwd: root,
    stdio: 'inherit',
  });
  // Then prove the artifact every e2e child is about to exec can actually boot.
  //
  // Observed in a full run: three spawn-heavy files failed while each passed in
  // isolation, and one of them said why — a child died on
  // `SyntaxError: the requested module './commands/idea.js' does not provide an
  // export named 'registerIdeaCommand'`, i.e. it read dist while it was not a
  // coherent whole. A torn dist does not fail the build; it fails an unrelated
  // test minutes later as a timeout, which is how a harness problem gets filed
  // as a product bug. Checking here turns "3 flaky files" into one loud,
  // explained failure.
  try {
    execSync('node dist/cli.js --help', { cwd: root, stdio: 'pipe', timeout: 120_000 });
  } catch (error) {
    const detail = (error as { stdout?: Buffer; stderr?: Buffer; message?: string }) ?? {};
    const output = `${detail.stderr?.toString() ?? detail.message ?? ''}`.slice(-600);
    // --force: a boot failure with a still-valid fingerprint means the
    // artifact is wrong in a way the skip check cannot see (truncated file
    // with matching digests is impossible, but a torn pre-fingerprint dist
    // or a stale one is not) — bypass the skip and drop .tsbuildinfo so
    // tsc re-emits everything instead of trusting the incremental cache.
    execSync('node scripts/build.mjs --force', { cwd: root, stdio: 'inherit' }); // one rebuild attempt
    try {
      execSync('node dist/cli.js --help', { cwd: root, stdio: 'pipe', timeout: 120_000 });
    } catch (retryError) {
      throw new Error(
        `the built CLI cannot boot, so every e2e spawn would fail — dist is not a coherent ` +
          `build. First failure:\n${output}\nAfter rebuilding:\n${String(
            (retryError as { stderr?: Buffer })?.stderr ?? (retryError as Error).message,
          ).slice(-600)}`,
      );
    }
  }
}
