import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN } from './helpers.js';
import { spawn } from 'node:child_process';

function runCli(
  cwd: string,
  args: string[],
  timeoutMs = 20_000,
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli ${args.join(' ')} timed out; stderr=${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ideaseek-setup-'));
  const init = await runCli(dir, ['init']);
  expect(init.code).toBe(0);
  return dir;
}

describe('setup / doctor / config explain', () => {
  it('doctor reports environment and healthy project state', async () => {
    const dir = await makeProject();

    const json = await runCli(dir, ['doctor', '--json']);
    expect(json.code).toBe(0);
    const payload = JSON.parse(json.stdout) as {
      ok: boolean;
      checks: { name: string; level: string; detail: string }[];
      environment: { node: { supported: boolean } };
    };
    expect(payload.ok).toBe(true);
    expect(payload.environment.node.supported).toBe(true);
    const byName = new Map(payload.checks.map((check) => [check.name, check]));
    expect(byName.get('config')?.level).toBe('ok');
    expect(byName.get('node')?.level).toBe('ok');
    expect(byName.get('recovery')?.level).toBe('ok');
    expect(byName.get('dsh')?.detail).toMatch(/pinned [0-9a-f]{12}/);
    expect(byName.get('credentials')?.detail).toContain('DEEPSEEK_API_KEY');

    const text = await runCli(dir, ['doctor']);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('ideaseek doctor');
    expect(text.stdout).toContain('✓');
  }, 30_000);

  it('config explain shows values with file/default provenance', async () => {
    const dir = await makeProject();
    // Partial config: only project.name comes from the file, the rest defaults.
    await writeFile(
      join(dir, 'research.yaml'),
      'config_version: 1\nproject:\n  name: partial\n',
      'utf8',
    );

    const json = await runCli(dir, ['config', 'explain', '--json']);
    expect(json.code).toBe(0);
    const payload = JSON.parse(json.stdout) as {
      errors: string[];
      sources: Record<string, string>;
      resolved: { runtime: { leaseTtlSeconds: number }; project: { name: string } };
    };
    expect(payload.errors).toEqual([]);
    expect(payload.sources['project.name']).toBe('file');
    expect(payload.sources['runtime.lease_ttl_seconds']).toBe('default');
    expect(payload.sources['resources.max_gpu_hours']).toBe('default');
    expect(payload.resolved.runtime.leaseTtlSeconds).toBe(30);
    expect(payload.resolved.project.name).toBe('partial');

    const text = await runCli(dir, ['config', 'explain']);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('[file]');
    expect(text.stdout).toContain('[default]');
  }, 30_000);

  it('setup persists a normalized versioned config and is idempotent', async () => {
    const dir = await makeProject();

    const first = await runCli(dir, ['setup', '--json']);
    expect(first.code).toBe(0);
    const firstPayload = JSON.parse(first.stdout) as {
      wrote: boolean;
      backupPath: string | null;
      environment: { node: { supported: boolean } };
    };
    expect(firstPayload.environment.node.supported).toBe(true);
    // The init template already matches the normalized shape except… it is
    // rewritten at least once to guarantee config_version and ordering.
    const afterFirst = await readFile(join(dir, 'research.yaml'), 'utf8');
    expect(afterFirst).toContain('config_version: 1');

    const second = await runCli(dir, ['setup', '--json']);
    expect(second.code).toBe(0);
    const secondPayload = JSON.parse(second.stdout) as { wrote: boolean };
    expect(secondPayload.wrote).toBe(false); // idempotent: nothing to change

    const dry = await runCli(dir, ['setup', '--dry-run', '--json']);
    expect(dry.code).toBe(0);
    expect((JSON.parse(dry.stdout) as { wrote: boolean }).wrote).toBe(false);
  }, 40_000);

  it('blocking config problems make config explain/doctor/run/next refuse', async () => {
    const dir = await makeProject();
    const configPath = join(dir, 'research.yaml');
    const config = await readFile(configPath, 'utf8');
    await writeFile(configPath, `${config}\nunknown_section:\n  x: 1\n`, 'utf8');

    const explain = await runCli(dir, ['config', 'explain']);
    expect(explain.code).toBe(2);
    expect(explain.stdout).toContain('unknown research.yaml key');

    const doctor = await runCli(dir, ['doctor', '--json']);
    expect(doctor.code).toBe(2);
    const doctorPayload = JSON.parse(doctor.stdout) as { ok: boolean };
    expect(doctorPayload.ok).toBe(false);

    const run = await runCli(dir, ['run', '--question', 'should not start', '--json']);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('USER_INPUT_REQUIRED');
    expect(run.stderr).toContain('ideaseek config explain');

    const next = await runCli(dir, ['next', '--json']);
    expect(next.code).toBe(2);
    const nextPayload = JSON.parse(next.stdout) as { stage: string; command: string };
    expect(nextPayload.stage).toBe('CONFIG_INVALID');
    expect(nextPayload.command).toBe('ideaseek config explain');

    // status still works so users can inspect state while config is broken.
    const status = await runCli(dir, ['status', '--json']);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toHaveProperty('project');
  }, 40_000);

  it('rejects a config_version from the future', async () => {
    const dir = await makeProject();
    const configPath = join(dir, 'research.yaml');
    await writeFile(configPath, 'config_version: 99\nproject:\n  name: future\n', 'utf8');

    const explain = await runCli(dir, ['config', 'explain']);
    expect(explain.code).toBe(2);
    expect(explain.stdout).toContain('upgrade ideaseek');
  }, 30_000);
});
