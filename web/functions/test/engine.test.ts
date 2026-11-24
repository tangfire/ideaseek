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
import { setApiKey } from '../engine/function-llm-adapter.ts';

function mockLlmFetch() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes('moyu.cn') || urlStr.includes('deepseek.com')) {
      const body = JSON.parse(init?.body as string ?? '{}');
      const schemaMatch = body?.messages?.[1]?.content?.match(/Schema:\s*(\S+)/);
      const schema = schemaMatch?.[1] ?? 'unknown';

      let mockOutput: Record<string, unknown>;
      if (schema.startsWith('papercard')) {
        mockOutput = {
          title: 'Mock Paper Title',
          problem: 'Mock research problem',
          method_summary: 'Mock method description',
          claims: [{ text: 'Mock claim 1', confidence: 'high', evidence_type: 'empirical' }],
          unknowns: ['Mock limitation 1'],
          keywords: ['mock', 'test'],
        };
      } else if (schema.startsWith('idea')) {
        mockOutput = {
          title: 'Mock Research Idea',
          hypothesis: 'Mock testable hypothesis',
          mechanism_summary: 'Mock mechanism',
          motivation: 'Mock motivation',
          feasibility: 'medium',
          novelty_claim: 'Mock novelty',
          suggested_experiments: [{ name: 'exp1', purpose: 'validate', expected_outcome: 'positive' }],
          references_paper_ids: [],
        };
      } else if (schema.startsWith('calibration')) {
        mockOutput = { feasible: true, strategy: 'standard', estimated_papers: 3, notes: 'Mock calibration' };
      } else {
        mockOutput = { status: 'ok' };
      }

      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(mockOutput) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
        model: 'deepseek-chat-mock',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(url, init);
  }) as typeof fetch;

  return () => { globalThis.fetch = originalFetch; };
}

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

test('claimNextTask 读回确认：insertIfAbsent 成功但不返回行时仍能认领（线上实测行为）', async () => {
  const { fake, run } = setup();

  // 模拟受管 SDK：lease 插入成功，但 await 结果 data 为空。
  const origFrom = fake.db.from.bind(fake.db);
  const silentDb = {
    from: (name: string) => {
      const q = origFrom(name) as unknown as Record<string, (...a: unknown[]) => unknown>;
      if (name !== 'cloud_task_lease') return q;
      const orig = q.insertIfAbsent.bind(q);
      q.insertIfAbsent = (...args: unknown[]) => {
        const result = orig(...args);
        const chain = {
          select: () => chain,
          then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
            Promise.resolve(result).then(() => resolve({ data: null, error: null }), reject),
        };
        return chain;
      };
      return q;
    },
  } as unknown as typeof fake.db;

  const engine = new CloudEngine(silentDb, fake.BackendError);
  const { task } = await engine.enqueueTask({
    runId: run.id,
    kind: 'analyze_paper',
    phaseTag: 'PAPER_ANALYSIS',
    externalTaskId: 'task-silent-lease',
  });

  // 别人的 lease 在先：读回归属不是自己，必须放弃认领。
  fake.seed('cloud_task_lease', {
    task_id: task.id,
    worker_id: 'worker-B',
    lease_epoch: 1,
    leased_at: '2026-11-23T00:00:00.000Z',
    expires_at: '2026-11-23T00:05:00.000Z',
  });
  assert.equal(await engine.claimNextTask(run.id, 'worker-A'), null, 'lease 属于别人时不得认领');
  await origFrom('cloud_task_lease').delete().eq('task_id', task.id);

  const claim = await engine.claimNextTask(run.id, 'worker-A');
  assert.ok(claim, '插入成功但无返回行时，读回确认归属后必须认领成功');
  assert.equal(claim.task.status, 'claimed');
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
  const { fake, engine, owner, run } = setup();
  setApiKey('test-key-for-mock');
  const restore = mockLlmFetch();

  try {
    await engine.enqueueTask({
      runId: run.id,
      kind: 'analyze_paper',
      phaseTag: 'PAPER_ANALYSIS',
      externalTaskId: 'task-step-1',
      payload: { paper_id: 'paper-1' },
    });

    const result = await handleStep(fake.db, fake.BackendError, { run_id: run.id }, owner.id);

    assert.equal(result.action, 'claimed');
    assert.ok(result.task);
    assert.equal(result.task.status, 'succeeded');
    assert.ok(result.events);
    assert.ok(result.events.length >= 2, '至少有 task_started + task_completed');
  } finally {
    restore();
  }
});

