import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from '../dev/fake-db.ts';
import { projectView, type Viewer } from '../views.ts';
import { CloudEngine } from '../engine/cloud-engine.ts';
import { executeGenerateIdea } from '../engine/task-executors.ts';
import { setApiKey } from '../engine/function-llm-adapter.ts';

function setup() {
  const fake = createFakeDb();
  const owner = fake.seed('cloud_owner', { email: 'provenance-owner' });
  const project = fake.seed('cloud_project', {
    owner_id: owner.id,
    external_id: 'provenance-project',
    title: '来源测试',
    visibility: 'private',
    archived_at: null,
  });
  const run = fake.seed('cloud_run', {
    project_id: project.id,
    external_run_id: 'provenance-run',
    phase_tag: 'IDEA_GENERATION',
    status: 'running',
    started_at: '2026-11-25T00:00:00Z',
    question: '研究问题',
  });
  const viewer: Viewer = {
    ownerId: String(owner.id),
    anonymousOwnerId: null,
    grantedProjectIds: [],
    limitedProjectIds: [],
    shareProjectId: null,
  };
  const node = (
    nodeId: string,
    kind: string,
    detail: Record<string, unknown> | null,
    patch: Record<string, unknown> = {},
  ) =>
    fake.seed('cloud_research_node', {
      run_id: run.id,
      node_id: nodeId,
      kind,
      status: 'succeeded',
      title: `标题 ${nodeId}`,
      detail,
      ...patch,
    });
  const read = async (actor = viewer) =>
    (await projectView(fake.db, actor, 'provenance-project', fake.BackendError)).json();
  return { ...fake, project, run, viewer, node, read };
}

test('来源只按本次运行的明确编号匹配，支持节点和原始论文编号，不按顺序或标题猜测', async () => {
  const fake = setup();
  fake.node('paper-node-a', 'paper_analysis', { paper_id: 'original-a', input_source: 'abstract' });
  fake.node('paper-node-b', 'paper_analysis', { paper_id: 'original-b', input_source: 'text' });
  fake.node(
    'foreign-paper',
    'paper_analysis',
    { paper_id: 'foreign-original', input_source: 'text' },
    { run_id: 'other-run' },
  );
  fake.node('idea-a', 'idea', {
    references_paper_ids: [
      'original-b',
      'paper-node-a',
      'original-b',
      'foreign-original',
      'invented-id',
    ],
  });
  fake.node('idea-b', 'idea', { context_paper_ids: ['original-a'] });
  fake.node('idea-c', 'idea', { references_paper_ids: [] });
  fake.node('experiment-a', 'experiment', {
    idea_id: 'idea-a',
    status: 'simulated',
    metrics: { accuracy: 0.9997 },
  });
  fake.node('experiment-no-source', 'experiment', {});
  const view = await fake.read();
  assert.deepEqual(
    view.ideas[0].paper_sources.map((source: { paper_id: string | null }) => source.paper_id),
    ['paper-node-b', 'paper-node-a', null, null],
  );
  assert.deepEqual(
    view.ideas[0].paper_sources.map((source: { status: string }) => source.status),
    ['linked', 'linked', 'missing', 'missing'],
  );
  assert.equal(view.ideas[1].paper_sources, null, '供模型参考不等于模型记录引用');
  assert.deepEqual(view.ideas[2].paper_sources, []);
  assert.equal(view.experiments[0].idea_id, 'idea-a');
  assert.equal(view.experiments[0].status, 'simulated');
  assert.equal(view.experiments[0].metrics, null);
  assert.equal(view.experiments[1].idea_id, null);
});

test('歧义、未核验及格式错误引用明确区分，既有数据不被修改', async () => {
  const fake = setup();
  fake.node('paper-one', 'paper_analysis', { paper_id: 'duplicate', input_source: 'text' });
  fake.node('paper-two', 'paper_analysis', { paper_id: 'duplicate', input_source: 'text' });
  fake.node('legacy', 'paper_analysis', { paper_id: 'legacy-original' });
  fake.node(
    'failed-paper',
    'paper_analysis',
    { paper_id: 'failed', input_source: 'text' },
    { status: 'failed' },
  );
  fake.node('idea', 'idea', { references_paper_ids: ['duplicate', 'legacy-original', 'failed'] });
  for (const [index, references] of [null, 'paper-one', [42], [' ']].entries()) {
    fake.node(`malformed-${index}`, 'idea', { references_paper_ids: references });
  }
  fake.node('numeric-experiment', 'experiment', { idea_id: 42 });
  const snapshot = JSON.stringify(fake.rowsOf('cloud_research_node'));
  const view = await fake.read();
  assert.deepEqual(
    view.ideas[0].paper_sources.map((source: { status: string }) => source.status),
    ['ambiguous', 'unverified', 'unverified'],
  );
  assert.equal(view.ideas[0].paper_sources[0].paper_id, null);
  assert.ok(
    view.ideas.slice(1).every((idea: { paper_sources: unknown }) => idea.paper_sources === null),
  );
  assert.equal(view.experiments[0].idea_id, null);
  assert.equal(JSON.stringify(fake.rowsOf('cloud_research_node')), snapshot);
});

