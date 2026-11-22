/**
 * Function 路由的本地回归。
 *
 * Node 直接 import **同一份** `routes.ts`，依赖换成 `dev/fake-db.ts` 的内存适配器，
 * 所以这里断言的是路由、授权与错误码本身，不是平台网关、平台数据库或 WS 握手
 * （那些只能在部署后量：§8 列出 M-1…M-4，§10 是 2026-11-22 的真实读数）。
 *
 * 跑法：`pnpm test:function`（Node 24 的 type-stripping + 内置 test runner）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { application } from '../routes.ts';
import { ContractError } from '../contract.ts';
import { createFakeDb, sha256Hex } from '../dev/fake-db.ts';
import { SYNC_TOKEN_HEADER } from '../token.ts';

/**
 * 机器凭据在这里只是"被哈希比对的不透明串"，刻意不写成 `TOKEN = '<一长串>'`：
 * 那种形状会被 `release-check` 的高熵凭据闸门当真凭据拦下。闸门是对的，
 * 该改的是测试数据的写法，不是规则；而长度仍要过 `token.ts` 的 ≥32 下限——
 * 那一条是"真实凭据不可猜"的防线，测试不许绕过它。
 */
const fakeToken = (label: string): string => `${label}-sync-fixture-${'0'.repeat(28)}`;
const DIAG_TOKEN = fakeToken('diag');
const PUSH_TOKEN = fakeToken('push');
const SHARE_TOKEN = fakeToken('share');
const DEAD_TOKEN = fakeToken('dead');

/** L1 哨兵：只要它们出现在降级响应里，就说明列级降级漏了。 */
const SENTINEL_NOTE = 'GATE-NOTE-NOT-FOR-PUBLIC-8f2c';
const SENTINEL_SUMMARY = 'EVENT-SUMMARY-NOT-FOR-PUBLIC-9b31';
const SENTINEL_SPENT = 987654321;

interface Outcome {
  status: number;
  code: string;
  raw: string;
  json: Record<string, unknown>;
}

/** 与 `index.ts` 的入口映射保持一致：契约错误自己带码，权限错误原样出去。 */
async function call(handle: ReturnType<typeof application>, path: string, init?: RequestInit): Promise<Outcome> {
  try {
    const response = await handle({ request: new Request(`https://site.test/functions/v1/app${path}`, init), requestId: 'test' });
    const raw = await response.text();
    return {
      status: response.status,
      code: String((raw ? ((JSON.parse(raw) as Record<string, unknown>).code ?? '') : '') as string),
      raw,
      json: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
    };
  } catch (error) {
    if (error instanceof ContractError) {
      return {
        status: error.status,
        code: 'invalid_projection',
        raw: JSON.stringify({ message: error.message }),
        json: { message: error.message },
      };
    }
    const thrown = error as { code?: string; status?: number };
    return { status: thrown.status ?? 500, code: thrown.code ?? 'internal', raw: JSON.stringify({ code: thrown.code }), json: { code: thrown.code } };
  }
}

/**
 * 每例一套内存库，但可以按不同读者反复取处理器：同一份数据、不同身份，
 * 才是可见性判定真正要测的样子（`as(null)` 就是匿名访客）。
 */
