/**
 * 投影器的真库读数（F1.15 / F1.2）。
 *
 * `projector.test.ts` 用的是端口桩，这里换成真的 `SqliteWorkflowDb`：
 * 只读事务、`PRAGMA user_version` 之外的迁移版本、`listRuns` 的排序——
 * 这些只有在真实驱动上量到才算数。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectBatches, collectRuns } from '../../src/cloud/projector.js';
import type { ProjectRuntime } from '../../src/workflow/runtime.js';
import { makeProjectDir, openRuntime, createDemoRun } from '../helpers.js';

let dir: string;
let runtime: ProjectRuntime;

beforeEach(async () => {
  dir = await makeProjectDir();
  runtime = await openRuntime(dir, { recover: false });
});

afterEach(async () => {
  await runtime.close();
});

const PROJECT = {
  externalId: 'proj-a1b2c3d4e5f60718',
  title: '真库读数',
  sourceHost: 'host-3f7868fca315',
};

async function project(runs: Awaited<ReturnType<typeof collectRuns>>['runs']) {
  return projectBatches({
    project: { ...PROJECT, question: runs[0]?.run.question ?? null },
    runs,
    generatedAt: 1_700_001_000_000,
    localSchemaVersion: 10,
  });
}

describe('projector against the real workflow database', () => {
  it('reads the runs and events that were actually written', async () => {
    const run = await createDemoRun(runtime);
    const collected = await collectRuns(runtime.db, { projectId: runtime.project.id });
    const batches = await project(collected.runs);

    expect(batches).toHaveLength(1);
    const entities = batches[0]!.batch.entities as {
      runs: Record<string, unknown>[];
      stages: Record<string, unknown>[];
      events: Record<string, unknown>[];
    };
    expect(entities.runs.map((r) => r.external_run_id)).toEqual([run.runId]);
    const stored = await runtime.db.listEvents(run.runId);
    expect(entities.events).toHaveLength(stored.length);
    expect(entities.events.map((e) => e.seq)).toEqual(stored.map((e) => e.seq));
    expect(batches[0]!.counts).toEqual({
      runs: 1,
      stages: entities.stages.length,
      events: stored.length,
    });
  });

  it('carries the local migration version and the config hash, never the config', async () => {
    await createDemoRun(runtime);
    const collected = await collectRuns(runtime.db, { projectId: runtime.project.id });
    expect(collected.localSchemaVersion).toBeGreaterThan(0);
    const [batch] = await project(collected.runs);
    const serialized = JSON.stringify(batch!.batch);
    expect(serialized).toContain('config_hash');
    // 本地 config 里的绝对路径与模型配置不许跟着投影出去。
    expect(serialized).not.toContain(dir.replace(/\\/g, '/'));
    expect(serialized).not.toContain(dir);
    expect(serialized).not.toContain('C:\\\\');
  });

  it('lists runs newest first so a capped push syncs the live run', async () => {
    const first = await runtime.db.createRun({
      projectId: runtime.project.id,
      question: '较早的问题',
      config: runtime.config,
    });
    const second = await runtime.db.createRun({
      projectId: runtime.project.id,
      question: '较新的问题',
      config: runtime.config,
    });
    const collected = await collectRuns(runtime.db, { projectId: runtime.project.id });
    expect(collected.runs.map((p) => p.run.runId)).toEqual([second.runId, first.runId]);
    const capped = await collectRuns(runtime.db, { projectId: runtime.project.id, maxRuns: 1 });
    expect(capped.runs.map((p) => p.run.runId)).toEqual([second.runId]);
  });

  it('resumes from the acknowledged cursor instead of re-reading history', async () => {
    const run = await createDemoRun(runtime);
    const all = await collectRuns(runtime.db, { projectId: runtime.project.id });
    const total = all.runs[0]!.events.length;
    expect(total).toBeGreaterThan(1);
    const cursor = all.runs[0]!.events[total - 3]!.seq;
    const resumed = await collectRuns(runtime.db, {
      projectId: runtime.project.id,
      sinceSeqByRun: { [run.runId]: cursor },
    });
    expect(resumed.runs[0]!.events).toHaveLength(2);
    const [batch] = await project(resumed.runs);
    expect(batch!.cursorByRun[run.runId]).toBe(all.runs[0]!.events[total - 1]!.seq);
  });

  it('refuses to write from inside the read snapshot', async () => {
    const run = await createDemoRun(runtime);
    let caught: unknown;
    try {
      // 同步抛也算数：被 query_only 挡下的写就是在 fn() 返回承诺之前炸的。
      await runtime.db.readSnapshot(() =>
        runtime.db.appendEvent({
          runId: run.runId,
          phase: 'INIT',
          eventType: 'cloud_projection_blocked',
          summary: '只读事务里不许写',
        }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).toContain('readonly');

    // 快照失败之后这条连接还得能用：query_only 必须被撤掉，且那条写没落库。
    const after = await collectRuns(runtime.db, { projectId: runtime.project.id });
    expect(after.runs.length).toBeGreaterThan(0);
    const events = await runtime.db.listEvents(run.runId);
    expect(events.some((e) => e.eventType === 'cloud_projection_blocked')).toBe(false);
  });
});
