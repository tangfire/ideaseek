import test from 'node:test';
import assert from 'node:assert/strict';
import { experimentEvidence } from '../experiment-presentation.ts';
import { projectView, type Viewer } from '../views.ts';
import { createFakeDb } from '../dev/fake-db.ts';

function complete() {
  return {
    spec: {
      specId: 'spec-one',
      codeCommit: 'recorded-commit',
      dataSnapshotId: 'data-one',
      sliceIds: ['slice-quick-one'],
      protocolId: 'protocol-one',
      seeds: [0, 7],
      metrics: [
        { name: 'accuracy', direction: 'higher' },
        { name: 'loss', direction: 'lower' },
      ],
    },
    result: {
      specId: 'spec-one',
      status: 'succeeded',
      metrics: [
        { name: 'accuracy', value: 0.812345678, stdev: 0, n: 2 },
        { name: 'loss', value: 0.2 },
      ],
      baselines: [
        { methodId: 'control-one', metric: 'accuracy', value: 0.8, stdev: 0.01 },
        { methodId: 'control-two', metric: 'accuracy', value: 0 },
        { methodId: 'control-one', metric: 'loss', value: 0.4 },
      ],
      logRefs: ['private-log-sentinel'],
      artifactRefs: ['private-artifact-sentinel'],
    },
  };
}

test('结构化结果按指标方向与同次运行对照投影，保留精度、零值及统计信息', () => {
  const output = experimentEvidence(complete(), 'workflow-one', 'completed');
  assert.equal(output.status, 'succeeded');
  assert.equal(output.context?.workflow_run_id, 'workflow-one');
  assert.deepEqual(output.context?.seeds, [0, 7]);
  assert.equal(output.metric_rows[0].value, 0.812345678);
  assert.equal(output.metric_rows[0].stdev, 0);
  assert.equal(output.metric_rows[0].n, 2);
  assert.equal(output.metric_rows[0].direction, 'higher');
  assert.equal(output.metric_rows[0].controls.length, 2);
  assert.equal(output.metric_rows[0].controls[0].delta, 0.812345678 - 0.8);
  assert.equal(output.metric_rows[0].controls[1].value, 0);
  assert.equal(output.metric_rows[1].direction, 'lower');
  assert.equal(output.metric_rows[1].controls[0].delta, -0.2);
  assert.ok(!JSON.stringify(output).includes('private-log-sentinel'));
  assert.ok(!JSON.stringify(output).includes('private-artifact-sentinel'));
});

test('旧记录没有推测方向、补造基线或默认复现来源', () => {
  const output = experimentEvidence(
    { metrics: { error: 0, score: 1e-12 } },
    'workflow-old',
    'completed',
  );
  assert.equal(output.context?.kind, 'legacy');
  assert.equal(output.context?.data_snapshot_id, null);
  assert.equal(output.context?.seeds, null);
  assert.equal(output.metric_rows[0].value, 0);
  assert.equal(output.metric_rows[1].value, 1e-12);
  assert.equal(output.metric_rows[0].direction, null);
  assert.deepEqual(output.metric_rows[0].controls, []);
  assert.equal(experimentEvidence(null, 'empty', 'completed').metrics, null);
});

test('数据、代码、切片、协议、种子、规格或方向不完整及失败结果不计算差值', () => {
  for (const field of [
    'specId',
    'codeCommit',
    'dataSnapshotId',
    'sliceIds',
    'protocolId',
    'seeds',
    'metrics',
  ]) {
    const data = complete();
    delete (data.spec as Record<string, unknown>)[field];
    const output = experimentEvidence(data, 'workflow-one', 'completed');
    assert.equal(output.metric_rows[0].controls[0].delta, null, field);
  }
  for (const status of ['failed', 'partial', 'invalid']) {
    const data = complete();
    data.result.status = status;
    const output = experimentEvidence(data, 'workflow-one', 'completed');
    assert.equal(output.status, status);
    assert.equal(output.metric_rows[0].controls[0].delta, null);
  }
  const data = complete();
  data.result.baselines = [];
  assert.deepEqual(
    experimentEvidence(data, 'workflow-one', 'completed').metric_rows[0].controls,
    [],
  );
});

