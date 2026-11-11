import type { Dirent } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  HarnessAdapter,
  HarnessHealth,
  HarnessTaskRequest,
  HarnessTaskResult,
} from '../src/dsh/adapter.js';
import { FakeHarnessAdapter } from '../src/dsh/fake-adapter.js';
import { sha256OfFile } from '../src/core/hash.js';
import { arisSkillsRoot } from '../src/aris/skill.js';
import { createWorkspace } from '../src/idea/workspace.js';
import {
  REVIEW_AUDIT_SCHEMA,
  REVIEW_IDEA_SCHEMA,
  listReviews,
  parseReviewOutput,
  reviewDir,
  reviewPath,
  runReview,
  type ParseReviewContext,
} from '../src/review/review.js';
import type { ProjectRuntime } from '../src/workflow/runtime.js';
import type { RunEvent } from '../src/workflow/types.js';
import { REPO_ROOT, createDemoRun, makeProjectDir, openRuntime } from './helpers.js';

/**
 * Phase 4.5 conformance for the fresh-context reviewer + experiment audit
 * (docs/ARIS_AUDIT.md 每项迁移的 conformance 必测路径):
 * 1. success → skill render → harness → contract validation → versioned
 *    Review artifact + review RunEvent (identity/route/scope/input hashes);
 * 2. bad output → PARSE_FAILED, nothing written;
 * 3. quota block → HarnessBlockError, nothing written, rerun recovers;
 * 4. idempotent reuse + append-only versioning (old reviews never touched);
 * 5. skill tamper → SKILL_TAMPERED before any model call;
 * 6. the reviewer never mutates Idea/protocol/metric/handoff state and
 *    carries no prior review content into the next prompt (fresh context).
 */

const IDEA_ID = 'synth-revisable-idea';
const CARD_FIXTURE = join(REPO_ROOT, 'tests/fixtures/fl-goldset/idea-revisable.json');
const PAPERCARD_FIXTURE = join(REPO_ROOT, 'tests/fixtures/fl-goldset/papercard.json');

const GOOD_IDEA_REVIEW = JSON.stringify({
  score: 7,
  verdict: 'ready',
  weaknesses: [
    { severity: 'minor', detail: 'single-seed evidence', minimumFix: 'run a second seed' },
  ],
  summary: 'scripted review: the mechanism chain holds against the cited artifacts.',
});

const GOOD_AUDIT = JSON.stringify({
  checks: [
    {
      id: 'gt_provenance',
      status: 'PASS',
      details: 'dataset labels used',
      evidence: 'experiments/analysis.json',
    },
    {
      id: 'score_normalization',
      status: 'PASS',
      details: 'raw scores reported',
      evidence: 'experiments/analysis.json',
    },
    {
      id: 'result_existence',
      status: 'PASS',
      details: 'mirrors carry metrics',
      evidence: 'experiments/*-v1.json',
    },
    {
      id: 'dead_code',
      status: 'PASS',
      details: 'configured metrics appear',
      evidence: 'experiments/*-v1.json',
    },
    {
      id: 'scope',
      status: 'PASS',
      details: 'quick-scale scope honest',
      evidence: 'experiments/analysis.json',
    },
  ],
  evalType: 'real_gt',
  overall: 'PASS',
  summary: 'scripted audit: artifacts are internally consistent.',
});

/** Deterministic harness double: scripted outputs, records every request. */
class ScriptedHarness implements HarnessAdapter {
  readonly kind = 'fake' as const;
  readonly version = 'scripted-1';
  readonly calls: HarnessTaskRequest[] = [];
  private readonly outputs: (string | Error)[];

  constructor(outputs: (string | Error)[]) {
    this.outputs = outputs;
  }

  async initialize(): Promise<void> {}

