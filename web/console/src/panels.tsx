/**
 * Web-First 操作面板（Phase 3/4/5/6/8）。
 *
 * 云原生架构：所有操作直接在云端 Function 内执行，不排队等待本地 Agent（M0 起 local-agent 已删除）。
 * 按钮文案直接反映云端执行结果（"已创建"、"执行中"），不再说"排队"。
 *
 * 写操作只认 Owner。`writable` 来自 Function（`views.ts` / `commands.ts`），
 * 不是前端用可见性字段推断的——被邀读者是 full 读者但没有写权。
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, mutateJson, requestJson } from './api';
import type { AccessView, CommandStatus, CommandsView, ProjectView, RepoView } from './types';

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
      mutateJson<{ ok: boolean; message?: string; replayed?: boolean; payload_mismatch?: boolean }>(`${APP}/commands/${input.type}`, {
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
    if (mutation.isSuccess) {
      setNotice(
        mutation.data?.payload_mismatch
          ? '同一个 command_id 已经排过一条不同载荷的命令：返回原记录，没有排第二条'
          : mutation.data?.message ?? '命令已排队，等待本地 Agent 执行',
      );
    }
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
      mutateJson<{ ok: boolean; message?: string; cloud_executed?: boolean }>(`${APP}/projects`, {
        method: 'POST',
        body: JSON.stringify({ command_id: commandId, name, question, strategy, autonomy }),
      }),
    onSuccess: (data) => {
      if (data.cloud_executed) {
        setNotice('✅ 项目已在云端创建，投影将立即同步。');
      } else {
        setNotice('项目创建中…');
      }
      void client.invalidateQueries({ queryKey: ['index'] });
      void client.invalidateQueries({ queryKey: ['commands', ''] });
    },
  });

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <h3 style={{ margin: '0 0 8px' }}>创建项目</h3>
      <p className="muted" style={{ margin: '0 0 12px', fontSize: 12 }}>
        ☁️ 云端模式：立即在云端沙箱执行（演示用，不创建真实文件）
      </p>
      
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input style={{ flex: '1 1 180px' }} placeholder="项目名称" value={name} onChange={(event) => setName(event.target.value)} />
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
          {mutation.isPending ? '创建中…' : '立即创建'}
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

export function CommandQueue({ projectId, writable }: { projectId: string; writable?: boolean }) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['commands', projectId],
    queryFn: () => requestJson<CommandsView>(`${APP}/views/commands?external_id=${encodeURIComponent(projectId)}`),
    // 有未终态的命令时缩短到 5 秒，否则维持默认 staleTime：轮询频率要跟着队列状态走，
    // 空闲项目没必要一直打云端。
    refetchInterval: (state) => (state.state.data?.commands.some((c) => c.status === 'queued' || c.status === 'claimed' || c.status === 'running') ? 5_000 : false),
  });

  const cancel = useMutation({
    mutationFn: (commandId: string) =>
      mutateJson<{ ok: boolean; ignored?: string; message?: string }>(`${APP}/commands/cancel`, {
        method: 'POST',
        body: JSON.stringify({ external_id: projectId, command_id: commandId }),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['commands', projectId] });
    },
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
          {writable ? <th>操作</th> : null}
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
            {writable ? (
              <td data-label="操作">
                {command.status === 'queued' ? (
                  <button className="btn-danger" disabled={cancel.isPending} onClick={() => cancel.mutate(command.command_id)}>
                    撤回排队
                  </button>
                ) : command.status === 'claimed' || command.status === 'running' ? (
                  <span className="muted" style={{ fontSize: 11 }}>已交给本机，云端不中断</span>
                ) : null}
              </td>
            ) : null}
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
        <CommandQueue projectId={projectId} writable={writable} />
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
            <button className="btn-secondary" disabled={pending} onClick={() => submit('git_fetch', {})}>排队抓取</button>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input style={{ flex: '1 1 260px' }} placeholder="新分支名" value={branch} onChange={(event) => setBranch(event.target.value)} />
            <button className="btn-secondary" disabled={pending || branch.trim().length === 0} onClick={() => submit('git_branch', { name: branch })}>
              排队建分支
            </button>
          </div>
          <p className="muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
            界面不提供强制推送与丢弃改动：覆盖历史、`checkout --force` 这类动作应当在您自己的终端里做。提交在本地仓库执行，凭据不进云端。
          </p>
          {notice ? <p className="mono" style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--ok)' }}>{notice}</p> : null}
          <ErrorLine error={error} />
        </div>
      ) : null}

      <BranchPanel projectId={projectId} writable={writable} git={git} />
    </div>
  );
}

/**
 * 分支与合并（Phase 7）。
 *
 * 这一格刻意**没有**"三栏 diff / 冲突标记编辑"：那需要把文件正文搬到云端，而
 * 云端的契约是无正文（0001 不变量 3、0004 头注）。这里能给的最有用的读数是
 * "哪些文件在冲突"，剩下的动作留在本地终端。
 */