test('模拟、合成和占位数据不投影指标、对照或运行来源', () => {
  for (const data of [
    { ...complete(), status: 'simulated' },
    { ...complete(), is_synthetic: true },
    { result: { ...complete().result, status: 'simulated' } },
    { result: { ...complete().result, is_synthetic: true } },
    {
      result: {
        ...complete().result,
        metrics: [{ name: 'accuracy', value: 0.9997, is_synthetic: true }],
      },
    },
    {
      result: {
        ...complete().result,
        baselines: [{ methodId: 'fake', metric: 'accuracy', value: 0.9997, is_synthetic: true }],
      },
    },
  ]) {
    const output = experimentEvidence(data, 'workflow-one', 'completed');
    assert.equal(output.status, 'simulated');
    assert.equal(output.metrics, null);
    assert.deepEqual(output.metric_rows, []);
    assert.equal(output.context, null);
  }
});

test('格式错误、非有限数值、重复指标和规格错配抛错，不用默认值掩盖', () => {
  for (const value of [NaN, Infinity, '0.8', null, false]) {
    assert.throws(
      () => experimentEvidence({ metrics: { accuracy: value } }, 'workflow', 'completed'),
      /有限数值/,
    );
  }
  const mismatch = complete();
  mismatch.result.specId = 'other';
  assert.throws(() => experimentEvidence(mismatch, 'workflow', 'completed'), /不匹配/);
  const invalidN = complete();
  invalidN.result.metrics[0].n = 0;
  assert.throws(() => experimentEvidence(invalidN, 'workflow', 'completed'), /重复次数/);
  const duplicate = complete();
  duplicate.result.metrics.push(duplicate.result.metrics[0]);
  assert.throws(() => experimentEvidence(duplicate, 'workflow', 'completed'), /指标重复/);
  const duplicateControl = complete();
  duplicateControl.result.baselines.push(duplicateControl.result.baselines[0]);
  assert.throws(
    () => experimentEvidence(duplicateControl, 'workflow', 'completed'),
    /对照指标重复/,
  );
});

test('仅交付运行材料不提供实验指标或对照', () => {
  const output = experimentEvidence(
    { ...complete(), scale: 'handoff_manifest' },
    'workflow',
    'completed',
  );
  assert.equal(output.metrics, null);
  assert.deepEqual(output.metric_rows, []);
  assert.equal(output.context?.code_commit, 'recorded-commit');
});

test('项目视图只读取当前运行的来源，对照不跨运行混入且不提供给 L2', async () => {
  const fake = createFakeDb();
  const owner = fake.seed('cloud_owner', { email: 'metric-owner' });
  const project = fake.seed('cloud_project', {
    owner_id: owner.id,
    external_id: 'metric-project',
    title: '指标项目',
    visibility: 'listed',
    archived_at: null,
  });
  const run = fake.seed('cloud_run', {
    project_id: project.id,
    external_run_id: 'metric-workflow',
    started_at: '2026-11-25T00:00:00Z',
    phase_tag: 'COMPLETED',
    status: 'succeeded',
  });
  fake.seed('cloud_research_node', {
    run_id: run.id,
    node_id: 'experiment-one',
    kind: 'experiment',
    title: '实验全名',
    status: 'completed',
    detail: complete(),
  });
  fake.seed('cloud_research_node', {
    run_id: 'foreign-run',
    node_id: 'foreign-experiment',
    kind: 'experiment',
    status: 'completed',
    detail: complete(),
  });
  const viewer: Viewer = {
    ownerId: String(owner.id),
    anonymousOwnerId: null,
    grantedProjectIds: [],
    limitedProjectIds: [],
    shareProjectId: null,
  };
  const view = await (
    await projectView(fake.db, viewer, 'metric-project', fake.BackendError)
  ).json();
  assert.equal(view.experiments.length, 1);
  assert.equal(view.experiments[0].title, '实验全名');
  assert.equal(view.experiments[0].context.workflow_run_id, 'metric-workflow');
  assert.equal(view.experiments[0].metric_rows[0].value, 0.812345678);
  const limited = await (
    await projectView(fake.db, { ...viewer, ownerId: null }, 'metric-project', fake.BackendError)
  ).json();
  assert.equal(limited.experiments, undefined);
  assert.ok(!JSON.stringify(limited).includes('recorded-commit'));
});
