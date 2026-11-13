import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLI_BIN, createDemoRun, makeProjectDir, openRuntime } from './helpers.js';
import {
  computeCostUsd,
  summarizeUsage,
  assertCostWithinBudget,
  parseUsageSummary,
  COST_PAUSE_RATIO,
} from '../src/runtime/usage.js';

/**
 * Cost telemetry (PROGRESS 212): model usage lands as model_usage
 * RunEvents (the ONE audit stream), aggregates to tokens + configured-
 * rate dollars, shows in status/monitor against max_model_cost, and
 * parks runs via the existing QUOTA_EXHAUSTED machinery at the pause
 * ratio. No rates configured → dollar ceiling honestly NOT enforced.
 */

function runCli(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  timeoutMs = 180_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1', ...extraEnv },
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
    child.stdin.end();
  });
}

const RATES = { inputPerMtok: 10, outputPerMtok: 20 };

function event(eventType: string, summary: string) {
  return { eventType, summary, objectId: null };
}

describe('usage aggregation (pure)', () => {
  it('sums tokens/cost, groups by model, skips malformed lines', () => {
    const summary = summarizeUsage(
      'run-1',
      [
        event('model_usage', JSON.stringify({ in: 1000, out: 200, cost: 0.014, model: 'm-a' })),
        event('model_usage', JSON.stringify({ in: 500, out: 100, cost: 0.007, model: 'm-b' })),
        event('model_usage', '{not json'),
        event('other_event', JSON.stringify({ in: 999999, out: 999999, cost: 999 })),
      ],
      RATES,
      50,
    );
    expect(summary.calls).toBe(2);
    expect(summary.inputTokens).toBe(1500);
    expect(summary.outputTokens).toBe(300);
    expect(summary.costUsd).toBeCloseTo(0.021, 6);
    expect(summary.rateConfigured).toBe(true);
    expect(summary.remainingUsd).toBeCloseTo(49.979, 6);
    expect(Object.keys(summary.byModel).sort()).toEqual(['m-a', 'm-b']);
    expect(summary.pauseRatio).toBe(COST_PAUSE_RATIO);
  });

  it('derives cost from tokens when the event lacks one (rates configured)', () => {
    const summary = summarizeUsage(
      'run-2',
      [event('model_usage', JSON.stringify({ in: 1_000_000, out: 0, model: 'm' }))],
      RATES,
      50,
    );
    expect(summary.costUsd).toBeCloseTo(10, 6); // 1M in × $10/MTok
  });

  it('without rates the dollar ceiling is honestly not enforced', () => {
    const summary = summarizeUsage(
      'run-3',
      [event('model_usage', JSON.stringify({ in: 1000, out: 0, model: 'm' }))],
      null,
      50,
    );
    expect(summary.costUsd).toBeNull();
    expect(summary.remainingUsd).toBeNull();
    expect(summary.rateConfigured).toBe(false);
    expect(() => assertCostWithinBudget(summary)).not.toThrow();
  });

  it('pauses at the configured ratio of max_model_cost', () => {
    const base = summarizeUsage('run-4', [], RATES, 1.0);
    expect(() => assertCostWithinBudget({ ...base, costUsd: 0.89 })).not.toThrow();
    expect(() => assertCostWithinBudget({ ...base, costUsd: 0.9 })).toThrow(/max_model_cost/);
    try {
      assertCostWithinBudget({ ...base, costUsd: 0.95 });
      expect.unreachable('should throw');
    } catch (error) {
      expect((error as { code: string }).code).toBe('QUOTA_EXHAUSTED');
      expect((error as { message: string }).message).toContain('90%');
    }
  });

  it('computeCostUsd rounds to micro-dollars', () => {
    expect(computeCostUsd(RATES, 1234, 567)).toBeCloseTo((1234 / 1e6) * 10 + (567 / 1e6) * 20, 9);
    expect(computeCostUsd(null, 1, 1)).toBeNull();
  });

  it('parseUsageSummary tolerates junk', () => {
    expect(parseUsageSummary('nope')).toBeNull();
    expect(parseUsageSummary('{"in":"x"}')).toEqual({
      in: 0,
      out: 0,
      cost: null,
      model: null,
      taskId: null,
    });
  });
});