  async runTask(request: HarnessTaskRequest): Promise<HarnessTaskResult> {
    this.calls.push(request);
    const next = this.outputs[Math.min(this.calls.length - 1, this.outputs.length - 1)];
    if (next === undefined) throw new Error('scripted harness: no output scripted');
    if (next instanceof Error) throw next;
    return {
      runId: request.runId,
      taskId: request.taskId,
      output: next,
      usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
      model: 'reviewer-model-1',
      toolCalls: [],
      runtime: { kind: 'fake', version: this.version },
      sessionId: `sess-${this.calls.length}`,
      finishedAt: Date.now(),
    };
  }

  async health(): Promise<HarnessHealth> {
    return {
      reachable: true,
      models: [{ name: 'reviewer-model-1', available: true, detail: 'scripted' }],
      blocked: false,
      blockReason: null,
    };
  }

  async shutdown(): Promise<void> {}
}

interface SeedOptions {
  run?: boolean;
  experiments?: boolean;
  papercard?: boolean;
}

const openRuntimes: ProjectRuntime[] = [];

afterEach(async () => {
  delete process.env.IDEASEEK_FAKE_REVIEW_OUTPUT;
  delete process.env.IDEASEEK_ARIS_SKILLS;
  while (openRuntimes.length > 0) {
    const runtime = openRuntimes.pop();
    await runtime?.close().catch(() => undefined);
  }
});

async function seedProject(
  opts: SeedOptions = {},
): Promise<{ dir: string; runtime: ProjectRuntime }> {
  const { run = true, experiments = true, papercard = true } = opts;
  const dir = await makeProjectDir();
  const runtime = await openRuntime(dir);
  openRuntimes.push(runtime);
  if (run) await createDemoRun(runtime);

  const card = JSON.parse(await readFile(CARD_FIXTURE, 'utf8'));
  await createWorkspace(dir, { ideaId: IDEA_ID, card });

  if (papercard) {
    await mkdir(join(dir, 'knowledge', 'paper-cards'), { recursive: true });
    await writeFile(
      join(dir, 'knowledge', 'paper-cards', 'synth-fedhet-0001.json'),
      JSON.stringify({
        artifactId: 'art-fixture',
        source: 'papers/synth-fedhet-0001.pdf',
        card: JSON.parse(await readFile(PAPERCARD_FIXTURE, 'utf8')),
      }),
      'utf8',
    );
  }

  if (experiments) {
    await writeFile(
      join(dir, 'ideas', IDEA_ID, 'experiments', 'analysis.json'),
      JSON.stringify({
        ideaId: IDEA_ID,
        ideaVersion: 1,
        verdict: 'inconclusive',
        reasons: ['seeded analysis'],
        generatedAt: 1,
      }),
      'utf8',
    );
    await writeFile(
      join(dir, 'ideas', IDEA_ID, 'experiments', 'fedavg-quick-v1.json'),
      JSON.stringify({
        spec: { specId: 'repro-fedavg' },
        result: { status: 'succeeded', metrics: [{ name: 'accuracy', value: 4.0 }] },
      }),
      'utf8',
    );
    await mkdir(join(dir, 'ideas', IDEA_ID, 'handoff'), { recursive: true });
    await writeFile(
      join(dir, 'ideas', IDEA_ID, 'handoff', 'handoff.json'),
      JSON.stringify({ ideaId: IDEA_ID, level: 'PROMISING', handoffReady: false }),
      'utf8',
    );
  }

  return { dir, runtime };
}

async function reviewEvents(runtime: ProjectRuntime): Promise<RunEvent[]> {
  const run = await runtime.db.getLatestRun(runtime.project.id);
  if (!run) return [];
  const events = await runtime.db.listEvents(run.runId, { limit: 1000 });
  return events.filter((event) => event.eventType === 'review');
}

async function snapshotIdeasTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        out[relative(root, full).split('\\').join('/')] = await sha256OfFile(full);
      }
    }
  };
  await walk(join(root, 'ideas'));
  out['research.yaml'] = await sha256OfFile(join(root, 'research.yaml'));
  return out;
}

async function fakeHarness(): Promise<FakeHarnessAdapter> {
  const harness = new FakeHarnessAdapter();
  await harness.initialize();
  return harness;
}

