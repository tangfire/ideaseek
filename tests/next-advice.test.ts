import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  HarnessAdapter,
  HarnessHealth,
  HarnessTaskRequest,
  HarnessTaskResult,
} from '../src/dsh/adapter.js';
import { firstTextInput } from '../src/dsh/adapter.js';
import type { ProjectRuntime } from '../src/workflow/runtime.js';
import {
  buildNextAdvice,
  loadNextAdvice,
  parseNextAdvice,
  validateNextAdvice,
} from '../src/knowledge/next-advice.js';
import { buildResearchMaterialAssessment } from '../src/knowledge/assessment.js';
import { materialAdvice, type NextAdvice } from '../src/commands/next.js';
import { CLI_BIN, makeProjectDir, openRuntime } from './helpers.js';

/**
 * Agent next-step advice (P2 判断面 agent 化): the gap ladder keeps the
 * facts (stage, blockers, exit code) and its own candidate set; the agent
 * re-ranks and rephrases within that set. What these tests pin down:
 * a command outside the candidate set is rejected however well-formed,
 * stale advice (changed contextHash) is ignored, a failed build writes
 * nothing, and the ladder answers whenever the model does not — because
 * `next` must always answer, and scripts depend on its exit codes.
 */

/** Stub harness: canned or request-derived output, counts calls. */
class StubHarness implements HarnessAdapter {
  readonly kind = 'fake' as const;
  readonly version = 'stub-1';
  calls = 0;
  constructor(private readonly respond: (request: HarnessTaskRequest) => string) {}
  async initialize(): Promise<void> {}
  async health(): Promise<HarnessHealth> {
    return { reachable: true, models: [], blocked: false, blockReason: null };
  }
  async shutdown(): Promise<void> {}
  async runTask(request: HarnessTaskRequest): Promise<HarnessTaskResult> {
    this.calls += 1;
    return {
      runId: request.runId,
      taskId: request.taskId,
      output: this.respond(request),
      usage: {},
      model: 'stub',
      toolCalls: [],
      runtime: { kind: 'fake', version: this.version },
      finishedAt: Date.now(),
    };
  }
}

/** Asks for the SECOND candidate — proves the agent can override the ladder. */
function pickSecondCandidate(request: HarnessTaskRequest): string {
  const context = JSON.parse(firstTextInput(request)) as { candidates?: unknown };
  const candidates = Array.isArray(context.candidates) ? context.candidates : [];
  return JSON.stringify({
    command: candidates[1] ?? '',
    suggestion: '先处理这个缺口，它解锁的下游步骤最多',
    rationale: '该候选一次性清除最多的下游阻塞',
  });
}

const CANDIDATES = ['ideaseek ingest', 'ideaseek extract', 'ideaseek assessment'];

describe('next-advice validation', () => {
  it('accepts a candidate command and redacts secrets', () => {
    const advice = validateNextAdvice(
      {
        command: 'ideaseek ingest',
        suggestion: '运行 ingest 解析论文，注意 sk-abc123456789',
        rationale: '解析是后续所有阶段的输入',
      },
      CANDIDATES,
    );
    expect(advice?.command).toBe('ideaseek ingest');
    expect(advice?.suggestion).toContain('sk-***');
    expect(advice?.suggestion).not.toContain('sk-abc123456789');
  });

  it('rejects a command outside the candidate set', () => {
    // The agent re-ranks the ladder's options; it never invents commands.
    expect(
      validateNextAdvice(
        { command: 'ideaseek rm-everything', suggestion: 'x', rationale: 'y enough' },
        CANDIDATES,
      ),
    ).toBeNull();
    expect(
      parseNextAdvice(
        JSON.stringify({ command: 'nonsense', suggestion: 'x', rationale: 'y' }),
        CANDIDATES,
      ),
    ).toBeNull();
  });

  it('rejects malformed shapes', () => {
    expect(parseNextAdvice('not json', CANDIDATES)).toBeNull();
    expect(
      validateNextAdvice({ command: 'ideaseek ingest', suggestion: 'x' }, CANDIDATES),
    ).toBeNull(); // missing rationale
    expect(
      validateNextAdvice(
        { command: 'ideaseek ingest', suggestion: 'x', rationale: 'y enough', extra: 1 },
        CANDIDATES,
      ),
    ).toBeNull();
  });
});

