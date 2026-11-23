/**
 * 协作与分享（Phase 9）的本地回归：谁能读、读到哪一级、撤销之后立刻算什么。
 *
 * 与 commands.test.ts 同一套夹具：浏览者走 `getUser` 注入，写权限只认 Owner。
 * 这里刻意把"role=viewer 的读者读到哪一级"当成主断言——邀请时的权限选择如果最后
 * 落到同一个读级上，那这一档就是假的，界面上的下拉框等于装饰。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { application } from '../routes.ts';
import type { SiteContext } from '../routes.ts';
import { createFakeDb, sha256Hex } from '../dev/fake-db.ts';

async function build() {
  const fake = createFakeDb();
  const owner = fake.seed('cloud_owner', { email: 'owner@example.com', display_name: null });
  fake.seed('cloud_owner', { email: 'stranger@example.com', display_name: null });
  const project = fake.seed('cloud_project', {
    owner_id: owner.id,
    external_id: 'prj-a',
    title: '一个项目',
    question: '只有读者与 Owner 能看到的问题',
    strategy: 'standard',
    autonomy: 'guided',
    visibility: 'private',
    archived_at: null,
    last_sync_at: '2026-11-23T00:00:00.000Z',
  });
  fake.seed('cloud_run', {
    project_id: project.id,
    external_run_id: 'run-1',
    status: 'QUOTA_EXHAUSTED',
    phase_tag: 'EXPERIMENTING',
    stage_known: true,
    question: 'L1 里的问题',
    block_reason: 'quota',
    block_detail: null,
    started_at: '2026-11-23T00:00:00.000Z',
    finished_at: null,
    heartbeat_at: null,
    budget_usd_micro: 5_000_000,
    spent_usd_micro: 4_900_000,
    summary: '一条只有 full 读级该看到的摘要',
  });
  fake.seed('cloud_command', {
    project_id: project.id,
    external_command_id: 'cmd-audit-1',
    type: 'git_commit',
    payload: { message: '本地提交' },
    status: 'succeeded',
    created_by: owner.id,
    created_at: '2026-11-23T01:00:00.000Z',
    claimed_at: '2026-11-23T01:00:10.000Z',
    finished_at: '2026-11-23T01:00:30.000Z',
    result: { commit: 'abcdef1234567890' },
    error: '第一行错误\n第二行带 /home/owner/私有路径',
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

  return { fake, as, owner, project };
}

async function call(handle: (ctx: SiteContext) => Promise<Response>, path: string, init?: RequestInit) {
  try {
    const response = await handle({ request: new Request(`https://site.test/functions/v1/app${path}`, init), requestId: 'test' });
    const raw = await response.text();
    return { status: response.status, raw, json: raw ? (JSON.parse(raw) as Record<string, unknown>) : {}, code: raw ? String((JSON.parse(raw) as Record<string, unknown>).code ?? '') : '' };
  } catch (error) {
    const thrown = error as { code?: string; status?: number };
    return { status: thrown.status ?? 500, raw: JSON.stringify({ code: thrown.code }), json: {}, code: thrown.code ?? 'internal' };
  }
}

const web = (json: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) });
const del = (json?: unknown): RequestInit => ({ method: 'DELETE', headers: json ? { 'content-type': 'application/json' } : undefined, body: json ? JSON.stringify(json) : undefined });

test('邀请 reviewer：读到 full，包括 L1 的运行状态与摘要', async () => {
  const { as } = await build();
  const created = await call(as('owner@example.com'), '/access/grants', web({ external_id: 'prj-a', email: 'Reader@Example.com', role: 'reviewer' }));
  assert.equal(created.status, 200);
  assert.equal(created.json.replayed, undefined);

  const grants = await call(as('owner@example.com'), '/views/access?external_id=prj-a');
  const listed = (grants.json.grants as Array<Record<string, unknown>>)[0]!;
  assert.equal(listed.email, 'reader@example.com', '邮箱归一化成小写再入库');
  assert.equal(listed.joined, false, '还没登录过的人不能显示成"已生效"');

  // 用邀请里的邮箱登录：按 email 那条匹配路径接上，不需要谁回来回填 owner_id。
  const read = await call(as('reader@example.com'), '/views/project?external_id=prj-a');
  assert.equal(read.status, 200);
  assert.equal(read.json.projection_level, 'full');
  assert.ok(read.raw.includes('一条只有 full 读级该看到的摘要'));
});

test('邀请 viewer：能打开项目，但只能读到 L2', async () => {
  const { as } = await build();
  await call(as('owner@example.com'), '/access/grants', web({ external_id: 'prj-a', email: 'lite@example.com', role: 'viewer' }));
  const read = await call(as('lite@example.com'), '/views/project?external_id=prj-a');
  assert.equal(read.status, 200, 'role=viewer 不是拒绝，是降级');
  assert.equal(read.json.projection_level, 'l2');
  assert.ok(!read.raw.includes('一条只有 full 读级该看到的摘要'), 'L1 字段在 Function 里就不选，不是前端隐藏');
  assert.ok(!read.raw.includes('quota'));
});

test('撤销邀请：下一次请求就读不到，不是等缓存过期', async () => {
  const { as, fake } = await build();
  await call(as('owner@example.com'), '/access/grants', web({ external_id: 'prj-a', email: 'lite@example.com' }));
  const list = await call(as('owner@example.com'), '/views/access?external_id=prj-a');
  const grantId = String((list.json.grants as Array<Record<string, unknown>>)[0]!.id);
  assert.ok(grantId && grantId !== 'undefined');

  assert.equal((await call(as('owner@example.com'), `/access/grants/${grantId}?external_id=prj-a`, del())).status, 200);
  assert.equal((await call(as('lite@example.com'), '/views/project?external_id=prj-a')).code, 'no_access', '撤销后读不到');
  // lite 第一次请求时已按需建了 cloud_owner 行，于是"有身份"：按 views.ts 的既有约定
  // 保留 403——这个项目存在过她本来就知道，报 404 反而指不清方向。
  assert.equal((await call(as(null), '/views/project?external_id=prj-a')).code, 'not_found', '完全匿名才当作不存在（F5.5 的推广）');

  // 重复撤销不报错也不改时间：终态就是终态。
  const again = await call(as('owner@example.com'), `/access/grants/${grantId}?external_id=prj-a`, del());
  assert.equal(again.json.ignored, 'already_revoked');
  assert.equal(fake.rowsOf('cloud_grant').length, 1, '重复邀请不产生第二行');

  // 重新邀请 = 点亮同一行，读权限恢复。
  await call(as('owner@example.com'), '/access/grants', web({ external_id: 'prj-a', email: 'lite@example.com' }));
  assert.equal(fake.rowsOf('cloud_grant').length, 1);
  assert.equal((await call(as('lite@example.com'), '/views/project?external_id=prj-a')).status, 200);
});

test('邀请载荷：形状不对就 400，自己的邮箱不能邀请自己', async () => {
  const { as } = await build();
  const bad = ['not-an-email', 'a@b', 'a b@example.com', 'x@y,z@example.com', ''];
  for (const email of bad) {
    assert.equal((await call(as('owner@example.com'), '/access/grants', web({ external_id: 'prj-a', email }))).status, 400, `${email} 不该被当成邮箱`);
  }
  assert.equal((await call(as('owner@example.com'), '/access/grants', web({ external_id: 'prj-a', email: 'owner@example.com' }))).code, 'invalid_input:grant.self');
  assert.equal((await call(as('owner@example.com'), '/access/grants', web({ external_id: 'prj-a', email: 'x@example.com', role: 'editor' }))).code, 'invalid_input:grant.role');
  assert.equal((await call(as('owner@example.com'), '/access/grants', web({ email: 'x@example.com' }))).code, 'invalid_input:external_id');
});

test('只有 Owner 能改 ACL：被邀读者、陌生登录者、匿名各走各的拒绝码', async () => {
  const { as } = await build();
  await call(as('owner@example.com'), '/access/grants', web({ external_id: 'prj-a', email: 'lite@example.com' }));

  // 被邀读者能读，不能转发读权限——这一条如果被漏掉，L1 的扩散速度就取决于任何一个读者。
  assert.equal((await call(as('lite@example.com'), '/access/grants', web({ external_id: 'prj-a', email: 'other@example.com' }))).code, 'no_access');
  assert.equal((await call(as('lite@example.com'), '/views/access?external_id=prj-a')).code, 'no_access');
  // 陌生登录者同样是 403 而不是 404：这不是新决定，是全仓既有约定
  // （commands.ts 的写面、views.ts:150-157 同一套；commands.test.ts:120 已钉住）。
  // 代价是登录者能用状态码探到某个 external_id 有 private 项目——要收紧就得同时改
  // 所有视图，那是独立一轮，不在这里偷偷改一个面造成两种语义。
  assert.equal((await call(as('stranger@example.com'), '/views/access?external_id=prj-a')).code, 'no_access', '与项目无关的登录者按既有约定保留 403');
  assert.equal((await call(as(null), '/access/grants', web({ external_id: 'prj-a', email: 'other@example.com' }))).code, 'not_found');
});

test('分享链接：明文只出现一次，库里只有哈希，撤销后立刻读不通', async () => {
  const { fake, as } = await build();
  // private 项目直接造链接会被拒：canRead 只在非 private 上认 share token。
  assert.equal((await call(as('owner@example.com'), '/access/share', web({ external_id: 'prj-a' }))).code, 'invalid_input:share.private');

  const settings = await call(as('owner@example.com'), '/commands/project_settings', web({ external_id: 'prj-a', visibility: 'link' }));
  assert.equal(settings.status, 200);
  // 可见性是排队命令，投影由本地引擎回写；测试里直接改行，模拟"Agent 已经执行完"。
  fake.rowsOf('cloud_project')[0]!.visibility = 'link';

  const share = await call(as('owner@example.com'), '/access/share', web({ external_id: 'prj-a' }));
  assert.equal(share.status, 200);
  const plain = String(share.json.plain_token);
  assert.match(plain, /^[0-9a-f]{32}$/, '链接里那串必须够长，猜得到就等于没分享');
  const stored = fake.rowsOf('cloud_share_token')[0]!;
  assert.equal(stored.token_hash, await sha256Hex(plain));
  assert.ok(!JSON.stringify(stored).includes(plain), '明文不入库');

  const viaLink = await call(as(null), `/views/project?external_id=prj-a&share=${plain}`);
  assert.equal(viaLink.status, 200);
  assert.equal(viaLink.json.projection_level, 'l2', '未记名链接永远到不了 full：那等于把 L1 交给转发');

  const list = await call(as('owner@example.com'), '/views/access?external_id=prj-a');
  const shareId = String((list.json.shares as Array<Record<string, unknown>>)[0]!.id);
  assert.ok(!list.raw.includes(plain), '列表里读不回明文，只能撤销再生成');

  assert.equal((await call(as('owner@example.com'), `/access/share/${shareId}?external_id=prj-a`, del())).status, 200);
  assert.equal((await call(as(null), `/views/project?external_id=prj-a&share=${plain}`)).code, 'not_found', '撤销即当作不存在（F5.5）');
});

test('操作台账：只列自己排的命令，错误只给首行', async () => {
  const { fake, as } = await build();
  const stranger = fake.rowsOf('cloud_owner')[1]!;
  fake.seed('cloud_command', {
    project_id: null,
    external_command_id: 'cmd-stranger',
    type: 'project_create',
    payload: { name: '别人的项目' },
    status: 'queued',
    created_by: stranger.id,
    created_at: '2026-11-23T02:00:00.000Z',
    result: null,
    error: null,
  });

  const view = await call(as('owner@example.com'), '/views/commands?external_id=');
  const audit = view.json.audit as Array<Record<string, unknown>>;
  assert.equal(audit.length, 1, '别人的命令不出现在我的台账里');
  assert.equal(audit[0]!.command_id, 'cmd-audit-1');
  assert.equal(audit[0]!.project, 'prj-a', '台账要能指到项目，而不是一串 uuid');
  assert.equal(audit[0]!.status, 'succeeded');
  assert.equal(audit[0]!.error, '第一行错误', '第二行的本地路径不外泄');
  assert.ok(!JSON.stringify(audit).includes('/home/owner'));
});
