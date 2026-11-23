/**
 * Web-First 操作面板（Phase 3/4/5/6/8）。
 *
 * 这一整层的措辞受同一条约束支配：**云端不执行任何东西**（F6.5）。所有按钮写的是
 * "已排队/等待本地 Agent 执行"，永远不写"已提交成功"或"已完成"——后者是本地引擎
 * 回写结果之后才允许出现的读数。把排队说成执行，等于给用户一个看不见的假状态，
 * 和审批面"只记意向不记生效"（R2）是同一条红线的两个方向。
 *
 * 第二层约束：写操作只认 Owner。`writable` 来自 Function（`views.ts` /
 * `commands.ts`），不是前端用可见性字段推断的——被邀读者是 full 读者但没有写权。
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, mutateJson, requestJson } from './api';
import type { AgentPresenceView, CommandStatus, CommandsView, ProjectView, RepoView } from './types';

const APP = '/functions/v1/app';

const COMMAND_STATE: Record<CommandStatus, 'ok' | 'active' | 'blocked' | 'fail' | 'quota' | 'idle'> = {
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
  project_archive: '归档投影',
  run_start: '启动运行',
  run_pause: '暂停运行',
  run_resume: '恢复运行',
  run_continue: '继续运行',
  run_cancel: '取消运行',
  git_commit: '本地提交',
  git_push: '推送远端',
  git_pull: '拉取远端',
  git_branch: '新建分支',
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

function bytes(size: number | null): string {
  if (size === null || !Number.isFinite(size)) return '—';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 排一条命令。
 *
 * `command_id` 在**调用时**生成并随变量传进 mutationFn，不在 mutationFn 里生成：
 * QueryClient 对失败请求会重试一次，如果在里面生成，重试就变成两条不同幂等键的
 * 命令，`run_start` 那种带真实花费的动作重放一次就是双倍成本（NFR-06）。
 */
function useEnqueue(projectId: string) {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: (input: { type: string; commandId: string; payload: Record<string, unknown> }) =>
      mutateJson<{ ok: boolean; message?: string; replayed?: boolean }>(`${APP}/commands/${input.type}`, {
        method: 'POST',
        body: JSON.stringify({ external_id: projectId, command_id: input.commandId, ...input.payload }),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['commands', projectId] });
      void client.invalidateQueries({ queryKey: ['agent', projectId] });
    },
  });
  const [notice, setNotice] = useState<string | null>(null);

  const submit = (type: string, payload: Record<string, unknown> = {}) => {
    const commandId = crypto.randomUUID();
    setNotice(null);
    mutation.mutate({ type, commandId, payload });
  };

  useEffect(() => {
    if (mutation.isSuccess) setNotice(mutation.data?.message ?? '命令已排队，等待本地 Agent 执行');
  }, [mutation.isSuccess, mutation.data]);

  return { submit, notice, pending: mutation.isPending, error: mutation.error as Error | null };
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

// --------------------------------------------------------------------------- Agent 在线