async function build() {
  const fake = createFakeDb();
  const owner = fake.seed('cloud_owner', { email: 'owner-1', display_name: null });
  const stranger = fake.seed('cloud_owner', { email: 'stranger-1', display_name: null });
  fake.seed('cloud_sync_token', {
    owner_id: owner.id,
    token_hash: await sha256Hex(DIAG_TOKEN),
    scopes: ['push', 'diagnostics'],
    project_scope: [],
    revoked_at: null,
  });
  fake.seed('cloud_sync_token', {
    owner_id: owner.id,
    token_hash: await sha256Hex(PUSH_TOKEN),
    scopes: ['push'],
    project_scope: [],
    revoked_at: null,
  });

  const listed = fake.seed('cloud_project', {
    owner_id: owner.id,
    external_id: 'prj-listed',
    title: '公开列表项目',
    question: '这个问题会公开',
    strategy: 'standard',
    autonomy: 'supervised',
    visibility: 'listed',
    archived_at: null,
    last_sync_at: '2026-11-22T00:00:00.000Z',
  });
  fake.seed('cloud_project', {
    owner_id: owner.id,
    external_id: 'prj-private',
    title: '私有项目',
    question: '不该出现',
    strategy: null,
    autonomy: null,
    visibility: 'private',
    archived_at: null,
    last_sync_at: '2026-11-22T00:00:00.000Z',
  });
  const link = fake.seed('cloud_project', {
    owner_id: owner.id,
    external_id: 'prj-link',
    title: '持链可读',
    question: '只在有效 share 下可读',
    strategy: null,
    autonomy: null,
    visibility: 'link',
    archived_at: null,
    last_sync_at: '2026-11-22T00:00:00.000Z',
  });
  fake.seed('cloud_project', {
    owner_id: stranger.id,
    external_id: 'prj-other-owner',
    title: '别人的项目',
    question: null,
    strategy: null,
    autonomy: null,
    visibility: 'private',
    archived_at: null,
    last_sync_at: null,
  });

  const run = fake.seed('cloud_run', {
    project_id: listed.id,
    external_run_id: 'run-0000000000000001',
    status: 'QUOTA_EXHAUSTED',
    phase_tag: 'EXPERIMENTING',
    question: 'L1 问题',
    block_reason: '额度耗尽',
    started_at: '2026-11-22T00:00:00.000Z',
    finished_at: null,
    heartbeat_at: null,
    budget_usd_micro: 1,
    spent_usd_micro: SENTINEL_SPENT,
    summary: 'L1 摘要',
  });
  fake.seed('cloud_stage_progress', {
    run_id: run.id,
    stage: 'EXPERIMENTING',
    state: 'active',
    stage_known: true,
    gate_note: SENTINEL_NOTE,
    blocker_code: 'QUOTA_EXHAUSTED',
  });
  fake.seed('cloud_run_event', {
    run_id: run.id,
    seq: 1,
    ts: '2026-11-22T00:00:01.000Z',
    phase_tag: 'EXPERIMENTING',
    type: 'quota_exhausted',
    summary: SENTINEL_SUMMARY,
    truncated: false,
    level: 'error',
  });

  fake.seed('cloud_share_token', { project_id: link.id, token_hash: await sha256Hex(SHARE_TOKEN), scope: 'project', revoked_at: null });
  fake.seed('cloud_share_token', {
    project_id: link.id,
    token_hash: await sha256Hex(DEAD_TOKEN),
    scope: 'project',
    revoked_at: '2026-11-22T01:00:00.000Z',
  });

  const as = (user: string | null) =>
    application({
      db: fake.db,
      BackendError: fake.BackendError,
      getUser: () => (user ? { id: user } : null),
      upgradeWebSocket: () => {
        throw new Error('本用例不测握手');
      },
    });

  return { fake, as, listed };
}

/** 部署态只认这一个头：网关会剥掉 Authorization（实测 SPIKE_SITES_RUNTIME.md §10）。 */
const sync = (token: string) => ({ [SYNC_TOKEN_HEADER]: token });
/** 直连与本地入口带得动 Bearer，兼容路径要有断言守着。 */
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test('诊断探针必须带 Owner 自己签发的 diagnostics token', async () => {
  const { as } = await build();
  const handle = as(null);
  assert.equal((await call(handle, '/probe/health')).status, 401, '公网可达的站点不能有无凭据的运行时读数');
  assert.equal((await call(handle, '/probe/sleep?ms=1')).status, 401);
  assert.equal((await call(handle, '/probe/db')).status, 401);

  const pushOnly = await call(handle, '/probe/health', { headers: sync(PUSH_TOKEN) });
  assert.equal(pushOnly.status, 403, 'push 范围不等于诊断范围');

  // 200 这条用 /probe/db 验：`/probe/health` 读数来自 `Deno` 全局，本地没有 Deno，
  // 它属于部署后实测项（M-1），不在这一层假装通过。
  const diag = await call(handle, '/probe/db', { headers: sync(DIAG_TOKEN) });
  assert.equal(diag.status, 200, diag.raw);
  assert.equal(diag.json.ok, true);
  const counts = diag.json.counts as Record<string, number>;
  assert.equal(counts.cloud_project, 4);
  assert.equal((await call(handle, '/probe/sleep?ms=1', { headers: sync(DIAG_TOKEN) })).status, 200);
});

