import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, makeProjectDir } from './helpers.js';

/**
 * `run`/`next`/`doctor` refuse a broken research.yaml with exit 2 and point
 * at `config explain`, but `status` — the most-run command — used to print a
 * healthy-looking view with zero mention of the breakage (silent degradation).
 * status keeps its run-state exit semantics (0 for a glance); what it must
 * never do is hide the problem: text warns with the recovery command, json
 * carries configErrors.
 */

function runCli(
  cwd: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`status ${args.join(' ')} timed out; stderr=${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end();
  });
}

const BROKEN_YAML = 'mode: [\n\tbroken<<yaml\n  - {{\n';

describe('status with a broken research.yaml', () => {
  it('warns with the recovery command in text mode (exit stays 0)', async () => {
    const root = await makeProjectDir('status-broken-config');
    await writeFile(join(root, 'research.yaml'), BROKEN_YAML, 'utf8');
    const text = await runCli(root, ['status']);
    expect(text.code, text.stdout + text.stderr).toBe(0);
    expect(text.stdout).toContain('research.yaml');
    expect(text.stdout).toContain('ideaseek config explain');
  }, 60_000);

  it('carries configErrors in json mode', async () => {
    const root = await makeProjectDir('status-broken-config-json');
    await writeFile(join(root, 'research.yaml'), BROKEN_YAML, 'utf8');
    const json = await runCli(root, ['status', '--json']);
    expect(json.code, json.stdout + json.stderr).toBe(0);
    const payload = JSON.parse(json.stdout) as { configErrors?: string[] };
    expect(Array.isArray(payload.configErrors)).toBe(true);
    expect(payload.configErrors!.length).toBeGreaterThan(0);
    expect(payload.configErrors!.join(' ')).toContain('research.yaml');
  }, 60_000);

  it('stays silent about config when the config is healthy', async () => {
    const root = await makeProjectDir('status-healthy-config');
    const json = await runCli(root, ['status', '--json']);
    expect(json.code, json.stdout + json.stderr).toBe(0);
    const payload = JSON.parse(json.stdout) as { configErrors?: string[] };
    expect(payload.configErrors).toEqual([]);
    const text = await runCli(root, ['status']);
    expect(text.stdout).not.toContain('ideaseek config explain');
  }, 60_000);
});