describe('fresh-context idea review (ARIS auto-review-loop)', () => {
  it('writes a versioned Review artifact with identity/route/scope/hashes and a review event', async () => {
    const { dir, runtime } = await seedProject();
    const harness = await fakeHarness();

    const result = await runReview({ runtime, ideaId: IDEA_ID, kind: 'idea-review', harness });

    expect(result.reused).toBe(false);
    expect(result.version).toBe(1);
    expect(result.path).toBe(reviewPath(dir, IDEA_ID, 'idea-review', 1));

    const onDisk = JSON.parse(await readFile(result.path, 'utf8')) as Record<string, unknown>;
    expect(onDisk.contract).toBe(REVIEW_IDEA_SCHEMA);
    expect(onDisk.kind).toBe('idea-review');
    expect(onDisk.reviewId).toBe(`rv-idea-review-${IDEA_ID}-v1`);
    expect(onDisk.target).toEqual({ kind: 'idea', ideaId: IDEA_ID, cardVersion: 1 });

    // reviewer identity (actual reported model/session/runtime) + route.
    const reviewer = onDisk.reviewer as Record<string, unknown>;
    expect(reviewer.identity).toEqual({
      model: 'fake-model',
      sessionId: null,
      runtime: 'fake',
    });
    expect(reviewer.route).toMatchObject({
      skill: 'auto-review-loop',
      profile: 'reviewer',
      harness: 'fake',
    });
    expect((reviewer.route as { skillSha256: string }).skillSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(reviewer.freshContext).toBe(true);

    // scope + input artifact hashes (goal 4).
    const inputs = onDisk.inputs as { kind: string; ref: string; sha256: string }[];
    expect(inputs.map((input) => input.kind).sort()).toEqual([
      'experiment-report',
      'handoff',
      'ideacard',
      'papercard',
      'run-result',
    ]);
    const ideaHash = await sha256OfFile(join(dir, 'ideas', IDEA_ID, 'idea.json'));
    expect(inputs.find((input) => input.kind === 'ideacard')?.sha256).toBe(ideaHash);
    expect(onDisk.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(onDisk.scope).toEqual({
      refs: expect.arrayContaining([`ideas/${IDEA_ID}/idea.json`]),
      unavailable: [],
      unmatchedPaperRefs: [],
    });
    expect(onDisk.score).toBe(7);
    expect(onDisk.verdict).toBe('ready');
    expect(onDisk.raw).toContain('fake idea review');

    // harness request shape (fresh one-shot dispatch).
    expect(harness.callCount(`review:idea-review:idea:${IDEA_ID}:v1:${onDisk.inputHash}`)).toBe(1);

    // Decision/Event trail (goal 5).
    const events = await reviewEvents(runtime);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      phase: 'REVIEW',
      objectId: `idea:${IDEA_ID}`,
      role: 'reviewer',
      status: 'ready',
    });
    expect(events[0]!.summary).toContain('auto-review-loop');
    expect(events[0]!.summary).toContain('fresh context');
    expect(result.eventSeq).toBe(events[0]!.seq);
  });

  it('records cited papers with no matching PaperCard instead of inventing them', async () => {
    const { dir, runtime } = await seedProject({ papercard: false });
    const harness = await fakeHarness();

    const result = await runReview({ runtime, ideaId: IDEA_ID, kind: 'idea-review', harness });

    expect(result.artifact.scope.unmatchedPaperRefs).toEqual(['synth-fedhet-0001']);
    expect(result.artifact.inputs.some((input) => input.kind === 'papercard')).toBe(false);
    expect(result.artifact.inputs.some((input) => input.kind === 'ideacard')).toBe(true);
    // Only the papercard is missing here; the experiment inputs were seeded.
    expect(result.artifact.scope.unavailable).toEqual([]);
    expect(await listReviews(dir, IDEA_ID)).toHaveLength(1);
  });

  it('reviews an experiment-less idea and records the absent artifacts as scope gaps', async () => {
    const { dir, runtime } = await seedProject({ experiments: false });
    const harness = await fakeHarness();

    const result = await runReview({ runtime, ideaId: IDEA_ID, kind: 'idea-review', harness });

    expect(result.version).toBe(1);
    expect(result.artifact.scope.unavailable).toEqual([
      `ideas/${IDEA_ID}/experiments/analysis.json`,
      `ideas/${IDEA_ID}/experiments/*-v*.json (no run results)`,
      `ideas/${IDEA_ID}/handoff/handoff.json`,
    ]);
    expect(await listReviews(dir, IDEA_ID)).toHaveLength(1);
  });

  it('writes the file but no event when the project has no run yet', async () => {
    const { dir, runtime } = await seedProject({ run: false, experiments: false });
    const harness = await fakeHarness();

    const result = await runReview({ runtime, ideaId: IDEA_ID, kind: 'idea-review', harness });

    expect(result.eventSeq).toBeNull();
    expect(await readFile(result.path, 'utf8')).toContain(REVIEW_IDEA_SCHEMA);
    expect(await listReviews(dir, IDEA_ID)).toHaveLength(1);
    expect(await reviewEvents(runtime)).toHaveLength(0);
  });
});