test('handleStep idle：无 queued 任务时尝试推进阶段', async () => {
  const { fake, owner, run } = setup();

  const result = await handleStep(fake.db, fake.BackendError, { run_id: run.id }, owner.id);

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

test('callLlm 缺 API key 抛错', async () => {
  const { callLlm } = await import('../engine/function-llm-adapter.ts');
  setApiKey('');
  await assert.rejects(
    () => callLlm({ instruction: 'test', inputs: [], outputSchema: 'test' }),
    (err: Error) => {
      assert.ok(err.message.includes('DEEPSEEK_API_KEY'));
      return true;
    },
  );
});

test('callLlm 正常返回解析 JSON', async () => {
  const { callLlm } = await import('../engine/function-llm-adapter.ts');
  setApiKey('test-key');
  const restore = mockLlmFetch();

  try {
    const result = await callLlm({
      instruction: 'Analyze this paper',
      inputs: [{ name: 'Paper', content: 'Test paper content' }],
      outputSchema: 'papercard-v1: {"title": "string"}',
    });

    assert.ok(result.parsed, '应该解析出 JSON');
    assert.equal(result.parsed.title, 'Mock Paper Title');
    assert.equal(result.model, 'deepseek-chat-mock');
    assert.equal(result.usage.inputTokens, 100);
  } finally {
    restore();
  }
});

test('handleStep idea 生成：从 queued 到 research node', async () => {
  const { fake, engine, owner, run } = setup();
  setApiKey('test-key');
  const restore = mockLlmFetch();

  try {
    await engine.setRunPhase(run.id, 'IDEA_GENERATION', { status: 'running' });

    await engine.enqueueTask({
      runId: run.id,
      kind: 'generate_idea',
      phaseTag: 'IDEA_GENERATION',
      externalTaskId: 'task-idea-1',
    });

    const result = await handleStep(fake.db, fake.BackendError, { run_id: run.id }, owner.id);

    assert.equal(result.action, 'claimed');
    assert.ok(result.task);
    assert.equal(result.task.status, 'succeeded');

    const events = await engine.listEvents(run.id);
    const ideaEvent = events.find((e) => e.type === 'idea_generated');
    assert.ok(ideaEvent, '应该有 idea_generated 事件');
  } finally {
    restore();
  }
});

test('handleStep 失败阻断：重试耗尽的任务不允许推进阶段', async () => {
  const { fake, engine, owner, run } = setup();

  await engine.enqueueTask({
    runId: run.id,
    kind: 'analyze_paper',
    phaseTag: 'PAPER_ANALYSIS',
    externalTaskId: 'task-fail-1',
    maxAttempts: 1,
  });
  const claim = await engine.claimNextTask(run.id, 'worker-A');
  assert.ok(claim);
  await engine.failTask({
    taskId: claim.task.id,
    workerId: 'worker-A',
    leaseEpoch: claim.leaseEpoch,
    errorClass: 'LlmAuthError',
    errorSummary: 'API auth failed: 401',
  });

  const result = await handleStep(fake.db, fake.BackendError, { run_id: run.id }, owner.id);
  assert.equal(result.action, 'blocked', '失败不是可以静默跳过的阶段');
  assert.equal(result.run?.status, 'blocked');
  assert.equal(result.run?.phase_tag, 'PAPER_ANALYSIS', '不得推进');
  assert.ok(result.message.includes('401'), '阻断消息要带真实失败原因');

  const events = await engine.listEvents(run.id);
  assert.ok(events.some((e) => e.type === 'run_blocked'));
});

test('handleStep 归属：别人的 run 不能步进；演示只对登录用户开放', async () => {
  const { fake, owner, project, run } = setup();

  const stranger = await handleStep(fake.db, fake.BackendError, { run_id: run.id }, 'not-the-owner');
  assert.equal(stranger.action, 'idle');

  const noTarget = await handleStep(fake.db, fake.BackendError, {}, 'not-the-owner');
  assert.equal(noTarget.action, 'idle', '兜底"任意活跃 run"会让访客步进别人的项目');

  // D2：演示项目（系统匿名 Owner 的 listed 项目）只读给访客——sessionOwnerId=null 就是没有会话。
  project.visibility = 'listed';
  const visitor = await handleStep(fake.db, fake.BackendError, { run_id: run.id }, owner.id, owner.id, null);
  assert.equal(visitor.action, 'idle', '访客点"继续运行"必须无效，否则陌生人也能烧 token');

  // 登录用户可以驱动平台演示：评委看演示时由账号来跑。
  const shared = await handleStep(fake.db, fake.BackendError, { run_id: run.id }, 'logged-in-visitor', owner.id);
  assert.equal(shared.action, 'advanced');
});

test('handleStep external_run_id：前端泵的定位参数生效，错配不兜底', async () => {
  const { fake, owner, project, run } = setup();

  const result = await handleStep(
    fake.db,
    fake.BackendError,
    { project_id: project.external_id, external_run_id: run.external_run_id },
    owner.id,
  );
  assert.equal(result.action, 'advanced');
  assert.equal(result.newPhase, 'DATA_READY');

  const wrong = await handleStep(
    fake.db,
    fake.BackendError,
    { project_id: project.external_id, external_run_id: 'run-does-not-exist' },
    owner.id,
  );
  assert.equal(wrong.action, 'idle', 'external_run_id 错配时不得落回"随便一个活跃 run"');
});

test('handleStep 完成：COMPLETED 标 succeeded + finished_at，再步返回 completed', async () => {
  const { fake, engine, owner, run } = setup();
  await engine.setRunPhase(run.id, 'IDEA_REVIEW', { status: 'running' });

  const result = await handleStep(fake.db, fake.BackendError, { run_id: run.id }, owner.id);
  assert.equal(result.action, 'advanced');
  assert.equal(result.run?.phase_tag, 'COMPLETED');
  assert.equal(result.run?.status, 'succeeded');
  assert.ok(result.run?.finished_at, '完成必须落 finished_at，否则 UI 永远"进行中"');

  const again = await handleStep(fake.db, fake.BackendError, { run_id: run.id }, owner.id);
  assert.equal(again.action, 'completed');
});