function BranchPanel({ projectId, writable, git }: { projectId: string; writable: boolean; git: RepoView['git'] }) {
  const { submit, notice, pending, error } = useEnqueue(projectId);
  const [target, setTarget] = useState('');
  const [strategy, setStrategy] = useState('ff-only');
  const branches = git?.branches ?? null;
  const conflicts = git?.conflicts ?? null;
  const remotes = git?.remotes ?? null;
  const names = (branches ?? []).map((entry) => entry.name);

  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <h3 style={{ margin: '0 0 8px' }}>分支</h3>
      {branches === null ? (
        <p className="muted" style={{ margin: 0 }}>
          分支清单还没有由 Agent 上报过（不是"没有分支"）。上一轮心跳只报了仓库状态时，这一格就该是空的。
        </p>
      ) : branches.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>上一轮上报里这个仓库没有本地分支。</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>分支</th>
              <th>领先/落后</th>
              {writable ? <th>操作</th> : null}
            </tr>
          </thead>
          <tbody>
            {branches.map((entry) => (
              <tr key={entry.name}>
                <td data-label="分支">
                  <span className="mono">{entry.name}</span>
                  {entry.current ? <span className="status-chip" data-state="active" style={{ marginLeft: 8 }}>当前</span> : null}
                </td>
                <td data-label="领先/落后" className="muted">
                  {entry.ahead === null && entry.behind === null ? '未上报' : `领先 ${entry.ahead ?? '?'} · 落后 ${entry.behind ?? '?'}`}
                </td>
                {writable ? (
                  <td data-label="操作">
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn-secondary" disabled={pending || entry.current} onClick={() => submit('git_checkout', { branch: entry.name })}>
                        排队切换
                      </button>
                      {entry.name === 'main' || entry.name === 'master' ? (
                        <span className="muted" style={{ alignSelf: 'center', fontSize: 11 }} title="主分支不在云端可删的集合里">
                          受保护
                        </span>
                      ) : (
                        <button className="btn-danger" disabled={pending || entry.current} onClick={() => submit('git_branch_delete', { name: entry.name })}>
                          排队删除
                        </button>
                      )}
                    </div>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {conflicts && conflicts.length > 0 ? (
        <div className="banner" style={{ marginTop: 10 }}>
          上一轮上报有 {conflicts.length} 个文件在冲突：
          {conflicts.slice(0, 6).map((path) => (
            <span className="mono" key={path} style={{ marginRight: 8, fontSize: 11 }}>{path}</span>
          ))}
          {conflicts.length > 6 ? <span className="muted"> 等 {conflicts.length} 个</span> : null}
          <div className="muted" style={{ marginTop: 4, fontSize: 11 }}>
            云端不保存文件正文，所以不在这里编辑冲突：在本地解决后排队提交即可，或放弃这次合并。
          </div>
          {writable ? (
            <button className="btn-danger" disabled={pending} style={{ marginTop: 6 }} onClick={() => submit('git_merge_abort', {})}>
              排队放弃合并
            </button>
          ) : null}
        </div>
      ) : null}

      {writable ? (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              style={{ flex: '1 1 200px' }}
              placeholder={names.length > 0 ? `合并来源，例如 ${names.find((n) => n !== git?.branch) ?? names[0]}` : '合并来源分支名'}
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              list={`branches-${projectId}`}
            />
            <datalist id={`branches-${projectId}`}>
              {names.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <select value={strategy} onChange={(event) => setStrategy(event.target.value)} aria-label="合并策略">
              <option value="ff-only">ff-only</option>
              <option value="no-ff">no-ff</option>
              <option value="squash">squash</option>
            </select>
            <button className="btn-primary" disabled={pending || target.trim().length === 0} onClick={() => submit('git_merge', { target, strategy })}>
              排队合并
            </button>
          </div>
          {git?.dirty === true ? (
            <p className="status-chip" data-state="blocked" style={{ marginTop: 6 }}>
              本地有未提交改动，建议先排队提交再合并。
            </p>
          ) : null}
          <p className="muted" style={{ margin: '6px 0 0', fontSize: 12 }}>
            默认 ff-only：不能快进时 Agent 会失败并把原因回写到这里，不会自作主张产生合并提交。
          </p>
          {notice ? <p className="mono" style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--ok)' }}>{notice}</p> : null}
          <ErrorLine error={error} />
        </div>
      ) : null}

      {remotes && remotes.length > 0 ? (
        <p className="muted mono" style={{ margin: '8px 0 0', fontSize: 11 }}>
          远端：{remotes.join(' · ')}（地址与凭据留在本地配置里）
        </p>
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
    queryFn: () => requestJson<AccessView>(`${APP}/views/access?external_id=${encodeURIComponent(projectId)}`),
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
      mutateJson<{ ok: boolean; replayed?: boolean; email: string; message?: string }>(`${APP}/access/grants`, {
        method: 'POST',
        body: JSON.stringify({ external_id: projectId, email: input.email, role: input.role }),
      }),
    onSuccess: (data) => {
      setNotice(data.replayed ? `${data.email} 之前被邀请过，这一条被重新点亮，而不是多出第二条权限` : (data.message ?? '邀请已记下'));
      setEmail('');
      invalidate();
    },
  });

  const revoke = useMutation({
    mutationFn: (grantId: string) =>
      mutateJson<{ ok: boolean }>(`${APP}/access/grants/${grantId}?external_id=${encodeURIComponent(projectId)}`, { method: 'DELETE' }),
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
      mutateJson<{ ok: boolean }>(`${APP}/access/share/${shareId}?external_id=${encodeURIComponent(projectId)}`, { method: 'DELETE' }),
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
          谁读得到这个项目由 Owner 决定。你现在的身份是被邀请的读者：能读，但不能把自己的读权限转发给别人。
        </p>
      </div>
    );
  }

  if (query.isPending) return <p className="muted mono">读取权限加载中…</p>;
  if (query.error) return <ErrorLine error={query.error as Error} />;

  const active = query.data.grants.filter((grant) => !grant.revoked_at);
  const shares = query.data.shares.filter((share) => !share.revoked_at);
  const link = plain ? `${window.location.origin}${window.location.pathname}#/p/${encodeURIComponent(projectId)}?share=${plain}` : null;
  const busy = invite.isPending || revoke.isPending || createShare.isPending || revokeShare.isPending;

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
      <p className="muted" style={{ margin: '0 0 12px', fontSize: 12 }}>
        这一页改的是云端的读取权限，不是本地投影：邀请与撤销点了就判定，下一次请求生效；项目可见性仍然要排队给本地 Agent 改。
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
              <td colSpan={5} className="muted">还没有邀请过读者。这个项目的 L1 读数目前只有你能看。</td>
            </tr>
          ) : (
            active.map((grant) => (
              <tr key={grant.id}>
                <td data-label="邮箱" className="mono">{grant.email}</td>
                <td data-label="读取范围">{grant.role === 'viewer' ? '降级读数（L2，看不到运行状态与成本）' : '完整读数（含 L1）'}</td>
                <td data-label="对方状态">
                  <span className="status-chip" data-state={grant.joined ? 'ok' : 'idle'}>{grant.joined ? '已登录过云端' : '还没登录过'}</span>
                </td>
                <td data-label="邀请时间" className="muted">{ago(grant.created_at)}</td>
                <td data-label="操作">
                  <button className="btn-danger" disabled={busy} onClick={() => revoke.mutate(grant.id)}>
                    撤销
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        <input style={{ flex: '1 1 220px' }} placeholder="对方邮箱" value={email} onChange={(event) => setEmail(event.target.value)} aria-label="受邀邮箱" />
        <select value={role} onChange={(event) => setRole(event.target.value as 'reviewer' | 'viewer')} aria-label="读取范围">
          <option value="reviewer">完整读数（含 L1）</option>
          <option value="viewer">降级读数（L2）</option>
        </select>
        <button className="btn-primary" disabled={busy || email.trim() === ''} onClick={() => invite.mutate({ email: email.trim(), role })}>
          {invite.isPending ? '记录中…' : '邀请读者'}
        </button>
      </div>
      <p className="muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
        邀请给的是读权限，不是写权限；对方还没在云端注册也能先邀请，首次登录后自动接上。
      </p>
      <ErrorLine error={(invite.error ?? revoke.error) as Error | null} />

      <h4 style={{ margin: '16px 0 8px' }}>未记名链接</h4>
      {view.visibility === 'private' ? (
        <p className="status-chip" data-state="blocked">
          项目还是 private，链接造不出来：先在设置里把可见性排队改成 link，等本地 Agent 改完回写投影，这里才允许生成。
        </p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn-primary" disabled={busy} onClick={() => createShare.mutate()}>
              {createShare.isPending ? '生成中…' : '生成分享链接'}
            </button>
            <span className="muted" style={{ fontSize: 12 }}>token 只在生成这一次显示；云端只存哈希，关掉页面就读不回明文。</span>
          </div>
          {link ? (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              <input className="mono" readOnly value={link} onFocus={(event) => event.target.select()} aria-label="分享链接" style={{ flex: '1 1 320px' }} />
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
                  <td colSpan={3} className="muted">当前没有有效链接。</td>
                </tr>
              ) : (
                shares.map((share) => (
                  <tr key={share.id}>
                    <td data-label="生成时间" className="muted">{ago(share.created_at)}</td>
                    <td data-label="状态"><span className="status-chip" data-state="ok">有效</span></td>
                    <td data-label="操作">
                      <button className="btn-danger" disabled={busy} onClick={() => revokeShare.mutate(share.id)}>
                        撤销
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <p className="muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
            持链接的人只读到 L2：标题、研究问题、阶段与结论标签。运行状态、成本、事件摘要不在链接这一级——那等于把 L1 交给转发。
          </p>
        </>
      )}
      <ErrorLine error={(createShare.error ?? revokeShare.error) as Error | null} />
      {notice ? <p className="mono" style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--ok)' }}>{notice}</p> : null}
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
              <td data-label="时间" className="muted">{ago(entry.created_at)}</td>
              <td data-label="操作">{TYPE_LABEL[entry.type] ?? entry.type}</td>
              <td data-label="项目" className="mono">{entry.project ?? '（还没落到项目）'}</td>
              <td data-label="状态">
                <span className="status-chip" data-state={COMMAND_STATE[entry.status] ?? 'idle'}>{COMMAND_LABEL[entry.status] ?? entry.status}</span>
              </td>
              <td data-label="结果" className="muted mono" style={{ fontSize: 11 }}>
                {entry.error ?? (entry.finished_at ? '本地已回写' : '—')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
        最近 {shown.length} 条由你排出的命令。云端只记谁排了什么、结果如何；执行细节在本地引擎的台账里。
      </p>
    </div>
  );
}