test('未知路径是 404，不是静默成功', async () => {
  const handle = (await build()).as(null);
  const miss = await call(handle, '/views/nosuch');
  assert.equal(miss.status, 404);
  assert.equal(miss.code, 'not_found');
});

test('匿名列表只出现 listed，且给的是 L2 投影', async () => {
  const handle = (await build()).as(null);
  const out = await call(handle, '/views/index');
  assert.equal(out.status, 200);
  const projects = out.json.projects as { external_id: string; projection_level: string; latest_run: Record<string, unknown> }[];
  assert.deepEqual(projects.map((p) => p.external_id), ['prj-listed'], 'link 与 private 都不该进公开列表');
  assert.equal(projects[0]!.projection_level, 'l2');
  assert.equal('status' in (projects[0]!.latest_run ?? {}), false, 'run 状态是 L1');
  assert.equal(out.raw.includes(String(SENTINEL_SPENT)), false);
});

test('匿名读私有项目 = 不存在；读 listed 时 L1 哨兵不得出现在响应里', async () => {
  const handle = (await build()).as(null);
  const priv = await call(handle, '/views/project?external_id=prj-private');
  assert.equal(priv.status, 404, '403 会确认这个项目存在');

  const listed = await call(handle, '/views/project?external_id=prj-listed');
  assert.equal(listed.status, 200);
  assert.equal(listed.json.projection_level, 'l2');
  assert.equal(listed.raw.includes(SENTINEL_NOTE), false, 'gate_note 泄漏');
  assert.equal(listed.raw.includes(SENTINEL_SUMMARY), false, '事件摘要泄漏');
  assert.equal(listed.raw.includes(String(SENTINEL_SPENT)), false, '成本泄漏');
  assert.equal(listed.raw.includes('QUOTA_EXHAUSTED'), false, 'status/blocker 是 L1');
  assert.equal(listed.raw.includes('"strategy"'), false, 'strategy/autonomy 是 L1');
  assert.equal((listed.json.events as unknown[]).length, 0);
  assert.ok(listed.raw.includes('这个问题会公开'), 'L2 允许研究问题');
});

test('share token 只降级不升级：link 项目持链可读，但拿到的仍是 L2', async () => {
  const handle = (await build()).as(null);
  const without = await call(handle, '/views/project?external_id=prj-link');
  assert.equal(without.status, 404, 'link 不进公开列表，也没链就读不到（Q1）');

  const viaShare = await call(handle, `/views/project?external_id=prj-link&share=${SHARE_TOKEN}`);
  assert.equal(viaShare.status, 200);
  assert.equal(viaShare.json.projection_level, 'l2', '未记名链接不是 Owner 身份');
  assert.equal(viaShare.raw.includes(SENTINEL_NOTE), false);
});

test('撤销 share 之后同一链接 404（NFR-04 的读侧）', async () => {
  const handle = (await build()).as(null);
  const dead = await call(handle, `/views/project?external_id=prj-link&share=${DEAD_TOKEN}`);
  assert.equal(dead.status, 404, '撤销过的 share 必须回到"不存在"');
});

