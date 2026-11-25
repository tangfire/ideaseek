import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from '../dev/fake-db.ts';
import { resourceView } from '../resources.ts';
import type { Db } from '../deps.ts';
import type { Viewer } from '../views.ts';
import { application } from '../routes.ts';
import { ensureSession, withSession } from '../dev/test-session.ts';

function setup() {
  const fake = createFakeDb();
  const owner = fake.seed('cloud_owner', { email: 'resource-owner' });
  const project = fake.seed('cloud_project', {
    external_id: 'resources',
    title: '材料项目',
    owner_id: owner.id,
    visibility: 'private',
    archived_at: null,
  });
  const run = fake.seed('cloud_run', { project_id: project.id, external_run_id: 'run-resources' });
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
      external_task_id: 'paper-task',
      phase_tag: 'PAPER_ANALYSIS',
      kind: 'analyze_paper',
      status: 'succeeded',
      attempt: 1,
      max_attempts: 3,
      started_at: null,
      ended_at: null,
      created_at: '2026-11-25T00:00:00Z',
      payload: {
        paper_id: 'paper-one',
        abstract: '已保存摘要',
        private_field: 'private-input-sentinel',
      },
      result: {
        title: '已分析论文',
        method_summary: '产出摘要',
        raw_log: 'private-output-sentinel',
      },
      ...patch,
    });
  const artifact = (patch: Record<string, unknown> = {}) =>
    fake.seed('cloud_artifact_ref', {
      run_id: run.id,
      external_artifact_id: 'artifact-one',
      external_task_id: 'paper-task',
      kind: 'report',
      status: 'committed',
      content_hash: `sha256:${'a'.repeat(64)}`,
      size_bytes: 0,
      committed_at: '2026-11-25T00:00:00Z',
      path_hint: 'private-path-sentinel',
      download_url: 'https://private-url-sentinel.invalid',
      ...patch,
    });
  const read = (actor = viewer, db = fake.db, runId = 'run-resources') =>
    resourceView(db, actor, 'resources', runId, fake.BackendError);
  return { ...fake, owner, project, run, viewer, task, artifact, read };
}

test('材料与成果只取指定项目运行，白名单投影输入产出与文件引用，零大小保留', async () => {
  const fake = setup();
  fake.task();
  fake.artifact();
  fake.task({ external_task_id: 'foreign-task', run_id: 'foreign-run' });
  fake.artifact({ external_artifact_id: 'foreign-artifact', run_id: 'foreign-run' });
  const raw = await (await fake.read()).text();
  const data = JSON.parse(raw);
  assert.equal(data.external_run_id, 'run-resources');
  assert.equal(data.tasks.length, 1);
  assert.equal(data.tasks[0].stage, 'PAPER_ANALYSIS');
  assert.ok(raw.includes('已保存摘要'));
  assert.ok(raw.includes('产出摘要'));
  assert.equal(data.artifacts.length, 1);
  assert.equal(data.artifacts[0].size_bytes, 0);
  for (const sentinel of [
    'private-input-sentinel',
    'private-output-sentinel',
    'private-path-sentinel',
    'private-url-sentinel',
    'foreign-task',
    'foreign-artifact',
  ])
    assert.ok(!raw.includes(sentinel));
  assert.equal(data.tasks_truncated, false);
  assert.equal(data.artifacts_truncated, false);
  await assert.rejects(() => fake.read(fake.viewer, fake.db, 'foreign-run'), { status: 404 });
});

