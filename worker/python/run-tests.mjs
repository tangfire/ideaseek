import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Runs the Python worker unit tests; skips (exit 0) when python is absent.
 *
 * Interpreter order mirrors src/knowledge/pdf.ts pythonBinary(): the pinned
 * worker venv first, then python3/python. Hardcoding `python` made this
 * runner fail with PARSER_MISSING on hosts where only the venv has
 * pypdf/pdfplumber — i.e. the exact layout setup.sh builds.
 */
const cwd = join(dirname(fileURLToPath(import.meta.url)));
const candidates =
  process.platform === 'win32'
    ? [join(cwd, '.venv', 'Scripts', 'python.exe'), 'python3', 'python']
    : [join(cwd, '.venv', 'bin', 'python'), 'python3', 'python'];
let python = null;
for (const candidate of candidates) {
  const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
  if (!probe.error && probe.status === 0) {
    python = candidate;
    break;
  }
}
if (python === null) {
  console.log('python not available; skipping ideaseek-worker python tests');
  process.exit(0);
}
const result = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'tests', '-v'], {
  cwd,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