test('Owner 读自己的项目 = full，哨兵原样出现；读别人的 = 403', async () => {
  const { as } = await build();
  const handle = as('owner-1');
  const out = await call(handle, '/views/project?external_id=prj-listed');
  assert.equal(out.status, 200);
  assert.equal(out.json.projection_level, 'full');
  assert.ok(out.raw.includes(SENTINEL_NOTE));
  assert.ok(out.raw.includes('QUOTA_EXHAUSTED'));

  const priv = await call(handle, '/views/project?external_id=prj-private');
  assert.equal(priv.status, 200, 'Owner 读私有项目当然可以');

  const foreign = await call(handle, '/views/project?external_id=prj-other-owner');
  assert.equal(foreign.status, 403, '有身份的读者被拒时给 403，指得出方向');
});

test('/live 握手前完成鉴权：匿名私有 404，listed 放行且只回 outbox 帧', async () => {
  const handle = (await build()).as(null);
  const denied = await call(handle, '/live?project=prj-private');
  assert.equal(denied.status, 404);
  const allowed = await call(handle, '/live?project=prj-listed');
  assert.equal(allowed.status, 304, '没有新帧就是 304，不是编一组空数据');
});

test('批次主版本不认识就整批拒绝，不是尽力解析', async () => {
  const handle = (await build()).as(null);
  const out = await call(handle, '/ingest', {
    method: 'POST',
    headers: { ...sync(PUSH_TOKEN), 'content-type': 'application/json' },
    body: JSON.stringify({ schema_version: 99, external_batch_id: 'bat-0000000000000001', project: { external_id: 'prj-x' }, entities: {} }),
  });
  assert.equal(out.status, 415);
  assert.equal(out.code, 'invalid_projection');
});

test('未实装的集合显式拒绝，不是收下再丢掉', async () => {
  const handle = (await build()).as(null);
  const out = await call(handle, '/ingest', {
    method: 'POST',
    headers: { ...sync(PUSH_TOKEN), 'content-type': 'application/json' },
    body: JSON.stringify({
      schema_version: 1,
      external_batch_id: 'bat-0000000000000002',
      generated_at: 1_765_000_000_000,
      local_schema_version: 42,
      project: { external_id: 'prj-synthetic', title: '合成' },
      entities: { papers: [{ localId: 'paper-1' }] },
    }),
  });
  assert.equal(out.status, 501);
  assert.match(out.code, /projection_collections_not_implemented/);
});

test('合成批 ingest → 深链读回；同一批重放幂等；新投影默认私有', async () => {
  const { as } = await build();
  const writer = as(null);
  const batch = {
    schema_version: 1,
    external_batch_id: 'bat-0000000000000001',
    generated_at: 1_765_000_000_000,
    local_schema_version: 42,
    project: { external_id: 'prj-synthetic', title: '合成演示项目' },
    entities: {
      runs: [
        {
          external_run_id: 'run-0000000000000001',
          status: 'SUCCEEDED',
          phase_tag: 'COMPLETED',
          started_at: 1_765_000_000_000,
          finished_at: 1_765_000_060_000,
        },
      ],
      stages: [{ run_external_id: 'run-0000000000000001', stage: 'COMPLETED', state: 'passed' }],
      events: [{ run_external_id: 'run-0000000000000001', seq: 1, ts: 1_765_000_001_000, event_type: 'run_completed', summary: '合成运行完成' }],
    },
  };
  const sent = await call(writer, '/ingest', {
    method: 'POST',
    headers: { ...sync(PUSH_TOKEN), 'content-type': 'application/json' },
    body: JSON.stringify(batch),
  });
  assert.equal(sent.status, 200, sent.raw);
  assert.equal(sent.json.status, 'accepted');

  const replay = await call(writer, '/ingest', {
    method: 'POST',
    headers: { ...sync(PUSH_TOKEN), 'content-type': 'application/json' },
    body: JSON.stringify(batch),
  });
  assert.equal(replay.json.status, 'replay', 'external_batch_id 必须幂等（F1.8）');
  assert.equal(replay.raw.includes('accepted'), false, '重放不得第二次写入');

  // 新投影默认私有（F5.1）：匿名拿不到，Owner 深链读得到，且事件真的落库了。
  const anon = await call(writer, '/views/project?external_id=prj-synthetic');
  assert.equal(anon.status, 404);

  const ownerView = await call(as('owner-1'), '/views/project?external_id=prj-synthetic');
  assert.equal(ownerView.status, 200);
  assert.equal(ownerView.json.projection_level, 'full');
  const events = ownerView.json.events as { seq: number; summary: string }[];
  assert.equal(events.length, 1);
  assert.equal(events[0]!.summary, '合成运行完成');
  assert.equal((ownerView.json.stages as unknown[]).length, 1);
});