test('沿用 full 读取权限，L2、分享链接、陌生人与归档项目在读材料前拒绝', async () => {
  const fake = setup();
  const guarded: Db = {
    from<T>(table: string) {
      assert.ok(!['cloud_task', 'cloud_artifact_ref'].includes(table));
      return fake.db.from<T>(table);
    },
  };
  assert.equal(
    (
      await fake.read({
        ...fake.viewer,
        ownerId: 'reviewer',
        grantedProjectIds: [String(fake.project.id)],
      })
    ).status,
    200,
  );
  for (const actor of [
    { ...fake.viewer, ownerId: 'stranger' },
    { ...fake.viewer, ownerId: 'limited', limitedProjectIds: [String(fake.project.id)] },
    { ...fake.viewer, ownerId: null, shareProjectId: String(fake.project.id) },
  ])
    await assert.rejects(() => fake.read(actor, guarded), { status: 403 });
  await assert.rejects(() => fake.read({ ...fake.viewer, ownerId: null }, guarded), {
    status: 404,
  });
  fake.project.visibility = 'listed';
  await assert.rejects(() => fake.read({ ...fake.viewer, ownerId: null }, guarded), {
    status: 403,
  });
  fake.project.archived_at = '2026-11-25T00:00:00Z';
  await assert.rejects(() => fake.read(fake.viewer, guarded), { status: 404 });
});

test('缺材料、模拟、暂存与中止记录不伪装已交付成果，数量与内容截断明确', async () => {
  const fake = setup();
  fake.task({ payload: null });
  fake.task({
    external_task_id: 'simulated',
    kind: 'run_experiment',
    result: { status: 'simulated', metrics: { score: 0.9997 } },
  });
  fake.task({ external_task_id: 'long', payload: { paper_text: '文'.repeat(2100) } });
  fake.artifact({ status: 'staged' });
  fake.artifact({ external_artifact_id: 'aborted', status: 'aborted' });
  const data = await (await fake.read()).json();
  assert.equal(data.tasks[0].status, 'input_unverified');
  assert.deepEqual(data.tasks[0].output, []);
  assert.equal(data.tasks[1].simulated, true);
  assert.deepEqual(data.tasks[1].output, []);
  assert.equal(data.tasks[2].input[0].truncated, true);
  assert.deepEqual(
    data.artifacts.map((item: { status: string }) => item.status),
    ['staged', 'aborted'],
  );
  assert.ok(!JSON.stringify(data).includes('0.9997'));
  for (let i = 0; i < 101; i++) {
    fake.task({ external_task_id: `extra-${i}` });
    fake.artifact({ external_artifact_id: `extra-${i}` });
  }
  const limited = await (await fake.read()).json();
  assert.equal(limited.tasks.length, 100);
  assert.equal(limited.tasks_truncated, true);
  assert.equal(limited.artifacts.length, 100);
  assert.equal(limited.artifacts_truncated, true);
});

test('查询失败向上抛出，不把服务故障显示成没有材料', async () => {
  const fake = setup();
  const empty = await (await fake.read()).json();
  assert.deepEqual(empty.tasks, []);
  assert.deepEqual(empty.artifacts, []);
  for (const target of ['cloud_task', 'cloud_artifact_ref']) {
    const failing: Db = {
      from<T>(table: string) {
        if (table === target) throw new Error('读取失败');
        return fake.db.from<T>(table);
      },
    };
    await assert.rejects(() => fake.read(fake.viewer, failing), /读取失败/);
  }
});

test('材料路由使用会话身份且必需项目与运行参数，不接受写操作', async () => {
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
  const fixture = await ensureSession(fake.db, 'resource-owner');
  const authenticated = withSession(handle, async () => fixture.cookie);
  const request = (path: string, method = 'GET') => ({
    request: new Request(`https://site.test/functions/v1/app${path}`, { method }),
    requestId: 'resources-test',
  });
  assert.equal(
    (
      await authenticated(
        request('/views/resources?external_id=resources&external_run_id=run-resources'),
      )
    ).status,
    200,
  );
  await assert.rejects(() => authenticated(request('/views/resources?external_id=resources')), {
    status: 400,
  });
  await assert.rejects(
    () => handle(request('/views/resources?external_id=resources&external_run_id=run-resources')),
    { status: 404 },
  );
  await assert.rejects(() => authenticated(request('/views/resources', 'POST')), { status: 404 });
});
