import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, makeProjectDir } from './helpers.js';

/**
 * `ideaseek mode` session mode (docs/MODES.md): show mode/project/
 * permission summary, switch research ↔ agent with a Decision/Event,
 * persist to .research/session.json, and refuse outside a project.
 */

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[], timeoutMs = 60_000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli ${args.join(' ')} timed out`));
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

interface ModePayload {
  sessionMode: string;
  project: string;
  root: string;
  autonomy: string;
  strategy: string;
  permissions: string[];
  changed?: boolean;
  decisionSeq?: number | null;
}

describe('ideaseek mode (session mode)', () => {
  it('shows mode, project and permission summary by default', async () => {
    const dir = await makeProjectDir();
    const shown = await runCli(dir, ['mode', '--json']);
    expect(shown.code).toBe(0);
    const payload = JSON.parse(shown.stdout) as ModePayload;
    expect(payload).toMatchObject({
      sessionMode: 'research',
      project: 'test-project',
      autonomy: 'guided',
    });
    expect(payload.root).toBeTruthy();
    expect(payload.permissions.length).toBeGreaterThan(2);

    const human = await runCli(dir, ['mode']);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('session mode : research');
    expect(human.stdout).toContain('the science pipeline treats papers/');
    expect(human.stdout).toContain('ideaseek mode research|analysis');
    // The coding entry is advertised where the old `mode agent` used to be.
    expect(human.stdout).toContain('coding entry (not a tier): ideaseek agent');
  });

  it('switches research → analysis, persists, and records a Decision/Event', async () => {
    const dir = await makeProjectDir();
    const enqueued = await runCli(dir, ['run', '--question', 'mode switch', '--enqueue-only']);
    expect(enqueued.code).toBe(0);

    const switched = await runCli(dir, ['mode', 'analysis', '--json']);
    expect(switched.code).toBe(0);
    const payload = JSON.parse(switched.stdout) as ModePayload;
    expect(payload).toMatchObject({ sessionMode: 'analysis', changed: true });
    expect(payload.decisionSeq).toBeGreaterThan(0);
    expect(payload.permissions.join('\n')).toContain('may build knowledge artifacts');

    const file = JSON.parse(await readFile(join(dir, '.research', 'session.json'), 'utf8')) as {
      mode: string;
    };
    expect(file.mode).toBe('analysis');

    const shown = await runCli(dir, ['mode', '--json']);
    expect(JSON.parse(shown.stdout) as ModePayload).toMatchObject({ sessionMode: 'analysis' });

    const events = await runCli(dir, ['events']);
    expect(events.stdout).toContain('change-session-mode');

    const again = await runCli(dir, ['mode', 'analysis', '--json']);
    expect(JSON.parse(again.stdout) as ModePayload).toMatchObject({ changed: false });
  });

  it('routes the retired `mode agent` target to the coding entry instead of switching', async () => {
    const dir = await makeProjectDir();
    const agent = await runCli(dir, ['mode', 'agent']);
    expect(agent.code).not.toBe(0);
    expect(agent.stderr).toContain('ideaseek agent');
    expect(agent.stderr).toContain('不是权限档位');

    // Nothing was written: the tier is still research.
    const shown = await runCli(dir, ['mode', '--json']);
    expect(JSON.parse(shown.stdout) as ModePayload).toMatchObject({ sessionMode: 'research' });
  });

  it('rejects unknown targets with the allowed set', async () => {
    const dir = await makeProjectDir();
    const bad = await runCli(dir, ['mode', 'banana']);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain('research | analysis');
  });

  it('refuses to run outside an IdeaSeek project', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-noproject-'));
    const result = await runCli(dir, ['mode']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('ideaseek init');
  });
});