test('身份相关的读数一律 no-store：缓存一份 Owner 的响应就是泄漏可见性', async () => {
  const { as } = await build();
  const response = await as(null)({ request: new Request('https://site.test/functions/v1/app/views/index'), requestId: 'test' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('no-store 不得包到 WS 握手上：101 原样出去', async () => {
  const { fake } = await build();
  // 101 在 fetch 规范里是**不可构造**的响应（undici 直接 RangeError），Deno 的
  // `upgradeWebSocket` 回的是运行时自己造的那一个。所以这里用桩对象：要断言的只是
  // 包装层看见 101 就早退，不去重新 `new Response(...)`。
  const upgrade = { status: 101, statusText: 'Switching Protocols', headers: new Headers() } as unknown as Response;
  const handle = application({
    db: fake.db,
    BackendError: fake.BackendError,
    getUser: () => null,
    upgradeWebSocket: () => ({
      // 帧泵只在 `open` 上启动，这里不让它启动：本例断言的是响应没被重新包装。
      socket: { readyState: WebSocket.CONNECTING, addEventListener: () => {}, send: () => {}, close: () => {} } as unknown as WebSocket,
      response: upgrade,
    }),
  });
  const response = await handle({
    request: new Request('https://site.test/functions/v1/app/live?project=prj-listed&action=live', { headers: { upgrade: 'websocket' } }),
    requestId: 'test',
  });
  assert.equal(response, upgrade, '必须是同一个响应对象');
  assert.equal(response.status, 101);
  assert.equal(response.headers.get('cache-control'), null, '重新包一层 101 就把升级弄断了');
});

test('/probe/ingress 不鉴权，但只报头名、绝不回显任何值', async () => {
  const { as } = await build();
  const hit = await call(as(null), '/probe/ingress', {
    headers: { ...sync(DIAG_TOKEN), 'x-secret-probe': 'value-must-not-appear' },
  });
  assert.equal(hit.status, 200, '它存在的意义就是回答"凭据有没有走到 Function"');
  assert.equal(hit.json.sync_header, true);
  assert.equal(hit.json.authorization, false);
  assert.equal(hit.raw.includes(DIAG_TOKEN), false, 'token 值不得出现在任何读数里');
  assert.equal(hit.raw.includes('value-must-not-appear'), false, '头值一律不外传');
});

test('机器凭据两条路都认：自定义头是部署态唯一可用的那一条', async () => {
  // 网关剥 `Authorization` 是 §10 的实测事实；这条守的是代码侧的契约——
  // `x-ideaseek-token` 必须能开门，Bearer 作为直连/本地兼容也不能突然失效。
  const { as } = await build();
  const handle = as(null);
  assert.equal((await call(handle, '/probe/db', { headers: sync(DIAG_TOKEN) })).status, 200);
  assert.equal((await call(handle, '/probe/db', { headers: bearer(DIAG_TOKEN) })).status, 200);
  assert.equal((await call(handle, '/probe/db', { headers: sync(PUSH_TOKEN) })).status, 403, 'push 范围开不了诊断门');
  assert.equal(
    (await call(handle, '/probe/db', { headers: { 'x-ideaseek-token': 'too-short' } })).status,
    401,
    '短凭据不得进库查询',
  );
});
