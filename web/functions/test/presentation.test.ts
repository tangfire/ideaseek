import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from '../dev/fake-db.ts';
import { projectView, type Viewer } from '../views.ts';
import { CloudEngine } from '../engine/cloud-engine.ts';
import { handleStep } from '../engine/step-driver.ts';
import { executeAnalyzePaper, PaperInputRequiredError } from '../engine/task-executors.ts';
import { setApiKey } from '../engine/function-llm-adapter.ts';

function setup() {
  const fake = createFakeDb();
  const owner = fake.seed('cloud_owner', { email: 'presentation-owner' });
  const project = fake.seed('cloud_project', {
    owner_id: owner.id, external_id: 'presentation-project', title: '界面回归',
    question: '研究问题', visibility: 'private', archived_at: null,
  });
  const run = fake.seed('cloud_run', {
    project_id: project.id, external_run_id: 'presentation-run', phase_tag: 'COMPLETED',
    status: 'succeeded', started_at: '2026-11-25T00:00:00Z',
  });
  const viewer: Viewer = {
    ownerId: String(owner.id), anonymousOwnerId: null, grantedProjectIds: [],
    limitedProjectIds: [], shareProjectId: null,
  };
  return { ...fake, project, run, viewer };
}

test('模拟实验经视图后不再变成真实完成，真实指标与规模保持原样', async () => {
  const fake = setup();
  fake.seed('cloud_research_node', {
    run_id: fake.run.id, node_id: 'demo', kind: 'experiment', status: 'completed',
    detail: { status: 'simulated', metrics: { accuracy: 0.99 } },
  });
  fake.seed('cloud_research_node', {
    run_id: fake.run.id, node_id: 'real', kind: 'experiment', status: 'completed',
    detail: { scale: 'quick', metrics: { accuracy: 0.81 } },
  });
  const response = await projectView(fake.db, fake.viewer, 'presentation-project', fake.BackendError);
  const view = await response.json();
  assert.equal(view.experiments[0].status, 'simulated');
  assert.equal(view.experiments[0].metrics, null);
  assert.equal(view.experiments[0].scale, null);
  assert.equal(view.experiments[1].status, 'completed');
  assert.equal(view.experiments[1].scale, 'quick');
  assert.equal(view.experiments[1].metrics.accuracy, 0.81);
});

