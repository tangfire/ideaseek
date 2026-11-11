import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { ROLE_TIERS, credentialStatus, describeTierBindings } from '../src/models/routing.js';
import { CLI_BIN } from './helpers.js';

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[], timeoutMs = 60_000): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
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
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

const KEY_SHAPE = /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/;

describe('model routing registry (unit)', () => {
  afterEach(() => {
    delete process.env.IDEASEEK_MODEL_FAST;
  });

  it('binds the four tiers with MODEL_ROUTING roles', () => {
    const bindings = describeTierBindings();
    expect(bindings.map((b) => b.tier)).toEqual(['fast', 'balanced', 'deep', 'deterministic']);
    const deterministic = bindings.find((b) => b.tier === 'deterministic')!;
    expect(deterministic.model).toBeNull();
    expect(deterministic.provider).toBeNull();
    expect(deterministic.roles).toContain('workflow_supervisor');
    expect(deterministic.roles).toContain('evidence_checker');

    const fast = bindings.find((b) => b.tier === 'fast')!;
    expect(fast.model).toBe('deepseek-v4-flash');
    expect(fast.roles).toContain('paper_extractor');
    const deep = bindings.find((b) => b.tier === 'deep')!;
    expect(deep.roles).toContain('idea_generator');
    expect(deep.roles).toContain('novelty_challenger');
    expect(Object.keys(ROLE_TIERS).length).toBeGreaterThanOrEqual(14);
  });

  it('honors environment overrides without reading any key material', () => {
    process.env.IDEASEEK_MODEL_FAST = 'my-custom-fast-model';
    const bindings = describeTierBindings();
    const fast = bindings.find((b) => b.tier === 'fast')!;
    expect(fast.model).toBe('my-custom-fast-model');
    expect(fast.overrideEnv).toBe('IDEASEEK_MODEL_FAST');
    expect(JSON.stringify(bindings)).not.toMatch(KEY_SHAPE);
  });

  it('credential status reports presence only', () => {
    const status = credentialStatus();
    expect(['configured', 'missing']).toContain(status.deepseekApiKey);
    expect(JSON.stringify(status)).not.toMatch(KEY_SHAPE);
    expect(Object.keys(status)).toEqual(['deepseekApiKey']);
  });
});

describe('ideaseek models (CLI)', () => {
  it('lists routes, roles and credential presence without leaking secrets', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-models-'));
    expect((await runCli(project, ['init'])).code).toBe(0);

    const json = await runCli(project, ['models', 'list', '--json']);
    expect(json.code, json.stdout + json.stderr).toBe(0);
    expect(json.stdout).not.toMatch(KEY_SHAPE);
    const payload = JSON.parse(json.stdout) as {
      projectRoute: string;
      dshCommit: string | null;
      credentials: { deepseekApiKey: string };
      tiers: { tier: string; model: string | null; roles: string[] }[];
      rules: string[];
    };
    expect(payload.projectRoute).toBe('default');
    expect(payload.dshCommit).toMatch(/^[0-9a-f]{7,}$/);
    expect(['configured', 'missing']).toContain(payload.credentials.deepseekApiKey);
    expect(payload.tiers.map((t) => t.tier)).toEqual(['fast', 'balanced', 'deep', 'deterministic']);
    expect(payload.tiers.find((t) => t.tier === 'deterministic')!.model).toBeNull();
    expect(payload.rules.join(' ')).toContain('presence');

    const plain = await runCli(project, ['models']);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain('fast');
    expect(plain.stdout).toContain('deep');
    expect(plain.stdout).toContain('presence only');
    expect(plain.stdout).not.toMatch(KEY_SHAPE);
  }, 60_000);

  it('switching routes needs guided confirmation and records a Decision', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-models-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    // A run must exist for the decision event to bind to.
    expect(
      (await runCli(project, ['run', '--question', 'models use', '--enqueue-only'])).code,
    ).toBe(0);

    const unconfirmed = await runCli(project, ['models', 'use', 'fast-thinking']);
    expect(unconfirmed.code).toBe(2);
    expect(unconfirmed.stderr).toContain('--confirm');

    const confirmed = await runCli(project, [
      'models',
      'use',
      'fast-thinking',
      '--confirm',
      '--json',
    ]);
    expect(confirmed.code, confirmed.stderr).toBe(0);
    const payload = JSON.parse(confirmed.stdout) as { route: string; decisionSeq: number | null };
    expect(payload.route).toBe('fast-thinking');
    expect(payload.decisionSeq).toBeGreaterThan(0);

    const yaml = await readFile(join(project, 'research.yaml'), 'utf8');
    expect(yaml).toContain('model_route: fast-thinking');

    const events = await runCli(project, ['events', '--json']);
    const decision = (
      JSON.parse(events.stdout) as {
        events: { eventType: string; summary: string }[];
      }
    ).events.find((e) => e.eventType === 'decision');
    expect(decision!.summary).toContain('change-model-route');

    const bad = await runCli(project, ['models', 'use', 'Bad Route!']);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain('kebab-case');
  }, 120_000);

  it('/models relays the same view inside the REPL', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-models-'));
    expect((await runCli(project, ['init'])).code).toBe(0);
    const repl = spawn(process.execPath, [CLI_BIN, 'interactive'], {
      cwd: project,
      env: { ...process.env, IDEASEEK_CLI: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    repl.stdout.on('data', (chunk) => (output += String(chunk)));
    repl.stderr.on('data', (chunk) => (output += String(chunk)));
    const waitFor = (pattern: RegExp, timeoutMs = 20_000): Promise<void> =>
      new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
          if (pattern.test(output)) {
            clearInterval(timer);
            resolve();
          } else if (Date.now() - started > timeoutMs) {
            clearInterval(timer);
            reject(new Error(`timeout waiting for ${pattern}`));
          }
        }, 100);
      });
    await waitFor(/ideaseek ›/);
    repl.stdin.write('/models\n');
    await waitFor(/deterministic/);
    expect(output).toContain('presence only');
    expect(output).not.toMatch(KEY_SHAPE);
    repl.stdin.write('/quit\n');
    await new Promise((resolve) => repl.on('close', resolve));
  }, 60_000);
});
