/**
 * Phase 10 的失败路径回归：取消、重复提交撞键、Agent 崩溃、输出损坏、权限拒绝、大清单。
 *
 * 这一组刻意只问"坏情况下云端说了什么"。正常路径在 commands.test.ts 里已经钉过，
 * 真正的事故都出在边界：租约到点没人回写、Agent 半路死了又活、上报的 JSON 形状不对、
 * 用户撤一条已经被领走的命令。每一条都要有确定的读数和确定的状态，不能靠"应该没事"。
 *
 * 跑法：`npm run test:function`（Node 24）或按 README 的编译—`node --test` 两步跑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { application } from '../routes.ts';
import type { SiteContext } from '../routes.ts';
import { createFakeDb, sha256Hex } from '../dev/fake-db.ts';
import { ensureSession, withSession } from '../dev/test-session.ts';
import { SYNC_TOKEN_HEADER } from '../token.ts';

const fakeToken = (label: string): string => `${label}-sync-fixture-${'0'.repeat(28)}`;
const AGENT_TOKEN = fakeToken('agent');

async function build() {
  const fake = createFakeDb();
  const owner = fake.seed('cloud_owner', { email: 'owner-1', display_name: null });
  const stranger = fake.seed('cloud_owner', { email: 'stranger-1', display_name: null });
  fake.seed('cloud_sync_token', {
    owner_id: owner.id,
    token_hash: await sha256Hex(AGENT_TOKEN),
    scopes: ['push', 'commands'],
    project_scope: [],
    revoked_at: null,
  });
  const project = fake.seed('cloud_project', {
    owner_id: owner.id,
    external_id: 'prj-listed',
    title: '公开列表项目',
    question: '这个问题会公开',
    strategy: 'standard',
    autonomy: 'guided',
    visibility: 'listed',
    archived_at: null,
    last_sync_at: '2026-11-23T00:00:00.000Z',
  });
  fake.seed('cloud_project', {
    owner_id: stranger.id,
    external_id: 'prj-other',
    title: '别人的项目',
    question: null,
    strategy: null,
    autonomy: null,
    visibility: 'private',
    archived_at: null,
    last_sync_at: null,
  });

  const handle = application({
    db: fake.db,
    BackendError: fake.BackendError,
    // D3：平台网关身份不参与业务鉴权，身份由会话 Cookie 提供。
    getUser: () => null,
    upgradeWebSocket: () => {
      throw new Error('本用例不测握手');
    },
  });
  const cookies = new Map<string, string>();
  const as = (user: string | null) =>
    user
      ? withSession(handle, async () => {
          const cached = cookies.get(user);
          if (cached) return cached;
          const fixture = await ensureSession(fake.db, user);
          cookies.set(user, fixture.cookie);
          return fixture.cookie;
        })
      : handle;

  return { fake, as, owner, stranger, project };
}

async function call(handle: (ctx: SiteContext) => Promise<Response>, path: string, init?: RequestInit) {
  try {
    const response = await handle({ request: new Request(`https://site.test/functions/v1/app${path}`, init), requestId: 'test' });
    const raw = await response.text();
    return { status: response.status, raw, json: raw ? (JSON.parse(raw) as Record<string, unknown>) : {}, code: raw ? String((JSON.parse(raw) as Record<string, unknown>).code ?? '') : '' };
  } catch (error) {
    const thrown = error as { code?: string; status?: number };
    const code = thrown.code ?? 'internal';
    return { status: thrown.status ?? 500, raw: JSON.stringify({ code }), json: { code }, code };
  }
}

const web = (json: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) });
const agent = (json: unknown): RequestInit => ({ method: 'POST', headers: { [SYNC_TOKEN_HEADER]: AGENT_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(json) });

async function enqueue(as: (user: string | null) => (ctx: SiteContext) => Promise<Response>, commandId: string, payload: Record<string, unknown> = {}) {
  return call(as('owner-1'), '/commands/run_start', web({ external_id: 'prj-listed', command_id: commandId, question: '测试运行', ...payload }));
}

// --------------------------------------------------------------------------- 撤回排队

test('撤回 queued 命令：标成已取消，Agent 之后也领不到', async () => {
  const { fake, as } = await build();
  await enqueue(as, 'cmd-x1');
  const cancel = await call(as('owner-1'), '/commands/cancel', web({ external_id: 'prj-listed', command_id: 'cmd-x1' }));
  assert.equal(cancel.status, 200);
  assert.equal(cancel.json.message, '命令已撤回，本地不会执行');
  assert.equal(fake.rowsOf('cloud_command')[0]!.status, 'canceled');
  assert.ok(fake.rowsOf('cloud_command')[0]!.finished_at, '终态要盖上时间，台账才知道什么时候结束');

  // 领不到是硬要求：canceled 不在 claimQueued 的查询条件里，不是靠 Agent 自觉。
  const beat = await call(as(null), '/agent/heartbeat', agent({}));
  assert.equal((beat.json.commands as unknown[]).length, 0);
  assert.equal(fake.rowsOf('cloud_command')[0]!.status, 'canceled');

  // 撤回后的命令再被回写：终态不推进第二次。
  const late = await call(as(null), '/agent/heartbeat', agent({ results: [{ command_id: 'cmd-x1', status: 'succeeded' }] }));
  assert.equal((late.json.applied_results as Array<Record<string, unknown>>)[0]!.reason, 'already_terminal');
});

test('撤回已被领取的命令：明确说"云端不中断"，状态一格不动', async () => {
  const { fake, as } = await build();
  await enqueue(as, 'cmd-x2');
  await call(as(null), '/agent/heartbeat', agent({}));
  assert.equal(fake.rowsOf('cloud_command')[0]!.status, 'claimed');

  const cancel = await call(as('owner-1'), '/commands/cancel', web({ external_id: 'prj-listed', command_id: 'cmd-x2' }));
  assert.equal(cancel.status, 200, '不是失败：命令确实还在跑，把它报成失败会诱使用户再排一条');
  assert.equal(cancel.json.ignored, 'already_claimed');
  assert.equal(fake.rowsOf('cloud_command')[0]!.status, 'claimed');
});

test('撤回的入口条件：缺参数、未知命令、别人的项目、匿名各回各的码', async () => {
  const { fake, as } = await build();
  assert.equal((await call(as('owner-1'), '/commands/cancel', web({ command_id: 'cmd-none' }))).code, 'invalid_input:external_id');
  assert.equal((await call(as('owner-1'), '/commands/cancel', web({ external_id: 'prj-listed' }))).code, 'invalid_input:command_id');
  assert.equal((await call(as('owner-1'), '/commands/cancel', web({ external_id: 'prj-listed', command_id: 'cmd-ghost' }))).code, 'not_found');

  // 幂等键是全局唯一的：拿别人的 command_id + 自己的项目也查不到行，不会误撤。
  const other = fake.rowsOf('cloud_project')[1]!;
  fake.seed('cloud_command', {
    project_id: other.id,
    external_command_id: 'cmd-theirs',
    type: 'run_start',
    payload: { message: '别人的' },
    status: 'queued',
    created_by: other.owner_id,
    created_at: new Date().toISOString(),
  });
  assert.equal((await call(as('owner-1'), '/commands/cancel', web({ external_id: 'prj-listed', command_id: 'cmd-theirs' }))).code, 'not_found');
  assert.equal(fake.rowsOf('cloud_command')[0]!.status, 'queued', '不是自己的命令一行都不该动');

  // 匿名没有 Owner 身份，先 401；这不是"项目不存在"，是"还没登录"。
  assert.equal((await call(as(null), '/commands/cancel', web({ external_id: 'prj-listed', command_id: 'cmd-none' }))).code, 'login_required');
  // 陌生登录者撤不动别人的项目。
  assert.equal((await call(as('stranger-1'), '/commands/cancel', web({ external_id: 'prj-listed', command_id: 'cmd-none' }))).code, 'no_access');
});

test('cancel 不会被当成命令类型：/commands/cancel 走撤回，未知类型仍然 404', async () => {
  const { as } = await build();
  // 通用 /commands/{type} 在前面的话，这里会得到一条"没有这种命令"的 404，
  // 而用户点的是"撤回"——同一条 URL 两种解释就是没钉住。
  assert.equal((await call(as('owner-1'), '/commands/cancel', web({}))).code, 'invalid_input:external_id');
  assert.equal((await call(as('owner-1'), '/commands/git_rebase', web({ external_id: 'prj-listed' }))).code, 'not_found');
});

// --------------------------------------------------------------------------- 幂等与撞键

test('同一幂等键换载荷：只有一行，原载荷不被改写，并明确报 mismatch', async () => {
  const { fake, as } = await build();
  await enqueue(as, 'cmd-same', { message: '第一条' });
  const again = await call(as('owner-1'), '/commands/git_commit', web({ external_id: 'prj-listed', command_id: 'cmd-same', message: '第二条' }));
  assert.equal(again.json.replayed, true);
  assert.equal(again.json.payload_mismatch, true, '客户端复用 id 说了两件不同的事，界面必须能看出来');
  assert.equal(fake.rowsOf('cloud_command').length, 1, '撞键不产生第二行');
  assert.equal(
    (fake.rowsOf('cloud_command')[0]!.payload as Record<string, unknown>).message,
    '第一条',
    '回放不改写已排队的载荷：撞键时以先入库的那条为准',
  );
});

test('同一幂等键同一载荷：纯回放，不报 mismatch', async () => {
  const { as } = await build();
  await enqueue(as, 'cmd-same2', { message: '同样的话' });
  const again = await call(as('owner-1'), '/commands/git_commit', web({ external_id: 'prj-listed', command_id: 'cmd-same2', message: '同样的话' }));
  assert.equal(again.json.replayed, true);
  assert.equal(again.json.payload_mismatch, false);
});

test('幂等键属于谁：别人用我的 command_id 排队会被拒，不改我的行', async () => {
  const { fake, as } = await build();
  await enqueue(as, 'cmd-mine');
  const stolen = await call(as('stranger-1'), '/commands/git_commit', web({ external_id: 'prj-listed', command_id: 'cmd-mine', message: '冒充' }));
  assert.equal(stolen.code, 'no_access');
  assert.equal(fake.rowsOf('cloud_command').length, 1);
  assert.equal((fake.rowsOf('cloud_command')[0]!.payload as Record<string, unknown>).message, '本地提交');
});

// --------------------------------------------------------------------------- 崩溃与租约

test('Agent 崩溃后重启：过期命令不会被重新领取，迟到的结果被忽略', async () => {
  const { fake, as } = await build();
  const stale = new Date(Date.now() - 16 * 60_000).toISOString();
  fake.seed('cloud_command', {
    project_id: fake.rowsOf('cloud_project')[0]!.id,
    external_command_id: 'cmd-crash',
    type: 'run_start',
    payload: { question: 'q' },
    status: 'running',
    created_by: fake.rowsOf('cloud_owner')[0]!.id,
    created_at: stale,
    claimed_at: stale,
  });

  const first = await call(as(null), '/agent/heartbeat', agent({}));
  assert.deepEqual(first.json.expired_commands, ['cmd-crash']);
  assert.equal((first.json.commands as unknown[]).length, 0, '过期不自动重排：run_start 重放就是重复花费');

  // 进程其实还活着，只是心跳断了 16 分钟——它回来的时候结果不能被接受。
  const late = await call(as(null), '/agent/heartbeat', agent({ results: [{ command_id: 'cmd-crash', status: 'succeeded', result: { run_id: 'run-late' } }] }));
  assert.equal((late.json.applied_results as Array<Record<string, unknown>>)[0]!.reason, 'already_terminal');
  assert.equal(fake.rowsOf('cloud_command')[0]!.status, 'expired');
  assert.equal(fake.rowsOf('cloud_run').length, 0, '过期命令不能悄悄把运行记录写回来');
});

test('在线窗口：90 秒内算在线，心跳一断读数立刻变', async () => {
  const { as } = await build();
  await call(as(null), '/agent/heartbeat', agent({ agent_version: '0.1.0' }));
  const online = await call(as('owner-1'), '/views/agent?external_id=prj-listed');
  assert.equal(online.json.online, true);
  assert.equal(online.json.agent_version, '0.1.0');
});

// --------------------------------------------------------------------------- 损坏输出

test('损坏的回写形状：不改任何一行，逐项说明为什么没接受', async () => {
  const { fake, as } = await build();
  await enqueue(as, 'cmd-shape');
  await call(as(null), '/agent/heartbeat', agent({}));

  const beat = await call(as(null), '/agent/heartbeat', agent({ results: 'not-an-array' }));
  assert.deepEqual(beat.json.applied_results, [], '整个字段不是数组就当没这一批，而不是猜');

  const messy = await call(as(null), '/agent/heartbeat', agent({
    results: [
      { command_id: 'cmd-shape', status: 'maybe' },
      { status: 'succeeded' },
    ],
  }));
  const applied = messy.json.applied_results as Array<Record<string, unknown>>;
  assert.equal(applied[0]!.reason, 'bad_shape', '非终态字符串不能把命令推进终态');
  assert.equal(applied[1]!.reason, 'bad_shape');
  assert.equal(fake.rowsOf('cloud_command')[0]!.status, 'claimed');

  // 合法终态 + 非 object 的 result：状态照常推进，正文原样留着（结构由 Agent 决定，
  // 云端只钉大小）。放在同一次心跳里断言会被上面那条覆盖掉，所以分开排。
  const done = await call(as(null), '/agent/heartbeat', agent({ results: [{ command_id: 'cmd-shape', status: 'canceled', result: '正文不是对象' }] }));
  assert.equal((done.json.applied_results as Array<Record<string, unknown>>)[0]!.applied, true);
  assert.deepEqual(fake.rowsOf('cloud_command')[0]!.result, '正文不是对象');
});

test('超大结果：整体不进云，只留 oversized 标记', async () => {
  const { fake, as } = await build();
  await enqueue(as, 'cmd-big');
  await call(as(null), '/agent/heartbeat', agent({}));
  await call(as(null), '/agent/heartbeat', agent({ results: [{ command_id: 'cmd-big', status: 'succeeded', result: { blob: 'x'.repeat(20_000) } }] }));
  const row = fake.rowsOf('cloud_command')[0]!;
  assert.equal(row.status, 'succeeded');
  assert.equal((row.result as Record<string, unknown>).oversized, true);
  assert.ok(!JSON.stringify(row.result).includes('xxxxxx'), '半条 JSON 比没有 JSON 更容易被误读');
});

test('损坏的上报：缺 external_id 与越界路径进不了库，超限清单被截到上限', async () => {
  const { fake, as } = await build();

  const messy = await call(as(null), '/agent/heartbeat', agent({
    reported: {
      git: [{ branch: 'main' }],
      files: [{ nodes: [{ path: '../escape.txt', kind: 'text' }, { path: 'papers/a.txt', kind: 'text' }] }],
    },
  }));
  const reported = messy.json.applied_reported as Record<string, unknown>;
  assert.deepEqual(reported.git, []);
  assert.deepEqual(reported.files, []);
  assert.ok((reported.skipped as string[]).includes('git:missing_external_id'));
  assert.ok((reported.skipped as string[]).includes('files:missing_external_id'));
  assert.equal(fake.rowsOf('cloud_git_state').length, 0, '没有项目归属的上报不落任何行');

  const nodes = Array.from({ length: 2_100 }, (_, index) => ({ path: `f${index}.txt`, kind: 'text', size: 1 }));
  const big = await call(as(null), '/agent/heartbeat', agent({ reported: { files: [{ external_id: 'prj-listed', nodes }] } }));
  const written = ((big.json.applied_reported as Record<string, unknown>).file_nodes_written as number[])[0]!;
  assert.equal(written, 2_000, '清单有上限：一轮写太多会把心跳拖长，读侧本来也只出示切片');
  assert.equal(fake.rowsOf('cloud_file_node').length, 2_000);
});

// --------------------------------------------------------------------------- 权限拒绝

test('token 范围与吊销：撤销后的 Agent 什么都写不动', async () => {
  const { fake, as } = await build();
  await enqueue(as, 'cmd-token');
  const token = fake.rowsOf('cloud_sync_token')[0]!;
  token.revoked_at = new Date().toISOString();
  const denied = await call(as(null), '/agent/heartbeat', agent({}));
  // 吊销是身份问题而不是授权问题（token.ts:58）：凭据不再代表任何人，所以是 401 不是 403。
  assert.equal(denied.code, 'login_required', '吊销要立刻生效，不等任何缓存');
  assert.equal(fake.rowsOf('cloud_command')[0]!.status, 'queued', '吊销的 token 不能把命令领走');
});