describe('ideaseek status usage display (e2e)', () => {
  it('records model_usage events through the wrapped harness and shows dollars', async () => {
    const dir = await makeProjectDir();
    // Configure rates in research.yaml.
    const configPath = join(dir, 'research.yaml');
    const config = await readFile(configPath, 'utf8');
    await writeFile(
      configPath,
      `${config.replace(
        /max_model_cost:.*/m,
        'max_model_cost: 50\n  model_rates:\n    input_per_mtok: 10\n    output_per_mtok: 20',
      )}`,
      'utf8',
    );
    await writeFile(
      join(dir, 'excerpt.txt'),
      'a short text excerpt about federated learning',
      'utf8',
    );

    const run = await runCli(
      dir,
      ['run', '--question', 'usage telemetry', '--paper', 'excerpt.txt', '--json'],
      { IDEASEEK_FAKE_USAGE: JSON.stringify({ inputTokens: 1000, outputTokens: 200 }) },
      300_000,
    );
    expect(run.code, run.stdout + run.stderr).toBe(0);

    const status = await runCli(dir, ['status', '--json']);
    expect(status.code, status.stdout + status.stderr).toBe(0);
    const payload = JSON.parse(status.stdout) as {
      usage: {
        calls: number;
        inputTokens: number;
        outputTokens: number;
        costUsd: number | null;
        rateConfigured: boolean;
        ceilingUsd: number;
        remainingUsd: number | null;
      } | null;
    };
    expect(payload.usage).not.toBeNull();
    const usage = payload.usage!;
    expect(usage.rateConfigured).toBe(true);
    expect(usage.inputTokens).toBeGreaterThanOrEqual(1000);
    expect(usage.outputTokens).toBeGreaterThanOrEqual(200);
    expect(usage.calls).toBeGreaterThanOrEqual(1);
    // 1000×$10/M + 200×$20/M = $0.014 per call (≥ one call recorded).
    expect(usage.costUsd ?? 0).toBeGreaterThanOrEqual(0.014 - 1e-9);
    expect(usage.ceilingUsd).toBe(50);
    expect(usage.remainingUsd).toBeCloseTo(50 - (usage.costUsd ?? 0), 6);

    const human = await runCli(dir, ['status']);
    expect(human.stdout).toContain('max_model_cost');
    expect(human.stdout).toContain('pause at 90%');
  }, 300_000);

  it('without configured rates: tokens shown, ceiling honestly NOT enforced', async () => {
    const dir = await makeProjectDir();
    await writeFile(join(dir, 'excerpt.txt'), 'another excerpt', 'utf8');
    const run = await runCli(
      dir,
      ['run', '--question', 'no rates', '--paper', 'excerpt.txt', '--json'],
      { IDEASEEK_FAKE_USAGE: JSON.stringify({ inputTokens: 500, outputTokens: 50 }) },
      300_000,
    );
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const status = await runCli(dir, ['status', '--json']);
    const payload = JSON.parse(status.stdout) as {
      usage: { costUsd: number | null; rateConfigured: boolean } | null;
    };
    expect(payload.usage?.rateConfigured).toBe(false);
    expect(payload.usage?.costUsd).toBeNull();
    const human = await runCli(dir, ['status']);
    expect(human.stdout).toContain('NOT enforced');
  }, 300_000);
});

describe('cost pause gate (QUOTA_EXHAUSTED parking)', () => {
  it('a harness call on a run at/over the pause ratio is refused with recovery', async () => {
    const dir = await makeProjectDir();
    const configPath = join(dir, 'research.yaml');
    const config = await readFile(configPath, 'utf8');
    // Tiny ceiling: seeded usage below will already be ≥90% of it.
    await writeFile(
      configPath,
      config.replace(/max_model_cost:.*/m, 'max_model_cost: 0.013'),
      'utf8',
    );
    // Rates are NOT needed for the gate — the seeded events carry cost.
    const rt = await openRuntime(dir, { recover: false });
    let runId: string;
    try {
      const run = await createDemoRun(rt, 'quota gate seed');
      runId = run.runId;
      // Two seeded model calls: $0.012 + $0.012 = $0.024 ≥ 90% × $0.013.
      for (const cost of [0.012, 0.012]) {
        await rt.db.appendEvent({
          runId,
          phase: 'USAGE',
          objectId: null,
          role: 'fake-model',
          eventType: 'model_usage',
          summary: JSON.stringify({ in: 600, out: 300, cost, model: 'fake-model', taskId: null }),
          status: null,
        });
      }
    } finally {
      await rt.close();
    }

    // `ask` runs a real harness turn on the latest run → the recorder's
    // beforeCall gate must refuse with the QUOTA recovery message.
    const ask = await runCli(dir, ['ask', 'what is the status of my run?']);
    expect(ask.code, ask.stdout + ask.stderr).not.toBe(0);
    expect(ask.stdout + ask.stderr).toContain('max_model_cost');
    expect(ask.stdout + ask.stderr).toContain('new model calls paused');
    expect(ask.stdout + ask.stderr).toContain('ideaseek continue');

    // And status reports the over-budget usage against the ceiling.
    const status = await runCli(dir, ['status', '--json']);
    const payload = JSON.parse(status.stdout) as {
      usage: { costUsd: number | null; ceilingUsd: number } | null;
      run: { runId: string } | null;
    };
    expect(payload.run?.runId).toBe(runId);
    expect(payload.usage?.costUsd ?? 0).toBeGreaterThanOrEqual(0.024 - 1e-9);
    expect(payload.usage?.ceilingUsd).toBe(0.013);
  }, 180_000);
});