describe('experiment audit (ARIS experiment-audit)', () => {
  it('audits experiment outputs with the A–F checks and records the verdict event', async () => {
    const { dir, runtime } = await seedProject();
    const harness = await fakeHarness();

    const result = await runReview({ runtime, ideaId: IDEA_ID, kind: 'experiment-audit', harness });

    expect(result.path).toBe(reviewPath(dir, IDEA_ID, 'experiment-audit', 1));
    const onDisk = JSON.parse(await readFile(result.path, 'utf8')) as Record<string, unknown>;
    expect(onDisk.contract).toBe(REVIEW_AUDIT_SCHEMA);
    expect(onDisk.kind).toBe('experiment-audit');
    expect(onDisk.evalType).toBe('real_gt');
    expect(onDisk.overall).toBe('PASS');
    const checks = onDisk.checks as { id: string; status: string }[];
    expect(checks.map((check) => check.id).sort()).toEqual([
      'dead_code',
      'gt_provenance',
      'result_existence',
      'scope',
      'score_normalization',
    ]);
    // The audit scope judges experiment outputs, not the literature.
    const inputs = onDisk.inputs as { kind: string }[];
    expect(inputs.some((input) => input.kind === 'papercard')).toBe(false);
    expect(inputs.map((input) => input.kind).sort()).toEqual([
      'experiment-report',
      'handoff',
      'ideacard',
      'run-result',
    ]);

    const events = await reviewEvents(runtime);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      phase: 'REVIEW',
      eventType: 'review',
      status: 'PASS',
      objectId: `idea:${IDEA_ID}`,
    });
    expect(events[0]!.summary).toContain('experiment-audit');
  });

  it('refuses to audit an idea with no experiment outputs before any model call', async () => {
    const { dir, runtime } = await seedProject({ experiments: false });
    const harness = new ScriptedHarness([GOOD_AUDIT]);

    await expect(
      runReview({ runtime, ideaId: IDEA_ID, kind: 'experiment-audit', harness }),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_NOT_MET' });
    expect(harness.calls).toHaveLength(0);
    expect(await listReviews(dir, IDEA_ID)).toHaveLength(0);
    expect(await reviewEvents(runtime)).toHaveLength(0);
  });
});

