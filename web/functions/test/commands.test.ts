/**
 * 反向通道（Web → 命令队列 → 本地 Agent）的本地回归。
 *
 * 这里刻意**不**断言任何执行结果：云端没有执行能力（F6.5），能断言的是排队语义、
 * 写权限、幂等、租约与降级。跑法 `node --test web/functions/test/commands.test.ts`。
 *
 * 身份面与 routes.test.ts 同一套：浏览者走 `getUser` 注入，Agent 走 `x-ideaseek-token`
 * 的哈希比对（部署态网关会剥 Authorization，实测 SPIKE_SITES_RUNTIME.md §10）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { application } from '../routes.ts';
import type { SiteContext } from '../routes.ts';
import { createFakeDb, sha256Hex } from '../dev/fake-db.ts';
import { ensureSession, withSession } from '../dev/test-session.ts';
import { SYNC_TOKEN_HEADER } from '../token.ts';

// 构造式凭据夹具：既过 token.ts 的 ≥32 下限，也不是一串能被当成真 key 的高熵值。
const fakeToken = (label: string): string => `${label}-sync-fixture-${'0'.repeat(28)}`;
const AGENT_TOKEN = fakeToken('agent');
const SCOPED_TOKEN = fakeToken('scoped');
const PUSH_ONLY_TOKEN = fakeToken('pushonly');

async function build() {
  const fake = createFakeDb();
  const owner = fake.seed('cloud_owner', { email: 'owner-1', display_name: null });
  const stranger = fake.seed('cloud_owner', { email: 'stranger-1', display_name: null });
  for (const [token, scopes, projectScope] of [
    [AGENT_TOKEN, ['push', 'commands'], []],
    [SCOPED_TOKEN, ['push', 'commands'], ['prj-listed']],
    [PUSH_ONLY_TOKEN, ['push'], []],
  ] as const) {
    fake.seed('cloud_sync_token', {
      owner_id: owner.id,
      token_hash: await sha256Hex(token),
      scopes,
      project_scope: projectScope,
      revoked_at: null,
    });
  }
  const listed = fake.seed('cloud_project', {
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

  return { fake, as, owner, stranger, listed };
}

async function call(handle: (ctx: SiteContext) => Promise<Response>, path: string, init?: RequestInit) {
  try {
    const response = await handle({ request: new Request(`https://site.test/functions/v1/app${path}`, init), requestId: 'test' });
    const raw = await response.text();
    return { status: response.status, raw, json: raw ? (JSON.parse(raw) as Record<string, unknown>) : {}, code: raw ? String((JSON.parse(raw) as Record<string, unknown>).code ?? '') : '' };
  } catch (error) {
    // 与 index.ts 的边界一致：BackendError 由平台的 errorResponse 变成状态码，
    // 本地入口没有那层，这里自己接住，断言的仍是同一个 code。
    const thrown = error as { code?: string; status?: number };
    const code = thrown.code ?? 'internal';
    return { status: thrown.status ?? 500, raw: JSON.stringify({ code }), json: { code }, code };
  }
}

const web = (json: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) });
const agent = (token: string, json: unknown): RequestInit => ({ method: 'POST', headers: { [SYNC_TOKEN_HEADER]: token, 'content-type': 'application/json' }, body: JSON.stringify(json) });

// --------------------------------------------------------------------------- 排队

test('Owner 排队一条 run_start：只写队列，不动投影', async () => {
  const { fake, as } = await build();
  const out = await call(as('owner-1'), '/commands/run_start', web({ external_id: 'prj-listed', question: '能不能少标注一半数据', command_id: 'cmd-1' }));
  assert.equal(out.status, 200);
  assert.equal(out.json.message, '命令已排队，等待本地 Agent 执行');
  const rows = fake.rowsOf('cloud_command');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, 'queued');
  assert.equal(rows[0]!.external_command_id, 'cmd-1');
  assert.deepEqual(rows[0]!.payload, { question: '能不能少标注一半数据' });
  // 投影表没有被浏览器写过：下一次 cloud push 会覆盖云上直改的值，所以那条路禁止。
  assert.equal(fake.rowsOf('cloud_project').length, 2);
});

test('同一 command_id 重复提交回原记录，不排第二个命令', async () => {
  const { fake, as } = await build();
  const handle = as('owner-1');
  await call(handle, '/commands/run_start', web({ external_id: 'prj-listed', question: '第一遍', command_id: 'cmd-dup' }));
  const again = await call(handle, '/commands/run_start', web({ external_id: 'prj-listed', question: '超时后重试', command_id: 'cmd-dup' }));
  assert.equal(again.json.replayed, true);
  assert.equal(fake.rowsOf('cloud_command').length, 1);
});

test('写权限只有 Owner：陌生人 403、匿名先被 401、不存在的 external_id 404', async () => {
  const { as } = await build();
  assert.equal((await call(as('stranger-1'), '/commands/run_start', web({ external_id: 'prj-listed', question: 'q' }))).status, 403);
  // 匿名访客在**任何**写面上都是 401：先确认身份再谈存在性，不给出"这个项目存不存在"的读数。
  assert.equal((await call(as(null), '/commands/run_start', web({ external_id: 'prj-listed', question: 'q' }))).code, 'login_required');
  const absent = await call(as('stranger-1'), '/commands/run_start', web({ external_id: 'prj-does-not-exist', question: 'q' }));
  assert.equal(absent.status, 404);
});

test('未知命令、越界路径、强推与凭据形状的载荷都在排队前拒掉', async () => {
  const { fake, as } = await build();
  const handle = as('owner-1');
  assert.equal((await call(handle, '/commands/run_destroy', web({ external_id: 'prj-listed' }))).code, 'not_found');
  assert.equal((await call(handle, '/commands/file_delete', web({ external_id: 'prj-listed', path: '../papers/x.pdf' }))).status, 400);
  assert.equal((await call(handle, '/commands/file_delete', web({ external_id: 'prj-listed', path: '/etc/passwd' }))).status, 400);
  assert.equal((await call(handle, '/commands/git_push', web({ external_id: 'prj-listed', force: true }))).status, 400);
  assert.equal((await call(handle, '/commands/run_start', web({ external_id: 'prj-listed', question: 'api_key=sk-live-123' }))).status, 400);
  assert.equal(fake.rowsOf('cloud_command').length, 0);
});

test('创建项目排成命令而不是写投影', async () => {
  const { fake, as } = await build();
  const out = await call(as('owner-1'), '/projects', web({ name: '新课题', question: '小样本能不能站住', strategy: 'starter', autonomy: 'guided' }));
  assert.equal(out.status, 200);
  assert.equal(out.json.message, '创建请求已排队，等待本地 Agent 执行');
  const command = fake.rowsOf('cloud_command')[0]!;
  assert.equal(command.type, 'project_create');
  assert.equal(command.project_id, null);
  assert.equal(fake.rowsOf('cloud_project').length, 2, '云端不替本地引擎建项目行');
});

test('设置与归档也只能排队', async () => {
  const { fake, as } = await build();
  const handle = as('owner-1');
  await call(handle, '/commands/project_settings', web({ external_id: 'prj-listed', visibility: 'listed', title: '改过的标题' }));
  assert.deepEqual(fake.rowsOf('cloud_command')[0]!.payload, { title: '改过的标题', visibility: 'listed' });
  assert.equal(fake.rowsOf('cloud_project')[0]!.title, '公开列表项目', '投影里的标题仍来自本地');
  assert.equal((await call(handle, '/commands/project_settings', web({ external_id: 'prj-listed', visibility: 'public' }))).status, 400, 'Q1 只有三档');
});

// --------------------------------------------------------------------------- 心跳与领取

test('Agent 心跳领走 queued 命令并标成 claimed', async () => {
  const { fake, as } = await build();
  await call(as('owner-1'), '/commands/run_start', web({ external_id: 'prj-listed', question: 'q', command_id: 'cmd-a' }));
  const beat = await call(as(null), '/agent/heartbeat', agent(AGENT_TOKEN, { agent_version: '0.1.0', local_projects: [{ path: '/srv/p1', name: 'p1', external_id: 'prj-listed' }] }));
  assert.equal(beat.status, 200);
  const commands = beat.json.commands as Array<Record<string, unknown>>;
  assert.equal(commands.length, 1);
  assert.equal(commands[0]!.command_id, 'cmd-a');
  assert.equal(fake.rowsOf('cloud_command')[0]!.status, 'claimed');
  const agentRow = fake.rowsOf('cloud_agent')[0]!;
  assert.equal(agentRow.agent_version, '0.1.0');
  assert.equal((agentRow.local_projects as Array<Record<string, unknown>>)[0]!.external_id, 'prj-listed');

  // 已领取的不会被第二次心跳重复下发——重复下发等于重复花费。
  const second = await call(as(null), '/agent/heartbeat', agent(AGENT_TOKEN, {}));
  assert.equal((second.json.commands as unknown[]).length, 0);
});

test('没有 commands 范围的 token 领不到命令', async () => {
  const { as } = await build();
  const out = await call(as(null), '/agent/heartbeat', agent(PUSH_ONLY_TOKEN, {}));
  assert.equal(out.code, 'no_access');
});

test('project_scope 限死的 token 不领越界命令、也不写越界状态', async () => {
  const { fake, as } = await build();
  const other = fake.rowsOf('cloud_project')[1]!;
  fake.seed('cloud_command', {
    project_id: other.id,
    external_command_id: 'cmd-other-owner',
    type: 'run_start',
    payload: { question: '别人排的' },
    status: 'queued',
    created_by: other.owner_id,
    created_at: new Date().toISOString(),
  });
  const beat = await call(as(null), '/agent/heartbeat', agent(SCOPED_TOKEN, { reported: { git: [{ external_id: 'prj-other', branch: 'main' }] } }));
  assert.equal((beat.json.commands as unknown[]).length, 0);
  assert.equal(fake.rowsOf('cloud_git_state').length, 0, '不在范围内的项目连状态都写不进来');
});

test('结果回写：终态推进一次，重复回写忽略', async () => {
  const { fake, as } = await build();
  await call(as('owner-1'), '/commands/run_start', web({ external_id: 'prj-listed', question: 'q', command_id: 'cmd-r' }));
  await call(as(null), '/agent/heartbeat', agent(AGENT_TOKEN, {}));
  const beat = await call(as(null), '/agent/heartbeat', agent(AGENT_TOKEN, { results: [{ command_id: 'cmd-r', status: 'succeeded', result: { run_id: 'run-1', exit_code: 0 } }] }));
  assert.equal((beat.json.applied_results as Array<Record<string, unknown>>)[0]!.applied, true);
  const row = fake.rowsOf('cloud_command')[0]!;
  assert.equal(row.status, 'succeeded');
  assert.ok(row.finished_at);
  assert.deepEqual(row.result, { run_id: 'run-1', exit_code: 0 });

  const replay = await call(as(null), '/agent/heartbeat', agent(AGENT_TOKEN, { results: [{ command_id: 'cmd-r', status: 'failed', error: '迟到的失败' }] }));
  assert.equal((replay.json.applied_results as Array<Record<string, unknown>>)[0]!.reason, 'already_terminal');
  assert.equal(fake.rowsOf('cloud_command')[0]!.status, 'succeeded');
});

test('回写不属于自己的命令被当作不存在', async () => {
  const { fake, as } = await build();
  const other = fake.rowsOf('cloud_project')[1]!;
  fake.seed('cloud_command', {
    project_id: other.id,
    external_command_id: 'cmd-priv',
    type: 'run_cancel',
    payload: {},
    status: 'claimed',
    created_by: other.owner_id,
    created_at: new Date().toISOString(),
  });
  const beat = await call(as(null), '/agent/heartbeat', agent(AGENT_TOKEN, { results: [{ command_id: 'cmd-priv', status: 'succeeded' }] }));
  assert.equal((beat.json.applied_results as Array<Record<string, unknown>>)[0]!.reason, 'not_found');
  assert.equal(fake.rowsOf('cloud_command')[0]!.status, 'claimed');
});

test('领取后 15 分钟没有结果 = 租约过期，只标记不自动重排', async () => {
  const { fake, as } = await build();
  const stale = new Date(Date.now() - 16 * 60_000).toISOString();
  fake.seed('cloud_command', {
    project_id: fake.rowsOf('cloud_project')[0]!.id,
    external_command_id: 'cmd-stale',
    type: 'run_start',
    payload: { question: 'q' },
    status: 'claimed',
    created_by: fake.rowsOf('cloud_owner')[0]!.id,
    created_at: stale,
    claimed_at: stale,
  });
  const beat = await call(as(null), '/agent/heartbeat', agent(AGENT_TOKEN, {}));
  assert.deepEqual(beat.json.expired_commands, ['cmd-stale']);
  assert.equal(fake.rowsOf('cloud_command')[0]!.status, 'expired');
  // 重排等于重复花费，所以过期命令不会再被下发。
  assert.equal((beat.json.commands as unknown[]).length, 0);
});

test('长任务续租：running 心跳刷新租约但不领新命令', async () => {
  const { fake, as } = await build();
  await call(as('owner-1'), '/commands/run_start', web({ external_id: 'prj-listed', question: 'q', command_id: 'cmd-long' }));
  await call(as(null), '/agent/heartbeat', agent(AGENT_TOKEN, {}));
  const beat = await call(as(null), '/agent/command', agent(AGENT_TOKEN, { command_id: 'cmd-long', status: 'running' }));
  assert.equal(beat.json.status, 'running');
  assert.equal(fake.rowsOf('cloud_command')[0]!.status, 'running');
  assert.equal((await call(as(null), '/agent/command', agent(AGENT_TOKEN, { command_id: 'cmd-long', status: 'succeeded' }))).status, 400);
});

// --------------------------------------------------------------------------- 上报与读数

test('仓库状态与文件清单按最新一轮上报出示', async () => {
  const { fake, as } = await build();
  const first = await call(as(null), '/agent/heartbeat', agent(AGENT_TOKEN, { reported: { git: [{ external_id: 'prj-listed', branch: 'main', ahead: 2, dirty: true, staged: 1 }], files: [{ external_id: 'prj-listed', nodes: [{ path: 'papers/a.pdf', kind: 'paper', size: 10 }, { path: 'papers/gone.pdf', kind: 'paper', size: 5 }] }] } }));
  assert.equal(first.status, 200);
  const second = await call(as(null), '/agent/heartbeat', agent(AGENT_TOKEN, { reported: { files: [{ external_id: 'prj-listed', nodes: [{ path: 'papers/a.pdf', kind: 'paper', size: 12 }] }] } }));
  assert.deepEqual((second.json.applied_reported as Record<string, unknown>).files, ['prj-listed']);

  const repo = await call(as('owner-1'), '/views/repo?external_id=prj-listed');
  const git = repo.json.git as Record<string, unknown>;
  assert.equal(git.branch, 'main');
  assert.equal(git.ahead, 2);
  const files = repo.json.files as Array<Record<string, unknown>>;
  assert.equal(repo.json.file_count, 1, '上一轮已删除的文件不再出现');
  assert.equal(files[0]!.path, 'papers/a.pdf');
  assert.equal(files[0]!.size, 12);
});

test('Agent 在线状态：90 秒内算在线，本地有没有对应目录单独说', async () => {
  const { fake, as } = await build();
  await call(as(null), '/agent/heartbeat', agent(AGENT_TOKEN, { local_projects: [{ path: '/srv/p1', name: 'p1', external_id: 'prj-listed' }] }));
  const online = await call(as('owner-1'), '/views/agent?external_id=prj-listed');
  assert.equal(online.json.online, true);
  assert.equal(online.json.reported_for_project, true);

  const staleRow = fake.rowsOf('cloud_agent')[0]!;
  staleRow.last_seen_at = new Date(Date.now() - 10 * 60_000).toISOString();
  const offline = await call(as('owner-1'), '/views/agent?external_id=prj-listed');
  assert.equal(offline.json.online, false);
  assert.ok(offline.json.last_seen_at);
});

test('命令与仓库读数按可见性降级：L2 拿不到载荷，匿名拿不到仓库', async () => {
  const { fake, as } = await build();
  await call(as('owner-1'), '/commands/run_start', web({ external_id: 'prj-listed', question: 'L1 里的问题', command_id: 'cmd-vis' }));
  await call(as(null), '/agent/heartbeat', agent(AGENT_TOKEN, { reported: { git: [{ external_id: 'prj-listed', branch: 'secret-branch-name' }] } }));

  const anon = await call(as(null), '/views/commands?external_id=prj-listed');
  assert.equal(anon.json.projection_level, 'l2');
  assert.ok(!anon.raw.includes('L1 里的问题'), 'listed 的匿名读者不该看到命令载荷');
  assert.ok(!anon.raw.includes('secret-branch-name'));
  // 仓库面没有"L2 版本"：分支名、文件名整级都是 L1，降级后没有任何可出示的字段，
  // 所以宁可 403，也不给前端一个"看起来是空的"的读数。
  assert.equal((await call(as(null), '/views/repo?external_id=prj-listed')).code, 'no_access');
  assert.equal((await call(as(null), '/views/agent?external_id=prj-listed')).code, 'no_access');

  // 被邀读者按 §4 就是 full 读者：能看到 L1，但仍然不能写（上面的 403 已验）。
  fake.seed('cloud_grant', { owner_id: fake.rowsOf('cloud_owner')[1]!.id, project_id: fake.rowsOf('cloud_project')[0]!.id, revoked_at: null });
  const granted = await call(as('stranger-1'), '/views/repo?external_id=prj-listed');
  assert.equal(granted.status, 200);
  assert.equal((granted.json.git as Record<string, unknown>).branch, 'secret-branch-name');
  assert.equal((await call(as('stranger-1'), '/commands/git_commit', web({ external_id: 'prj-listed', message: '被邀读者不能提交' }))).status, 403);
});

test('未知路径仍然 404，命令面没有兜底成功', async () => {
  const { as } = await build();
  assert.equal((await call(as('owner-1'), '/commands/')).code, 'not_found');
  assert.equal((await call(as('owner-1'), '/projects/prj-listed', { method: 'DELETE' })).code, 'not_found');
  assert.equal((await call(as('owner-1'), '/files/papers/a.pdf')).code, 'not_found');
});

// --------------------------------------------------------------------------- 首页（无项目锚点）

test('首页视图：待创建队列与本机在线状态不挂在某个项目上', async () => {
  const { fake, as } = await build();
  await call(as('owner-1'), '/projects', web({ command_id: 'cmd-new', name: '新项目', question: '排队之后才存在' }));
  // 别人排的创建请求不属于自己的队列：按 created_by 过滤，否则首页会串号。
  const strangerOwner = fake.rowsOf('cloud_owner')[1]!;
  fake.seed('cloud_command', {
    project_id: null,
    external_command_id: 'cmd-new-stranger',
    type: 'project_create',
    payload: { name: '别人的新项目' },
    status: 'queued',
    created_by: strangerOwner.id,
    created_at: new Date().toISOString(),
  });

  const before = await call(as('owner-1'), '/views/commands?external_id=');
  assert.equal(before.status, 200);
  assert.deepEqual(before.json.commands, [], '全局视图不掺项目命令');
  const queued = before.json.provisioning as Array<Record<string, unknown>>;
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.name, '新项目');
  assert.equal(queued[0]!.status, 'queued');

  await call(as(null), '/agent/heartbeat', agent(AGENT_TOKEN, { agent_version: '0.1.0', local_projects: [{ path: '/srv/p1', name: 'p1', external_id: 'prj-listed' }] }));

  // 领取之后仍未落到投影，所以它还该留在待创建里，只是状态换了——消失会被读成"没排过"。
  const after = await call(as('owner-1'), '/views/commands?external_id=');
  const claimedRow = (after.json.provisioning as Array<Record<string, unknown>>)[0]!;
  assert.equal(claimedRow.status, 'claimed');

  const presence = await call(as('owner-1'), '/views/agent?external_id=');
  assert.equal(presence.json.online, true);
  assert.equal(presence.json.agent_version, '0.1.0');
  assert.equal((presence.json.local_projects as unknown[]).length, 1);
  assert.equal(presence.json.reported_for_project, false, '没有项目可比，就不假装有');

  // 未登录时是 401，不是一个看起来"没有待创建"的空读数。
  assert.equal((await call(as(null), '/views/commands?external_id=')).code, 'login_required');
  assert.equal((await call(as(null), '/views/agent?external_id=')).code, 'login_required');

  // 仓库面仍然必须带项目：没有 project_id 就找不到任何上报行。
  assert.equal((await call(as('owner-1'), '/views/repo?external_id=')).code, 'invalid_input');
});

// --------------------------------------------------------------------------- Phase 7：高级 git

test('git 载荷只钉机械不变量：ref 形状、主分支保护、不丢弃改动、合并策略白名单', async () => {
  const { fake, as } = await build();
  const handle = as('owner-1');
  const post = (type: string, body: Record<string, unknown>) => call(handle, `/commands/${type}`, web({ external_id: 'prj-listed', ...body }));

  assert.equal((await post('git_checkout', { branch: 'feature/x' })).status, 200);
  // 以 `-` 开头会被 git 当成开关；`@{`/空格是 rev-parse 语法：都拼不进 argv。
  assert.equal((await post('git_checkout', { branch: '-b' })).status, 400, '开关形状的分支名');
  assert.equal((await post('git_checkout', { branch: 'feature@{1}' })).status, 400, 'rev-parse 表达式');
  assert.equal((await post('git_checkout', { branch: 'a b' })).status, 400, '带空格的分支名');
  assert.equal((await post('git_checkout', { branch: 'main', discard_uncommitted: true })).status, 400, '丢弃改动不在云端能力里');
  // 未知字段被丢掉，不透传给 Agent。
  const sneak = await call(handle, '/commands/git_merge', web({ external_id: 'prj-listed', target: 'feature/x', strategy: 'squash', force: true }));
  assert.equal(sneak.status, 200);
  const queued = fake.rowsOf('cloud_command');
  assert.ok(!JSON.stringify(queued.at(-1)!.payload).includes('force'), '载荷里没有 force 的容身之处');

  assert.equal((await post('git_branch_delete', { name: 'main' })).status, 400, '主分支删不掉');
  assert.equal((await post('git_branch_delete', { name: 'feature/x' })).status, 200);
  assert.equal((await post('git_merge', { target: 'feature/x', strategy: 'rebase' })).status, 400, '策略只有三档');
  assert.equal((await post('git_merge_abort', {})).status, 200);
  assert.equal((await post('git_fetch', { remote: 'origin', prune: true })).status, 200);
  assert.equal((await post('git_branch', { name: 'release/1.2', from: 'main' })).status, 200);
  assert.equal((await post('git_branch', { name: 'release/1.2', from: '../etc/passwd' })).status, 400, 'base 也要过 ref 形状');
});

test('分支、冲突与远端上报：只留 ref 名与路径，正文与凭据型 URL 进不来', async () => {
  const { fake, as } = await build();
  const beat = await call(as(null), '/agent/heartbeat', agent(AGENT_TOKEN, {
    reported: {
      git: [
        {
          external_id: 'prj-listed',
          branch: 'main',
          dirty: false,
          branches: [{ name: 'main', current: true, ahead: 0, behind: 2 }, { name: 'ok/branch' }, { name: '-i/evil' }, { name: '../escape' }],
          conflicts: ['src/model.py', '../../etc/passwd', 'papers/论文.pdf'],
          remotes: ['origin', { name: 'upstream' }, 'https://user:tok3n@host/private.git'],
        },
      ],
    },
  }));
  assert.equal(beat.status, 200);
  assert.deepEqual((beat.json.applied_reported as Record<string, unknown>).git, ['prj-listed']);

  const view = await call(as('owner-1'), '/views/repo?external_id=prj-listed');
  const git = view.json.git as Record<string, unknown>;
  const names = (git.branches as Array<Record<string, unknown>>).map((entry) => entry.name);
  assert.deepEqual(names, ['main', 'ok/branch'], '形状不对的分支条目丢掉，不整条拒绝');
  assert.deepEqual(git.conflicts, ['src/model.py', 'papers/论文.pdf'], '越界路径丢掉，正文本来就不在这一级');
  assert.deepEqual(git.remotes, ['origin', 'upstream']);
  assert.ok(!JSON.stringify(view.json).includes('host/private'), 'remote URL 不落库：带凭据的地址不能被读出来');
  assert.equal(fake.rowsOf('cloud_git_state').length, 1);
});

// --------------------------------------------------------------------------- M0.3 云端执行（真）

test('云端 project_create 写真实投影：项目 + 运行 + 阶段 + 事件 + outbox', async () => {
  const { fake, as } = await build();
  const commandId = crypto.randomUUID();
  const res = await call(as('owner-1'), '/projects', web({
    command_id: commandId,
    name: '云端测试项目',
    question: '验证真执行',
    strategy: 'starter',
    autonomy: 'autonomous',
  }));
  assert.equal(res.status, 200, `期望 200，实际 ${res.status}: ${res.raw}`);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.cloud_executed, true, '必须真执行，不是假成功');
  assert.ok(res.json.project_external_id, '返回 project_external_id');
  assert.ok(res.json.run_external_id, '返回 run_external_id');

  // 验证投影行全部写入
  const projects = fake.rowsOf('cloud_project');
  assert.equal(projects.length, 3, '新增 1 个项目（原有 2 个夹具）');
  const created = projects.find((p) => p.external_id === res.json.project_external_id);
  assert.ok(created, '项目行存在');
  assert.equal(created.title, '云端测试项目');
  assert.equal(created.strategy, 'starter');
  assert.equal(created.autonomy, 'autonomous');
  assert.equal(created.visibility, 'private');

  const runs = fake.rowsOf('cloud_run');
  assert.equal(runs.length, 1, '新增 1 个运行');
  assert.equal(runs[0].external_run_id, res.json.run_external_id);
  assert.equal(runs[0].status, 'created');
  assert.equal(runs[0].phase_tag, 'INIT');

  const stages = fake.rowsOf('cloud_stage_progress');
  assert.equal(stages.length, 1, '新增 1 个阶段');
  assert.equal(stages[0].stage, 'INIT');
  assert.equal(stages[0].state, 'active');

  const events = fake.rowsOf('cloud_run_event');
  assert.equal(events.length, 1, '新增 1 个事件');
  assert.equal(events[0].type, 'project_created');
  assert.equal(events[0].seq, 1);

  const outbox = fake.rowsOf('live_outbox');
  assert.equal(outbox.length, 1, '新增 1 个 outbox 帧');
  assert.equal(outbox[0].frame_type, 'state');

  const commands = fake.rowsOf('cloud_command');
  const cmd = commands.find((c) => c.external_command_id === commandId);
  assert.ok(cmd, '命令行存在');
  assert.equal(cmd.status, 'succeeded');
  assert.equal(cmd.project_id, created.id, '命令关联到项目');
  assert.equal((cmd.result as Record<string, unknown>).cloud_executed, true);
});

test('云端 project_create 幂等回放：同 command_id 不重复创建', async () => {
  const { fake, as } = await build();
  const commandId = crypto.randomUUID();
  const body = {
    command_id: commandId,
    name: '幂等测试',
    question: null,
    strategy: 'standard',
    autonomy: 'guided',
  };
  const first = await call(as('owner-1'), '/projects', web(body));
  assert.equal(first.status, 200);
  const firstProjectId = first.json.project_external_id;

  const second = await call(as('owner-1'), '/projects', web(body));
  assert.equal(second.status, 200);
  assert.equal(second.json.replayed, true, '第二次调用返回 replayed=true');
  assert.equal(second.json.project_external_id, firstProjectId, '返回同一个 project_external_id');

  const projects = fake.rowsOf('cloud_project');
  assert.equal(projects.length, 3, '没有新增项目（原有 2 个夹具 + 第一次创建 1 个）');
});

test('云端 project_create 缺 name 返回 400', async () => {
  const { as } = await build();
  const res = await call(as('owner-1'), '/projects', web({
    command_id: crypto.randomUUID(),
    question: '没有名字',
    strategy: 'standard',
    autonomy: 'guided',
  }));
  assert.equal(res.status, 400);
  assert.ok(res.code.includes('invalid_input'), `错误码包含 invalid_input: ${res.code}`);
});

test('云端 project_create：研究问题留空（空串）等于没填，不是 400', async () => {
  const { fake, as } = await build();
  const res = await call(as('owner-1'), '/projects', web({
    command_id: crypto.randomUUID(),
    name: '没写研究问题的项目',
    question: '',
    strategy: 'standard',
    autonomy: 'guided',
  }));
  // 前端始终带 question 字段，空串必须与省略同义，否则"不写研究问题"建不了项目。
  assert.equal(res.status, 200, `空串应等价于省略字段，实际 ${res.status}: ${res.raw}`);
  assert.equal(res.json.cloud_executed, true);

  const created = fake.rowsOf('cloud_project').find((p) => p.title === '没写研究问题的项目');
  assert.ok(created, '项目行已写入');
  assert.equal(created.question, null, '没填就是 null，不落空串');
  assert.equal(fake.rowsOf('cloud_run')[0]!.question, null, '运行同样不带研究问题');
});

test('云端 project_settings：清空研究问题（空串）不是 400', async () => {
  const { fake, as } = await build();
  const res = await call(as('owner-1'), '/commands/project_settings', web({ external_id: 'prj-listed', question: '' }));
  assert.equal(res.status, 200, `清空应被接受，实际 ${res.status}: ${res.raw}`);
  assert.deepEqual(fake.rowsOf('cloud_command')[0]!.payload, { question: null });
});

test('云端 project_create 的 command CAS 更新：并发重入只有一个成功', async () => {
  const { fake, as } = await build();
  const commandId = crypto.randomUUID();
  const body = {
    command_id: commandId,
    name: 'CAS 测试',
    question: null,
    strategy: 'starter',
    autonomy: 'guided',
  };

  // 模拟并发：两个请求同时到达（fake-db 是单线程，但测试 CAS 逻辑）
  const [first, second] = await Promise.all([
    call(as('owner-1'), '/projects', web(body)),
    call(as('owner-1'), '/projects', web(body)),
  ]);

  // 两个都应该成功（幂等回放），但只有一个真正创建
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);

  const projects = fake.rowsOf('cloud_project');
  const created = projects.filter((p) => p.external_id.startsWith('proj-'));
  assert.equal(created.length, 1, '只创建了 1 个项目');

  // 第二次调用应该返回 replayed=true
  const replayed = [first, second].find((r) => r.json.replayed === true);
  assert.ok(replayed, '至少有一个返回 replayed=true');
});
