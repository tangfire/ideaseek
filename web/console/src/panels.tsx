/**
 * Web-First 操作面板（Phase 3/4/5/6/8）。
 *
 * 云原生架构：所有操作直接在云端 Function 内执行，不排队等待本地 Agent（M0 起 local-agent 已删除）。
 * 按钮文案直接反映云端执行结果（"已创建"、"执行中"），不再说"排队"。
 *
 * 写操作只认 Owner。`writable` 来自 Function（`views.ts` / `commands.ts`），
 * 不是前端用可见性字段推断的——被邀读者是 full 读者但没有写权。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, mutateJson, requestJson } from './api';
import type { AccessView, CommandStatus, CommandsView, ProjectView } from './types';

const APP = '/functions/v1/app';

const COMMAND_STATE: Record<
  CommandStatus,
  'ok' | 'active' | 'blocked' | 'fail' | 'quota' | 'idle'
> = {
  queued: 'idle',
  claimed: 'active',
  running: 'active',
  succeeded: 'ok',
  failed: 'fail',
  expired: 'fail',
  canceled: 'idle',
};

const COMMAND_LABEL: Record<string, string> = {
  queued: '排队中',
  claimed: '已领取',
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
  expired: '超时未回写',
  canceled: '已取消',
};

const TYPE_LABEL: Record<string, string> = {
  project_create: '创建项目',
  project_settings: '更新设置',
  project_archive: '归档项目',
  run_start: '启动运行',
  run_pause: '暂停运行',
  run_resume: '恢复运行',
  run_continue: '继续运行',
  run_cancel: '取消运行',
  git_commit: '本地提交',
  git_push: '推送远端',
  git_pull: '拉取远端',
  git_fetch: '抓取远端',
  git_branch: '新建分支',
  git_branch_delete: '删除分支',
  git_checkout: '切换分支',
  git_merge: '合并分支',
  git_merge_abort: '放弃合并',
  file_delete: '删除文件',
};

function ago(iso: string | null): string {
  if (!iso) return '从未';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '未知';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function ErrorLine({ error }: { error: Error | null }) {
  if (!error) return null;
  const code = error instanceof ApiError ? error.code : 'network';
  return (
    <p className="status-chip" data-state="fail" style={{ marginTop: 8 }}>
      {error.message || code}
    </p>
  );
}

// --------------------------------------------------------------------------- 创建项目

export function CreateProjectPanel({ onCreated }: { onCreated?: () => void }) {
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [question, setQuestion] = useState('');
  const [strategy, setStrategy] = useState('standard');
  const [autonomy, setAutonomy] = useState('guided');
  const [notice, setNotice] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (commandId: string) =>
      mutateJson<{ ok: boolean; message?: string; cloud_executed?: boolean }>(`${APP}/projects`, {
        method: 'POST',
        body: JSON.stringify({ command_id: commandId, name, question, strategy, autonomy }),
      }),
    onSuccess: (data) => {
      if (data.cloud_executed) {
        setNotice('项目已在云端创建。');
        // 只有云端确认建成才收起，待处理的请求保留面板说明。
        onCreated?.();
      } else {
        setNotice('项目创建中…');
      }
      void client.invalidateQueries({ queryKey: ['index'] });
      void client.invalidateQueries({ queryKey: ['commands', ''] });
    },
  });

  return (
    <form
      className="panel"
      style={{ marginTop: 16, marginBottom: 16 }}
      onSubmit={(event) => {
        event.preventDefault();
        if (!mutation.isPending && name.trim().length > 0) mutation.mutate(crypto.randomUUID());
      }}
    >
      <h3 style={{ margin: '0 0 8px' }}>创建项目</h3>

      <div className="form-grid">
        <label className="form-field">
          项目名称
          <input
            placeholder="项目名称"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="form-field">
          运行策略
          <select
            value={strategy}
            onChange={(event) => setStrategy(event.target.value)}
            aria-label="运行策略"
          >
            <option value="starter">入门</option>
            <option value="standard">标准</option>
            <option value="research">深度研究</option>
          </select>
        </label>
        <label className="form-field">
          人工确认方式
          <select
            value={autonomy}
            onChange={(event) => setAutonomy(event.target.value)}
            aria-label="人工门槛"
          >
            <option value="guided">引导（科学门槛暂停）</option>
            <option value="autonomous">自主（自动通过并记录）</option>
            <option value="review-only">只评审（不跑实验）</option>
          </select>
        </label>
      </div>
      <label className="form-field" style={{ marginTop: 12 }}>
        研究问题（可选）
        <textarea
          style={{ width: '100%', marginTop: 8, minHeight: 60 }}
          placeholder="研究问题（可留空，之后在设置里改）"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
        />
      </label>
      <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
        <button
          className="btn-primary"
          type="submit"
          disabled={mutation.isPending || name.trim().length === 0}
        >
          {mutation.isPending ? '创建中…' : '立即创建'}
        </button>
        {notice ? (
          <span className="muted mono" style={{ fontSize: 14 }}>
            {notice}
          </span>
        ) : null}
      </div>
      <ErrorLine error={mutation.error as Error | null} />
    </form>
  );
}

/**
 * 还没落到投影的创建请求。它们出现在列表之上而不是混在项目行里：这个项目此刻
 * **还不存在**，把它画成一条正常项目就是假状态。
 */
