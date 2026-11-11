import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN } from './helpers.js';

/**
 * Phase 7 notification entry: user-config driven enable/webhook, durable
 * local JSONL delivery records, webhook success/failure paths that never
 * crash the caller, and the background supervisor notifying on terminal
 * run states.
 */

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 60_000,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1', ...env },
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

async function enabledUserConfig(project: string, webhook: string | null): Promise<string> {
  const configPath = join(project, 'user-config.yaml');
  await writeFile(
    configPath,
    `notifications:\n  enabled: true\n  webhook: ${webhook === null ? 'null' : JSON.stringify(webhook)}\n`,
    'utf8',
  );
  return configPath;
}

interface NotifyPayload {
  sent: boolean;
  reason: string;
  record: { kind: string; delivery: string; title: string } | null;
}

describe('ideaseek notify (user-config delivery)', () => {
  it('is disabled by default and says so without failing', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-notify-'));
    expect((await runCli(project, ['init'])).code).toBe(0);

    const test = await runCli(project, ['notify', 'test', '--json']);
    expect(test.code, test.stderr).toBe(0);
    const payload = JSON.parse(test.stdout) as NotifyPayload;
    expect(payload).toMatchObject({ sent: false, reason: 'disabled' });

    const list = await runCli(project, ['notify', 'list', '--json']);
    expect((JSON.parse(list.stdout) as { count: number }).count).toBe(0);

    const human = await runCli(project, ['notify', 'test']);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('notifications disabled');
  }, 120_000);

  it('records locally when enabled without a webhook', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-notify-local-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    const configPath = await enabledUserConfig(project, null);
    const env = { IDEASEEK_USER_CONFIG: configPath };

    const test = await runCli(project, ['notify', 'test', '--json'], env);
    expect(test.code, test.stderr).toBe(0);
    const payload = JSON.parse(test.stdout) as NotifyPayload;
    expect(payload).toMatchObject({ sent: true, reason: 'recorded' });
    expect(payload.record?.delivery).toBe('recorded');

    const list = await runCli(project, ['notify', 'list', '--json'], env);
    const records = JSON.parse(list.stdout) as {
      count: number;
      notifications: { kind: string; delivery: string }[];
    };
    expect(records.count).toBe(1);
    expect(records.notifications[0]).toMatchObject({ kind: 'test', delivery: 'recorded' });
  }, 120_000);

  it('posts to the webhook and records the outcome', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-notify-hook-'));
    expect((await runCli(project, ['init'])).code).toBe(0);

    const received: unknown[] = [];
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += String(chunk)));
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.statusCode = 200;
        res.end('ok');
      });
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
    });
    try {
      const configPath = await enabledUserConfig(project, `http://127.0.0.1:${port}/hook`);
      const env = { IDEASEEK_USER_CONFIG: configPath };

      const test = await runCli(project, ['notify', 'test', '--json'], env);
      expect(test.code, test.stderr).toBe(0);
      const payload = JSON.parse(test.stdout) as NotifyPayload;
      expect(payload).toMatchObject({ sent: true, reason: 'webhook-ok' });
      expect(payload.record?.delivery).toBe('webhook-ok');
      expect(received).toHaveLength(1);
      expect((received[0] as { title: string }).title).toContain('IdeaSeek test');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, 120_000);

  it('records a webhook failure without crashing', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-notify-fail-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    const configPath = await enabledUserConfig(project, 'http://127.0.0.1:1/refused');
    const env = { IDEASEEK_USER_CONFIG: configPath };

    const test = await runCli(project, ['notify', 'test', '--json'], env);
    expect(test.code, test.stderr).toBe(0);
    const payload = JSON.parse(test.stdout) as NotifyPayload;
    expect(payload.sent).toBe(true);
    expect(payload.reason).toContain('webhook-failed');

    const list = await runCli(project, ['notify', 'list', '--json'], env);
    const deliveries = (
      JSON.parse(list.stdout) as { notifications: { delivery: string }[] }
    ).notifications.map((entry) => entry.delivery);
    expect(deliveries).toContain('recorded');
    expect(deliveries).toContain('webhook-failed');
  }, 120_000);

  it('background supervisor notifies when the run reaches a terminal state', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-notify-detach-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    const configPath = await enabledUserConfig(project, null);
    const env = { IDEASEEK_USER_CONFIG: configPath };

    const detach = await runCli(project, ['run', '--question', 'notify e2e', '--detach'], env);
    expect(detach.code, detach.stdout + detach.stderr).toBe(0);

    // Poll the local delivery record until the supervisor reports the end.
    const deadline = Date.now() + 45_000;
    let found = false;
    while (Date.now() < deadline && !found) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const list = await runCli(project, ['notify', 'list', '--json'], env);
      try {
        const records = JSON.parse(list.stdout) as {
          notifications: { kind: string; delivery: string }[];
        };
        found = records.notifications.some((entry) =>
          ['completed', 'failed', 'blocked', 'canceled'].includes(entry.kind),
        );
      } catch {
        // keep polling
      }
    }
    expect(found).toBe(true);
  }, 90_000);
});
