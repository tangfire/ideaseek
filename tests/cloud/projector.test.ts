/**
 * 投影器单测（M2 出口门禁的后一半：F1.2 / F1.4 / F1.9 / F1.14 / F1.15）。
 *
 * 这里刻意不连数据库也不连 Function：投影器真正要守的是"出去的那份 JSON 长什么样"，
 * 所以断言都打在 `batch` 对象上。DB 读取用最小桩，真库集成在 push 那一层测。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BATCH_LIMITS,
  collectRuns,
  projectBatches,
  type ProjectIdentity,
  type ProjectionRequest,
} from '../../src/cloud/projector.js';
import type { WorkflowDb } from '../../src/workflow/db.js';
import type { RunEvent, RunRecord } from '../../src/workflow/types.js';
import { isIdeaseekError } from '../../src/core/errors.js';

const PROJECT: ProjectIdentity = {
  externalId: 'proj-a1b2c3d4e5f60718',
  title: 'Continual learning',
  question: '能否在小样本上稳定降低灾难性遗忘？',
  strategy: 'standard',
  autonomy: 'guided',
  sourceHost: 'host-3f7868fca315',
};

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-a1b2c3d4e5f60718',
    projectId: 'proj-a1b2c3d4e5f60718',
    question: '能否在小样本上稳定降低灾难性遗忘？',
    status: 'RUNNING',
    // 引擎今天的 RunPhase 只有 INIT|DEMO|COMPLETED，更细的科研阶段只能从 event.phase 里读出来。
    phase: 'INIT',
    strategy: 'standard',
    blockReason: null,
    // config 全文里带一个绝不该出网的值：白名单转换必须把它留在本地。
    config: { budget: { secret_note: 'internal-only-note' }, models: { primary: 'deepseek-chat' } },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_600_000,
    finishedAt: null,
    ...overrides,
  };
}

function event(seq: number, overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    seq,
    runId: 'run-a1b2c3d4e5f60718',
    ts: 1_700_000_000_000 + seq * 1000,
    phase: 'INIT',
    objectId: `task-0123456789abcdef`,
    role: 'worker',
    eventType: 'step_finished',
    summary: `第 ${seq} 步完成`,
    status: 'succeeded',
    artifactRefs: ['art-a1b2c3d4e5f60718'],
    ...overrides,
  };
}

function request(overrides: Partial<ProjectionRequest> = {}): ProjectionRequest {
  return {
    project: PROJECT,
    runs: [{ run: run(), events: [event(1), event(2)] }],
    generatedAt: 1_700_001_000_000,
    localSchemaVersion: 10,
    ...overrides,
  };
}

/** 只实现投影器会碰的那几个方法；其余一律炸掉，免得投影器偷偷换数据源。 */
function stubDb(runs: RunRecord[], events: Record<string, RunEvent[]>, version = 10): WorkflowDb {
  const calls: string[] = [];
  return {
    calls,
    schemaVersion: () => {
      calls.push('schemaVersion');
      return version;
    },
    readSnapshot: <T>(fn: () => Promise<T>): Promise<T> => {
      calls.push('readSnapshot');
      return fn();
    },
    listRuns: async (_projectId: string, limit?: number) => {
      calls.push('listRuns');
      return runs.slice(0, limit ?? runs.length);
    },
    listEvents: async (runId: string, opts?: { since?: number; limit?: number }) => {
      calls.push(`listEvents:${runId}:${opts?.since ?? 0}`);
      return (events[runId] ?? [])
        .filter((e) => e.seq > (opts?.since ?? 0))
        .slice(0, opts?.limit ?? 1000);
    },
  } as unknown as WorkflowDb;
}