describe('failure paths are recoverable and write nothing', () => {
  it('quota block propagates, persists nothing, and a rerun recovers', async () => {
    const { dir, runtime } = await seedProject();
    const harness = new FakeHarnessAdapter({ block: 'QUOTA_EXHAUSTED', blockTimes: 1 });
    await harness.initialize();

    await expect(
      runReview({ runtime, ideaId: IDEA_ID, kind: 'idea-review', harness }),
    ).rejects.toMatchObject({ name: 'HarnessBlockError', block: 'QUOTA_EXHAUSTED' });
    expect(await listReviews(dir, IDEA_ID)).toHaveLength(0);
    expect(await reviewEvents(runtime)).toHaveLength(0);

    // Same inputs → same idempotency key; the second call gets past the block.
    const recovered = await runReview({ runtime, ideaId: IDEA_ID, kind: 'idea-review', harness });
    expect(recovered.reused).toBe(false);
    expect(recovered.version).toBe(1);
    expect(await reviewEvents(runtime)).toHaveLength(1);
  });

  it('bad output fails the contract with nothing written; a clean rerun succeeds', async () => {
    const { dir, runtime } = await seedProject();
    const harness = await fakeHarness();

    process.env.IDEASEEK_FAKE_REVIEW_OUTPUT = 'not json';
    await expect(
      runReview({ runtime, ideaId: IDEA_ID, kind: 'idea-review', harness }),
    ).rejects.toMatchObject({ code: 'PARSE_FAILED' });
    expect(await listReviews(dir, IDEA_ID)).toHaveLength(0);
    expect(await reviewEvents(runtime)).toHaveLength(0);

    process.env.IDEASEEK_FAKE_REVIEW_OUTPUT =
      '{"score":99,"verdict":"ready","weaknesses":[],"summary":"x"}';
    await expect(
      runReview({ runtime, ideaId: IDEA_ID, kind: 'idea-review', harness }),
    ).rejects.toMatchObject({ code: 'PARSE_FAILED' });
    expect(await listReviews(dir, IDEA_ID)).toHaveLength(0);

    delete process.env.IDEASEEK_FAKE_REVIEW_OUTPUT;
    const recovered = await runReview({ runtime, ideaId: IDEA_ID, kind: 'idea-review', harness });
    expect(recovered.version).toBe(1);
    expect(await reviewEvents(runtime)).toHaveLength(1);
  });

  it('refuses a tampered vendored skill before any model call', async () => {
    const { dir, runtime } = await seedProject();
    const tamperedRoot = await mkdtemp(join(tmpdir(), 'aris-tamper-'));
    const skillFile = join(tamperedRoot, 'skills', 'auto-review-loop', 'SKILL.md');
    try {
      await cp(arisSkillsRoot(), tamperedRoot, { recursive: true });
      await writeFile(skillFile, `${await readFile(skillFile, 'utf8')}\n<!-- tampered -->`, 'utf8');
      process.env.IDEASEEK_ARIS_SKILLS = tamperedRoot;
      const harness = new ScriptedHarness([GOOD_IDEA_REVIEW]);

      await expect(
        runReview({ runtime, ideaId: IDEA_ID, kind: 'idea-review', harness }),
      ).rejects.toMatchObject({ code: 'SKILL_TAMPERED' });
      expect(harness.calls).toHaveLength(0);
      expect(await listReviews(dir, IDEA_ID)).toHaveLength(0);
      expect(await reviewEvents(runtime)).toHaveLength(0);
    } finally {
      await rm(tamperedRoot, { recursive: true, force: true });
    }
  });
});

