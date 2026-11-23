import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Route, Switch, useLocation } from 'wouter';
import { ApiError, loginHref, requestJson } from './api';
import { openLive, type Transport } from './live';
import type { EventRow, IndexView, IdeaSummary, LiveFrame, PaperCard, ClaimRow, ExperimentResult, ProtocolSummary, ProjectView, RunSummary } from './types';

/**
 * 阶段名逐字取 `docs/WORKFLOW_SPEC.md:5-21`（经 DIAGRAMS.md §2.5 转录）。
 * 控制台不得增删或重命名——NFR-12。引擎当前只产出 INIT/DEMO/COMPLETED 三个
 * RunPhase，所以 `stage_known=false` 的阶段要显式画成"未上报"，
 * 而不是被投影层悄悄抹平成"未开始"。
 */
const STAGES = [
  'INIT',
  'INPUT_READY',
  'CALIBRATING',
  'PAPER_ANALYSIS',
  'DATA_READY',
  'PROTOCOL_PROPOSED',
  'PROTOCOL_REVIEW',
  'COMPARISON_DISCOVERY',
  'COMPARISON_REPRODUCTION',
  'BASELINE_VALIDATED',
  'IDEA_GENERATION',
  'IDEA_SCREENING',
  'EXPERIMENTING',
  'IDEA_REVIEW',
  'COMPLETED',
] as const;

const STATUS_STATE: Record<string, 'ok' | 'active' | 'blocked' | 'fail' | 'quota' | 'idle'> = {
  SUCCEEDED: 'ok',
  COMPLETED: 'ok',
  RUNNING: 'active',
  INIT: 'active',
  PAUSED: 'blocked',
  USER_INPUT_REQUIRED: 'blocked',
  PROTOCOL_REVIEW: 'blocked',
  AUTH_REQUIRED: 'blocked',
  NETWORK_BLOCKED: 'blocked',
  QUOTA_EXHAUSTED: 'quota',
  FAILED_RECOVERABLE: 'fail',
  FAILED: 'fail',
  CANCELED: 'idle',
};

function stateOf(value: string | null | undefined): string {
  return (value && STATUS_STATE[value]) || 'idle';
}

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

function Chips({ run }: { run: RunSummary }) {
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
      {run.status ? (
        // L2 降级投影里没有 status（F5.2），不渲染而不是渲染成 `status=undefined`。
        <span className="status-chip" data-state={stateOf(run.status)}>
          status={run.status}
        </span>
      ) : null}
      <span className="status-chip" data-state={run.stage_known ? stateOf(run.phase_tag) : 'idle'}>
        phase={run.phase_tag}
        {run.stage_known ? '' : '（未上报）'}
      </span>
      {run.status === 'QUOTA_EXHAUSTED' ? (
        // 额度耗尽不是失败：文案与配色都要分开（F2.4）。
        <span className="status-chip" data-state="quota">
          额度已用尽 · 不是运行失败
        </span>
      ) : null}
    </span>
  );
}

/**
 * F2.5: 阻塞原因卡——说清卡在哪、等什么、下一步建议是什么。
 *
 * 与科学失败（FAILED/FAILED_RECOVERABLE）视觉分离（F2.4）：阻塞是"还在等"，
 * 失败是"已经停了"。两者的用户动作完全不同。
 */
