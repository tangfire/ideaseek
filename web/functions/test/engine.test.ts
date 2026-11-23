/**
 * 云原生引擎回归测试：CloudEngine + step-driver。
 *
 * 验证三条硬规则（CLOUD_NATIVE_REFACTOR_PLAN §5）：
 *   1. 认领 = 唯一键插入（并发 claim 只有一个成功）
 *   2. 提交 = CAS 更新 + 返回行核对
 *   3. 幂等键覆盖（同 external_task_id 不重复创建）
 *
 * 跑法：node --test web/functions/test/engine.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from '../dev/fake-db.ts';
import { CloudEngine } from '../engine/cloud-engine.ts';
import { handleStep } from '../engine/step-driver.ts';

function setup() {
  const fake = createFakeDb();
  const owner = fake.seed('cloud_owner', { email: 'engine-owner', display_name: null });
  const project = fake.seed('cloud_project', {
    owner_id: owner.id,
    external_id: 'prj-engine',
    title: '引擎测试项目',
    question: '测试问题',
    strategy: 'standard',
    autonomy: 'guided',
    visibility: 'private',
    archived_at: null,
    last_sync_at: '2026-11-23T00:00:00.000Z',
  });
  const run = fake.seed('cloud_run', {
    project_id: project.id,
    external_run_id: 'run-engine-1',
    status: 'running',
    phase_tag: 'PAPER_ANALYSIS',
    question: '测试问题',
    block_reason: null,
    error_class: null,
    summary: null,
    started_at: '2026-11-23T00:00:00.000Z',
    finished_at: null,
    heartbeat_at: '2026-11-23T00:00:00.000Z',
    config_hash: null,
    budget_usd_micro: 0,
    spent_usd_micro: 0,
    synced_at: '2026-11-23T00:00:00.000Z',
  });
  const engine = new CloudEngine(fake.db, fake.BackendError);
  return { fake, engine, owner, project, run };
}

test('enqueueTask 幂等：同 external_task_id 不重复创建', async () => {
  const { engine, run } = setup();

  const first = await engine.enqueueTask({
    runId: run.id,
    kind: 'analyze_paper',
    phaseTag: 'PAPER_ANALYSIS',
    externalTaskId: 'task-idempotent-1',
    payload: { paper_id: 'paper-1' },
  });
  assert.equal(first.created, true);
  assert.equal(first.task.external_task_id, 'task-idempotent-1');
  assert.equal(first.task.status, 'queued');

  const second = await engine.enqueueTask({
    runId: run.id,
    kind: 'analyze_paper',
    phaseTag: 'PAPER_ANALYSIS',
    externalTaskId: 'task-idempotent-1',
    payload: { paper_id: 'paper-1' },
  });
  assert.equal(second.created, false);
  assert.equal(second.task.id, first.task.id);
});

test('claimNextTask 认领 queued 任务并建 lease', async () => {
  const { engine, run } = setup();

  await engine.enqueueTask({
    runId: run.id,
    kind: 'analyze_paper',
    phaseTag: 'PAPER_ANALYSIS',
    externalTaskId: 'task-claim-1',
  });

  const claim = await engine.claimNextTask(run.id, 'worker-A');
  assert.ok(claim, '应该认领到任务');
  assert.equal(claim.task.status, 'claimed');
  assert.equal(claim.leaseEpoch, 1);

  const leaseRows = engine['db'].from('cloud_task_lease').select('*');
  const leases = (await leaseRows).data ?? [];
  assert.equal(leases.length, 1);
  assert.equal(leases[0].worker_id, 'worker-A');
});

test('并发 claim：两个 worker 只有一个成功', async () => {
  const { engine, run } = setup();

  await engine.enqueueTask({
    runId: run.id,
    kind: 'analyze_paper',
    phaseTag: 'PAPER_ANALYSIS',
    externalTaskId: 'task-race-1',
  });

  const [a, b] = await Promise.all([
    engine.claimNextTask(run.id, 'worker-A'),
    engine.claimNextTask(run.id, 'worker-B'),
  ]);

  const successCount = [a, b].filter(Boolean).length;
  assert.equal(successCount, 1, '并发认领恰有一个成功');
});

test('commitTask CAS：用旧 leaseEpoch 提交失败', async () => {
  const { engine, run } = setup();

  await engine.enqueueTask({
    runId: run.id,
    kind: 'analyze_paper',
    phaseTag: 'PAPER_ANALYSIS',
    externalTaskId: 'task-cas-1',
  });

  const claim = await engine.claimNextTask(run.id, 'worker-A');
  assert.ok(claim);

  const committed = await engine.commitTask({
    taskId: claim.task.id,
    workerId: 'worker-A',
    leaseEpoch: claim.leaseEpoch,
    result: { paper_id: 'paper-1', claims: 5 },
  });
  assert.equal(committed.status, 'succeeded');
  assert.deepEqual(committed.result, { paper_id: 'paper-1', claims: 5 });

  await assert.rejects(
    () => engine.commitTask({
      taskId: claim.task.id,
      workerId: 'worker-A',
      leaseEpoch: claim.leaseEpoch,
      result: {},
    }),
    (err: Error) => {
      assert.ok('code' in err);
      assert.equal((err as { code: string }).code, 'lease_expired');
      return true;
    },
    '重复提交应被 CAS 拒绝',
  );
});

test('failTask 重试：attempt < max_attempts 时重新排队', async () => {
  const { engine, run } = setup();

  await engine.enqueueTask({
    runId: run.id,
    kind: 'analyze_paper',
    phaseTag: 'PAPER_ANALYSIS',
    externalTaskId: 'task-retry-1',
    maxAttempts: 3,
  });

  const claim = await engine.claimNextTask(run.id, 'worker-A');
  assert.ok(claim);

  const failed = await engine.failTask({
    taskId: claim.task.id,
    workerId: 'worker-A',
    leaseEpoch: claim.leaseEpoch,
    errorClass: 'transient',
    errorSummary: 'LLM timeout',
  });
  assert.equal(failed.status, 'queued', 'attempt 1 < max 3，重新排队');
});

test('appendEvent + listEvents 事件流', async () => {
  const { engine, run } = setup();

  const e1 = await engine.appendEvent({
    runId: run.id,
    type: 'phase_entered',
    summary: '进入 PAPER_ANALYSIS',
    phaseTag: 'PAPER_ANALYSIS',
  });
  const e2 = await engine.appendEvent({
    runId: run.id,
    type: 'task_completed',
    summary: '论文分析完成',
    phaseTag: 'PAPER_ANALYSIS',
    objectType: 'task',
    objectId: 'task-1',
  });

  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);

  const events = await engine.listEvents(run.id);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'phase_entered');
  assert.equal(events[1].type, 'task_completed');
});

test('setRunPhase + setStageProgress', async () => {
  const { engine, run } = setup();

  const updated = await engine.setRunPhase(run.id, 'IDEA_GENERATION', { status: 'running', summary: '开始生成 idea' });
  assert.equal(updated.phase_tag, 'IDEA_GENERATION');
  assert.equal(updated.status, 'running');

  await engine.setStageProgress(run.id, 'PAPER_ANALYSIS', 'passed');
  await engine.setStageProgress(run.id, 'IDEA_GENERATION', 'active');

  await engine.setStageProgress(run.id, 'PAPER_ANALYSIS', 'passed', { gateNote: '3 篇论文已分析' });
});

test('handleStep 端到端：从 queued 到 succeeded', async () => {
  const { fake, engine, run } = setup();

  await engine.enqueueTask({
    runId: run.id,
    kind: 'analyze_paper',
    phaseTag: 'PAPER_ANALYSIS',
    externalTaskId: 'task-step-1',
    payload: { paper_id: 'paper-1' },
  });

  const result = await handleStep(fake.db, fake.BackendError, { run_id: run.id }, 'owner-1');

  assert.equal(result.action, 'claimed');
  assert.ok(result.task);
  assert.equal(result.task.status, 'succeeded');
  assert.ok(result.events);
  assert.ok(result.events.length >= 2, '至少有 task_started + task_completed');
});

test('handleStep idle：无 queued 任务时尝试推进阶段', async () => {
  const { fake, engine, run } = setup();

  const result = await handleStep(fake.db, fake.BackendError, { run_id: run.id }, 'owner-1');

  assert.equal(result.action, 'advanced');
  assert.ok(result.newPhase, '应该推进到下一阶段');
});

test('upsertResearchNode 幂等 + 成功节点不降级', async () => {
  const { engine, run } = setup();

  const first = await engine.upsertResearchNode({
    runId: run.id,
    nodeId: 'node-1',
    kind: 'paper_analysis',
    status: 'pending',
    title: '论文 1',
  });
  assert.equal(first.created, true);

  const second = await engine.upsertResearchNode({
    runId: run.id,
    nodeId: 'node-1',
    kind: 'paper_analysis',
    status: 'succeeded',
    title: '论文 1 (完成)',
  });
  assert.equal(second.created, false);

  const third = await engine.upsertResearchNode({
    runId: run.id,
    nodeId: 'node-1',
    kind: 'paper_analysis',
    status: 'pending',
    title: '不应该降级',
  });
  assert.equal(third.created, false);
});
