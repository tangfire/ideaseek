/**
 * 协作与分享（Phase 9）：受邀读者与未记名分享链接。
 *
 * 与命令队列相反的写入方向：`cloud_grant` / `cloud_share_token` 是**云端自己的
 * ACL**，不是投影表——本地引擎从来不写它们，删掉它们也不影响从 workflow.sqlite
 * 重建投影。所以这两张表允许 Owner 直接写（commands.ts 的第 3 条边界针对的
 * 是 cloud_project/cloud_run 那一类）。写权限仍然只有 Owner：被邀读者是**读**授权，
 * 平台没有 editor 这一档（Q1/§4），role 只在 reviewer（L1 full）与 viewer（L2 降级）
 * 之间选，选不出第三种写权限。
 *
 * 第二件事：分享链接的明文只在创建响应里出现一次，库里只有哈希（NFR-02 的同一
 * 条理由）。撤销后的行为是"当作不存在"，不是"无权限"——`external_id` 就是本地
 * 目录名，403 会把它存在过这件事说出来。
 */
import type { BackendErrorLike, Db } from './deps.ts';
import { rows } from './deps.ts';
import type { Viewer } from './views.ts';
import { byExternalId, deniesAsAbsent } from './views.ts';

const GRANT_ROLES = ['reviewer', 'viewer'] as const;
type GrantRole = (typeof GRANT_ROLES)[number];

interface GrantRow {
  id: string;
  project_id: string;
  email: string | null;
  owner_id: string | null;
  role: string | null;
  created_at: string;
  revoked_at: string | null;
}

interface ShareRow {
  id: string;
  project_id: string;
  created_by: string | null;
  created_at: string;
  revoked_at: string | null;
}

/** 只钉机械不变量：形状、长度、小写归一。邮箱是否真实存在不是云端能判断的。 */
function normalizeEmail(value: unknown, BackendError: BackendErrorLike): string {
  if (typeof value !== 'string') throw new BackendError('invalid_input:grant.email', 400);
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@,;]+@[^\s@,;.]+(\.[^\s@,;.]+)+$/.test(email)) {
    throw new BackendError('invalid_input:grant.email', 400);
  }
  return email;
}

function normalizeRole(value: unknown, BackendError: BackendErrorLike): GrantRole {
  const role = value === undefined ? 'reviewer' : String(value);
  if (!(GRANT_ROLES as readonly string[]).includes(role)) throw new BackendError('invalid_input:grant.role', 400);
  return role as GrantRole;
}

/** 项目 + Owner 两道门：不是自己的项目就按 deniesAsAbsent 的既有语义拒绝。 */
async function ownedProject(db: Db, viewer: Viewer, externalId: string, BackendError: BackendErrorLike) {
  const project = await byExternalId(db, externalId, BackendError);
  if (!project) throw new BackendError('not_found', 404);
  if (!viewer.ownerId || viewer.ownerId !== project.owner_id) {
    throw new BackendError(deniesAsAbsent(viewer) ? 'not_found' : 'no_access', deniesAsAbsent(viewer) ? 404 : 403);
  }
  return project;
}

/** Owner 自己的邮箱：用来挡住"把自己邀请成读者"这条看似无害实则误导的路径。 */
async function ownerEmail(db: Db, ownerId: string, BackendError: BackendErrorLike): Promise<string | null> {
  const row = rows<{ email: string | null }>(
    await db.from<{ email: string | null }>('cloud_owner').select('email').eq('id', ownerId).limit(1),
    BackendError,
  )[0];
  return row?.email ?? null;
}

export async function accessView(db: Db, viewer: Viewer, externalId: string, BackendError: BackendErrorLike): Promise<Response> {
  const project = await ownedProject(db, viewer, externalId, BackendError);

  const grants = rows<GrantRow>(
    await db.from<GrantRow>('cloud_grant').select('*').eq('project_id', project.id).order('created_at', { ascending: false }).limit(100),
    BackendError,
  );
  const shares = rows<ShareRow>(
    await db.from<ShareRow>('cloud_share_token').select('id,project_id,created_by,created_at,revoked_at').eq('project_id', project.id).order('created_at', { ascending: false }).limit(50),
    BackendError,
  );

  // "已登录" = 这个邮箱在云端有 cloud_owner 行。按邮箱逐个查而不是拉全表：
  // owner_id 只在邀请时解析得到，之后对方第一次登录并不会回填那一列，
  // 只看 owner_id 会把"已经能读的人"显示成"邀请还没生效"。
  const emails = [...new Set(grants.map((grant) => grant.email).filter((email): email is string => !!email))];
  const joined = new Set(
    (
      await Promise.all(
        emails.map(async (email) =>
          rows<{ email: string }>(await db.from<{ email: string }>('cloud_owner').select('email').eq('email', email).limit(1), BackendError)[0]?.email ?? null,
        ),
      )
    ).filter((email): email is string => !!email),
  );

  return Response.json({
    ok: true,
    generated_at: new Date().toISOString(),
    writable: true,
    grants: grants.map((grant) => ({
      id: grant.id,
      email: grant.email,
      role: grant.role ?? 'reviewer',
      joined: grant.email !== null && joined.has(grant.email),
      created_at: grant.created_at,
      revoked_at: grant.revoked_at,
    })),
    // 只有哈希在场，链接不可能被重新显示——这是设计，不是遗漏。
    shares: shares.map((share) => ({
      id: share.id,
      created_at: share.created_at,
      revoked_at: share.revoked_at,
    })),
  });
}

