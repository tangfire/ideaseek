import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MODEL_OUTPUT_MARKERS,
  evaluateWatchGate,
  type WatchReason,
} from '../src/knowledge/surveillance.js';
import { CLI_BIN, makeProjectDir } from './helpers.js';

/**
 * Continuous literature surveillance (design review #13: "synthesize/wiki are
 * one-shot"). Two contracts are pinned here: the gate never lies (a change
 * reopens the chain, a keyless project never loops on outputs it cannot
 * produce, an unchanged project no-ops in the fast path), and the chain it
 * opens actually refreshes downstream state — the second watch after a
 * successful chain must be a no-op, and a newly arrived paper must reopen it.
 */

describe('evaluateWatchGate', () => {
  const base = {
    force: false,
    hasBaseline: true,
    missing: [] as string[],
    driftChanges: 0,
    pendingIngest: 0,
    pendingExtract: 0,
    modelEnabled: true,
  };

  it('force wins over everything', () => {
    expect(evaluateWatchGate({ ...base, force: true })).toEqual({
      changed: true,
      reason: 'forced',
    });
  });

  it('no recorded baseline means first run, whatever else holds', () => {
    expect(
      evaluateWatchGate({ ...base, hasBaseline: false, driftChanges: 3, missing: ['x'] }),
    ).toEqual({ changed: true, reason: 'first-run' });
  });

  it('missing outputs reopen the chain', () => {
    expect(evaluateWatchGate({ ...base, missing: ['knowledge/research-map.md'] })).toEqual({
      changed: true,
      reason: 'outputs-missing',
    });
  });

  it('new or changed inputs reopen the chain', () => {
    expect(evaluateWatchGate({ ...base, driftChanges: 1 })).toEqual({
      changed: true,
      reason: 'new-or-changed-inputs',
    });
  });

  it('unparsed papers reopen the chain', () => {
    expect(evaluateWatchGate({ ...base, pendingIngest: 2 })).toEqual({
      changed: true,
      reason: 'unprocessed-inputs',
    });
  });

  it('unextracted sources reopen only when a model can extract them', () => {
    expect(evaluateWatchGate({ ...base, pendingExtract: 1 })).toEqual({
      changed: true,
      reason: 'unprocessed-inputs',
    });
    // Keyless: extraction is deferred, not a reason to run every tick.
    expect(evaluateWatchGate({ ...base, pendingExtract: 1, modelEnabled: false })).toEqual({
      changed: false,
      reason: 'no-change',
    });
  });

  it('an unchanged project with current outputs is a no-op', () => {
    expect(evaluateWatchGate(base)).toEqual({ changed: false, reason: 'no-change' });
  });
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[], timeoutMs = 240_000): Promise<CliResult> {
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

interface WatchPayload {
  contract: string;
  changed: boolean;
  reason: WatchReason;
  drift: { added: number; modified: number; removed: number; files: string[] } | null;
  missing: string[];
  deferred: string[];
  pending: { ingest: number; extract: number };
  steps?: { step: string; status: string; detail: string }[];
  verdict?: string | null;
  blockingGaps?: number | null;
  wiki?: { nodes: number; edges: number } | null;
}

describe('ideaseek literature watch', () => {
  let dir: string;
  let havePdf = false;

  beforeEach(async () => {
    dir = await makeProjectDir();
    await mkdir(join(dir, 'papers'), { recursive: true });
    try {
      const { makeFixturePdf } = await import('../src/knowledge/pdf.js');
      await makeFixturePdf(join(dir, 'papers', 'alpha.pdf'), 'Alpha');
      havePdf = true;
    } catch {
      havePdf = false; // python/pypdf unavailable — parse-dependent tests skip
    }
  }, 120_000);

  async function watch(
    extra: string[] = [],
  ): Promise<{ result: CliResult; payload: WatchPayload }> {
    const result = await runCli(dir, ['literature', 'watch', '--skip-model', '--json', ...extra]);
    const payload = JSON.parse(result.stdout) as WatchPayload;
    return { result, payload };
  }

  function stepsOf(payload: WatchPayload): Record<string, string> {
    return Object.fromEntries((payload.steps ?? []).map((step) => [step.step, step.status]));
  }

  async function exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  it('first run builds the chain, the second run is a fast no-op', async () => {
    const first = await watch();
    expect(first.result.code, first.result.stdout + first.result.stderr).not.toBe(1);
    expect(first.payload.contract).toBe('literature-watch-v1');
    expect(first.payload.changed).toBe(true);
    expect(first.payload.reason).toBe('first-run');
    const steps = stepsOf(first.payload);
    expect(steps.scan).toBe('ran');
    expect(steps.ingest).toBe('ran');
    expect(steps.wiki).toBe('ran');
    expect(steps.assessment).toBe('ran');
    expect(steps.extract).toBe('skipped'); // --skip-model
    expect(steps.synthesize).toBe('skipped');
    expect(first.payload.wiki).not.toBeNull();

    // The chain left its deterministic outputs behind.
    expect(await exists(join(dir, 'knowledge', 'research-wiki', 'graph', 'edges.jsonl'))).toBe(
      true,
    );
    expect(await exists(join(dir, 'knowledge', 'research-material-assessment.json'))).toBe(true);

    const second = await watch();
    expect(second.result.code, second.result.stdout + second.result.stderr).toBe(0);
    expect(second.payload.changed).toBe(false);
    expect(second.payload.reason).toBe('no-change');
    expect(second.payload.steps).toBeUndefined(); // fast path: no chain ran
    expect(second.payload.verdict).toBe(first.payload.verdict); // stored report surfaced
    // Human path prints the no-op line (JSON mode carries it as reason).
    const human = await runCli(dir, ['literature', 'watch', '--skip-model']);
    expect(human.code, human.stdout + human.stderr).toBe(0);
    expect(human.stdout).toContain('no change');
    // research-map.md cannot exist without a model — deferred, not a loop.
    expect(second.payload.deferred).toEqual(expect.arrayContaining([...MODEL_OUTPUT_MARKERS]));
  }, 300_000);

  it('a newly arrived paper reopens the gate and gets parsed', async () => {
    if (!havePdf) return;
    await watch(); // first run
    const idle = await watch();
    expect(idle.payload.changed).toBe(false);

    const { makeFixturePdf } = await import('../src/knowledge/pdf.js');
    await makeFixturePdf(join(dir, 'papers', 'beta.pdf'), 'Beta');
    const opened = await watch();
    expect(opened.result.code, opened.result.stdout + opened.result.stderr).not.toBe(1);
    expect(opened.payload.changed).toBe(true);
    expect(opened.payload.reason).toBe('new-or-changed-inputs');
    expect(opened.payload.drift?.added).toBe(1);
    expect(stepsOf(opened.payload).ingest).toBe('ran');

    // …and the parse committed: the next tick is quiet again.
    const settled = await watch();
    expect(settled.payload.changed).toBe(false);
    expect(settled.payload.pending.ingest).toBe(0);
  }, 300_000);

  it('--force reopens an unchanged project', async () => {
    await watch();
    const idle = await watch();
    expect(idle.payload.changed).toBe(false);

    const forced = await watch(['--force']);
    expect(forced.result.code, forced.result.stdout + forced.result.stderr).not.toBe(1);
    expect(forced.payload.changed).toBe(true);
    expect(forced.payload.reason).toBe('forced');
    expect(forced.payload.steps).toBeDefined();
  }, 300_000);

  it('rejects a non-project directory', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const outside = await mkdtemp(join(tmpdir(), 'ideaseek-nonproject-'));
    const result = await runCli(outside, ['literature', 'watch', '--json']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('NOT_INITIALIZED');
  }, 120_000);
});