describe('next-advice build and cache', () => {
  let root: string;

  it('builds, persists and reloads advice for the same contextHash', async () => {
    root = await mkdtemp(join(tmpdir(), 'ideaseek-next-advice-'));
    const stub = new StubHarness(pickSecondCandidate);
    const built = await buildNextAdvice({
      harness: stub,
      root,
      contextHash: 'hash-1',
      question: 'q?',
      stats: { paperCards: 0 },
      gaps: [],
      candidates: CANDIDATES,
      current: { command: CANDIDATES[0]!, suggestion: 'mechanical suggestion' },
    });
    expect(built?.command).toBe(CANDIDATES[1]);
    expect(built?.rationale).toContain('下游');

    const loaded = await loadNextAdvice(root, 'hash-1', CANDIDATES);
    expect(loaded).toEqual(built);
    expect(stub.calls).toBe(1);
  });

  it('writes nothing when the model output fails validation', async () => {
    root = await mkdtemp(join(tmpdir(), 'ideaseek-next-advice-'));
    const stub = new StubHarness(() =>
      JSON.stringify({
        command: 'ideaseek not-a-candidate',
        suggestion: 'x',
        rationale: 'y enough',
      }),
    );
    const built = await buildNextAdvice({
      harness: stub,
      root,
      contextHash: 'hash-1',
      question: 'q',
      stats: {},
      gaps: [],
      candidates: CANDIDATES,
      current: { command: CANDIDATES[0]!, suggestion: 's' },
    });
    expect(built).toBeNull();
    // A bad model call never poisons the cache.
    await expect(readFile(join(root, 'knowledge', 'next-advice.json'), 'utf8')).rejects.toThrow();
  });

  it('writes nothing when the harness throws', async () => {
    root = await mkdtemp(join(tmpdir(), 'ideaseek-next-advice-'));
    const stub = new StubHarness(() => '{}');
    stub.runTask = async () => {
      throw new Error('provider unreachable');
    };
    const built = await buildNextAdvice({
      harness: stub,
      root,
      contextHash: 'hash-1',
      question: 'q',
      stats: {},
      gaps: [],
      candidates: CANDIDATES,
      current: { command: CANDIDATES[0]!, suggestion: 's' },
    });
    expect(built).toBeNull();
    await expect(readFile(join(root, 'knowledge', 'next-advice.json'), 'utf8')).rejects.toThrow();
  });

  it('ignores advice keyed to another contextHash or leaving the candidate set', async () => {
    root = await mkdtemp(join(tmpdir(), 'ideaseek-next-advice-'));
    const file = join(root, 'knowledge', 'next-advice.json');
    const { ensureDir } = await import('../src/core/atomic.js');
    await ensureDir(join(root, 'knowledge'));
    await writeFile(
      file,
      JSON.stringify({
        contract: 'next-advice-v1',
        contextHash: 'hash-OLD',
        at: 1,
        advice: { command: 'ideaseek ingest', suggestion: 's', rationale: 'r enough' },
      }),
    );
    expect(await loadNextAdvice(root, 'hash-NEW', CANDIDATES)).toBeNull();

    // Fresh hash, but the command is no longer on offer: stale or foreign.
    await writeFile(
      file,
      JSON.stringify({
        contract: 'next-advice-v1',
        contextHash: 'hash-NEW',
        at: 1,
        advice: { command: 'ideaseek gone', suggestion: 's', rationale: 'r enough' },
      }),
    );
    expect(await loadNextAdvice(root, 'hash-NEW', CANDIDATES)).toBeNull();
  });
});

