import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './helpers.js';

// run-tests.mjs hardcoded `python`, so on hosts where only the pinned worker
// venv has pypdf/pdfplumber (the layout setup.sh builds) the python lane died
// with PARSER_MISSING while the TS lanes were green. The runner must reach
// the venv even when no system python is on PATH.
describe('worker python test runner', () => {
  it('uses the worker venv interpreter and runs the suite (no system python on PATH)', () => {
    const runner = join(REPO_ROOT, 'worker', 'python', 'run-tests.mjs');
    const venvPython =
      process.platform === 'win32'
        ? join(REPO_ROOT, 'worker', 'python', '.venv', 'Scripts', 'python.exe')
        : join(REPO_ROOT, 'worker', 'python', '.venv', 'bin', 'python');
    if (!existsSync(venvPython)) return; // no venv on this host: environment guard

    // Strip PATH so only an absolute venv path can resolve: if the runner
    // falls back to bare `python`, the probe fails and it would "skip" —
    // which must NOT count as a pass here.
    const result = spawnSync(process.execPath, [runner], {
      cwd: REPO_ROOT,
      env: { ...process.env, PATH: '/nonexistent-ideaseek-path' },
      encoding: 'utf8',
      timeout: 240_000,
    });
    const output = (result.stdout ?? '') + (result.stderr ?? '');
    expect(output).not.toContain('python not available; skipping');
    expect(result.status, output.slice(-2000)).toBe(0);
  }, 300_000);
});
