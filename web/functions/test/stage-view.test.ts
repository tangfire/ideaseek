import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from '../dev/fake-db.ts';
import { stageView, type Viewer } from '../views.ts';
import type { Db } from '../deps.ts';
import { application } from '../routes.ts';
import { ensureSession, withSession } from '../dev/test-session.ts';

function setup() {
  const fake = createFakeDb();
  const owner = fake.seed('cloud_owner', { email: 'stage-owner' });
  const project = fake.seed('cloud_project', {
    external_id: 'stage-project',
    owner_id: owner.id,
    visibility: 'private',
    archived_at: null,
  });
  const run = fake.seed('cloud_run', { project_id: project.id, external_run_id: 'stage-run' });
  const viewer: Viewer = {
    ownerId: String(owner.id),
    anonymousOwnerId: null,
    grantedProjectIds: [],
    limitedProjectIds: [],
    shareProjectId: null,
  };
  const task = (patch: Record<string, unknown> = {}) =>
    fake.seed('cloud_task', {
      run_id: run.id,
      external_task_id: 'task-paper',
      kind: 'analyze_paper',
      phase_tag: 'PAPER_ANALYSIS',
      status: 'succeeded',
      attempt: 1,
      max_attempts: 3,
      started_at: null,
      ended_at: null,
      payload: { paper_id: 'paper-one', abstract: '真实摘要', api_key: 'private-fixture' },
      result: {
        title: '论文标题',
        method_summary: '方法描述',
        claims: [{ text: '一条结论', api_key: 'nested-private-fixture' }],
        api_key: 'output-private-fixture',
      },
      error_summary: 'private-error-fixture',
      created_at: '2026-11-25T00:00:00Z',
      ...patch,
    });
  const read = (stage = 'PAPER_ANALYSIS', actor = viewer, db = fake.db, runId = 'stage-run') =>
    stageView(db, actor, 'stage-project', runId, stage, fake.BackendError);
  return { ...fake, owner, project, run, viewer, task, read };
}

test('阶段详情按项目、运行与阶段隔离，只返回允许展示的输入和产出', async () => {
  const fake = setup();
  fake.task();
  fake.task({ external_task_id: 'other-stage', phase_tag: 'EXPERIMENTING' });
  fake.task({ external_task_id: 'other-run', run_id: 'foreign-run' });
  const response = await fake.read();
  const raw = await response.text();
  const view = JSON.parse(raw);
  assert.equal(view.tasks.length, 1);
  assert.equal(view.tasks[0].status, 'succeeded');
  assert.deepEqual(
    view.tasks[0].input.map((field: { value: unknown }) => field.value),
    ['paper-one', '真实摘要'],
  );
  assert.ok(raw.includes('方法描述'));
  assert.ok(raw.includes('一条结论'));
  assert.ok(!raw.includes('private-fixture'));
  assert.ok(!raw.includes('private-error-fixture'));
  assert.ok(!raw.includes('api_key'));
  assert.equal(view.truncated, false);
  await assert.rejects(() => fake.read('PAPER_ANALYSIS', fake.viewer, fake.db, 'foreign-run'), {
    status: 404,
  });
});

test('full 受邀读者可读，公开链接、降级读者和陌生人均不能查询任务表', async () => {
  const fake = setup();
  fake.task();
  const reviewer = {
    ...fake.viewer,
    ownerId: 'reviewer',
    grantedProjectIds: [String(fake.project.id)],
  };
  assert.equal((await fake.read('PAPER_ANALYSIS', reviewer)).status, 200);
  const guarded: Db = {
    from<T>(table: string) {
      assert.notEqual(table, 'cloud_task', '权限拒绝前不应读取任务');
      return fake.db.from<T>(table);
    },
  };
  for (const actor of [
    { ...fake.viewer, ownerId: 'stranger' },
    { ...fake.viewer, ownerId: 'limited', limitedProjectIds: [String(fake.project.id)] },
    { ...fake.viewer, ownerId: null, shareProjectId: String(fake.project.id) },
  ])
    await assert.rejects(() => fake.read('PAPER_ANALYSIS', actor, guarded), { status: 403 });
  await assert.rejects(
    () => fake.read('PAPER_ANALYSIS', { ...fake.viewer, ownerId: null }, guarded),
    { status: 404 },
  );
  fake.project.visibility = 'listed';
  await assert.rejects(
    () => fake.read('PAPER_ANALYSIS', { ...fake.viewer, ownerId: null }, guarded),
    { status: 403 },
  );
});