describe('materialAdvice applies agent advice over the ladder', () => {
  let runtime: ProjectRuntime | null = null;
  let dir = '';

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
    dir = '';
  });

  async function ladderProject(): Promise<{
    advice: NextAdvice;
    contextHash: string;
    question: string;
    stats: Record<string, unknown>;
    gaps: Awaited<ReturnType<typeof buildResearchMaterialAssessment>>['gaps'];
  }> {
    dir = await makeProjectDir();
    runtime = await openRuntime(dir);
    const assessment = await buildResearchMaterialAssessment(dir, {});
    const advice = await materialAdvice(runtime);
    expect(advice, 'fixture project must have a gap branch').not.toBeNull();
    return {
      advice: advice!,
      contextHash: assessment.contextHash,
      question: assessment.question,
      stats: assessment.stats as Record<string, unknown>,
      gaps: assessment.gaps,
    };
  }

  it('attaches candidates and stays on the ladder without harness or file', async () => {
    const { advice } = await ladderProject();
    expect(advice.candidates!.length).toBeGreaterThanOrEqual(2);
    expect(advice.adviceSource).toBeUndefined();
    expect(advice.stage).toBe('MATERIAL_INCOMPLETE');
    expect(advice.exitCode).toBe(0);
  });

  it('uses stored advice without a harness (load path) and keeps the facts', async () => {
    const { advice, contextHash, question, stats, gaps } = await ladderProject();
    const alternative = advice.candidates![1]!;
    expect(alternative).not.toBe(advice.command);
    const stub = new StubHarness(pickSecondCandidate);
    const built = await buildNextAdvice({
      harness: stub,
      root: dir,
      contextHash,
      question,
      stats,
      gaps,
      candidates: advice.candidates!,
      current: { command: advice.command, suggestion: advice.suggestion },
    });
    expect(built?.command).toBe(alternative);

    const applied = await materialAdvice(runtime!); // no harness: load only
    if (!applied) throw new Error('materialAdvice returned null');
    expect(applied.adviceSource).toBe('agent');
    expect(applied.command).toBe(alternative);
    expect(applied.adviceRationale).toContain('下游');
    // Facts are never touched by the judgment layer.
    expect(applied.stage).toBe('MATERIAL_INCOMPLETE');
    expect(applied.exitCode).toBe(0);
    expect(applied.blockers.join(' ')).toContain('question');
  });

  it('builds through the harness when no artifact exists', async () => {
    dir = await makeProjectDir();
    runtime = await openRuntime(dir);
    const stub = new StubHarness(pickSecondCandidate);
    const applied = await materialAdvice(runtime, { harness: stub });
    expect(stub.calls).toBe(1);
    expect(applied!.adviceSource).toBe('agent');
    expect(applied!.command).toBe(applied!.candidates![1]);
    // And the artifact it wrote is reusable without a harness.
    const reloaded = await materialAdvice(runtime);
    expect(reloaded!.adviceSource).toBe('agent');
    expect(reloaded!.command).toBe(applied!.command);
  });

  it('falls back to the ladder when the harness output is invalid', async () => {
    dir = await makeProjectDir();
    runtime = await openRuntime(dir);
    const stub = new StubHarness(() =>
      JSON.stringify({
        command: 'ideaseek invented-command',
        suggestion: 'x',
        rationale: 'y enough',
      }),
    );
    const applied = await materialAdvice(runtime, { harness: stub });
    expect(applied!.adviceSource).toBeUndefined();
    expect(applied!.candidates!.length).toBeGreaterThanOrEqual(2);
    expect(applied!.stage).toBe('MATERIAL_INCOMPLETE');
  });
});

function runCli(
  cwd: string,
  args: string[],
  timeoutMs = 120_000,
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

describe('next CLI end-to-end (fake harness builds, cache reuses)', () => {
  it('reports agent advice built through the fake harness and reused across calls', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-next-e2e-'));
    expect((await runCli(dir, ['init'])).code).toBe(0);

    const first = await runCli(dir, ['next', '--json']);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    const payload = JSON.parse(first.stdout.trim().split(/\r?\n/).pop() ?? '{}') as {
      stage: string;
      command: string;
      candidates?: string[];
      adviceSource?: string;
      adviceRationale?: string;
      exitCode: number;
    };
    // The fake echoes the ladder's pick, so the command is unchanged — but
    // the full agent path (build → validate → persist → apply) ran.
    expect(payload.adviceSource).toBe('agent');
    expect(payload.candidates!.length).toBeGreaterThanOrEqual(2);
    expect(payload.command).toBe(payload.candidates![0]);
    // Journey A: the question gap's candidate must be the persisting command
    // (plan --question is a dry-run; advising it looped the blocker).
    expect(payload.candidates!.some((candidate) => candidate.includes('setup --question'))).toBe(
      true,
    );
    expect(payload.candidates!.some((candidate) => candidate.includes('plan --question'))).toBe(
      false,
    );
    expect(payload.adviceRationale).toContain('fake harness');
    expect(payload.stage).toBe('MATERIAL_INCOMPLETE');
    expect(payload.exitCode).toBe(0);

    // Second call reads the persisted artifact instead of rebuilding.
    const second = await runCli(dir, ['next', '--json']);
    expect(second.code).toBe(0);
    const cached = JSON.parse(second.stdout.trim().split(/\r?\n/).pop() ?? '{}') as {
      adviceSource?: string;
      command: string;
    };
    expect(cached.adviceSource).toBe('agent');
    expect(cached.command).toBe(payload.command);

    // Human output surfaces the agent's reasoning when advice is active.
    const human = await runCli(dir, ['next']);
    expect(human.stdout).toContain('依据：');
    expect(human.stdout).toContain('下一条命令：');
  }, 180_000);
});