/** 邀请或复活一条读者授权。同一个邮箱重复邀请返回 `replayed`，不产生第二行。 */
export async function grantCreate(db: Db, viewer: Viewer, externalId: string, body: Record<string, unknown>, BackendError: BackendErrorLike): Promise<Response> {
  const project = await ownedProject(db, viewer, externalId, BackendError);
  const email = normalizeEmail(body.email, BackendError);
  const role = normalizeRole(body.role, BackendError);
  if (email === (await ownerEmail(db, project.owner_id, BackendError))) {
    throw new BackendError('invalid_input:grant.self', 400);
  }

  const existing = rows<GrantRow>(
    await db.from<GrantRow>('cloud_grant').select('*').eq('project_id', project.id).eq('email', email).limit(1),
    BackendError,
  )[0];

  if (existing) {
    // UNIQUE(project_id,email) 决定了这里只会有一行；重复邀请是把同一行重新点亮，
    // 而不是插第二条——两条并存的 grant 会让"撤销"只撤销其中一条。
    rows(
      await db
        .from('cloud_grant')
        .update({ role, revoked_at: null })
        .eq('id', existing.id)
        .select('id'),
      BackendError,
    );
    return Response.json({ ok: true, replayed: true, grant_id: existing.id, email, role });
  }

  // 对方可能还没登录过：能解析到 cloud_owner 就一并写 owner_id，解析不到只留邮箱，
  // resolveViewer 会按 email 那条路径在对方首次登录时接上。
  const grantee = rows<{ id: string }>(
    await db.from<{ id: string }>('cloud_owner').select('id').eq('email', email).limit(1),
    BackendError,
  )[0];
  const created = rows<{ id: string }>(
    await db
      .from<{ id: string }>('cloud_grant')
      .insert({
        project_id: project.id,
        email,
        owner_id: grantee?.id ?? null,
        role,
        created_at: new Date().toISOString(),
        revoked_at: null,
      })
      .select('id'),
    BackendError,
  );
  if (!created[0]) throw new BackendError('write_failed', 500);
  return Response.json({
    ok: true,
    grant_id: created[0].id,
    email,
    role,
    message: grantee ? '对方已在云端登录过，读权限即刻生效' : '对方还没有登录过云端，首次登录后读权限生效',
  });
}

export async function grantRevoke(db: Db, viewer: Viewer, externalId: string, grantId: string, BackendError: BackendErrorLike): Promise<Response> {
  const project = await ownedProject(db, viewer, externalId, BackendError);
  const grant = rows<{ id: string; revoked_at: string | null }>(
    await db.from<{ id: string; revoked_at: string | null }>('cloud_grant').select('id,revoked_at').eq('id', grantId).eq('project_id', project.id).limit(1),
    BackendError,
  )[0];
  if (!grant) throw new BackendError('not_found', 404);
  if (grant.revoked_at) return Response.json({ ok: true, ignored: 'already_revoked', grant_id: grantId });

  const revokedAt = new Date().toISOString();
  rows(await db.from('cloud_grant').update({ revoked_at: revokedAt }).eq('id', grantId).select('id'), BackendError);
  // 撤销是立即的：下一次请求就重新 resolveViewer，不给自己留"缓存里还算它有效"的说法。
  return Response.json({ ok: true, grant_id: grantId, revoked_at: revokedAt });
}

/**
 * 未记名分享链接：返回一次明文，库里只留哈希。
 *
 * 明文用 16 字节随机数（32 个十六进制字符）而不是 sync token 那种 8 字节形状：
 * 链接会被人转发、会进截图，猜中得到就等于把 private 项目变成 link 项目。
 */
export async function shareCreate(db: Db, viewer: Viewer, externalId: string, BackendError: BackendErrorLike): Promise<Response> {
  const project = await ownedProject(db, viewer, externalId, BackendError);
  if (project.visibility === 'private') {
    // share token 在 canRead 里只对非 private 生效（§4）：在这里造一条永远读不通的
    // 链接，等于给用户一条看起来能用却被 404 的 URL。
    throw new BackendError('invalid_input:share.private', 400);
  }

  const plain = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plain));
  const tokenHash = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  const created = rows<{ id: string }>(
    await db
      .from<{ id: string }>('cloud_share_token')
      .insert({
        project_id: project.id,
        token_hash: tokenHash,
        scope: 'project',
        object_id: null,
        created_by: viewer.ownerId,
        created_at: new Date().toISOString(),
        revoked_at: null,
      })
      .select('id'),
    BackendError,
  );
  if (!created[0]) throw new BackendError('write_failed', 500);
  return Response.json({
    ok: true,
    share_id: created[0].id,
    plain_token: plain,
    message: '链接只显示这一次；关掉页面后只能撤销再重新生成，云端读不回明文',
  });
}

export async function shareRevoke(db: Db, viewer: Viewer, externalId: string, shareId: string, BackendError: BackendErrorLike): Promise<Response> {
  const project = await ownedProject(db, viewer, externalId, BackendError);
  const share = rows<{ id: string; revoked_at: string | null }>(
    await db.from<{ id: string; revoked_at: string | null }>('cloud_share_token').select('id,revoked_at').eq('id', shareId).eq('project_id', project.id).limit(1),
    BackendError,
  )[0];
  if (!share) throw new BackendError('not_found', 404);
  if (share.revoked_at) return Response.json({ ok: true, ignored: 'already_revoked', share_id: shareId });

  const revokedAt = new Date().toISOString();
  rows(await db.from('cloud_share_token').update({ revoked_at: revokedAt }).eq('id', shareId).select('id'), BackendError);
  return Response.json({ ok: true, share_id: shareId, revoked_at: revokedAt });
}