test('来源字段沿用 full 权限，公开及被邀降级读者不获得研究节点或来源编号', async () => {
  const fake = setup();
  fake.project.visibility = 'listed';
  fake.node('private-paper-sentinel', 'paper_analysis', {
    paper_id: 'private-source-sentinel',
    input_source: 'text',
  });
  fake.node('private-idea-sentinel', 'idea', { references_paper_ids: ['private-source-sentinel'] });
  const reviewer = {
    ...fake.viewer,
    ownerId: 'reviewer',
    grantedProjectIds: [String(fake.project.id)],
  };
  assert.equal(
    (await fake.read(reviewer)).ideas[0].paper_sources[0].paper_id,
    'private-paper-sentinel',
  );
  for (const actor of [
    { ...fake.viewer, ownerId: null },
    { ...fake.viewer, ownerId: 'limited', limitedProjectIds: [String(fake.project.id)] },
    { ...fake.viewer, ownerId: null, shareProjectId: String(fake.project.id) },
  ]) {
    const view = await fake.read(actor);
    assert.equal(view.ideas, undefined);
    assert.equal(view.papers, undefined);
    assert.equal(view.experiments, undefined);
    assert.ok(!JSON.stringify(view).includes('private-source-sentinel'));
  }
});

test('想法生成把论文编号交给模型，仅保存模型选择的有效引用，分开记录参考上下文', async () => {
  const fake = setup();
  const engine = new CloudEngine(fake.db, fake.BackendError);
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
    await engine.enqueueTask({
      runId: String(fake.run.id),
      externalTaskId: `task-${id}`,
      kind: 'analyze_paper',
      phaseTag: 'PAPER_ANALYSIS',
    });
    await fake.db
      .from('cloud_task')
      .update({ status: 'succeeded', result: { paper_id: `paper-${id}`, title: `论文 ${id}` } })
      .eq('external_task_id', `task-${id}`);
  }
  const { task } = await engine.enqueueTask({
    runId: String(fake.run.id),
    externalTaskId: 'task-idea',
    kind: 'generate_idea',
    phaseTag: 'IDEA_GENERATION',
  });
  const run = await engine.getRun(String(fake.run.id));
  assert.ok(run);
  const previous = globalThis.fetch;
  setApiKey('provenance-test');
  let references: unknown = ['paper-b', 'paper-b'];
  globalThis.fetch = async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[1].content;
    assert.ok(prompt.includes('Paper ID: paper-a'));
    assert.ok(prompt.includes('Paper ID: paper-b'));
    assert.ok(!prompt.includes('Paper ID: paper-f'), '参考上下文仅包含实际传入的前五篇论文');
    return Response.json({
      choices: [
        {
          message: { content: JSON.stringify({ title: '想法', references_paper_ids: references }) },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 40 },
      model: 'mock',
    });
  };
  try {
    const result = await executeGenerateIdea({ engine, run, task });
    assert.deepEqual(result.references_paper_ids, ['paper-b']);
    assert.deepEqual(result.context_paper_ids, [
      'paper-a',
      'paper-b',
      'paper-c',
      'paper-d',
      'paper-e',
    ]);
    assert.deepEqual(fake.rowsOf('cloud_research_node')[0].detail.references_paper_ids, [
      'paper-b',
    ]);
    const count = fake.rowsOf('cloud_research_node').length;
    for (references of [undefined, 'paper-a', [42], ['invented'], [' '], ['paper-f']]) {
      await assert.rejects(() => executeGenerateIdea({ engine, run, task }), /来源论文编号/);
      assert.equal(fake.rowsOf('cloud_research_node').length, count, '无效引用不能写入想法节点');
    }
    assert.equal(fake.rowsOf('cloud_cost_entry').length, 7, '模型调用后引用校验失败也要记录费用');
    references = [];
    const noCitation = await executeGenerateIdea({ engine, run, task });
    assert.deepEqual(noCitation.references_paper_ids, []);
    assert.deepEqual(noCitation.context_paper_ids, [
      'paper-a',
      'paper-b',
      'paper-c',
      'paper-d',
      'paper-e',
    ]);
  } finally {
    globalThis.fetch = previous;
    setApiKey('');
  }
});