test('归档、未知阶段或不存在的运行不能读详情，查询失败向上抛出', async () => {
  const fake = setup();
  await assert.rejects(() => fake.read('UNKNOWN'), { status: 400 });
  await assert.rejects(() => fake.read('PAPER_ANALYSIS', fake.viewer, fake.db, 'missing'), {
    status: 404,
  });
  const failing: Db = {
    from<T>(table: string) {
      if (table === 'cloud_task') throw new Error('查询失败');
      return fake.db.from<T>(table);
    },
  };
  await assert.rejects(() => fake.read('PAPER_ANALYSIS', fake.viewer, failing), /查询失败/);
  fake.project.archived_at = '2026-11-25T01:00:00Z';
  await assert.rejects(() => fake.read(), { status: 404 });
});

test('模拟复现、基线和实验不泄露指标或验证结论，旧论文输入缺失不展示成功产出', async () => {
  const fake = setup();
  for (const kind of ['reproduce_comparison', 'validate_baseline', 'run_experiment']) {
    fake.task({
      external_task_id: kind,
      kind,
      result: {
        status: 'simulated',
        metrics: { accuracy: 0.9997 },
        validation_passed: true,
        notes: '模拟数据',
      },
    });
  }
  fake.task({ external_task_id: 'legacy', payload: null, result: { title: '缺材料的旧结果' } });
  const view = await (await fake.read()).json();
  assert.deepEqual(
    view.tasks.map((task: { status: string }) => task.status),
    ['simulated', 'simulated', 'simulated', 'input_unverified'],
  );
  assert.ok(view.tasks.every((task: { output: unknown[] }) => task.output.length === 0));
  assert.ok(!JSON.stringify(view).includes('0.9997'));
  assert.ok(!JSON.stringify(view).includes('缺材料的旧结果'));
});

test('嵌套计划可展示，缺少输出不伪造，长输入、长列表及任务数量明确截断', async () => {
  const fake = setup();
  fake.task({
    payload: { paper_text: '文'.repeat(2100) },
    result: {
      datasets: [{ name: '数据集', source: '公开数据', password: 'hidden-fixture' }],
      unknowns: Array.from({ length: 21 }, (_, i) => `问题 ${i}`),
    },
  });
  const detail = await (await fake.read()).json();
  assert.equal(detail.tasks[0].input[0].value.length, 2000);
  assert.equal(detail.tasks[0].input[0].truncated, true);
  const unknowns = detail.tasks[0].output.find(
    (field: { label: string }) => field.label === '未解决问题',
  );
  assert.equal(unknowns.value.length, 20);
  assert.equal(unknowns.truncated, true);
  assert.ok(JSON.stringify(detail).includes('公开数据'));
  assert.ok(!JSON.stringify(detail).includes('hidden-fixture'));
  for (let index = 0; index < 101; index++)
    fake.task({ external_task_id: `extra-${index}`, result: null });
  const limited = await (await fake.read()).json();
  assert.equal(limited.tasks.length, 100);
  assert.equal(limited.truncated, true);
  const empty = await (await fake.read('INIT')).json();
  assert.deepEqual(empty.tasks, []);
  assert.equal(empty.truncated, false);
});

test('阶段路由校验必需参数并使用会话身份读取', async () => {
  const fake = setup();
  fake.task();
  const handle = application({
    db: fake.db,
    BackendError: fake.BackendError,
    getUser: () => null,
    upgradeWebSocket: () => {
      throw new Error('不测试握手');
    },
  });
  const fixture = await ensureSession(fake.db, 'stage-owner');
  const authenticated = withSession(handle, async () => fixture.cookie);
  const request = (path: string) => ({
    request: new Request(`https://site.test/functions/v1/app${path}`),
    requestId: 'stage-test',
  });
  const result = await authenticated(
    request(
      '/views/stage?external_id=stage-project&external_run_id=stage-run&stage=PAPER_ANALYSIS',
    ),
  );
  assert.equal((await result.json()).tasks.length, 1);
  await assert.rejects(() => authenticated(request('/views/stage?external_id=stage-project')), {
    status: 400,
  });
  await assert.rejects(
    () =>
      handle(
        request(
          '/views/stage?external_id=stage-project&external_run_id=stage-run&stage=PAPER_ANALYSIS',
        ),
      ),
    { status: 404 },
  );
});
