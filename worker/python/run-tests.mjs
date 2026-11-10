import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Runs the Python worker unit tests; skips (exit 0) when python is absent. */
const cwd = join(dirname(fileURLToPath(import.meta.url)));
const probe = spawnSync('python', ['--version'], { stdio: 'ignore' });
if (probe.error || probe.status !== 0) {
  console.log('python not available; skipping ideaseek-worker python tests');
  process.exit(0);
}
const result = spawnSync('python', ['-m', 'unittest', 'discover', '-s', 'tests', '-v'], {
  cwd,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