function BlockReasonCard({ run }: { run: RunSummary }) {
  if (!run.block_reason && !run.block_detail) return null;
  const detail = run.block_detail;
  const kind = detail?.kind ?? run.status ?? 'BLOCKED';
  // 额度耗尽、需要认证、网络阻断是基础设施问题，不是科学失败（WORKFLOW_SPEC.md:27）。
  const isInfra = ['QUOTA_EXHAUSTED', 'AUTH_REQUIRED', 'NETWORK_BLOCKED'].includes(kind);
  // 从 block_reason 推导 next 建议（如果 detail 没有提供）。
  const next = detail?.next ?? deriveNextFromReason(kind, run.block_reason);
  return (
    <div className="panel" style={{ borderLeftColor: isInfra ? 'var(--quota)' : 'var(--blocked)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span className="status-chip" data-state={isInfra ? 'quota' : 'blocked'}>
          {isInfra ? '基础设施阻塞' : '等待确认'}
        </span>
        <strong>{kind}</strong>
      </div>
      {detail?.message ? (
        <p style={{ margin: '0 0 8px' }}>{detail.message}</p>
      ) : run.block_reason ? (
        <p style={{ margin: '0 0 8px' }}>{run.block_reason}</p>
      ) : null}
      {next ? (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          下一步：<code className="mono">{next}</code>
        </p>
      ) : null}
    </div>
  );
}

function deriveNextFromReason(kind: string, blockReason: string | null | undefined): string | null {
  switch (kind) {
    case 'QUOTA_EXHAUSTED':
      return 'ideaseek doctor → 检查额度 → ideaseek continue';
    case 'AUTH_REQUIRED':
      return 'ideaseek setup → 配置凭据 → ideaseek continue';
    case 'NETWORK_BLOCKED':
      return '检查网络连接 → ideaseek continue';
    case 'USER_INPUT_REQUIRED':
      return 'ideaseek attach → 回应提示';
    case 'PROTOCOL_REVIEW':
      return 'ideaseek pending → 查看待确认协议';
    default:
      return blockReason ? 'ideaseek status → 查看详情' : null;
  }
}

/**
 * F2.3: 运行历史列表——一个 project 的多次 run，含终态与耗时。
 *
 * 按 started_at 倒序；终态用 status chip 渲染，耗时用墙钟时间。
 * L2 降级下 status 不可见，只留阶段与时间。
 */
function RunHistory({ runs }: { runs: RunSummary[] }) {
  if (runs.length === 0) return <p className="muted">还没有运行记录。</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>运行 ID</th>
          <th>阶段</th>
          <th>状态</th>
          <th>开始时间</th>
          <th>耗时</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => {
          const duration = run.started_at && run.finished_at
            ? formatDuration(new Date(run.finished_at).getTime() - new Date(run.started_at).getTime())
            : run.finished_at ? '—' : '进行中';
          return (
            <tr key={run.external_run_id}>
              <td className="mono">{run.external_run_id.slice(0, 8)}…</td>
              <td>
                <span className="status-chip" data-state={run.stage_known ? stateOf(run.phase_tag) : 'idle'}>
                  {run.phase_tag}
                  {run.stage_known ? '' : '（未上报）'}
                </span>
              </td>
              <td>
                {run.status ? (
                  <span className="status-chip" data-state={stateOf(run.status)}>
                    {run.status}
                  </span>
                ) : (
                  <span className="muted">不在公开级</span>
                )}
              </td>
              <td className="muted">{run.started_at ? new Date(run.started_at).toLocaleString() : '—'}</td>
              <td className="muted">{duration}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

function Pipeline({ stages }: { stages: ProjectView['stages'] }) {
  const byName = new Map(stages.map((s) => [s.stage, s]));
  return (
    <div style={{ margin: '16px 0' }}>
      <h3 style={{ fontSize: 15, margin: '0 0 8px' }}>阶段流水线</h3>
      <ol className="pipeline" style={{ listStyle: 'none', display: 'flex', flexWrap: 'wrap', gap: 4, padding: 0 }}>
        {STAGES.map((stage) => {
          const row = byName.get(stage);
          const state = row ? stateOf(row.state) : 'idle';
          const title = row?.gate_note ?? row?.blocker_code ?? '';
          return (
            <li key={stage} className="status-chip" data-state={state} title={title}>
              {stage}
            </li>
          );
        })}
      </ol>
      {/* F3.3: 门槛达成说明——每个阶段的进入条件与当前证据 */}
      {stages.some((s) => s.gate_note || s.blocker_code) ? (
        <details style={{ marginTop: 8 }}>
          <summary className="muted" style={{ cursor: 'pointer', fontSize: 13 }}>
            查看门槛说明
          </summary>
          <div style={{ marginTop: 8, paddingLeft: 16 }}>
            {stages
              .filter((s) => s.gate_note || s.blocker_code)
              .map((s) => (
                <div key={s.stage} style={{ marginBottom: 8 }}>
                  <strong className="mono">{s.stage}</strong>
                  {s.gate_note ? <p style={{ margin: '2px 0' }}>{s.gate_note}</p> : null}
                  {s.blocker_code ? (
                    <p className="muted" style={{ margin: '2px 0', fontSize: 12 }}>
                      阻塞码：<code className="mono">{s.blocker_code}</code>
                    </p>
                  ) : null}
                </div>
              ))}
          </div>
        </details>
      ) : null}
      {/* F3.4: unknown 阶段兜底——映射不到 14 阶段的显式标出 */}
      {stages.some((s) => !s.stage_known) ? (
        <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          注：标记为"未上报"的阶段是引擎尚未投影到 14 阶段模型的中间状态。
        </p>
      ) : null}
    </div>
  );
}

/**
 * F4.1-F4.4: 时间线视图——事件按 seq 倒序分页，支持过滤，批更新标注。
 *
 * F4.4: 明确标注"数据来自 x 分钟前的一批同步"，禁用"实时"字样（R3）。
 * F4.2: 按 stage / type / level 过滤（actor_role 当前引擎未投影，留接口）。
 * F4.3: 摘要≤400字符，截断标记可见。
 */
function EventList({ events, redacted, lastSyncAt }: { events: EventRow[]; redacted: boolean; lastSyncAt: string | null }) {
  const [stageFilter, setStageFilter] = useState<string>('');
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [levelFilter, setLevelFilter] = useState<string>('');
  const [page, setPage] = useState(0);
  const pageSize = 200;

  // F4.2: 过滤逻辑
  const filtered = events.filter((event) => {
    if (stageFilter && event.phase_tag !== stageFilter) return false;
    if (typeFilter && event.type !== typeFilter) return false;
    if (levelFilter && event.level !== levelFilter) return false;
    return true;
  });

  // F4.1: 分页
  const totalPages = Math.ceil(filtered.length / pageSize);
  const paginatedEvents = filtered.slice(page * pageSize, (page + 1) * pageSize);

  // 提取唯一的 stage / type / level 值用于过滤选项
  const stageOptions = [...new Set(events.map((e) => e.phase_tag).filter(Boolean))] as string[];
  const typeOptions = [...new Set(events.map((e) => e.type))];
  const levelOptions = [...new Set(events.map((e) => e.level))];

  // L2 的事件摘要是被有意扣下的，不是这条运行没有事件——两者混说就是把降级读成空数据。
  if (events.length === 0) return <p className="muted">{redacted ? '事件摘要不在公开降级投影（L2）这一级。' : '云端还没有这条运行的事件。'}</p>;

  return (
    <div>
      {/* F4.4: 批更新标注——明确说明数据来源时间，禁用"实时"字样 */}
      <p className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>
        数据来自 {ago(lastSyncAt)}的一批同步 · 共 {filtered.length} 条事件
        {filtered.length !== events.length ? `（已过滤 ${events.length - filtered.length} 条）` : ''}
      </p>
      {/* F4.2: 过滤器 */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <select value={stageFilter} onChange={(e) => { setStageFilter(e.target.value); setPage(0); }} style={{ background: 'var(--panel)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 4, padding: '4px 8px' }}>
          <option value="">全部阶段</option>
          {stageOptions.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); setPage(0); }} style={{ background: 'var(--panel)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 4, padding: '4px 8px' }}>
          <option value="">全部类型</option>
          {typeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={levelFilter} onChange={(e) => { setLevelFilter(e.target.value); setPage(0); }} style={{ background: 'var(--panel)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 4, padding: '4px 8px' }}>
          <option value="">全部级别</option>
          {levelOptions.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
        {(stageFilter || typeFilter || levelFilter) ? (
          <button onClick={() => { setStageFilter(''); setTypeFilter(''); setLevelFilter(''); setPage(0); }} style={{ background: 'var(--panel)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 4, padding: '4px 12px', cursor: 'pointer' }}>
            清除过滤
          </button>
        ) : null}
      </div>
      {/* 事件列表 */}
      <table>
        <tbody>
          {paginatedEvents.map((event) => (
            <tr key={event.seq}>
              <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                #{event.seq}
              </td>
              <td className="mono muted" style={{ whiteSpace: 'nowrap' }}>
                {new Date(event.ts).toLocaleTimeString()}
              </td>
              <td>
                {event.gap_before > 0 ? (
                  // 缺口必须说出来：安静地展示一条更短的时间线是本项目定义过的静默降级。
                  <span className="status-chip" data-state="fail">
                    {event.gap_before} 条事件未同步
                  </span>
                ) : null}
                {/* F4.3: 摘要展示与截断标记 */}
                {event.summary}
                {event.truncated ? <span className="muted" title="摘要被截断至 400 字符"> …（已截断）</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* 分页控制 */}
      {totalPages > 1 ? (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 12 }}>
          <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0} style={{ background: 'var(--panel)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 4, padding: '4px 12px', cursor: page === 0 ? 'not-allowed' : 'pointer', opacity: page === 0 ? 0.5 : 1 }}>
            上一页
          </button>
          <span className="muted" style={{ display: 'flex', alignItems: 'center' }}>
            {page + 1} / {totalPages}
          </span>
          <button onClick={() => setPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1} style={{ background: 'var(--panel)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 4, padding: '4px 12px', cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer', opacity: page >= totalPages - 1 ? 0.5 : 1 }}>
            下一页
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Landing() {
  const query = useQuery({
    queryKey: ['index'],
    queryFn: () => requestJson<IndexView>('/functions/v1/app/views/index'),
  });
  const [, navigate] = useLocation();
  return (
    <>
      {/* F6.1: 落地页 Hero */}
      <div className="hero" style={{ textAlign: 'center', padding: '48px 24px', marginBottom: 32 }}>
        <h1 style={{ fontSize: 32, marginBottom: 16 }}>IdeaSeek</h1>
        <p style={{ fontSize: 18, color: 'var(--muted)', marginBottom: 24 }}>
          从研究问题，到可验证发现
        </p>
        <div style={{ display: 'flex', gap: 16, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 24 }}>
          <span className="status-chip" data-state="ok">证据链</span>
          <span className="status-chip" data-state="ok">恢复语义</span>
          <span className="status-chip" data-state="ok">公平性锁定</span>
          <span className="status-chip" data-state="ok">审计门禁</span>
        </div>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button onClick={() => navigate('/#/p/demo')} style={{ background: 'var(--active)', color: '#fff', border: 'none', borderRadius: 6, padding: '10px 20px', cursor: 'pointer', fontSize: 14 }}>
            查看演示项目
          </button>
          <a href="#docs" style={{ background: 'var(--panel)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 6, padding: '10px 20px', textDecoration: 'none', fontSize: 14 }}>
            阅读文档
          </a>
        </div>
      </div>

      {/* F6.2: 差异化定位段 */}
      <div className="panel" style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 18, marginTop: 0 }}>与"单 Agent 直接写论文"的三条差异</h2>
        <ol style={{ paddingLeft: 20, margin: '12px 0' }}>
          <li style={{ marginBottom: 8 }}>
            <strong>引擎在哪里</strong>：科研引擎运行在<strong>你自己的机器</strong>上，云端不碰你的论文和数据。云端只有脱敏后的运行状态与事件投影。
          </li>
          <li style={{ marginBottom: 8 }}>
            <strong>结论怎么来的</strong>：每个 idea 都有论文证据、baseline 局限、可检验假设和停止条件。不是 Agent 拍脑袋，是有据可查的证据链。
          </li>
          <li style={{ marginBottom: 8 }}>
            <strong>失败了怎么办</strong>：额度耗尽、网络中断、审批阻塞——每种异常都有明确的恢复路径。不是"重跑一遍"，是精确续接。
          </li>
        </ol>
      </div>

      {/* F6.3: 公开项目入口 */}
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 18 }}>在线项目</h2>
        {query.isPending ? <p className="muted">正在读取云端投影…</p> : null}
        {query.error instanceof ApiError && query.error.code === 'login_required' ? (
          <p>
            <a href={loginHref('/#/')}>登录 Qoder</a> 后继续。
          </p>
        ) : null}
        {query.error && !(query.error instanceof ApiError && query.error.code === 'login_required') ? (
          <p className="status-chip" data-state="fail">
            {(query.error as Error).message}
          </p>
        ) : null}
        {query.data && query.data.projects.length === 0 ? (
          <>
            <p className="muted">还没有可见项目。</p>
            {/* F7.3: 首访引导——匿名访客默认落到演示项目 */}
            <p>
              可以先查看 <a href="#/p/demo">合成演示项目</a>，了解控制台的观测能力。
            </p>
          </>
        ) : null}
        {query.data ? (
          <table>
            <tbody>
              {query.data.projects.map((project) => (
                <tr
                  key={project.external_id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => navigate(`/p/${project.external_id}`)}
                >
                  <td>
                    {project.title}
                    {/* F7.4: 演示数据指标诚实标注 */}
                    {project.external_id === 'demo' ? (
                      <span className="status-chip" data-state="active" style={{ marginLeft: 8, fontSize: 11 }}>
                        演示数据
                      </span>
                    ) : null}
                    <div className="muted mono">{project.external_id}</div>
                  </td>
                  <td className="muted">最后同步 {ago(project.last_sync_at)}</td>
                  <td>{project.latest_run ? <Chips run={project.latest_run} /> : <span className="muted">无运行</span>}</td>
                  <td className="status-chip">{project.visibility}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>

      {/* F6.4 + F6.5: 文档站 + 安装指引 */}
      <div id="docs" className="panel" style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 18, marginTop: 0 }}>快速开始</h2>
        <p>在本地安装 IdeaSeek，科研引擎在你的机器上运行：</p>
        <pre style={{ background: 'var(--bg)', padding: 12, borderRadius: 4, overflow: 'auto', fontSize: 13 }}>
          <code className="mono">
{`# 安装
curl -fsSL https://ideaseek.dev/setup.sh | bash

# 初始化项目
ideaseek init my-research

# 启动交互式会话
ideaseek start`}
          </code>
        </pre>
        <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
          云端不含引擎。投影同步是可选的：<code className="mono">ideaseek cloud link</code> 建立连接后，<code className="mono">ideaseek cloud push</code> 将脱敏状态推送到云端，让你在手机或任意浏览器远程观察。
        </p>
      </div>

      {/* 底部说明 */}
      <div className="banner" style={{ fontSize: 13 }}>
        <strong>隐私承诺</strong>：论文正文、数据集、凭据、原始日志永远不离开你的机器。云端只有脱敏后的运行状态与事件投影。
      </div>
    </>
  );
}

function Project({ id }: { id: string }) {
  const query = useQuery({
    queryKey: ['project', id],
    queryFn: () => requestJson<ProjectView>(`/functions/v1/app/views/project?external_id=${encodeURIComponent(id)}`),
  });
  const [transport, setTransport] = useState<Transport>('connecting');
  const [liveEvents, setLiveEvents] = useState<EventRow[]>([]);
  const [revoked, setRevoked] = useState<string | null>(null);
  const refetch = query.refetch;

  useEffect(() => {
    setLiveEvents([]);
    setRevoked(null);
    const handle = openLive({
      projectId: id,
      onFrame(frame: LiveFrame) {
        if (frame.type === 'revoked') {
          setRevoked(frame.reason);
          handle.close();
          return;
        }
        if (frame.type === 'events') setLiveEvents((previous) => [...previous, ...frame.events].slice(-200));
        else void refetch();
      },
      onTransport: setTransport,
      onError: () => setTransport('polling'),
    });
    const interval = setInterval(() => void refetch(), 60_000);
    return () => {
      handle.close();
      clearInterval(interval);
    };
  }, [id, refetch]);

  if (revoked) {
    return <p className="status-chip" data-state="fail">投影已被撤销：{revoked}</p>;
  }
  if (query.isPending) return <p className="muted">正在读取投影…</p>;
  if (query.error) {
    return <p className="status-chip" data-state="fail">{(query.error as Error).message}</p>;
  }
  const view = query.data;
  const latest = view.runs[0];
  const l2 = view.projection_level === 'l2';
  return (
    <>
      <p>
        <a href="#/">← 项目列表</a>
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <h1 style={{ margin: 0 }}>{view.project.title}</h1>
        {/* F5.1: 可见性徽标 */}
        <VisibilityBadge visibility={view.visibility} />
      </div>
      {view.projection_level === 'l2' ? (
        // 降级要说明降了什么，否则空区块会被读成"没有数据"（缺口⑨ 的同一类错误）。
        <p className="banner">
          你看到的是公开降级投影（L2）。运行状态与原因、事件摘要、门槛说明、成本与假设全文不在这一级。
        </p>
      ) : null}
      <p className="muted">
        {ago(view.project.last_sync_at)}同步 · strategy={l2 ? '不在这一级' : (view.project.strategy ?? '未记录')} · autonomy=
        {l2 ? '不在这一级' : (view.project.autonomy ?? '未记录')} ·{' '}
        <span className="status-chip" data-state={transport === 'websocket' ? 'active' : transport === 'polling' ? 'blocked' : 'idle'}>
          {transport === 'websocket' ? '服务端推送' : transport === 'polling' ? '降级：15 s 轮询' : '连接中'}
        </span>
      </p>
      {view.project.question ? <p className="panel">{view.project.question}</p> : null}
      {latest ? (
        <>
          <Chips run={latest} />
          <BlockReasonCard run={latest} />
        </>
      ) : (
        <p className="muted">云端还没有这个项目的运行。</p>
      )}
      <Pipeline stages={view.stages} />
      {view.unsynced && view.unsynced.pending_batches > 0 ? (
        <p className="status-chip" data-state="blocked">
          本地还有 {view.unsynced.pending_batches} 批未投递 · {view.unsynced.dropped_events} 条事件被丢弃
        </p>
      ) : null}
      <h2>运行历史</h2>
      <RunHistory runs={view.runs} />
      {/* F8: Idea 看板——L1 字段，L2 降级时不显示 */}
      {view.ideas && view.ideas.length > 0 && !l2 ? (
        <IdeaBoard ideas={view.ideas} />
      ) : null}
      {/* F9: 证据链追溯——L1 字段，L2 降级时不显示 */}
      {view.papers && view.claims && !l2 ? (
        <EvidenceChain papers={view.papers} claims={view.claims} />
      ) : null}
      {/* F10: 实验结果与协议对比——L1 字段，L2 降级时不显示 */}
      {view.experiments && view.protocols && !l2 ? (
        <ExperimentView experiments={view.experiments} protocols={view.protocols} />
      ) : null}
      <h2>事件</h2>
      <EventList events={[...view.events, ...liveEvents].slice(-80)} redacted={l2} lastSyncAt={view.project.last_sync_at} />
    </>
  );
}

/**
 * F5.1: 可见性徽标——显示当前项目的可见性级别。
 *
 * 三态语义（Q1）：
 * - private: 只有 Owner 与被邀读者可读
 * - link: 持有分享链接的人可读
 * - listed: 出现在公开列表中
 */
function VisibilityBadge({ visibility }: { visibility: 'private' | 'link' | 'listed' }) {
  const labels = {
    private: { text: '私有', state: 'idle' as const },
    link: { text: '链接可见', state: 'active' as const },
    listed: { text: '公开', state: 'ok' as const },
  };
  const { text, state } = labels[visibility];
  return (
    <span className="status-chip" data-state={state} title={getVisibilityDescription(visibility)}>
      {text}
    </span>
  );
}

function getVisibilityDescription(visibility: 'private' | 'link' | 'listed'): string {
  switch (visibility) {
    case 'private':
      return '只有项目所有者和被邀请的读者可以查看';
    case 'link':
      return '持有分享链接的人可以查看，但不会出现在公开列表中';
    case 'listed':
      return '出现在公开项目列表中，任何人都可以查看（L2 降级投影）';
  }
}

/**
 * F8.1: Idea 卡片——标题、机制摘要、状态、结论。
 *
 * F8.3: DRAFT_COMPOSITION 徽标——无理由拼接的候选必须标出，不得混入"有效 idea"。
 * F8.5: 假设全文按 hypothesis_disclosure 分级显示。
 * F8.6: 结论徽章——SUPPORTED/NEEDS_REVISION/REJECTED/INVALID_RUN。
 */
function IdeaCard({ idea }: { idea: IdeaSummary }) {
  const isDraft = idea.status === 'DRAFT_COMPOSITION';
  const verdictState = idea.verdict === 'SUPPORTED' ? 'ok'
    : idea.verdict === 'REJECTED' || idea.verdict === 'INVALID_RUN' ? 'fail'
    : idea.verdict === 'NEEDS_REVISION' ? 'blocked'
    : 'idle';
  return (
    <div className="panel" style={{ opacity: isDraft ? 0.6 : 1, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <strong style={{ fontSize: 15 }}>{idea.title}</strong>
        {isDraft ? (
          <span className="status-chip" data-state="blocked" style={{ fontSize: 11 }}>
            DRAFT_COMPOSITION
          </span>
        ) : null}
        <span className="status-chip" data-state="idle" style={{ fontSize: 11 }}>
          v{idea.version}
        </span>
      </div>
      {idea.mechanism_summary ? (
        <p style={{ margin: '0 0 8px', fontSize: 13 }}>{idea.mechanism_summary}</p>
      ) : null}
      {/* F8.5: 假设全文按 disclosure 分级 */}
      {idea.hypothesis_disclosure === 'full' && idea.hypothesis ? (
        <details style={{ marginBottom: 8 }}>
          <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>查看假设全文</summary>
          <p style={{ margin: '8px 0', fontSize: 13, whiteSpace: 'pre-wrap' }}>{idea.hypothesis}</p>
        </details>
      ) : idea.hypothesis_disclosure === 'structure' ? (
        <p className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>
          假设结构已公开，全文需 Owner 授权
        </p>
      ) : (
        <p className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>
          假设全文未公开（withheld）
        </p>
      )}
      {/* F8.6: 结论徽章 */}
      {idea.verdict ? (
        <span className="status-chip" data-state={verdictState}>
          {idea.verdict}
        </span>
      ) : (
        <span className="status-chip" data-state="idle">无结论</span>
      )}
    </div>
  );
}

/**
 * F8.2: 版本树——parent_idea_id 链。
 *
 * 按 parent_idea_id 递归构建树结构，显示 idea 的演化历史。
 */
function VersionTree({ ideas }: { ideas: IdeaSummary[] }) {
  const byId = new Map(ideas.map((i) => [i.external_idea_id, i]));
  const roots = ideas.filter((i) => !i.parent_idea_id || !byId.has(i.parent_idea_id));

  if (roots.length === 0) return <p className="muted">还没有 idea。</p>;

  const renderTree = (idea: IdeaSummary, depth: number): JSX.Element => {
    const children = ideas.filter((i) => i.parent_idea_id === idea.external_idea_id);
    return (
      <div key={idea.external_idea_id} style={{ marginLeft: depth * 20, marginBottom: 8 }}>
        <IdeaCard idea={idea} />
        {children.map((child) => renderTree(child, depth + 1))}
      </div>
    );
  };

  return <div>{roots.map((root) => renderTree(root, 0))}</div>;
}

/**
 * F9: 证据链追溯组件。
 *
 * F9.1: 论文卡片列表——标题、问题、方法摘要、解析状态。
 * F9.2: claim → 页码定位——点击结论跳到 evidence_ref(page, section)。
 * F9.3: unknown/uncertain 呈现——缺失字段显示"未确认"而非空白或猜测。
 * F9.4: 结论—证据—实验三跳——idea ↔ claim ↔ metric 互链。
 */
function PaperCardList({ papers }: { papers: PaperCard[] }) {
  if (papers.length === 0) return <p className="muted">还没有论文卡片。</p>;
  return (
    <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
      {papers.map((paper) => (
        <div key={paper.external_paper_id} className="panel" style={{ marginBottom: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <strong style={{ fontSize: 14 }}>{paper.title}</strong>
            <span className="status-chip" data-state={paper.parse_status === 'parsed' ? 'ok' : 'blocked'} style={{ fontSize: 11 }}>
              {paper.parse_status}
            </span>
          </div>
          {paper.question ? <p style={{ margin: '0 0 8px', fontSize: 13 }}>{paper.question}</p> : null}
          {paper.method_summary ? <p className="muted" style={{ margin: 0, fontSize: 12 }}>{paper.method_summary}</p> : null}
        </div>
      ))}
    </div>
  );
}

function ClaimList({ claims }: { claims: ClaimRow[] }) {
  if (claims.length === 0) return <p className="muted">还没有结论陈述。</p>;
  return (
    <div style={{ marginTop: 12 }}>
      {claims.map((claim) => (
        <div key={claim.external_claim_id} className="panel" style={{ marginBottom: 8 }}>
          <p style={{ margin: '0 0 8px' }}>{claim.text}</p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="status-chip" data-state={claim.support_level === 'supported' ? 'ok' : claim.support_level === 'uncertain' ? 'blocked' : 'idle'} style={{ fontSize: 11 }}>
              {claim.support_level}
            </span>
            {/* F9.2: claim → 页码定位 */}
            {claim.evidence_ref?.paper_external_id ? (
              <span className="muted" style={{ fontSize: 12 }}>
                出处：{claim.evidence_ref.paper_external_id}
                {claim.evidence_ref.page ? ` 第 ${claim.evidence_ref.page} 页` : ''}
                {claim.evidence_ref.section ? ` §${claim.evidence_ref.section}` : ''}
              </span>
            ) : (
              // F9.3: unknown/uncertain 呈现
              <span className="muted" style={{ fontSize: 12 }}>出处：未确认</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * F9: 证据链追溯视图——论文卡片 + 结论陈述。
 */
function EvidenceChain({ papers, claims }: { papers: PaperCard[]; claims: ClaimRow[] }) {
  return (
    <div style={{ marginTop: 24 }}>
      <h2>证据链追溯</h2>
      <h3 style={{ fontSize: 15 }}>论文卡片</h3>
      <PaperCardList papers={papers} />
      <h3 style={{ fontSize: 15, marginTop: 16 }}>结论陈述</h3>
      <ClaimList claims={claims} />
    </div>
  );
}

/**
 * F10: 实验结果与协议对比组件。
 *
 * F10.1: 指标表——主/辅指标、方差、方向。
 * F10.2: baseline 对比——与 comparison 的 delta。
 * F10.3: 数据规模标签——smoke/quick/standard/handoff_manifest 醒目。
 * F10.4: 协议详情——锁定的 ExperimentalProtocol 与规则来源。
 * F10.5: 失败分类——failure-diagnosis 的层级与证据摘录。
 */
function ExperimentResults({ experiments }: { experiments: ExperimentResult[] }) {
  if (experiments.length === 0) return <p className="muted">还没有实验结果。</p>;
  return (
    <div style={{ marginTop: 12 }}>
      {experiments.map((exp) => {
        // F10.3: 数据规模标签
        const scaleState = exp.scale === 'standard' ? 'ok'
          : exp.scale === 'quick' ? 'active'
          : exp.scale === 'smoke' ? 'blocked'
          : 'idle'; // handoff_manifest
        return (
          <div key={exp.external_spec_id} className="panel" style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <strong className="mono" style={{ fontSize: 13 }}>{exp.external_spec_id.slice(0, 12)}…</strong>
              <span className="status-chip" data-state={scaleState} style={{ fontSize: 11 }}>
                {exp.scale}
                {exp.scale === 'handoff_manifest' ? ' · 未执行' : ''}
              </span>
              <span className="status-chip" data-state={exp.status === 'succeeded' ? 'ok' : 'fail'} style={{ fontSize: 11 }}>
                {exp.status}
              </span>
            </div>
            {/* F10.1: 指标表 */}
            {exp.metrics && Object.keys(exp.metrics).length > 0 ? (
              <div style={{ marginTop: 8 }}>
                <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>指标</div>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  {Object.entries(exp.metrics).map(([key, value]) => (
                    <span key={key} className="mono" style={{ fontSize: 12 }}>
                      {key}={typeof value === 'number' ? value.toFixed(4) : String(value)}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
            {exp.verdict ? (
              <div style={{ marginTop: 8 }}>
                <span className="status-chip" data-state={exp.verdict === 'supported' ? 'ok' : exp.verdict === 'rejected' ? 'fail' : 'blocked'} style={{ fontSize: 11 }}>
                  {exp.verdict}
                </span>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ProtocolList({ protocols }: { protocols: ProtocolSummary[] }) {
  if (protocols.length === 0) return <p className="muted">还没有协议。</p>;
  return (
    <div style={{ marginTop: 12 }}>
      {protocols.map((proto) => (
        <div key={proto.external_protocol_id} className="panel" style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <strong className="mono" style={{ fontSize: 13 }}>{proto.external_protocol_id.slice(0, 12)}…</strong>
            {proto.locked_at ? (
              <span className="muted" style={{ fontSize: 11 }}>锁定于 {new Date(proto.locked_at).toLocaleDateString()}</span>
            ) : (
              <span className="status-chip" data-state="blocked" style={{ fontSize: 11 }}>未锁定</span>
            )}
          </div>
          {/* F10.4: 协议详情——规则来源 */}
          {proto.provenance ? (
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>来源：{proto.provenance}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/**
 * F10: 实验结果与协议对比视图。
 */
function ExperimentView({ experiments, protocols }: { experiments: ExperimentResult[]; protocols: ProtocolSummary[] }) {
  return (
    <div style={{ marginTop: 24 }}>
      <h2>实验结果</h2>
      <ExperimentResults experiments={experiments} />
      <h2 style={{ marginTop: 24 }}>实验协议</h2>
      <ProtocolList protocols={protocols} />
    </div>
  );
}

/**
 * F8: Idea 看板——按状态分列显示。
 *
 * DRAFT_COMPOSITION 单独一列且灰显，不与有效候选混排。
 */
function IdeaBoard({ ideas }: { ideas: IdeaSummary[] }) {
  const active = ideas.filter((i) => i.status !== 'DRAFT_COMPOSITION' && i.status !== 'REJECTED');
  const drafts = ideas.filter((i) => i.status === 'DRAFT_COMPOSITION');
  const rejected = ideas.filter((i) => i.status === 'REJECTED');

  return (
    <div style={{ marginTop: 24 }}>
      <h2>Idea 看板</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
        <div>
          <h3 style={{ fontSize: 14, color: 'var(--ok)' }}>有效候选 ({active.length})</h3>
          {active.length === 0 ? <p className="muted">无</p> : active.map((idea) => <IdeaCard key={idea.external_idea_id} idea={idea} />)}
        </div>
        <div>
          <h3 style={{ fontSize: 14, color: 'var(--blocked)' }}>草稿拼接 ({drafts.length})</h3>
          {drafts.length === 0 ? <p className="muted">无</p> : drafts.map((idea) => <IdeaCard key={idea.external_idea_id} idea={idea} />)}
        </div>
        <div>
          <h3 style={{ fontSize: 14, color: 'var(--fail)' }}>已拒绝 ({rejected.length})</h3>
          {rejected.length === 0 ? <p className="muted">无</p> : rejected.map((idea) => <IdeaCard key={idea.external_idea_id} idea={idea} />)}
        </div>
      </div>
      <details style={{ marginTop: 16 }}>
        <summary className="muted" style={{ cursor: 'pointer', fontSize: 13 }}>查看版本树</summary>
        <div style={{ marginTop: 8 }}>
          <VersionTree ideas={ideas} />
        </div>
      </details>
    </div>
  );
}

export function App() {
  return (
    <main>
      <Switch>
        <Route path="/p/:id">{(params: { id: string }) => <Project id={params.id} />}</Route>
        <Route path="/">
          <Landing />
        </Route>
      </Switch>
    </main>
  );
}