describe('append-only review history and fresh context', () => {
  it('reuses an identical-input review without a second model call or event', async () => {
    const { dir, runtime } = await seedProject();
    const harness = await fakeHarness();

    const first = await runReview({ runtime, ideaId: IDEA_ID, kind: 'idea-review', harness });
    const second = await runReview({ runtime, ideaId: IDEA_ID, kind: 'idea-review', harness });

    expect(second.reused).toBe(true);
    expect(second.version).toBe(1);
    expect(second.path).toBe(first.path);
    expect(second.eventSeq).toBeNull();
    expect(second.artifact.inputHash).toBe(first.artifact.inputHash);
    expect(
      harness.callCount(`review:idea-review:idea:${IDEA_ID}:v1:${first.artifact.inputHash}`),
    ).toBe(1);
    expect(await reviewEvents(runtime)).toHaveLength(1);
    expect(await listReviews(dir, IDEA_ID)).toHaveLength(1);
  });

  it('appends new versions without ever rewriting an older review', async () => {
    const { dir, runtime } = await seedProject();
    const harness = await fakeHarness();

    const first = await runReview({ runtime, ideaId: IDEA_ID, kind: 'idea-review', harness });
    const v1Bytes = await readFile(first.path, 'utf8');

    // Changed inputs → new inputHash → a NEW append-only version.
    await writeFile(
      join(dir, 'ideas', IDEA_ID, 'experiments', 'analysis.json'),
      JSON.stringify({
        ideaId: IDEA_ID,
        ideaVersion: 1,
        verdict: 'rejected',
        reasons: ['changed'],
        generatedAt: 2,
      }),
      'utf8',
    );
    const second = await runReview({ runtime, ideaId: IDEA_ID, kind: 'idea-review', harness });
    expect(second.version).toBe(2);
    expect(second.reused).toBe(false);
    expect(second.artifact.inputHash).not.toBe(first.artifact.inputHash);
    expect(await readFile(first.path, 'utf8')).toBe(v1Bytes);

    // force re-reviews identical inputs as yet another version.
    const third = await runReview({
      runtime,
      ideaId: IDEA_ID,
      kind: 'idea-review',
      harness,
      force: true,
    });
    expect(third.version).toBe(3);
    expect(third.artifact.inputHash).toBe(second.artifact.inputHash);
    expect(await readFile(first.path, 'utf8')).toBe(v1Bytes);
    expect(await readFile(second.path, 'utf8')).toContain('"version": 2');

    const files = await readdir(reviewDir(dir, IDEA_ID));
    expect(files).toContain('idea-review-v1.json');
    expect(files).toContain('idea-review-v2.json');
    expect(files).toContain('idea-review-v3.json');
    expect(await reviewEvents(runtime)).toHaveLength(3);
  });

  it('never carries prior review content into the next prompt (fresh context)', async () => {
    const { runtime } = await seedProject();
    const secret = JSON.stringify({
      score: 8,
      verdict: 'ready',
      weaknesses: [],
      summary: 'FIRST REVIEW SECRET marker',
    });

    const first = new ScriptedHarness([secret]);
    await runReview({ runtime, ideaId: IDEA_ID, kind: 'idea-review', harness: first });

    const second = new ScriptedHarness([GOOD_IDEA_REVIEW]);
    await runReview({
      runtime,
      ideaId: IDEA_ID,
      kind: 'idea-review',
      harness: second,
      force: true,
    });

    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
    // No prior review output, executor summary or memory crosses invocations.
    expect(first.calls[0]!.instruction).not.toContain('FIRST REVIEW SECRET');
    expect(second.calls[0]!.instruction).not.toContain('FIRST REVIEW SECRET');
    expect(second.calls[0]!.instruction).toContain('fresh review');
    // Each review is its own task with its own idempotency key.
    expect(second.calls[0]!.taskId).not.toBe(first.calls[0]!.taskId);
    expect(second.calls[0]!.idempotencyKey).not.toBe(first.calls[0]!.idempotencyKey);
    expect(second.calls[0]!.profile).toBe('reviewer');
  });
});

describe('reviewer read-only guarantee (goal 6)', () => {
  it('never mutates Idea, handoff, metrics or config state', async () => {
    const { dir, runtime } = await seedProject();
    const before = await snapshotIdeasTree(dir);
    const harness = await fakeHarness();

    await runReview({ runtime, ideaId: IDEA_ID, kind: 'idea-review', harness });
    await runReview({ runtime, ideaId: IDEA_ID, kind: 'experiment-audit', harness });

    const after = await snapshotIdeasTree(dir);
    expect(after).toEqual(before);
    // The only new files live under knowledge/reviews/.
    const reviewFiles = await readdir(reviewDir(dir, IDEA_ID));
    expect(reviewFiles.sort()).toEqual(['experiment-audit-v1.json', 'idea-review-v1.json']);
  });
});