test('缺少论文输入时立即阻断，零模型请求、零成功论文节点', async () => {
  const fake = setup();
  const engine = new CloudEngine(fake.db, fake.BackendError);
  await engine.setRunPhase(String(fake.run.id), 'PAPER_ANALYSIS', { status: 'running' });
  await engine.enqueueTask({ runId: String(fake.run.id), kind: 'analyze_paper', phaseTag: 'PAPER_ANALYSIS', payload: { abstract: '  ' } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('不应调用模型'); };
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const result = await handleStep(fake.db, fake.BackendError, { run_id: String(fake.run.id) }, fake.viewer.ownerId!);
      assert.equal(result.action, 'blocked');
      assert.equal(result.run?.phase_tag, 'PAPER_ANALYSIS');
    }
    assert.equal(fake.rowsOf('cloud_research_node').length, 0);
    assert.equal(fake.rowsOf('cloud_cost_entry').length, 0);
    assert.equal(fake.rowsOf('cloud_stage_progress')[0].state, 'blocked');
    assert.equal(fake.rowsOf('cloud_task')[0].status, 'queued');
    assert.equal(fake.rowsOf('cloud_task')[0].attempt, 0);
    assert.equal(fake.rowsOf('cloud_task_lease').length, 0);
    assert.equal(fake.rowsOf('cloud_run_event').length, 1);
    const view = await (await projectView(fake.db, fake.viewer, 'presentation-project', fake.BackendError)).json();
    assert.equal(view.runs[0].block_detail.kind, 'USER_INPUT_REQUIRED');
    assert.match(view.runs[0].block_detail.message, /正文或摘要/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('历史无来源论文不再显示成功，已记录输入的论文保留成功状态', async () => {
  const fake = setup();
  fake.seed('cloud_research_node', { run_id: fake.run.id, node_id: 'old-paper', kind: 'paper_analysis', status: 'succeeded', detail: {} });
  fake.seed('cloud_research_node', { run_id: fake.run.id, node_id: 'new-paper', kind: 'paper_analysis', status: 'succeeded', detail: { input_source: 'abstract' } });
  fake.seed('cloud_research_node', { run_id: fake.run.id, node_id: 'failed-paper', kind: 'paper_analysis', status: 'failed', detail: {} });
  fake.seed('cloud_stage_progress', { run_id: fake.run.id, stage: 'PAPER_ANALYSIS', state: 'passed', stage_known: true });
  const view = await (await projectView(fake.db, fake.viewer, 'presentation-project', fake.BackendError)).json();
  assert.equal(view.papers[0].parse_status, 'input_unverified');
  assert.equal(view.papers[1].parse_status, 'succeeded');
  assert.equal(view.papers[2].parse_status, 'failed');
  assert.equal(view.stages[0].state, 'blocked');
});

test('空白、缺失和非字符串输入直接拒绝，研究问题不会充当论文内容', async () => {
  const fake = setup();
  const engine = new CloudEngine(fake.db, fake.BackendError);
  const run = await engine.getRun(String(fake.run.id));
  assert.ok(run);
  const payloads = [null, {}, { paper_text: '' }, { paper_text: ' \n ', abstract: '\t' }, { abstract: 123 }];
  for (const [index, payload] of payloads.entries()) {
    const { task } = await engine.enqueueTask({ runId: run.id, kind: 'analyze_paper', phaseTag: 'PAPER_ANALYSIS', externalTaskId: `missing-${index}` });
    task.payload = payload;
    await assert.rejects(executeAnalyzePaper({ engine, run, task }), PaperInputRequiredError);
  }
  assert.equal(fake.rowsOf('cloud_research_node').length, 0);
  assert.equal(fake.rowsOf('cloud_cost_entry').length, 0);
});

for (const source of ['text', 'abstract'] as const) {
  test(`补充${source}后可恢复并通过论文阶段，不重跑已完成任务`, async () => {
    const fake = setup();
    const engine = new CloudEngine(fake.db, fake.BackendError);
    await engine.setRunPhase(String(fake.run.id), 'PAPER_ANALYSIS', { status: 'running' });
    const { task } = await engine.enqueueTask({ runId: String(fake.run.id), kind: 'analyze_paper', phaseTag: 'PAPER_ANALYSIS', payload: {} });
    const request = { run_id: String(fake.run.id) };
    const driver = fake.viewer.ownerId!;
    assert.equal((await handleStep(fake.db, fake.BackendError, request, driver)).action, 'blocked');
    const content = 'A supplied paper describes an evaluated method.';
    await fake.db.from('cloud_task').update({ payload: source === 'text' ? { paper_text: content } : { paper_text: '  ', abstract: content } }).eq('id', task.id);
    const originalFetch = globalThis.fetch;
    let calls = 0;
    setApiKey('presentation-test');
    globalThis.fetch = async (_url, init) => {
      calls++;
      assert.ok(String(init?.body).includes(content));
      return Response.json({
        choices: [{ message: { content: JSON.stringify({ title: 'Supplied paper', problem: 'Question', method_summary: 'Method', claims: [], unknowns: [], keywords: [] }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 50 }, model: 'test-model',
      });
    };
    try {
      const result = await handleStep(fake.db, fake.BackendError, request, driver);
      assert.equal(result.action, 'claimed');
      assert.equal(result.task?.status, 'succeeded');
      assert.equal(result.run?.status, 'running');
      assert.equal(result.run?.block_reason, null);
      assert.equal(fake.rowsOf('cloud_task')[0].attempt, 1);
      assert.equal(fake.rowsOf('cloud_research_node')[0].detail.input_source, source);
      assert.equal(fake.rowsOf('cloud_stage_progress')[0].blocker_code, null);
      const next = await handleStep(fake.db, fake.BackendError, request, driver);
      assert.equal(next.newPhase, 'DATA_READY');
      assert.equal(calls, 1);
      const view = await (await projectView(fake.db, fake.viewer, 'presentation-project', fake.BackendError)).json();
      assert.equal(view.papers[0].parse_status, 'succeeded');
      assert.equal(view.stages.find((stage: { stage: string }) => stage.stage === 'PAPER_ANALYSIS').state, 'passed');
      assert.equal(view.runs[0].block_detail, undefined);
    } finally {
      globalThis.fetch = originalFetch;
      setApiKey('');
    }
  });
}

test('非拥有者不能触发论文检查或更改运行状态', async () => {
  const fake = setup();
  const engine = new CloudEngine(fake.db, fake.BackendError);
  await engine.setRunPhase(String(fake.run.id), 'PAPER_ANALYSIS', { status: 'running' });
  await engine.enqueueTask({ runId: String(fake.run.id), kind: 'analyze_paper', phaseTag: 'PAPER_ANALYSIS', payload: {} });
  const result = await handleStep(fake.db, fake.BackendError, { run_id: String(fake.run.id) }, 'another-owner');
  assert.equal(result.action, 'idle');
  assert.equal(fake.rowsOf('cloud_run')[0].status, 'running');
  assert.equal(fake.rowsOf('cloud_stage_progress').length, 0);
  assert.equal(fake.rowsOf('cloud_run_event').length, 0);
});

test('论文阶段没有分析任务时不能空跑通过', async () => {
  const fake = setup();
  const engine = new CloudEngine(fake.db, fake.BackendError);
  await engine.setRunPhase(String(fake.run.id), 'PAPER_ANALYSIS', { status: 'running' });
  const result = await handleStep(fake.db, fake.BackendError, { run_id: String(fake.run.id) }, fake.viewer.ownerId!);
  assert.equal(result.action, 'blocked');
  assert.equal(result.run?.phase_tag, 'PAPER_ANALYSIS');
  assert.equal(fake.rowsOf('cloud_stage_progress')[0].state, 'blocked');
});

test('论文正在执行时不能提前把阶段标成通过', async () => {
  const fake = setup();
  const engine = new CloudEngine(fake.db, fake.BackendError);
  await engine.setRunPhase(String(fake.run.id), 'PAPER_ANALYSIS', { status: 'running' });
  await engine.enqueueTask({ runId: String(fake.run.id), kind: 'analyze_paper', phaseTag: 'PAPER_ANALYSIS', payload: { abstract: 'Supplied abstract' } });
  assert.ok(await engine.claimNextTask(String(fake.run.id), 'another-worker'));
  const result = await handleStep(fake.db, fake.BackendError, { run_id: String(fake.run.id) }, fake.viewer.ownerId!);
  assert.equal(result.action, 'idle');
  assert.equal(result.run?.phase_tag, 'PAPER_ANALYSIS');
  assert.equal(fake.rowsOf('cloud_stage_progress').length, 0);
});