/** 不传 projectId = 读 Owner 自己的全局在线状态（首页用）。 */
export function AgentPresence({ projectId }: { projectId?: string }) {
  const query = useQuery({
    queryKey: ['agent', projectId ?? ''],
    queryFn: () => requestJson<AgentPresenceView>(`${APP}/views/agent?external_id=${encodeURIComponent(projectId ?? '')}`),
    refetchInterval: 20_000,
  });

  if (query.isPending) return <span className="muted mono">Agent 状态读取中…</span>;
  if (query.error) {
    const code = query.error instanceof ApiError ? query.error.code : 'network';
    // 403 是"你没有 full 读级"、401 是"还没登录"，都不是"Agent 离线"：把权限问题
    // 说成连接问题，用户会去重启一个根本没在跑的 Agent。
    const text =
      code === 'no_access' ? 'Agent 状态仅 Owner 可读' : code === 'login_required' ? '登录后才显示 Agent 状态' : 'Agent 状态读不到';
    return <span className="muted mono">{text}</span>;
  }
  const view = query.data;
  const dir = projectId ? (view.local_projects.find((entry) => entry.external_id === projectId) ?? null) : null;

  return (
    <div className="panel">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="status-chip" data-state={view.online ? 'ok' : 'fail'}>{view.online ? '本地 Agent 在线' : '本地 Agent 离线'}</span>
        <span className="muted">心跳 {ago(view.last_seen_at)}</span>
        {view.agent_version ? <span className="muted mono">{view.agent_version}</span> : null}
        {view.active_commands > 0 ? <span className="status-chip" data-state="active">{`${view.active_commands} 条正在执行`}</span> : null}
        {view.local_projects.length > 0 ? (
          <span className="muted mono" style={{ fontSize: 11 }}>{`本机上报 ${view.local_projects.length} 个目录`}</span>
        ) : null}
      </div>
      <p className="muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
        {view.online
          ? !projectId
            ? '命令排队后会被本机领取执行；云端不运行任何东西。'
            : view.reported_for_project
              ? `本机的对应目录是 ${dir?.path ?? '（未上报路径）'}。`
              : '本机在线，但这个项目目录还没在本地上报清单里——创建或归档类命令仍可领取，运行类命令要等目录出现。'
          : '命令会继续排队。Agent 恢复心跳后领取；超过 15 分钟没有结果回写的命令标记为超时未回写，不会自动重排。'}
      </p>
      {view.online ? null : (
        <pre style={{ marginTop: 8 }}>ideaseek-agent start --base {`${APP}`} --token "&lt;本地 cloud link 保存的 sync token&gt;"</pre>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- 创建项目

export function CreateProjectPanel() {
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [question, setQuestion] = useState('');
  const [strategy, setStrategy] = useState('standard');
  const [autonomy, setAutonomy] = useState('guided');
  const [notice, setNotice] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (commandId: string) =>
      mutateJson<{ ok: boolean; message?: string }>(`${APP}/projects`, {
        method: 'POST',
        body: JSON.stringify({ command_id: commandId, name, question, strategy, autonomy }),
      }),
    onSuccess: () => {
      setNotice('创建请求已排队，本地 Agent 执行后项目才会出现在投影里。');
      void client.invalidateQueries({ queryKey: ['index'] });
      void client.invalidateQueries({ queryKey: ['provisioning'] });
    },
  });

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <h3 style={{ margin: '0 0 8px' }}>创建项目</h3>
      <p className="muted" style={{ margin: '0 0 12px', fontSize: 12 }}>
        云端不建项目目录：这一步只把 <code className="mono">ideaseek start</code> 排给你的机器，跑完之后投影才出现在这张列表里。
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input style={{ flex: '1 1 180px' }} placeholder="项目名称（同时作为本地目录名）" value={name} onChange={(event) => setName(event.target.value)} />
        <select value={strategy} onChange={(event) => setStrategy(event.target.value)} aria-label="运行策略">
          <option value="starter">starter</option>
          <option value="standard">standard</option>
          <option value="research">research</option>
        </select>
        <select value={autonomy} onChange={(event) => setAutonomy(event.target.value)} aria-label="人工门槛">
          <option value="guided">guided（科学门槛暂停）</option>
          <option value="autonomous">autonomous（自动通过并记录）</option>
          <option value="review-only">review-only（不写代码不跑实验）</option>
        </select>
      </div>
      <textarea
        style={{ width: '100%', marginTop: 8, minHeight: 60 }}
        placeholder="研究问题（可留空，之后在设置里改）"
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
        <button
          className="btn-primary"
          disabled={mutation.isPending || name.trim().length === 0}
          onClick={() => mutation.mutate(crypto.randomUUID())}
        >
          {mutation.isPending ? '排队中…' : '排队创建'}
        </button>
        {notice ? <span className="muted mono" style={{ fontSize: 12 }}>{notice}</span> : null}
      </div>
      <ErrorLine error={mutation.error as Error | null} />
    </div>
  );
}

/**
 * 还没落到投影的创建请求。它们出现在列表之上而不是混在项目行里：这个项目此刻
 * **还不存在**，把它画成一条正常项目就是假状态。
 */
export function ProvisioningList() {
  const query = useQuery({
    queryKey: ['provisioning'],
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
              <td data-label="名称" className="mono">{entry.name ?? '（未命名）'}</td>
              <td data-label="状态">
                <span className="status-chip" data-state={COMMAND_STATE[entry.status] ?? 'idle'}>{COMMAND_LABEL[entry.status] ?? entry.status}</span>
              </td>
              <td data-label="排队时间" className="muted">{ago(entry.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
        完成后项目会由本地引擎写回投影并出现在下方列表；失败或超时未回写的请求留在命令队列里，不会自动重排。
      </p>
    </div>
  );
}

// --------------------------------------------------------------------------- 命令队列

export function CommandQueue({ projectId }: { projectId: string }) {
  const query = useQuery({
    queryKey: ['commands', projectId],
    queryFn: () => requestJson<CommandsView>(`${APP}/views/commands?external_id=${encodeURIComponent(projectId)}`),
    // 有未终态的命令时缩短到 5 秒，否则维持默认 staleTime：轮询频率要跟着队列状态走，
    // 空闲项目没必要一直打云端。
    refetchInterval: (state) => (state.state.data?.commands.some((c) => c.status === 'queued' || c.status === 'claimed' || c.status === 'running') ? 5_000 : false),
  });

  if (query.isPending) return <p className="muted">正在读取命令队列…</p>;
  if (query.error) return <ErrorLine error={query.error as Error} />;
  const commands = query.data.commands;
  if (commands.length === 0) return <p className="muted">还没有排过命令。</p>;

  return (
    <table>
      <thead>
        <tr>
          <th>命令</th>
          <th>状态</th>
          <th>排队时间</th>
          <th>读数</th>
        </tr>
      </thead>
      <tbody>
        {commands.map((command) => (
          <tr key={command.command_id}>
            <td data-label="命令">
              {TYPE_LABEL[command.type] ?? command.type}
              <div className="muted mono" style={{ fontSize: 11 }}>{command.type}</div>
            </td>
            <td data-label="状态">
              <span className="status-chip" data-state={COMMAND_STATE[command.status] ?? 'idle'}>
                {COMMAND_LABEL[command.status] ?? command.status}
              </span>
            </td>
            <td data-label="排队时间" className="muted">{ago(command.created_at)}</td>
            <td data-label="读数" className="muted mono" style={{ fontSize: 11, maxWidth: 360, overflowWrap: 'anywhere' }}>
              {command.projection_level === 'l2' ? (
                <span>不在这一级</span>
              ) : command.error ? (
                <span style={{ color: 'var(--fail)' }}>{command.error}</span>
              ) : command.result ? (
                <span>{summarizeResult(command)}</span>
              ) : command.claimed_at ? (
                <span>领取于 {ago(command.claimed_at)}</span>
              ) : (
                <span>等待本地 Agent 领取</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function summarizeResult(command: CommandsView['commands'][number]): string {
  const result = command.result ?? {};
  const parts: string[] = [];
  if (typeof result.exit_code === 'number') parts.push(`exit ${result.exit_code}`);
  if (typeof result.run_id === 'string') parts.push(`run ${result.run_id}`);
  if (typeof result.commit === 'string') parts.push(`commit ${result.commit.slice(0, 8)}`);
  if (typeof result.branch === 'string') parts.push(result.branch);
  if (parts.length === 0 && command.finished_at) parts.push(`回写于 ${ago(command.finished_at)}`);
  return parts.join(' · ');
}

// --------------------------------------------------------------------------- 运行控制

export function RunControl({ projectId, writable, run }: { projectId: string; writable: boolean; run: ProjectView['runs'][number] | undefined }) {
  const { submit, notice, pending, error } = useEnqueue(projectId);
  const [question, setQuestion] = useState(run?.question ?? '');

  if (!writable) {
    return (
      <div className="panel">
        <p style={{ margin: 0 }}>这个项目不是你的，只能读。</p>
        <p className="muted" style={{ margin: '6px 0 0', fontSize: 12 }}>运行控制、Git 操作与设置修改都只开放给 Owner。</p>
      </div>
    );
  }

  const status = run?.status ?? null;
  const running = status === 'RUNNING' || status === 'INIT';
  const paused = status === 'PAUSED';
  const blocked = status === 'QUOTA_EXHAUSTED' || status === 'AUTH_REQUIRED' || status === 'NETWORK_BLOCKED' || status === 'USER_INPUT_REQUIRED';

  return (
    <div className="panel">
      <h3 style={{ margin: '0 0 8px' }}>运行控制</h3>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <input style={{ flex: '1 1 260px' }} placeholder="研究问题（启动新 run 时必填）" value={question} onChange={(event) => setQuestion(event.target.value)} />
        <button className="btn-primary" disabled={pending || question.trim().length === 0} onClick={() => submit('run_start', { question })}>
          排队启动
        </button>
        <button className="btn-secondary" disabled={pending || !running} onClick={() => submit('run_pause', {})}>排队暂停</button>
        <button className="btn-secondary" disabled={pending || !paused} onClick={() => submit('run_resume', {})}>排队恢复</button>
        <button className="btn-secondary" disabled={pending || !blocked} onClick={() => submit('run_continue', {})}>排队继续</button>
        <button className="btn-danger" disabled={pending || (!running && !blocked)} onClick={() => submit('run_cancel', {})}>排队取消</button>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        暂停在安全 checkpoint 收线，已提交 artifact 与成功结果保持有效；额度/凭据/网络类阻塞用"排队继续"，它只重跑失败或未完成的最小任务。
      </p>
      {notice ? <p className="mono" style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--ok)' }}>{notice}</p> : null}
      <ErrorLine error={error} />
      <div style={{ marginTop: 12 }}>
        <h3 style={{ margin: '0 0 8px' }}>命令队列</h3>
        <CommandQueue projectId={projectId} />
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- 仓库

export function RepoPanel({ projectId, writable }: { projectId: string; writable: boolean }) {
  const query = useQuery({
    queryKey: ['repo', projectId],
    queryFn: () => requestJson<RepoView>(`${APP}/views/repo?external_id=${encodeURIComponent(projectId)}`),
    refetchInterval: 30_000,
  });
  const { submit, notice, pending, error } = useEnqueue(projectId);
  const [message, setMessage] = useState('');
  const [branch, setBranch] = useState('');

  if (query.isPending) return <p className="muted">正在读取本地仓库上报的读数…</p>;
  if (query.error) return <ErrorLine error={query.error as Error} />;
  const git = query.data.git;

  return (
    <div>
      <div className="panel">
        <h3 style={{ margin: '0 0 8px' }}>仓库状态（由本地 Agent 上报）</h3>
        {!git ? (
          <p className="muted" style={{ margin: 0 }}>
            还没有读到仓库读数。Agent 每轮心跳上报一次；本地不是 git 仓库时这一格就该是空的。
          </p>
        ) : (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="status-chip" data-state="active">{git.branch ?? '游离 HEAD'}</span>
            <span className="status-chip" data-state={git.ahead ? 'blocked' : 'idle'}>{`领先 ${git.ahead ?? '?'}`}</span>
            <span className="status-chip" data-state={git.behind ? 'blocked' : 'idle'}>{`落后 ${git.behind ?? '?'}`}</span>
            <span className="status-chip" data-state={git.staged ? 'active' : 'idle'}>{`已暂存 ${git.staged ?? '?'}`}</span>
            <span className="status-chip" data-state={git.unstaged ? 'blocked' : 'idle'}>{`已改动 ${git.unstaged ?? '?'}`}</span>
            <span className="status-chip" data-state={git.untracked ? 'blocked' : 'idle'}>{`未跟踪 ${git.untracked ?? '?'}`}</span>
            <span className="muted mono" style={{ fontSize: 11 }}>
              {git.last_commit_hash ? `${git.last_commit_hash.slice(0, 8)} · ` : ''}
              {git.last_commit_text ?? ''}
            </span>
            <span className="muted" style={{ fontSize: 11 }}>上报于 {ago(git.reported_at)}</span>
          </div>
        )}
      </div>

      {writable ? (
        <div className="panel" style={{ marginTop: 12 }}>
          <h3 style={{ margin: '0 0 8px' }}>仓库操作</h3>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input style={{ flex: '1 1 260px' }} placeholder="提交说明" value={message} onChange={(event) => setMessage(event.target.value)} />
            <button className="btn-primary" disabled={pending || message.trim().length === 0} onClick={() => submit('git_commit', { message })}>
              排队提交
            </button>
            <button className="btn-secondary" disabled={pending} onClick={() => submit('git_push', {})}>排队推送</button>
            <button className="btn-secondary" disabled={pending} onClick={() => submit('git_pull', {})}>排队拉取</button>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input style={{ flex: '1 1 260px' }} placeholder="新分支名" value={branch} onChange={(event) => setBranch(event.target.value)} />
            <button className="btn-secondary" disabled={pending || branch.trim().length === 0} onClick={() => submit('git_branch', { name: branch })}>
              排队建分支
            </button>
          </div>
          <p className="muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
            界面不提供强制推送：覆盖历史应当在您自己的终端里做。提交在本地仓库执行，凭据不进云端。
          </p>
          {notice ? <p className="mono" style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--ok)' }}>{notice}</p> : null}
          <ErrorLine error={error} />
        </div>
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------------------- 文件清单

export function FilePanel({ projectId, writable }: { projectId: string; writable: boolean }) {
  const query = useQuery({
    queryKey: ['repo', projectId],
    queryFn: () => requestJson<RepoView>(`${APP}/views/repo?external_id=${encodeURIComponent(projectId)}`),
    refetchInterval: 30_000,
  });
  const { submit, notice, pending, error } = useEnqueue(projectId);
  const [filter, setFilter] = useState('');
  const [kind, setKind] = useState('全部');

  const nodes = query.data?.files ?? [];
  const kinds = useMemo(() => ['全部', ...new Set(nodes.map((node) => node.kind))], [nodes]);
  const shown = nodes
    .filter((node) => (kind === '全部' ? true : node.kind === kind))
    .filter((node) => (filter.trim() === '' ? true : node.path.toLowerCase().includes(filter.trim().toLowerCase())))
    .slice(0, 400);

  if (query.isPending) return <p className="muted">正在读取本地输入清单…</p>;
  if (query.error) return <ErrorLine error={query.error as Error} />;

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <input style={{ flex: '1 1 220px' }} placeholder="按路径过滤" value={filter} onChange={(event) => setFilter(event.target.value)} />
        <select value={kind} onChange={(event) => setKind(event.target.value)} aria-label="类别">
          {kinds.map((entry) => (
            <option key={entry} value={entry}>{entry}</option>
          ))}
        </select>
        <span className="muted mono" style={{ alignSelf: 'center', fontSize: 12 }}>{`${shown.length} / ${query.data.file_count} 项`}</span>
      </div>
      {nodes.length === 0 ? (
        <p className="muted">
          本地还没有上报输入清单。论文与数据集放在项目目录后，Agent 下一轮心跳会带上来；云端不保存任何文件内容。
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>路径</th>
              <th>类别</th>
              <th>大小</th>
              <th>改动时间</th>
              {writable ? <th>操作</th> : null}
            </tr>
          </thead>
          <tbody>
            {shown.map((node) => (
              <tr key={node.path}>
                <td className="mono" data-label="路径">{node.path}</td>
                <td data-label="类别"><span className="status-chip">{node.kind}</span></td>
                <td data-label="大小" className="muted">{bytes(node.size)}</td>
                <td data-label="改动时间" className="muted">{ago(node.updated_at)}</td>
                {writable ? (
                  <td data-label="操作">
                    <button className="btn-danger" disabled={pending} onClick={() => submit('file_delete', { path: node.path })}>
                      排队删除
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {notice ? <p className="mono" style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--ok)' }}>{notice}</p> : null}
      <ErrorLine error={error} />
    </div>
  );
}

// --------------------------------------------------------------------------- 设置

export function SettingsPanel({ projectId, view }: { projectId: string; view: ProjectView }) {
  const { submit, notice, pending, error } = useEnqueue(projectId);
  const [title, setTitle] = useState(view.project.title);
  const [question, setQuestion] = useState(view.project.question ?? '');
  const [strategy, setStrategy] = useState(view.project.strategy ?? 'standard');
  const [autonomy, setAutonomy] = useState(view.project.autonomy ?? 'guided');
  const [visibility, setVisibility] = useState(view.visibility);

  const patch = () => {
    const body: Record<string, unknown> = {};
    if (title !== view.project.title) body.title = title;
    if (question !== (view.project.question ?? '')) body.question = question;
    if (strategy !== (view.project.strategy ?? 'standard')) body.strategy = strategy;
    if (autonomy !== (view.project.autonomy ?? 'guided')) body.autonomy = autonomy;
    if (visibility !== view.visibility) body.visibility = visibility;
    return body;
  };

  const dirty = Object.keys(patch()).length > 0;
  const downgraded = visibility === 'listed' && view.visibility !== 'listed';

  if (view.writable !== true) {
    return (
      <div className="panel">
        <h3 style={{ margin: '0 0 8px' }}>项目设置</h3>
        <p className="muted" style={{ margin: 0 }}>
          这个项目不是你的，设置只读。可见性与共享由 Owner 决定；需要改动请让 Owner 在设置里排队更新或分享新的读取 Token。
        </p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h3 style={{ margin: '0 0 8px' }}>项目设置</h3>
      <p className="muted" style={{ margin: '0 0 12px', fontSize: 12 }}>
        这些值由本地引擎拥有。改它们排成一条命令，Agent 在本地改完之后投影才会回写——直接改云端会在下一次同步被覆盖。
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input style={{ flex: '1 1 220px' }} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="项目标题" />
        <select value={strategy} onChange={(event) => setStrategy(event.target.value)} aria-label="策略">
          {['starter', 'standard', 'research'].map((entry) => (
            <option key={entry} value={entry}>{entry}</option>
          ))}
        </select>
        <select value={autonomy} onChange={(event) => setAutonomy(event.target.value)} aria-label="门槛">
          {['guided', 'autonomous', 'review-only'].map((entry) => (
            <option key={entry} value={entry}>{entry}</option>
          ))}
        </select>
        <select value={visibility} onChange={(event) => setVisibility(event.target.value as 'private' | 'link' | 'listed')} aria-label="可见性">
          <option value="private">private 仅自己</option>
          <option value="link">link 持链可读</option>
          <option value="listed">listed 进公开列表</option>
        </select>
      </div>
      <textarea style={{ width: '100%', marginTop: 8, minHeight: 60 }} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="研究问题" />
      {view.projection_level === 'l2' ? (
        <p className="muted" style={{ fontSize: 12 }}>策略与门槛不在这一级：被扣下不等于没记录。</p>
      ) : null}
      {downgraded ? (
        <p className="status-chip" data-state="blocked" style={{ marginTop: 8 }}>
          拨成 listed 会进公开列表，匿名访客能读到标题、研究问题与阶段读数。
        </p>
      ) : null}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <button className="btn-primary" disabled={pending || !dirty} onClick={() => submit('project_settings', patch())}>
          {pending ? '排队中…' : '排队更新'}
        </button>
        <button className="btn-danger" disabled={pending} onClick={() => submit('project_archive', {})}>
          排队归档云端投影
        </button>
        {notice ? <span className="muted mono" style={{ fontSize: 12 }}>{notice}</span> : null}
      </div>
      <ErrorLine error={error} />
    </div>
  );
}
