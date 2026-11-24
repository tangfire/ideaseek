/**
 * 项目 CRUD 的写面（AUTH_AND_CRUD_REFACTOR_PLAN.md §5.2-5.3）。
 *
 * 三条主线：改（PATCH，含越权与空 patch）、归档（DELETE + 标题确认 + 幂等）、
 * 恢复（restore）。每条都钉住"归档 = 对外不存在"——读路径全 404 是 D4 软删的判据，
 * 少一条都会退化成"只是列表里看不见"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { application } from '../routes.ts';
import type { SiteContext } from '../routes.ts';
import { createFakeDb } from '../dev/fake-db.ts';
import { ensureSession, withSession } from '../dev/test-session.ts';

async function build() {
  const fake = createFakeDb();
  const owner = fake.seed('cloud_owner', { email: 'owner-1', display_name: null });
  const stranger = fake.seed('cloud_owner', { email: 'stranger-1', display_name: null });
  const project = fake.seed('cloud_project', {
    owner_id: owner.id,
    external_id: 'prj-mine',
    title: '我的项目',
    question: '原来的问题',
    strategy: 'standard',
    autonomy: 'guided',
    visibility: 'private',
    archived_at: null,
    last_sync_at: '2026-11-24T00:00:00.000Z',
  });
  const other = fake.seed('cloud_project', {
    owner_id: stranger.id,
    external_id: 'prj-theirs',
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

  return { fake, as, owner, stranger, project, other };
}

interface CallResult {
  status: number;
  raw: string;
  json: Record<string, unknown>;
  code: string;
}

async function call(handle: (ctx: SiteContext) => Promise<Response>, path: string, init?: RequestInit): Promise<CallResult> {
  try {
    const response = await handle({ request: new Request(`https://site.test/functions/v1/app${path}`, init), requestId: 'test' });
    const raw = await response.text();
    const json = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    return { status: response.status, raw, json, code: String(json.code ?? '') };
  } catch (error) {
    const thrown = error as { code?: string; status?: number };
    const code = thrown.code ?? 'internal';
    return { status: thrown.status ?? 500, raw: '', json: { code }, code };
  }
}

const web = (json: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) });
const patch = (json: unknown): RequestInit => ({ method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) });
const del = (): RequestInit => ({ method: 'DELETE' });

// --------------------------------------------------------------------------- 改

test('PATCH 改标题与研究问题：保存即生效，并在台账留一行 succeeded', async () => {
  const { fake, as } = await build();
  const res = await call(as('owner-1'), '/projects/prj-mine', patch({ title: '改过的标题', question: '新的问题' }));
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.json.project && (res.json.project as { title: string }).title, '改过的标题');

  const row = fake.rowsOf('cloud_project').find((p) => p.external_id === 'prj-mine')!;
  assert.equal(row.title, '改过的标题', '投影立即更新，不排队');
  assert.equal(row.question, '新的问题');

  const audit = fake.rowsOf('cloud_command').find((c) => c.type === 'project_settings');
  assert.ok(audit, '台账要看得见这次改动');
  assert.equal(audit.status, 'succeeded');
  assert.equal(audit.project_id, row.id);
});

test('PATCH 的边界：匿名 401、别人 404、空 patch 400、非法枚举 400', async () => {
  const { fake, as } = await build();

  const anon = await call(as(null), '/projects/prj-mine', patch({ title: 'x' }));
  assert.equal(anon.status, 401, '没有会话不能改');

  const before = fake.rowsOf('cloud_project').find((p) => p.external_id === 'prj-mine')!.title;
  const stranger = await call(as('stranger-1'), '/projects/prj-mine', patch({ title: '越权改名' }));
  assert.equal(stranger.status, 404, '非 owner 按不存在处理，不泄露存在性');
  assert.equal(fake.rowsOf('cloud_project').find((p) => p.external_id === 'prj-mine')!.title, before, '一行都不该被改');

  const empty = await call(as('owner-1'), '/projects/prj-mine', patch({}));
  assert.equal(empty.status, 400);
  assert.equal(empty.code, 'invalid_input:project_settings.empty_patch');

  const badEnum = await call(as('owner-1'), '/projects/prj-mine', patch({ visibility: 'public' }));
  assert.equal(badEnum.status, 400, 'Q1 只有三档');
});

// --------------------------------------------------------------------------- 归档

test('归档：确认标题才删得掉，读路径全 404，重复归档幂等', async () => {
  const { fake, as } = await build();

  const noConfirm = await call(as('owner-1'), '/projects/prj-mine', del());
  assert.equal(noConfirm.status, 400, '不带确认不许归档');
  assert.equal(noConfirm.code, 'invalid_input:project.confirm');

  const wrong = await call(as('owner-1'), `/projects/prj-mine?confirm=${encodeURIComponent('打错了')}`, del());
  assert.equal(wrong.status, 400, '标题对不上不许归档');

  const stranger = await call(as('stranger-1'), `/projects/prj-mine?confirm=${encodeURIComponent('我的项目')}`, del());
  assert.equal(stranger.status, 404, '别人动不了你的项目');
  assert.equal(fake.rowsOf('cloud_project').find((p) => p.external_id === 'prj-mine')!.archived_at, null);

  const done = await call(as('owner-1'), `/projects/prj-mine?confirm=${encodeURIComponent('我的项目')}`, del());
  assert.equal(done.status, 200, done.raw);
  assert.equal(done.json.archived, true);
  assert.ok(fake.rowsOf('cloud_project').find((p) => p.external_id === 'prj-mine')!.archived_at, '归档标记落库');

  // 读路径：项目视图 / 列表 / 成本 三处按"不存在"处理；审批是 Owner 聚合视图，
  // 归档项目的条目不再出现（不是 404，因为它本来就不按单项目寻址）。
  assert.equal((await call(as('owner-1'), '/views/project?external_id=prj-mine')).status, 404, '项目视图 404');
  const index = await call(as('owner-1'), '/views/index');
  const ids = (index.json.projects as { external_id: string }[]).map((p) => p.external_id);
  assert.ok(!ids.includes('prj-mine'), '列表里消失');
  assert.equal((await call(as('owner-1'), '/views/costs?external_id=prj-mine')).status, 404, '成本视图 404');
  const approvals = await call(as('owner-1'), '/views/approvals');
  assert.deepEqual(approvals.json.approvals, [], '归档项目的审批从聚合里消失');
  // 归档后也不能再改
  assert.equal((await call(as('owner-1'), '/projects/prj-mine', patch({ title: 'x' }))).status, 404, '归档项目不可改');

  const again = await call(as('owner-1'), `/projects/prj-mine?confirm=${encodeURIComponent('我的项目')}`, del());
  assert.equal(again.status, 200);
  assert.equal(again.json.archived, false, '重复归档是幂等的，不是 409');
  assert.equal(fake.rowsOf('cloud_command').filter((c) => c.type === 'project_archive').length, 1, '台账不重复记账');
});

test('恢复：清掉归档标记，读路径与编辑能力都回来', async () => {
  const { fake, as } = await build();
  await call(as('owner-1'), `/projects/prj-mine?confirm=${encodeURIComponent('我的项目')}`, del());

  const stranger = await call(as('stranger-1'), '/projects/prj-mine/restore', web({}));
  assert.equal(stranger.status, 404, '别人不能恢复你的项目');

  const restored = await call(as('owner-1'), '/projects/prj-mine/restore', web({}));
  assert.equal(restored.status, 200, restored.raw);
  assert.equal(restored.json.restored, true);
  assert.equal(fake.rowsOf('cloud_project').find((p) => p.external_id === 'prj-mine')!.archived_at, null);

  assert.equal((await call(as('owner-1'), '/views/project?external_id=prj-mine')).status, 200, '读路径回来');
  assert.equal((await call(as('owner-1'), '/projects/prj-mine', patch({ title: '恢复后再改' }))).status, 200, '编辑能力回来');
  assert.ok(fake.rowsOf('cloud_command').some((c) => c.type === 'project_restore'), '恢复也留痕');

  const again = await call(as('owner-1'), '/projects/prj-mine/restore', web({}));
  assert.equal(again.json.restored, false, '没归档时恢复是幂等的');
});

test('归档是数据保留的软删：行还在，只是对外不存在', async () => {
  const { fake, as } = await build();
  await call(as('owner-1'), `/projects/prj-mine?confirm=${encodeURIComponent('我的项目')}`, del());

  const row = fake.rowsOf('cloud_project').find((p) => p.external_id === 'prj-mine');
  assert.ok(row, 'D4：软删保留数据，项目行不删');
  assert.ok(row.archived_at, '靠 archived_at 标记，随时可恢复');
  assert.ok(fake.rowsOf('cloud_project').some((p) => p.external_id === 'prj-theirs'), '别人的项目一行都不受影响');
});