describe('review output contracts', () => {
  const baseCtx: ParseReviewContext = {
    kind: 'idea-review',
    target: { kind: 'idea', ideaId: 'x-idea', cardVersion: 1 },
    scope: { refs: [], unavailable: [], unmatchedPaperRefs: [] },
    inputs: [],
    inputHash: `sha256:${'a'.repeat(64)}`,
    skill: { name: 'auto-review-loop', sha256: 'b'.repeat(64) },
    identity: { model: null, sessionId: null, runtime: 'fake' },
    routeHarness: 'fake',
    version: 1,
    now: 1,
  };

  it('rejects non-JSON and out-of-contract review payloads', () => {
    expect(() => parseReviewOutput('nope', baseCtx)).toThrow(/not JSON/);
    expect(() =>
      parseReviewOutput('{"score":99,"verdict":"ready","weaknesses":[],"summary":"x"}', baseCtx),
    ).toThrow(/score must be/);
    expect(() =>
      parseReviewOutput('{"score":5,"verdict":"approve","weaknesses":[],"summary":"x"}', baseCtx),
    ).toThrow(/verdict must be/);
    expect(() =>
      parseReviewOutput('{"score":5,"verdict":"not ready","weaknesses":[],"summary":"x"}', baseCtx),
    ).toThrow(/weaknesses must have/);
    expect(() =>
      parseReviewOutput(
        '{"score":5,"verdict":"ready","weaknesses":[{"severity":"s","detail":"d"}],"summary":"x"}',
        baseCtx,
      ),
    ).toThrow(/minimumFix/);
  });

  it('requires every audit check and a worst-status-consistent overall', () => {
    const auditCtx: ParseReviewContext = { ...baseCtx, kind: 'experiment-audit' };
    expect(() =>
      parseReviewOutput(
        '{"checks":[],"evalType":"real_gt","overall":"PASS","summary":"x"}',
        auditCtx,
      ),
    ).toThrow(/missing id/);

    const checks = [
      'gt_provenance',
      'score_normalization',
      'result_existence',
      'dead_code',
      'scope',
    ].map((id) => ({ id, status: 'PASS', details: 'ok', evidence: 'ref' }));
    expect(() =>
      parseReviewOutput(
        JSON.stringify({ checks, evalType: 'real_gt', overall: 'FAIL', summary: 'x' }),
        auditCtx,
      ),
    ).toThrow(/worst check status/);

    const parsed = parseReviewOutput(
      JSON.stringify({ checks, evalType: 'real_gt', overall: 'PASS', summary: 'x' }),
      auditCtx,
    );
    expect(parsed.contract).toBe(REVIEW_AUDIT_SCHEMA);
    expect(parsed.kind).toBe('experiment-audit');
  });
});

describe('fake harness review outputs', () => {
  it('serves contract-shaped review payloads and honors the override hook', async () => {
    const harness = await fakeHarness();
    const request = (schema: string, key: string): HarnessTaskRequest => ({
      runId: 'r',
      taskId: 't',
      profile: 'reviewer',
      instruction: '',
      inputs: [],
      outputSchema: schema,
      budget: { timeoutMs: 5_000 },
      idempotencyKey: key,
    });

    const idea = await harness.runTask(request('idea-review-v1', 'k-idea'));
    expect(JSON.parse(idea.output)).toMatchObject({ verdict: 'ready', score: 7 });

    const audit = await harness.runTask(request('experiment-audit-v1', 'k-audit'));
    expect(JSON.parse(audit.output)).toMatchObject({ overall: 'PASS', evalType: 'real_gt' });

    process.env.IDEASEEK_FAKE_REVIEW_OUTPUT = '{"broken":';
    try {
      const overridden = await harness.runTask(request('idea-review-v1', 'k-override'));
      expect(overridden.output).toBe('{"broken":');
    } finally {
      delete process.env.IDEASEEK_FAKE_REVIEW_OUTPUT;
    }
    await harness.shutdown();
  });
});