describe('cloud projector (F1.2)', () => {
  it('emits only contract fields, and leaves the local config behind', async () => {
    const [batch] = await projectBatches(request());
    expect(batch).toBeDefined();
    const serialized = JSON.stringify(batch!.batch);
    expect(serialized).not.toContain('internal-only-note');
    expect(serialized).not.toContain('deepseek-chat');
    expect(serialized).not.toContain('"config"');
    expect(serialized).not.toContain('payload');
    const runRow = (batch!.batch.entities as { runs: Record<string, unknown>[] }).runs[0]!;
    expect(Object.keys(runRow).sort()).toEqual(
      [
        'config_hash',
        'external_run_id',
        'heartbeat_at',
        'phase_tag',
        'question',
        'started_at',
        'status',
      ].sort(),
    );
  });

  it('stamps a content hash of the config instead of the config itself', async () => {
    const [batch] = await projectBatches(request());
    const runRow = (batch!.batch.entities as { runs: Record<string, unknown>[] }).runs[0]!;
    expect(String(runRow.config_hash)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('keeps the engine enums verbatim and only heartbeat while running', async () => {
    const [running] = await projectBatches(request());
    const row = (running!.batch.entities as { runs: Record<string, unknown>[] }).runs[0]!;
    expect(row.status).toBe('RUNNING');
    expect(row.phase_tag).toBe('INIT');
    expect(row.heartbeat_at).toBe(1_700_000_600_000);

    const [ended] = await projectBatches(
      request({
        runs: [
          {
            run: run({
              status: 'COMPLETED',
              phase: 'COMPLETED',
              finishedAt: 1_700_000_900_000,
              updatedAt: 1_700_000_900_000,
            }),
            events: [],
          },
        ],
      }),
    );
    const doneRow = (ended!.batch.entities as { runs: Record<string, unknown>[] }).runs[0]!;
    expect(doneRow.finished_at).toBe(1_700_000_900_000);
    expect('heartbeat_at' in doneRow).toBe(false); // 终态 run 的 updated_at 不是心跳
  });

  it('never claims a visibility it was not given', async () => {
    const [batch] = await projectBatches(request());
    const project = batch!.batch.project as Record<string, unknown>;
    expect(project.visibility).toBe('private');
    expect(project.source_host).toBe(PROJECT.sourceHost);
  });

  it('drops an enum value the contract does not know instead of inventing one', async () => {
    const [batch] = await projectBatches(
      request({ project: { ...PROJECT, strategy: 'ultra-turbo', autonomy: 'yolo' } }),
    );
    const project = batch!.batch.project as Record<string, unknown>;
    expect('strategy' in project).toBe(false);
    expect('autonomy' in project).toBe(false);
  });
});

describe('L0 sanitization before serialization (F1.4)', () => {
  it('caps a summary at the contract length and flags the truncation', async () => {
    const [batch] = await projectBatches(
      request({ runs: [{ run: run(), events: [event(1, { summary: '长'.repeat(900) })] }] }),
    );
    const row = (batch!.batch.entities as { events: Record<string, unknown>[] }).events[0]!;
    expect(String(row.summary)).toHaveLength(400);
    expect(row.truncated).toBe(true);
  });

  it('folds newlines so a summary stays one line', async () => {
    const [batch] = await projectBatches(
      request({ runs: [{ run: run(), events: [event(1, { summary: '第一行\n第二行\t制表' })] }] }),
    );
    const row = (batch!.batch.entities as { events: Record<string, unknown>[] }).events[0]!;
    expect(String(row.summary)).toBe('第一行 第二行 制表');
    expect(row.truncated).toBe(false);
  });

  it('refuses the batch before schema validation when a credential shape is present', async () => {
    const secret = `sk-${'a1b2c3d4e5f6g7h8i9j0'.repeat(2)}`;
    let caught: unknown;
    try {
      await projectBatches(
        request({ runs: [{ run: run(), events: [event(1, { summary: `用完 ${secret}` })] }] }),
      );
    } catch (error) {
      caught = error;
    }
    expect(isIdeaseekError(caught) && caught.code).toBe('SECRET_GATE_BLOCKED');
    expect(JSON.stringify(caught)).not.toContain(secret);
  });

  it('reports a contract violation as INVALID_ARTIFACT, not as a send', async () => {
    let caught: unknown;
    try {
      // 一个 run 的 id 不合法：闸门放过去，契约拦下来。
      await projectBatches(
        request({
          runs: [
            { run: run({ runId: 'RUN-Upper-Not-Allowed-Because-Pattern' }), events: [event(1)] },
          ],
        }),
      );
    } catch (error) {
      caught = error;
    }
    expect(isIdeaseekError(caught) && caught.code).toBe('INVALID_ARTIFACT');
  });

  it('keeps absolute local paths out of object_id', async () => {
    const [batch] = await projectBatches(
      request({
        runs: [
          {
            run: run(),
            events: [
              event(1, { objectId: 'C:\\Users\\researcher\\papers\\a.pdf' }),
              event(2, { objectId: '/home/researcher/out.json' }),
              event(3, { objectId: '../../etc/passwd' }),
              event(4, { objectId: 'out/metrics.json' }),
            ],
          },
        ],
      }),
    );
    const rows = (batch!.batch.entities as { events: Record<string, unknown>[] }).events;
    expect('object_id' in rows[0]!).toBe(false);
    expect('object_id' in rows[1]!).toBe(false);
    expect('object_id' in rows[2]!).toBe(false);
    expect(rows[3]!.object_id).toBe('out/metrics.json');
    const serialized = JSON.stringify(batch!.batch);
    expect(serialized).not.toContain('researcher');
  });

  it('keeps artifact refs that look like local ids and drops the rest', async () => {
    const [batch] = await projectBatches(
      request({
        runs: [
          {
            run: run(),
            events: [event(1, { artifactRefs: ['art-a1b2c3d4e5f60718', '/tmp/x', 'AB78'] })],
          },
        ],
      }),
    );
    const row = (batch!.batch.entities as { events: Record<string, unknown>[] }).events[0]!;
    expect(row.artifact_refs).toEqual(['art-a1b2c3d4e5f60718']);
  });
});

describe('stage derivation (F1.15 read shape)', () => {
  it('walks the phases seen in events and marks the current one active', async () => {
    const [batch] = await projectBatches(
      request({
        runs: [
          {
            run: run({ phase: 'COMPLETED' }),
            events: [
              event(1, { phase: 'INIT', ts: 1_700_000_001_000 }),
              event(2, { phase: 'PAPER_ANALYSIS', ts: 1_700_000_002_000 }),
              event(3, { phase: 'EXPERIMENTING', ts: 1_700_000_003_000 }),
              event(4, { phase: 'COMPLETED', ts: 1_700_000_004_000 }),
            ],
          },
        ],
      }),
    );
    const stages = (batch!.batch.entities as { stages: Record<string, unknown>[] }).stages;
    expect(stages.map((s) => [s.stage, s.state, s.stage_known])).toEqual([
      ['INIT', 'passed', true],
      ['PAPER_ANALYSIS', 'passed', true],
      ['EXPERIMENTING', 'passed', true],
      ['COMPLETED', 'active', true],
    ]);
    expect(stages[0]!.exited_at).toBe(1_700_000_002_000);
    expect('exited_at' in stages[3]!).toBe(false);
  });

  it('does not invent an entry time for a phase no event reported', async () => {
    const [batch] = await projectBatches(
      request({
        runs: [{ run: run({ phase: 'COMPLETED' }), events: [event(1, { phase: 'INIT' })] }],
      }),
    );
    const stages = (batch!.batch.entities as { stages: Record<string, unknown>[] }).stages;
    expect(stages).toHaveLength(2);
    expect(stages[1]).toMatchObject({ stage: 'COMPLETED', state: 'active' });
    expect('entered_at' in stages[1]!).toBe(false);
  });

  it('reports an unknown phase instead of hiding it', async () => {
    const [batch] = await projectBatches(
      request({ runs: [{ run: run(), events: [event(1, { phase: 'SOMETHING_NEW' })] }] }),
    );
    const stages = (batch!.batch.entities as { stages: Record<string, unknown>[] }).stages;
    const exotic = stages.find((s) => s.stage === 'SOMETHING_NEW');
    expect(exotic).toMatchObject({ state: 'passed', stage_known: false });
  });

  it('carries the blocker as a code plus the reason on a blocked stage', async () => {
    const [batch] = await projectBatches(
      request({
        runs: [
          {
            run: run({ status: 'QUOTA_EXHAUSTED', blockReason: '额度耗尽：本阶段停止' }),
            events: [],
          },
        ],
      }),
    );
    const stages = (batch!.batch.entities as { stages: Record<string, unknown>[] }).stages;
    expect(stages[0]!.state).toBe('blocked');
    expect(stages[0]!.blocker_code).toBe('QUOTA_EXHAUSTED');
    expect(String(stages[0]!.gate_note)).toContain('额度耗尽');
  });
});

describe('event cursor (F1.9)', () => {
  it('reads only events after the acknowledged seq', async () => {
    const events = { 'run-a1b2c3d4e5f60718': [event(1), event(2), event(3)] };
    const collected = await collectRuns(stubDb([run()], events), {
      projectId: 'proj-a1b2c3d4e5f60718',
      sinceSeqByRun: { 'run-a1b2c3d4e5f60718': 2 },
    });
    expect(collected.runs[0]!.events.map((e) => e.seq)).toEqual([3]);
    expect(collected.localSchemaVersion).toBe(10);
  });

  it('stops the cursor at the last event that actually made the batch', async () => {
    const many = Array.from({ length: BATCH_LIMITS.maxEvents + 7 }, (_, i) => event(i + 1));
    const batches = await projectBatches(
      request({
        runs: [{ run: run(), events: many }],
        batchIds: ['bat-0000000000000001', 'bat-0000000000000002'],
      }),
    );
    expect(batches.length).toBe(2);
    expect(batches[0]!.counts.events).toBe(BATCH_LIMITS.maxEvents);
    expect(batches[0]!.cursorByRun['run-a1b2c3d4e5f60718']).toBe(BATCH_LIMITS.maxEvents);
    expect(batches[1]!.cursorByRun['run-a1b2c3d4e5f60718']).toBe(BATCH_LIMITS.maxEvents + 7);
    const total = new Set(
      batches.flatMap((b) =>
        (b.batch.entities as { events: { seq: number }[] }).events.map((e) => e.seq),
      ),
    );
    expect(total.size).toBe(many.length);
    for (const batch of batches) {
      const runs = (batch.batch.entities as { runs: Record<string, unknown>[] }).runs;
      expect(runs.map((r) => r.external_run_id)).toEqual(['run-a1b2c3d4e5f60718']); // 每片都自带被引用的 run 行
    }
  });

  it('keeps every batch inside the contract and transport ceilings', async () => {
    const runs = Array.from({ length: 4 }, (_, index) => ({
      run: run({ runId: `run-000000000000000${index}` }),
      events: Array.from({ length: 2600 }, (_, i) =>
        event(i + 1, { runId: `run-000000000000000${index}` }),
      ),
    }));
    const batches = await projectBatches(request({ runs }));
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      const entities = batch.batch.entities as {
        runs: unknown[];
        stages: unknown[];
        events: unknown[];
      };
      expect(entities.events.length).toBeLessThanOrEqual(BATCH_LIMITS.maxEvents);
      expect(entities.stages.length).toBeLessThanOrEqual(BATCH_LIMITS.maxStages);
      expect(batch.bytes).toBeLessThanOrEqual(BATCH_LIMITS.maxBytes);
    }
    const sent = batches.reduce((sum, b) => sum + b.counts.events, 0);
    expect(sent).toBe(4 * 2600);
  });
});

describe('data source discipline (F1.14 / NFR-14)', () => {
  it('reads through one snapshot transaction and only through the port', async () => {
    const calls: string[] = [];
    const db = stubDb([run()], { 'run-a1b2c3d4e5f60718': [event(1)] }) as unknown as {
      calls: string[];
    };
    calls.push(...db.calls);
    await collectRuns(db as unknown as WorkflowDb, { projectId: 'proj-a1b2c3d4e5f60718' });
    const after = (db as unknown as { calls: string[] }).calls;
    expect(after[0]).toBe('readSnapshot'); // 所有读取在同一个只读事务里（F1.15）
    expect(after.filter((c) => c === 'listRuns')).toHaveLength(1);
    expect(after.filter((c) => c.startsWith('listEvents'))).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it('imports no filesystem module at all', () => {
    const source = readFileSync(new URL('../../src/cloud/projector.ts', import.meta.url), 'utf8');
    // 只看 import 头：注释里提到 readdir 是给人读的警告，不是调用。
    const imports = source
      .split('\n')
      .filter((line) => line.startsWith('import '))
      .join('\n');
    for (const banned of ['node:fs', 'node:path', 'readdir', 'createReadStream', 'glob']) {
      expect(imports).not.toContain(banned);
    }
    expect(imports).toContain('../workflow/db.js');
  });
});