export function ProvisioningList() {
  const query = useQuery({
    // 与 AuditLedger 同一个全局读数（`external_id` 为空）：两个 key 会让首页发两次一样的请求。
    queryKey: ['commands', ''],
    queryFn: () => requestJson<CommandsView>(`${APP}/views/commands?external_id=`),
    refetchInterval: 15_000,
  });

  if (query.isPending || query.error) return null;
  if (query.data.provisioning.length === 0) return null;

  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <h3 style={{ margin: '0 0 8px' }}>排队中的创建请求</h3>
      <table>
        <thead>
          <tr>
            <th>名称</th>
            <th>状态</th>
            <th>排队时间</th>
          </tr>
        </thead>
        <tbody>
          {query.data.provisioning.map((entry) => (
            <tr key={entry.command_id}>
              <td data-label="名称" className="mono">
                {entry.name ?? '（未命名）'}
              </td>
              <td data-label="状态">
                <span className="status-chip" data-state={COMMAND_STATE[entry.status] ?? 'idle'}>
                  {COMMAND_LABEL[entry.status] ?? entry.status}
                </span>
              </td>
              <td data-label="排队时间" className="muted">
                {ago(entry.created_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted" style={{ margin: '8px 0 0', fontSize: 14 }}>
        创建成功后项目会立即出现在下方列表；失败或超时的请求留在这里，不会自动重排。
      </p>
    </div>
  );
}

// --------------------------------------------------------------------------- 设置

export function SettingsPanel({ projectId, view }: { projectId: string; view: ProjectView }) {
  const client = useQueryClient();
  const [title, setTitle] = useState(view.project.title);
  const [question, setQuestion] = useState(view.project.question ?? '');
  const [strategy, setStrategy] = useState(view.project.strategy ?? 'standard');
  const [autonomy, setAutonomy] = useState(view.project.autonomy ?? 'guided');
  const [visibility, setVisibility] = useState(view.visibility);
  const [notice, setNotice] = useState<string | null>(null);

  const patch = () => {
    const body: Record<string, unknown> = {};
    if (title !== view.project.title) body.title = title;
    if (question !== (view.project.question ?? '')) body.question = question;
    if (strategy !== (view.project.strategy ?? 'standard')) body.strategy = strategy;
    if (autonomy !== (view.project.autonomy ?? 'guided')) body.autonomy = autonomy;
    if (visibility !== view.visibility) body.visibility = visibility;
    return body;
  };

  // 保存 = PATCH /projects/{id}，云端直接改投影（不再入队——队列没有执行者）。
  const save = useMutation({
    mutationFn: () =>
      mutateJson<{ ok: boolean }>(`${APP}/projects/${encodeURIComponent(projectId)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch()),
      }),
    onSuccess: async () => {
      setNotice('已保存');
      await client.invalidateQueries({ queryKey: ['project', projectId] });
      await client.invalidateQueries({ queryKey: ['index'] });
    },
    onError: (err: Error) => setNotice(`保存失败：${err.message}`),
  });

  const archive = useMutation({
    mutationFn: (confirm: string) =>
      mutateJson<{ ok: boolean }>(
        `${APP}/projects/${encodeURIComponent(projectId)}?confirm=${encodeURIComponent(confirm)}`,
        { method: 'DELETE' },
      ),
    onSuccess: async () => {
      setNotice('已归档，可在项目列表"显示已归档"里恢复');
      await client.invalidateQueries({ queryKey: ['index'] });
    },
    onError: (err: Error) => setNotice(`归档失败：${err.message}`),
  });

  const dirty = Object.keys(patch()).length > 0;
  const downgraded = visibility === 'listed' && view.visibility !== 'listed';
  const pending = save.isPending || archive.isPending;

  if (view.writable !== true) {
    return (
      <div className="panel">
        <h3 style={{ margin: '0 0 8px' }}>项目设置</h3>
        <p className="muted" style={{ margin: 0 }}>
          当前为只读访问。项目设置与分享方式由项目所有者管理。
        </p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h3 style={{ margin: '0 0 8px' }}>项目设置</h3>
      <p className="muted" style={{ margin: '0 0 12px', fontSize: 14 }}>
        修改保存后立即在云端生效。
      </p>
      <div className="form-grid">
        <label className="form-field">项目标题
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="项目标题"
        />
        </label>
        <label className="form-field">运行策略
        <select
          value={strategy}
          onChange={(event) => setStrategy(event.target.value)}
          aria-label="策略"
        >
          {[
            ['starter', '入门'],
            ['standard', '标准'],
            ['research', '深度研究'],
          ].map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        </label>
        <label className="form-field">人工确认方式
        <select
          value={autonomy}
          onChange={(event) => setAutonomy(event.target.value)}
          aria-label="门槛"
        >
          {[
            ['guided', '引导（科学门槛暂停）'],
            ['autonomous', '自主（自动通过并记录）'],
            ['review-only', '只评审（不跑实验）'],
          ].map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        </label>
        <label className="form-field">可见性
        <select
          value={visibility}
          onChange={(event) => setVisibility(event.target.value as 'private' | 'link' | 'listed')}
          aria-label="可见性"
        >
          <option value="private">私有 · 仅自己</option>
          <option value="link">链接可见 · 持链可读</option>
          <option value="listed">公开 · 进公开列表</option>
        </select>
        </label>
      </div>
      <label className="form-field" style={{ marginTop: 12 }}>研究问题
      <textarea
        style={{ width: '100%', marginTop: 8, minHeight: 60 }}
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        placeholder="研究问题"
      />
      </label>
      {view.projection_level === 'l2' ? (
        <p className="muted" style={{ fontSize: 14 }}>
          公开摘要不展示运行策略与确认方式，不代表未设置。
        </p>
      ) : null}
      {downgraded ? (
        <p className="status-chip" data-state="blocked" style={{ marginTop: 8 }}>
          设为公开后，项目将进入公开列表；访客可查看标题、研究问题与阶段摘要。
        </p>
      ) : null}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <button
          className="btn-primary"
          disabled={pending || !dirty}
          onClick={() => save.mutate()}
        >
          {save.isPending ? '保存中…' : '保存修改'}
        </button>
        <button
          className="btn-danger"
          disabled={pending}
          onClick={() => {
            const confirm = window.prompt(
              `归档「${view.project.title}」后将从默认列表隐藏，暂时无法打开。可在列表的“项目范围”选择“已归档项目”恢复。请输入项目标题确认：`,
            );
            if (confirm !== null) archive.mutate(confirm);
          }}
        >
          归档项目
        </button>
        {notice ? (
          <span className="muted mono" style={{ fontSize: 14 }}>
            {notice}
          </span>
        ) : null}
      </div>
      <ErrorLine error={save.error instanceof Error ? save.error : null} />
    </div>
  );
}

// --------------------------------------------------------------------------- 协作与分享

/**
 * 邀请读者与分享链接（Phase 9）。
 *
 * 这一面**不是**排队命令：`cloud_grant` / `cloud_share_token` 是云端自己的 ACL，
 * 本地引擎从不写它们，删掉也不影响从 workflow.sqlite 重建投影（理由见 access.ts 头注）。
 * 所以措辞可以和别处不同——这里说"下一次请求重新判定"是真的，把设置也说成"点了就改"
 * 才是假的。两种方向混在一页上，用户就分不清哪件事要等 Agent。
 *
 * 只给读权限，不给写权限：平台没有 editor 这一档（REQUIREMENTS §4），界面上也不许
 * 出现"共同编辑"这种说法。
 */
export function AccessPanel({ projectId, view }: { projectId: string; view: ProjectView }) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['access', projectId],
    queryFn: () =>
      requestJson<AccessView>(`${APP}/views/access?external_id=${encodeURIComponent(projectId)}`),
  });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'reviewer' | 'viewer'>('reviewer');
  const [plain, setPlain] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ['access', projectId] });
  };

  const invite = useMutation({
    mutationFn: (input: { email: string; role: string }) =>
      mutateJson<{ ok: boolean; replayed?: boolean; email: string; message?: string }>(
        `${APP}/access/grants`,
        {
          method: 'POST',
          body: JSON.stringify({ external_id: projectId, email: input.email, role: input.role }),
        },
      ),
    onSuccess: (data) => {
      setNotice(
        data.replayed
          ? `${data.email} 之前被邀请过，这一条被重新点亮，而不是多出第二条权限`
          : (data.message ?? '邀请已记下'),
      );
      setEmail('');
      invalidate();
    },
  });

  const revoke = useMutation({
    mutationFn: (grantId: string) =>
      mutateJson<{ ok: boolean }>(
        `${APP}/access/grants/${grantId}?external_id=${encodeURIComponent(projectId)}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      setNotice('撤销是立即的：下一次请求就重新判定读权限，不等缓存过期');
      invalidate();
    },
  });

  const createShare = useMutation({
    mutationFn: () =>
      mutateJson<{ ok: boolean; plain_token: string; message?: string }>(`${APP}/access/share`, {
        method: 'POST',
        body: JSON.stringify({ external_id: projectId }),
      }),
    onSuccess: (data) => {
      setPlain(data.plain_token);
      setNotice(data.message ?? '链接只显示这一次');
      invalidate();
    },
  });

  const revokeShare = useMutation({
    mutationFn: (shareId: string) =>
      mutateJson<{ ok: boolean }>(
        `${APP}/access/share/${shareId}?external_id=${encodeURIComponent(projectId)}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      setNotice('链接已撤销：拿过这条链接的人下一次打开就读不到了');
      setPlain(null);
      invalidate();
    },
  });

  if (view.writable !== true) {
    // 这个面板只在 Owner 面上挂载（app.tsx 的 tab 过滤）；留着这层判定是因为
    // `/views/access` 对被邀读者回 403，而 403 的固定文案是"没有读取权限"——
    // 对方明明读得到项目，界面上却会说成读不到。
    return (
      <div className="panel">
        <h3 style={{ margin: '0 0 8px' }}>协作与分享</h3>
        <p className="muted" style={{ margin: 0 }}>
          谁可以查看这个项目由项目所有者
          决定。你现在的身份是被邀请的读者：能读，但不能把自己的读权限转发给别人。
        </p>
      </div>
    );
  }

  if (query.isPending) return <p className="muted mono">读取权限加载中…</p>;
  if (query.error) return <ErrorLine error={query.error as Error} />;

  const active = query.data.grants.filter((grant) => !grant.revoked_at);
  const shares = query.data.shares.filter((share) => !share.revoked_at);
  const link = plain
    ? `${window.location.origin}${window.location.pathname}#/p/${encodeURIComponent(projectId)}?share=${plain}`
    : null;
  const busy =
    invite.isPending || revoke.isPending || createShare.isPending || revokeShare.isPending;

  const copy = () => {
    if (!link) return;
    if (!navigator.clipboard) {
      setNotice('这个浏览器不给剪贴板权限，链接可以手动选中复制');
      return;
    }
    navigator.clipboard
      .writeText(link)
      .then(() => setNotice('链接已复制到剪贴板'))
      .catch(() => setNotice('复制没成功，链接可以手动选中复制'));
  };

  return (
    <div className="panel">
      <h3 style={{ margin: '0 0 8px' }}>协作与分享</h3>
      <p className="muted" style={{ margin: '0 0 12px', fontSize: 14 }}>
        邀请与撤销在保存后生效。项目是否进入公开列表，请在“设置”中修改可见性。
      </p>

      <table>
        <thead>
          <tr>
            <th>邮箱</th>
            <th>读取范围</th>
            <th>对方状态</th>
            <th>邀请时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {active.length === 0 ? (
            <tr>
              <td colSpan={5} className="muted">
                尚未邀请读者。你可以邀请他人查看完整记录或公开摘要。
              </td>
            </tr>
          ) : (
            active.map((grant) => (
              <tr key={grant.id}>
                <td data-label="邮箱" className="mono">
                  {grant.email}
                </td>
                <td data-label="读取范围">
                  {grant.role === 'viewer'
                    ? '公开摘要（不含运行状态与成本）'
                    : '完整记录'}
                </td>
                <td data-label="对方状态">
                  <span className="status-chip" data-state={grant.joined ? 'ok' : 'idle'}>
                    {grant.joined ? '已登录过云端' : '还没登录过'}
                  </span>
                </td>
                <td data-label="邀请时间" className="muted">
                  {ago(grant.created_at)}
                </td>
                <td data-label="操作">
                  <button
                    className="btn-danger"
                    disabled={busy}
                    onClick={() => revoke.mutate(grant.id)}
                  >
                    撤销
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <div className="form-grid" style={{ marginTop: 12 }}>
        <label className="form-field">受邀邮箱
        <input
          placeholder="对方邮箱"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-label="受邀邮箱"
        />
        </label>
        <label className="form-field">读取范围
        <select
          value={role}
          onChange={(event) => setRole(event.target.value as 'reviewer' | 'viewer')}
          aria-label="读取范围"
        >
          <option value="reviewer">完整记录</option>
          <option value="viewer">公开摘要</option>
        </select>
        </label>
        <button
          className="btn-primary"
          disabled={busy || email.trim() === ''}
          onClick={() => invite.mutate({ email: email.trim(), role })}
        >
          {invite.isPending ? '记录中…' : '邀请读者'}
        </button>
      </div>
      <p className="muted" style={{ margin: '8px 0 0', fontSize: 14 }}>
        邀请给的是读权限，不是写权限；对方还没在云端注册也能先邀请，首次登录后自动接上。
      </p>
      <ErrorLine error={(invite.error ?? revoke.error) as Error | null} />

      <h4 style={{ margin: '16px 0 8px' }}>未记名链接</h4>
      {view.visibility === 'private' ? (
        <p className="status-chip" data-state="blocked">
          项目还是私有的，先在设置里把可见性改成"链接可见"，才能生成分享链接。
        </p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn-primary" disabled={busy} onClick={() => createShare.mutate()}>
              {createShare.isPending ? '生成中…' : '生成分享链接'}
            </button>
            <span className="muted" style={{ fontSize: 14 }}>
              token 只在生成这一次显示；云端只存哈希，关掉页面就读不回明文。
            </span>
          </div>
          {link ? (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              <label className="form-field" style={{ flex: '1 1 200px' }}>分享链接
              <input
                className="mono"
                readOnly
                value={link}
                onFocus={(event) => event.target.select()}
                aria-label="分享链接"
              />
              </label>
              <button onClick={copy}>复制</button>
            </div>
          ) : null}
          <table>
            <thead>
              <tr>
                <th>生成时间</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {shares.length === 0 ? (
                <tr>
                  <td colSpan={3} className="muted">
                    当前没有有效链接。
                  </td>
                </tr>
              ) : (
                shares.map((share) => (
                  <tr key={share.id}>
                    <td data-label="生成时间" className="muted">
                      {ago(share.created_at)}
                    </td>
                    <td data-label="状态">
                      <span className="status-chip" data-state="ok">
                        有效
                      </span>
                    </td>
                    <td data-label="操作">
                      <button
                        className="btn-danger"
                        disabled={busy}
                        onClick={() => revokeShare.mutate(share.id)}
                      >
                        撤销
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <p className="muted" style={{ margin: '8px 0 0', fontSize: 14 }}>
            分享链接仅提供标题、研究问题、阶段与结论标签。运行状态、成本和事件详情不随链接公开。
          </p>
        </>
      )}
      <ErrorLine error={(createShare.error ?? revokeShare.error) as Error | null} />
      {notice ? (
        <p className="mono" style={{ margin: '8px 0 0', fontSize: 14, color: 'var(--ok)' }}>
          {notice}
        </p>
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------------------- 操作台账

/**
 * Owner 自己的操作台账（Phase 9.4）。读的是全局 `/views/commands?external_id=`，
 * 与首页待创建队列共用同一份缓存。台账就是命令行本身，不另造审计表；错误只给首行，
 * 因为第二行往往是带本地路径的堆栈，那部分不进云。
 */
export function AuditLedger() {
  const query = useQuery({
    queryKey: ['commands', ''],
    queryFn: () => requestJson<CommandsView>(`${APP}/views/commands?external_id=`),
    refetchInterval: 30_000,
  });

  if (query.isPending || query.error) return null;
  const audit = query.data.audit ?? [];
  if (audit.length === 0) return null;
  const shown = audit.slice(0, 20);

  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <h3 style={{ margin: '0 0 8px' }}>我的操作台账</h3>
      <table>
        <thead>
          <tr>
            <th>时间</th>
            <th>操作</th>
            <th>项目</th>
            <th>状态</th>
            <th>结果</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((entry) => (
            <tr key={entry.command_id}>
              <td data-label="时间" className="muted">
                {ago(entry.created_at)}
              </td>
              <td data-label="操作">{TYPE_LABEL[entry.type] ?? entry.type}</td>
              <td data-label="项目" className="mono">
                {entry.project ?? '（还没落到项目）'}
              </td>
              <td data-label="状态">
                <span className="status-chip" data-state={COMMAND_STATE[entry.status] ?? 'idle'}>
                  {COMMAND_LABEL[entry.status] ?? entry.status}
                </span>
              </td>
              <td data-label="结果" className="muted mono" style={{ fontSize: 13 }}>
                {entry.error ?? (entry.finished_at ? '已完成' : '—')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted" style={{ margin: '8px 0 0', fontSize: 14 }}>
        最近 {shown.length} 条由你发起的操作。云端记录谁做了什么、结果如何。
      </p>
    </div>
  );
}

// --------------------------------------------------------------------------- 步进泵

interface StepResult {
  action: 'claimed' | 'advanced' | 'idle' | 'completed' | 'blocked';
  task?: { external_task_id: string; kind: string; status: string };
  run?: { external_run_id: string; phase_tag: string; status: string };
  newPhase?: string;
  events?: Array<{ seq: number; type: string; summary: string }>;
  message: string;
}

/**
 * 浏览器泵：每 2s 调用 POST /app/step，驱动云原生引擎推进阶段。
 * 每步结果通过 onProgress 通知父级刷新投影，链路视图不用等 60s 轮询。
 */
export function StepPump({
  projectId,
  externalRunId,
  notStarted,
  completed,
  onProgress,
}: {
  projectId: string;
  externalRunId: string;
  notStarted: boolean;
  completed?: boolean;
  onProgress?: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [pending, setPending] = useState(false);
  const [lastResult, setLastResult] = useState<StepResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);
  // 回调身份每次渲染都变；放 ref 里避免 setInterval 被反复重建。
  const progressRef = useRef(onProgress);
  progressRef.current = onProgress;

  const done = completed || lastResult?.action === 'completed';

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!running || done) return;
    const interval = setInterval(async () => {
      if (pendingRef.current) return;
      pendingRef.current = true;
      setPending(true);
      try {
        const result = await mutateJson<StepResult>(`${APP}/app/step`, {
          method: 'POST',
          body: JSON.stringify({ project_id: projectId, external_run_id: externalRunId }),
        });
        if (!mountedRef.current) return;
        setLastResult(result);
        setError(null);
        progressRef.current?.();
        if (result.action === 'completed' || result.action === 'blocked') {
          setRunning(false);
        }
      } catch (err) {
        if (!mountedRef.current) return;
        setError(err instanceof ApiError && err.code === 'rate_limited'
          ? '请求过于频繁，请稍后点击继续运行。'
          : err instanceof Error ? err.message : String(err));
        setRunning(false);
      } finally {
        pendingRef.current = false;
        if (mountedRef.current) setPending(false);
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [running, done, projectId, externalRunId]);

  if (done) {
    return (
      <div
        className="panel"
        style={{ marginTop: 12, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}
      >
        <span className="muted">
          研究流程已完成
        </span>
        {lastResult?.message ? (
          <span className="muted" style={{ fontSize: 14 }}>
            {lastResult.message}
          </span>
        ) : null}
      </div>
    );
  }

  const blocked = lastResult?.action === 'blocked';
  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          className="btn-primary"
          disabled={!running && pending}
          onClick={() => {
            if (!running) {
              setHasStarted(true);
              setError(null);
            }
            setRunning(!running);
          }}
        >
          {running ? '暂停' : pending ? '等待当前步骤完成' : notStarted && !hasStarted ? '开始运行' : '继续运行'}
        </button>
        <span className="status-chip" data-state={error ? 'fail' : blocked || pending ? 'blocked' : running ? 'active' : 'idle'} role="status">
          {running ? '本页正在推进' : pending ? '正在暂停，等待当前步骤返回' : blocked ? '请处理提示后继续' : error ? '请求失败，推进已停止' : hasStarted ? '已暂停推进' : notStarted ? '尚未开始' : '等待继续'}
        </span>
        {error ? (
          <span className="status-chip" data-state="fail" role="alert">
            {error}
          </span>
        ) : blocked ? (
          <span className="muted">
            {lastResult?.message}
          </span>
        ) : lastResult ? (
          <span className="muted" style={{ fontSize: 14 }}>
            {lastResult.message}
          </span>
        ) : null}
      </div>
      <p className="muted" style={{ fontSize: 14, margin: '8px 0 0' }}>
        请保持此项目页面打开。切换页签会继续；离开项目、刷新或关闭页面后停止推进，返回后需手动继续。
      </p>
      <p className="muted" style={{ fontSize: 14, margin: '4px 0 0' }}>
        暂停会停止后续步骤；已发出的步骤仍可能在云端完成，并保留结果。
      </p>
    </div>
  );
}
