import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Route, Switch, useLocation } from 'wouter';
import { ApiError, requestJson, mutateJson } from './api';
import { openLive, type Transport } from './live';
import type {
  EventRow,
  IndexView,
  IdeaSummary,
  LiveFrame,
  PaperCard,
  ClaimRow,
  ExperimentResult,
  ProtocolSummary,
  ProjectIndexEntry,
  ProjectView,
  RunSummary,
  ApprovalRequest,
  CostSummary,
  EgressEntry,
  SyncToken,
  SyncHealth,
} from './types';
import {
  AccessPanel,
  AuditLedger,
  CreateProjectPanel,
  ProvisioningList,
  SettingsPanel,
  StepPump,
} from './panels';
import { AuthGate, AuthPanel, GuestBanner, logout, useMe } from './auth';
import { StageDetails } from './stage-details';
import { ExperimentEvidence } from './experiment-evidence';
import { Resources } from './resources';
import { ExpandableText } from './expandable-text';
import { ProjectTabs } from './project-tabs';
import {
  ExperimentRelations,
  IdeaRelations,
  PaperRelations,
  outputId,
  type OutputNavigation,
} from './output-relations';

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
  // 云引擎用小写状态词；阶段进度用 passed/active/pending/failed。
  running: 'active',
  created: 'idle',
  succeeded: 'ok',
  blocked: 'blocked',
  failed: 'fail',
  partial: 'blocked',
  invalid: 'fail',
  canceled: 'idle',
  queued: 'idle',
  claimed: 'active',
  passed: 'ok',
  active: 'active',
  pending: 'idle',
  completed: 'ok',
  parsed: 'ok',
  simulated: 'blocked',
  supported: 'ok',
  uncertain: 'blocked',
  unsupported: 'idle',
};

/** 阶段中文名：与 WORKFLOW_SPEC 的 15 阶段一一对应，只翻译不增删。 */
const PHASE_LABEL: Record<string, string> = {
  INIT: '初始化',
  INPUT_READY: '输入就绪',
  CALIBRATING: '可行性校准',
  PAPER_ANALYSIS: '论文分析',
  DATA_READY: '数据准备',
  PROTOCOL_PROPOSED: '协议生成',
  PROTOCOL_REVIEW: '协议评审',
  COMPARISON_DISCOVERY: '对比发现',
  COMPARISON_REPRODUCTION: '对比复现',
  BASELINE_VALIDATED: '基线验证',
  IDEA_GENERATION: '想法生成',
  IDEA_SCREENING: '想法筛选',
  EXPERIMENTING: '实验执行',
  IDEA_REVIEW: '想法评审',
  COMPLETED: '完成',
};

const STATUS_LABEL: Record<string, string> = {
  SUCCEEDED: '已完成',
  COMPLETED: '已完成',
  RUNNING: '运行中',
  INIT: '初始化',
  PAUSED: '已暂停',
  USER_INPUT_REQUIRED: '等待输入',
  PROTOCOL_REVIEW: '待评审',
  AUTH_REQUIRED: '需要认证',
  NETWORK_BLOCKED: '网络受阻',
  QUOTA_EXHAUSTED: '额度耗尽',
  FAILED_RECOVERABLE: '失败·可恢复',
  FAILED: '失败',
  CANCELED: '已取消',
  running: '运行中',
  created: '已创建',
  succeeded: '已完成',
  blocked: '等待处理',
  BLOCKED: '等待处理',
  failed: '失败',
  partial: '部分完成',
  invalid: '结果无效',
  canceled: '已取消',
  queued: '排队中',
  claimed: '执行中',
  passed: '已通过',
  active: '进行中',
  pending: '未开始',
  completed: '已完成',
  parsed: '已解析',
  simulated: '模拟演示 · 未执行实验',
  input_unverified: '材料来源待核验',
  supported: '有证据支持',
  uncertain: '不确定',
  unsupported: '无证据',
  SUPPORTED: '支持',
  REJECTED: '拒绝',
  NEEDS_REVISION: '需修订',
  INVALID_RUN: '无效运行',
  rejected: '未获支持',
};

function labelOf(value: string): string {
  return STATUS_LABEL[value] ?? PHASE_LABEL[value] ?? value;
}

const STRATEGY_LABEL: Record<string, string> = {
  starter: '入门',
  standard: '标准',
  research: '深度研究',
};
const AUTONOMY_LABEL: Record<string, string> = {
  guided: '引导',
  autonomous: '自主',
  'review-only': '只评审',
};
const SCALE_LABEL: Record<string, string> = {
  smoke: '最小验证',
  quick: '小规模验证',
  standard: '标准规模',
  handoff_manifest: '实验交付清单',
};

/** 云端已完整跑通 15 阶段的演示项目（匿名 Owner，任何登录用户可驱动）。 */
const DEMO_PROJECT_ID = 'proj-8f6c57e4-56e';

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

export function Chips({ run }: { run: RunSummary }) {
  const sameStage =
    run.stage_known &&
    (run.status === run.phase_tag ||
      (run.phase_tag === 'COMPLETED' &&
        ['succeeded', 'completed', 'SUCCEEDED', 'COMPLETED'].includes(run.status ?? '')));
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
      {run.status ? (
        // L2 降级投影里没有 status（F5.2），不渲染而不是渲染成 `status=undefined`。
        <span className="status-chip" data-state={stateOf(run.status)} title={run.status}>
          {labelOf(run.status)}
        </span>
      ) : null}
      {!sameStage ? (
        <span className="status-chip" data-state="idle" title={run.phase_tag}>
          阶段：{PHASE_LABEL[run.phase_tag] ?? run.phase_tag}
          {run.stage_known ? '' : '（未上报）'}
        </span>
      ) : null}
      {run.status === 'QUOTA_EXHAUSTED' ? (
        // 额度耗尽不是失败：文案与配色都要分开（F2.4）。
        <span className="muted">额度耗尽会保留已有结果，不代表实验失败。</span>
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
  const isQuota = kind === 'QUOTA_EXHAUSTED';
  // 从 block_reason 推导 next 建议（如果 detail 没有提供）。
  const next = detail?.next ?? deriveNextFromReason(kind, run.block_reason);
  return (
    <div className="panel" style={{ borderLeftColor: isQuota ? 'var(--quota)' : 'var(--blocked)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <strong title={kind}>{labelOf(kind)}</strong>
      </div>
      {detail?.message ? (
        <p style={{ margin: '0 0 8px' }}>{detail.message}</p>
      ) : run.block_reason ? (
        <p style={{ margin: '0 0 8px' }}>{run.block_reason}</p>
      ) : null}
      {next ? (
        <p className="muted" style={{ margin: 0, fontSize: 15 }}>
          下一步：<code className="mono">{next}</code>
        </p>
      ) : null}
    </div>
  );
}

function deriveNextFromReason(kind: string, blockReason: string | null | undefined): string | null {
  switch (kind) {
    case 'QUOTA_EXHAUSTED':
      return '检查成本额度后继续运行';
    case 'AUTH_REQUIRED':
      return '配置模型服务凭据后继续运行';
    case 'NETWORK_BLOCKED':
      return '检查网络连接后继续运行';
    case 'USER_INPUT_REQUIRED':
      return '在审批信箱中回应提示';
    case 'PROTOCOL_REVIEW':
      return '在审批信箱中确认协议';
    default:
      return blockReason ? '查看运行事件了解详情' : null;
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
          const duration =
            run.started_at && run.finished_at
              ? formatDuration(
                  new Date(run.finished_at).getTime() - new Date(run.started_at).getTime(),
                )
              : run.finished_at
                ? '—'
                : '进行中';
          return (
            <tr key={run.external_run_id}>
              <td className="mono">{run.external_run_id.slice(0, 8)}…</td>
              <td>
                <span
                  className="status-chip"
                  data-state="idle"
                  title={run.phase_tag}
                >
                  {PHASE_LABEL[run.phase_tag] ?? run.phase_tag}
                  {run.stage_known ? '' : '（未上报）'}
                </span>
              </td>
              <td>
                {run.status ? (
                  <span className="status-chip" data-state={stateOf(run.status)} title={run.status}>
                    {labelOf(run.status)}
                  </span>
                ) : (
                  <span className="muted">不在公开级</span>
                )}
              </td>
              <td className="muted">
                {run.started_at ? new Date(run.started_at).toLocaleString() : '—'}
              </td>
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

/** 15 阶段的连通步进器：节点按状态着色，连线表示已通过的前序阶段。 */
function Pipeline({ stages, projectId, externalRunId, inspectable }: {
  stages: ProjectView['stages']; projectId: string; externalRunId?: string; inspectable: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const byName = new Map(stages.map((s) => [s.stage, s]));
  const stateAt = (stage: string) => {
    const row = byName.get(stage);
    return row ? stateOf(row.state) : 'idle';
  };
  return (
    <div className="flow-layout" style={{ margin: '16px 0' }}>
      <h3 style={{ fontSize: 15, margin: '0 0 12px' }}>研究链路</h3>
      {inspectable ? <p className="muted">选择阶段，查看任务、输入与产出。</p> : null}
      <p className="flow-hint muted">按序从左向右查看，可横向滚动。</p>
      <ol className="flow" aria-label="研究阶段" tabIndex={0}>
        {STAGES.map((stage, i) => {
          const row = byName.get(stage);
          const state = stateAt(stage);
          const mark =
            state === 'ok'
              ? '✓'
              : state === 'active'
                ? '●'
                : state === 'fail'
                  ? '✕'
                  : state === 'blocked'
                    ? '!'
                    : state === 'quota' ? '◇' : '';
          return (
            <li
              key={stage}
              className="flow-node"
              data-state={state}
              title={`${PHASE_LABEL[stage]}：${row ? labelOf(row.state) : '未上报'}${row?.gate_note ? ` · ${row.gate_note}` : ''}`}
            >
              {i < STAGES.length - 1 ? (
                <span className="flow-link" data-done={state === 'ok' ? '1' : '0'} aria-hidden />
              ) : null}
              {inspectable && externalRunId ? (
                <button
                  className="flow-col flow-step"
                  aria-expanded={selected === stage}
                  aria-controls={selected === stage ? 'stage-detail' : undefined}
                  onClick={() => setSelected(selected === stage ? null : stage)}
                >
                  <span className="flow-dot" aria-hidden>{mark}</span>
                  <span className="flow-label">{i + 1}. {PHASE_LABEL[stage]}</span>
                </button>
              ) : (
                <span className="flow-col">
                  <span className="flow-dot">{mark}</span>
                  <span className="flow-label">{i + 1}. {PHASE_LABEL[stage]}</span>
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <p className="muted">阶段标记：✓ 已通过 · ● 进行中 · ! 等待处理 · ✕ 失败 · ◇ 额度耗尽；空心为未开始或未上报。</p>
      {inspectable && selected && externalRunId ? (
        <StageDetails
          key={selected}
          projectId={projectId}
          externalRunId={externalRunId}
          stage={selected}
          title={PHASE_LABEL[selected]!}
          progress={byName.get(selected)}
        />
      ) : null}
      {/* F3.3: 门槛达成说明——每个阶段的进入条件与当前证据 */}
      {stages.some((s) => s.gate_note || s.blocker_code) ? (
        <details style={{ marginTop: 8 }}>
          <summary className="muted" style={{ cursor: 'pointer', fontSize: 15 }}>
            查看门槛说明
          </summary>
          <div style={{ marginTop: 8, paddingLeft: 16 }}>
            {stages
              .filter((s) => s.gate_note || s.blocker_code)
              .map((s) => (
                <div key={s.stage} style={{ marginBottom: 8 }}>
                  <strong>{PHASE_LABEL[s.stage] ?? s.stage}</strong>
                  {s.gate_note ? <p style={{ margin: '2px 0' }}>{s.gate_note}</p> : null}
                  {s.blocker_code ? (
                    <p className="muted" style={{ margin: '2px 0', fontSize: 14 }}>
                      阻塞码：<code className="mono">{s.blocker_code}</code>
                    </p>
                  ) : null}
                </div>
              ))}
          </div>
        </details>
      ) : null}
      {/* F3.4: unknown 阶段兜底——映射不到 15 阶段的显式标出 */}
      {stages.some((s) => !s.stage_known) ? (
        <p className="muted" style={{ marginTop: 8, fontSize: 14 }}>
          “未上报”表示尚未收到阶段记录，不能据此判断已经完成或尚未开始。
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
function EventList({
  events,
  redacted,
  lastSyncAt,
}: {
  events: EventRow[];
  redacted: boolean;
  lastSyncAt: string | null;
}) {
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
  if (events.length === 0)
    return (
      <p className="muted">
        {redacted ? '公开摘要不展示事件详情。' : '尚无这次运行的事件记录。'}
      </p>
    );

  return (
    <div>
      {/* F4.4: 批更新标注——明确说明数据来源时间，禁用"实时"字样 */}
      <p className="muted" style={{ fontSize: 14, margin: '0 0 8px' }}>
        数据来自 {ago(lastSyncAt)}的一批同步 · 共 {filtered.length} 条事件
        {filtered.length !== events.length
          ? `（已过滤 ${events.length - filtered.length} 条）`
          : ''}
      </p>
      {/* F4.2: 过滤器 */}
      <div className="form-grid" style={{ marginBottom: 12 }}>
        <label className="form-field">阶段
        <select
          value={stageFilter}
          onChange={(e) => {
            setStageFilter(e.target.value);
            setPage(0);
          }}
          style={{
            background: 'var(--panel)',
            color: 'var(--text)',
            border: '1px solid var(--control-line)',
            borderRadius: 4,
            padding: '4px 8px',
          }}
        >
          <option value="">全部阶段</option>
          {stageOptions.map((s) => (
            <option key={s} value={s}>
              {PHASE_LABEL[s] ?? s}
            </option>
          ))}
        </select>
        </label>
        <label className="form-field">事件类型
        <select
          value={typeFilter}
          onChange={(e) => {
            setTypeFilter(e.target.value);
            setPage(0);
          }}
          style={{
            background: 'var(--panel)',
            color: 'var(--text)',
            border: '1px solid var(--control-line)',
            borderRadius: 4,
            padding: '4px 8px',
          }}
        >
          <option value="">全部类型</option>
          {typeOptions.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        </label>
        <label className="form-field">事件级别
        <select
          value={levelFilter}
          onChange={(e) => {
            setLevelFilter(e.target.value);
            setPage(0);
          }}
          style={{
            background: 'var(--panel)',
            color: 'var(--text)',
            border: '1px solid var(--control-line)',
            borderRadius: 4,
            padding: '4px 8px',
          }}
        >
          <option value="">全部级别</option>
          {levelOptions.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        </label>
        {stageFilter || typeFilter || levelFilter ? (
          <button
            onClick={() => {
              setStageFilter('');
              setTypeFilter('');
              setLevelFilter('');
              setPage(0);
            }}
            className="btn-secondary"
          >
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
                {event.truncated ? (
                  <span className="muted" title="摘要被截断至 400 字符">
                    {' '}
                    …（已截断）
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* 分页控制 */}
      {totalPages > 1 ? (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 12 }}>
          <button
            onClick={() => setPage(Math.max(0, page - 1))}
            disabled={page === 0}
            className="btn-secondary"
            style={{
              opacity: page === 0 ? 0.5 : 1,
              cursor: page === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            上一页
          </button>
          <span className="muted" style={{ display: 'flex', alignItems: 'center' }}>
            {page + 1} / {totalPages}
          </span>
          <button
            onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
            disabled={page >= totalPages - 1}
            className="btn-secondary"
            style={{
              opacity: page >= totalPages - 1 ? 0.5 : 1,
              cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer',
            }}
          >
            下一页
          </button>
        </div>
      ) : null}
    </div>
  );
}

function HomePage() {
  const [, navigate] = useLocation();
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
    >
      <div style={{ textAlign: 'center', maxWidth: 600 }}>
        <h1 style={{ fontSize: 48, marginBottom: 16, letterSpacing: '-1px' }}>IdeaSeek</h1>
        <p style={{ fontSize: 18, color: 'var(--muted)', marginBottom: 32, lineHeight: 1.6 }}>
          从研究问题，到可验证发现
        </p>
        <div
          style={{
            display: 'flex',
            gap: 16,
            justifyContent: 'center',
            flexWrap: 'wrap',
            marginBottom: 48,
          }}
        >
          <span className="status-chip" data-state="ok">
            证据链
          </span>
          <span className="status-chip" data-state="ok">
            恢复语义
          </span>
          <span className="status-chip" data-state="ok">
            公平性锁定
          </span>
          <span className="status-chip" data-state="ok">
            审计门禁
          </span>
        </div>
        <button
          onClick={() => navigate('/console')}
          className="btn-primary"
          style={{ fontSize: 16, padding: '12px 32px' }}
        >
          开始
        </button>
        <div style={{ marginTop: 48, paddingTop: 32, borderTop: '1px solid var(--line)' }}>
          <p className="muted" style={{ fontSize: 15, marginBottom: 16 }}>
            研究流程在云端执行，全程留下可审计的事件与证据链。
          </p>
          <div style={{ display: 'flex', gap: 16, justifyContent: 'center', flexWrap: 'wrap' }}>
            <a
              href="https://gitee.com/tangfire216/ideaseek"
              target="_blank"
              rel="noopener"
              className="btn-secondary"
            >
              阅读文档
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

function ConsoleLayout({ children }: { children: ReactElement }) {
  const [location] = useLocation();
  const me = useMe();
  const currentPath = location.replace(/\/$/, '');
  const demoPath = `/p/${DEMO_PROJECT_ID}`;
  const currentProject = /^\/p\/[^/]+$/.test(currentPath) && currentPath !== demoPath;

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>IdeaSeek</h1>
          <div className="subtitle">科研工作台</div>
        </div>
        <ul className="sidebar-nav">
          <li>
            <a
              href="#/console"
              className={currentPath === '/console' ? 'active' : ''}
              aria-current={currentPath === '/console' ? 'page' : undefined}
            >
              项目列表
            </a>
          </li>
          <li>
            <a
              href={`#${demoPath}`}
              className={currentPath === demoPath ? 'active' : ''}
              aria-current={currentPath === demoPath ? 'page' : undefined}
            >
              演示项目
            </a>
          </li>
          {currentProject ? (
            <li>
              <a href={`#${currentPath}`} className="active" aria-current="page">
                当前项目
              </a>
            </li>
          ) : null}
        </ul>
        <div className="sidebar-section sidebar-account">
          <div className="sidebar-section-title">账号</div>
          <ul className="sidebar-nav">
            {me.data ? (
              <>
                <li>
                  <span
                    className="account-name"
                    title={me.data.username}
                    style={{ padding: '8px 16px', fontSize: 15, display: 'block' }}
                  >
                    {me.data.username}
                  </span>
                </li>
                <li>
                  <a
                    href="#/login"
                    onClick={(event) => {
                      event.preventDefault();
                      void logout().then(() => {
                        window.location.hash = '#/login';
                        window.location.reload();
                      });
                    }}
                  >
                    退出登录
                  </a>
                </li>
              </>
            ) : (
              <>
                <li>
                  <span
                    className="muted"
                    style={{ padding: '8px 16px', fontSize: 15, display: 'block' }}
                  >
                    未登录 · 游客
                  </span>
                </li>
                <li>
                  <a href="#/register">注册</a>
                </li>
                <li>
                  <a href="#/login">登录</a>
                </li>
              </>
            )}
          </ul>
        </div>
        <div className="sidebar-section">
          <div className="sidebar-section-title">文档</div>
          <ul className="sidebar-nav">
            <li>
              <a href="https://gitee.com/tangfire216/ideaseek" target="_blank" rel="noopener">
                项目文档
              </a>
            </li>
          </ul>
        </div>
        <div className="sidebar-section">
          <div className="sidebar-section-title">运行位置</div>
          <ul className="sidebar-nav">
            <li>
              <span className="muted" style={{ padding: '8px 16px', fontSize: 13 }}>
                任务在云端执行
              </span>
            </li>
            <li>
              <span className="muted" style={{ padding: '8px 16px', fontSize: 13 }}>
                保持项目页面打开以继续推进
              </span>
            </li>
          </ul>
        </div>
      </aside>
      <div className="main-content">
        <GuestBanner />
        {children}
      </div>
    </div>
  );
}

/** 列表页的过滤条件全部在客户端算：投影一次就发全量（M7 的读数上限），没必要为排序再打一次云端。 */
const LIST_FILTERS = ['全部', '运行中', '需处理', '已结束', '尚未开始', '无运行', '状态未公开'] as const;

function runFilter(run: RunSummary | null): (typeof LIST_FILTERS)[number] {
  if (!run) return '无运行';
  if (run.status === undefined) return '状态未公开';
  const status = run.status.toUpperCase();
  if (['RUNNING', 'ACTIVE', 'CLAIMED'].includes(status)) return '运行中';
  if (['INIT', 'CREATED', 'QUEUED', 'PENDING'].includes(status)) return '尚未开始';
  if (['SUCCEEDED', 'COMPLETED', 'FAILED', 'CANCELED', 'INVALID'].includes(status)) return '已结束';
  return '需处理';
}

/**
 * 行内改名 / 归档 / 恢复（§5.2-5.3）。只有自己的项目才渲染操作——
 * 平台演示不是你的，在它上面摆"归档"只会让人误伤入口。
 * 归档必须把标题原样打一遍（服务端也这么校验），防手滑。
 */
function RowActions({ project, onChanged }: { project: ProjectIndexEntry; onChanged: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [draft, setDraft] = useState(project.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!project.owned)
    return (
      <span className="muted" style={{ fontSize: 13 }}>
        —
      </span>
    );

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setRenaming(false);
      setArchiving(false);
      setConfirmation('');
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rename = () =>
    run(async () => {
      const title = draft.trim();
      if (!title || title === project.title) return;
      await mutateJson(`/functions/v1/app/projects/${encodeURIComponent(project.external_id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ title }),
      });
    });

  const archive = () =>
    run(async () => {
      await mutateJson(
        `/functions/v1/app/projects/${encodeURIComponent(project.external_id)}?confirm=${encodeURIComponent(confirmation)}`,
        { method: 'DELETE' },
      );
    });

  const restore = () =>
    run(() =>
      mutateJson(`/functions/v1/app/projects/${encodeURIComponent(project.external_id)}/restore`, {
        method: 'POST',
        body: '{}',
      }),
    );

  if (renaming || archiving) {
    return (
      <form
        className="project-edit"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          if (archiving) {
            if (confirmation === project.title) void archive();
          } else if (draft.trim() && draft.trim() !== project.title) void rename();
        }}
      >
        {archiving ? (
          <p>归档后从默认列表隐藏，暂时无法打开；可在“已归档项目”中恢复，不删除研究记录。</p>
        ) : null}
        <label className="form-field">
          {archiving ? '输入项目标题确认归档' : '新标题'}
          <input
            autoFocus
            value={archiving ? confirmation : draft}
            onChange={(event) =>
              archiving ? setConfirmation(event.target.value) : setDraft(event.target.value)
            }
            disabled={busy}
          />
        </label>
        {archiving ? <p className="muted">项目标题：{project.title}</p> : null}
        <div className="project-action-buttons">
          <button
            type="submit"
            className={archiving ? 'btn-danger' : 'btn-primary'}
            disabled={
              busy ||
              (archiving
                ? confirmation !== project.title
                : !draft.trim() || draft.trim() === project.title)
            }
          >
            {busy ? '处理中…' : archiving ? '确认归档' : '保存'}
          </button>
          <button
            className="btn-secondary"
            type="button"
            disabled={busy}
            onClick={() => {
              setDraft(project.title);
              setRenaming(false);
              setArchiving(false);
              setConfirmation('');
              setError(null);
            }}
          >
            取消
          </button>
        </div>
        {error ? (
          <span role="alert" style={{ fontSize: 13, color: 'var(--fail)' }}>
            {error}
          </span>
        ) : null}
      </form>
    );
  }

  return (
    <div>
      {project.archived ? (
        <button className="btn-secondary" disabled={busy} onClick={restore}>
          恢复
        </button>
      ) : (
        <details className="project-actions">
          <summary>更多操作</summary>
          <div className="project-action-buttons">
            <button
              className="btn-secondary"
              disabled={busy}
              onClick={() => {
                setDraft(project.title);
                setError(null);
                setRenaming(true);
              }}
            >
              改名
            </button>
            <button
              className="btn-danger"
              disabled={busy}
              onClick={() => {
                setError(null);
                setArchiving(true);
              }}
            >
              归档
            </button>
          </div>
        </details>
      )}
      {error ? (
        <span role="alert" style={{ fontSize: 13, color: 'var(--fail)' }}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

function ConsoleHome() {
  const client = useQueryClient();
  const me = useMe();
  const loggedIn = Boolean(me.data);
  const [showArchived, setShowArchived] = useState(false);
  const query = useQuery({
    queryKey: ['index', showArchived],
    queryFn: () =>
      requestJson<IndexView>(
        `/functions/v1/app/views/index${showArchived ? '?include_archived=1' : ''}`,
      ),
  });
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const [filter, setFilter] = useState<(typeof LIST_FILTERS)[number]>('全部');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('最近同步');
  const [layout, setLayout] = useState<'列表' | '卡片'>('列表');
  const invalidateIndex = () => {
    void client.invalidateQueries({ queryKey: ['index'] });
  };

  const projects = (query.data?.projects ?? [])
    .filter((project) => Boolean(project.archived) === showArchived)
    .filter((project) => (filter === '全部' ? true : runFilter(project.latest_run) === filter))
    .filter((project) => {
      const needle = search.trim().toLowerCase();
      if (!needle) return true;
      return `${project.title} ${project.external_id} ${project.latest_run?.question ?? ''}`
        .toLowerCase()
        .includes(needle);
    })
    .sort((a, b) =>
      sort === '标题'
        ? a.title.localeCompare(b.title)
        : (b.last_sync_at ?? '').localeCompare(a.last_sync_at ?? ''),
    );

  return (
    <>
      <div className="project-list-header">
        <h2 style={{ margin: 0 }}>项目列表</h2>
        {loggedIn ? (
          <button
            ref={createButton}
            className="btn-primary"
            aria-expanded={creating}
            aria-controls="create-project-panel"
            onClick={() => {
              setCreating(!creating);
              setNotice(null);
            }}
          >
            {creating ? '收起创建' : '新建项目'}
          </button>
        ) : null}
      </div>
      {notice ? <p role="status">{notice}</p> : null}
      {creating ? (
        <section id="create-project-panel" aria-label="创建项目">
          <CreateProjectPanel
            onCreated={() => {
              setCreating(false);
              setShowArchived(false);
              setFilter('全部');
              setSearch('');
              setNotice('项目已创建。请从列表打开项目，检查材料后开始运行。');
              createButton.current?.focus();
            }}
          />
        </section>
      ) : null}
      <div
        className="project-toolbar"
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'end',
          flexWrap: 'wrap',
          marginBottom: 12,
        }}
      >
        <label className="form-field" style={{ flex: '1 1 220px', maxWidth: 320 }}>
          搜索项目
          <input
            placeholder="搜索标题、目录名或研究问题"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="搜索项目"
          />
        </label>
        <label className="form-field">
          状态筛选
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value as (typeof LIST_FILTERS)[number])}
            aria-label="状态筛选"
          >
            {LIST_FILTERS.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
        <label className="form-field">
          排序
          <select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="排序">
            <option value="最近同步">最近同步</option>
            <option value="标题">标题</option>
          </select>
        </label>
        <button
          className="btn-secondary"
          onClick={() => setLayout(layout === '列表' ? '卡片' : '列表')}
        >
          {layout === '列表' ? '卡片视图' : '列表视图'}
        </button>
        <label className="form-field">
          项目范围
          <select
            aria-label="项目范围"
            value={showArchived ? 'archived' : 'active'}
            onChange={(event) => setShowArchived(event.target.value === 'archived')}
          >
            <option value="active">未归档项目</option>
            <option value="archived">已归档项目</option>
          </select>
        </label>
      </div>

      <ProvisioningList />
      {query.data && !query.error ? (
        <p className="muted">
          {showArchived ? '已归档项目' : '未归档项目'} · 当前显示 {projects.length} 项
        </p>
      ) : null}

      {query.isPending ? <p className="muted">正在加载项目列表…</p> : null}
      {query.error instanceof ApiError && query.error.code === 'login_required' ? (
        <p>
          <a href="#/login">登录</a> 后继续。
        </p>
      ) : null}
      {query.error &&
      !(query.error instanceof ApiError && query.error.code === 'login_required') ? (
        <div className="panel">
          <p style={{ margin: '0 0 8px' }}>暂时无法加载项目列表</p>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            {(query.error as Error).message} 稍后重试即可，云端数据不受影响。
          </p>
        </div>
      ) : null}
      {query.data && projects.length === 0 ? (
        <div className="panel">
          <p style={{ margin: '0 0 8px' }}>
            {query.data.projects.length === 0 ? '还没有可见项目' : '没有符合筛选条件的项目'}
          </p>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            {query.data.projects.length === 0
              ? loggedIn
                ? '点击“新建项目”。创建后打开项目，检查材料，再点击“开始运行”。'
                : '注册或登录后就能创建你自己的研究项目。'
              : '清空搜索或换一个筛选条件即可看到全部。'}
          </p>
        </div>
      ) : null}
      {layout === '列表' ? (
        <table>
          <thead>
            <tr>
              <th>项目</th>
              <th>同步时间</th>
              <th>状态</th>
              <th>可见性</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => (
              <tr key={project.external_id}>
                <td data-label="项目">
                  {project.archived ? (
                    <strong>{project.title}</strong>
                  ) : (
                    <a href={`#/p/${encodeURIComponent(project.external_id)}`}>{project.title}</a>
                  )}
                  {project.external_id === DEMO_PROJECT_ID ? (
                    <span
                      className="status-chip"
                      data-state="idle"
                      style={{ marginLeft: 8, fontSize: 13 }}
                    >
                      演示
                    </span>
                  ) : null}
                  {project.archived ? (
                    <span
                      className="status-chip"
                      data-state="idle"
                      style={{ marginLeft: 8, fontSize: 13 }}
                    >
                      已归档
                    </span>
                  ) : null}
                  <div className="muted mono" style={{ fontSize: 13 }}>
                    {project.external_id}
                  </div>
                </td>
                <td className="muted" data-label="同步时间">
                  {ago(project.last_sync_at)}
                </td>
                <td data-label="状态">
                  {project.latest_run ? (
                    <Chips run={project.latest_run} />
                  ) : (
                    <span className="muted">无运行</span>
                  )}
                </td>
                <td data-label="可见性">
                  <VisibilityBadge visibility={project.visibility} />
                </td>
                <td data-label="操作">
                  <RowActions project={project} onChanged={invalidateIndex} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))',
            gap: 12,
          }}
        >
          {projects.map((project) => (
            <div key={project.external_id} className="panel" style={{ marginBottom: 0 }}>
              <h3 style={{ marginTop: 0 }}>
                {project.archived ? (
                  project.title
                ) : (
                  <a href={`#/p/${encodeURIComponent(project.external_id)}`}>{project.title}</a>
                )}
              </h3>
              <VisibilityBadge visibility={project.visibility} />
              {project.archived ? (
                <span className="status-chip" data-state="idle">
                  已归档
                </span>
              ) : null}
              {project.external_id === DEMO_PROJECT_ID ? (
                <span className="status-chip" data-state="idle">
                  演示
                </span>
              ) : null}
              <div className="muted mono" style={{ fontSize: 13, marginBottom: 6 }}>
                {project.external_id}
              </div>
              <div className="muted" style={{ fontSize: 14, marginBottom: 6 }}>
                {project.latest_run?.question ?? '没有记录研究问题'}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                {project.latest_run ? (
                  <Chips run={project.latest_run} />
                ) : (
                  <span className="muted">无运行</span>
                )}
                <span className="muted" style={{ fontSize: 13 }}>
                  {ago(project.last_sync_at)}同步
                </span>
              </div>
              <div style={{ marginTop: 8 }}>
                <RowActions project={project} onChanged={invalidateIndex} />
              </div>
            </div>
          ))}
        </div>
      )}
      <AuditLedger />
    </>
  );
}

function Project({ id }: { id: string }) {
  const tabsId = useId();
  const query = useQuery({
    queryKey: ['project', id],
    queryFn: () =>
      requestJson<ProjectView>(
        `/functions/v1/app/views/project?external_id=${encodeURIComponent(id)}`,
      ),
  });
  const [transport, setTransport] = useState<Transport>('connecting');
  const [revoked, setRevoked] = useState<string | null>(null);
  // hook 必须在任何提前 return 之前声明：这个项目页有 3 条 loading/error 分支。
  const [tab, setTab] = useState<string>('概览');
  const refetch = query.refetch;

  useEffect(() => {
    let disposed = false;
    setRevoked(null);
    const handle = openLive({
      projectId: id,
      onFrame(frame: LiveFrame) {
        if (disposed) return;
        if (frame.type === 'revoked') {
          setRevoked(frame.reason);
          handle.close();
          return;
        }
        // 推送事件没有运行编号，不能与当前运行按序号拼接；重新读取按运行定位的已保存记录。
        void refetch();
      },
      onTransport: setTransport,
      onError: () => setTransport('polling'),
    });
    const interval = setInterval(() => void refetch(), 60_000);
    return () => {
      disposed = true;
      handle.close();
      clearInterval(interval);
    };
  }, [id, refetch]);

  if (revoked) {
    return (
      <p className="status-chip" data-state="fail">
        项目访问已被撤销，请返回项目列表或联系项目所有者。
      </p>
    );
  }
  if (query.isPending) return <p className="muted">正在加载项目…</p>;
  if (query.error) {
    return (
      <p className="status-chip" data-state="fail">
        {(query.error as Error).message}
      </p>
    );
  }
  const view = query.data;
  const latest = view.runs[0];
  const l2 = view.projection_level === 'l2';
  const canWrite = view.writable === true;
  // 设置与协作只有 Owner 可写；审计面板全是 L1 字段，L2 降级下整面隐藏。
  // 审计/设置/协作都是 Owner 的工具：游客与被邀读者看不到（审计里有成本与审批入口）。
  const tabs = (['概览', '材料与成果', '运行', '审计', '设置', '协作'] as const).filter((name) =>
    name === '概览' || name === '运行' ? true : name === '材料与成果' ? !l2 : canWrite,
  );
  const active = tabs.includes(tab as (typeof tabs)[number]) ? tab : '概览';
  return (
    <>
      <p>
        <a href="#/console">← 项目列表</a>
      </p>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 12,
          marginBottom: 8,
        }}
      >
        {' '}
        <h1 style={{ margin: 0 }}>{view.project.title}</h1>
        {/* F5.1: 可见性徽标 */}
        <VisibilityBadge visibility={view.visibility} />
      </div>
      {view.projection_level === 'l2' ? (
        // 降级要说明降了什么，否则空区块会被读成"没有数据"（缺口⑨ 的同一类错误）。
        <p className="banner">
          当前为公开摘要。运行状态与原因、事件详情、阶段要求、成本和假设全文不对外展示。
        </p>
      ) : null}
      <p className="muted">
        {ago(view.project.last_sync_at)}更新 · 策略：
        {l2
          ? '公开摘要不展示'
          : (STRATEGY_LABEL[view.project.strategy ?? ''] ?? view.project.strategy ?? '未记录')}{' '}
        · 确认方式：
        {l2
          ? '公开摘要不展示'
          : (AUTONOMY_LABEL[view.project.autonomy ?? ''] ?? view.project.autonomy ?? '未记录')}{' '}
        ·{' '}
        <span className="status-chip" data-state={'idle'}>
          {transport === 'websocket'
            ? '自动接收更新'
            : transport === 'polling'
              ? '每 15 秒检查更新'
              : '连接中'}
        </span>
      </p>
      <ProjectTabs tabs={tabs} active={active} onSelect={setTab} idPrefix={tabsId} />
      {latest && canWrite ? (
        <StepPump
          key={`${id}:${latest.external_run_id}`}
          projectId={id}
          externalRunId={latest.external_run_id}
          notStarted={latest.status === 'created' && latest.phase_tag === 'INIT'}
          completed={latest.phase_tag === 'COMPLETED'}
          onProgress={() => void refetch()}
        />
      ) : null}
      {latest && !canWrite ? (
        <p className="muted">当前为只读访问，运行操作由项目所有者执行。</p>
      ) : null}
      <section
        role="tabpanel"
        id={`${tabsId}-panel-${active}`}
        aria-labelledby={`${tabsId}-tab-${active}`}
        tabIndex={0}
      >
        {active === '概览' ? (
          <>
            {view.project.question ? (
              <div className="panel">
                <ExpandableText text={view.project.question} label="研究问题" />
              </div>
            ) : null}
            {latest ? (
              <>
                <Chips run={latest} />
                <BlockReasonCard run={latest} />
              </>
            ) : (
              <p className="muted">云端还没有这个项目的运行。</p>
            )}
            <Pipeline
              key={latest ? `${id}:${latest.external_run_id}` : id}
              stages={view.stages}
              projectId={id}
              externalRunId={latest?.external_run_id}
              inspectable={!l2 && latest !== undefined}
            />
            {!l2 ? <OutputChain view={view} /> : null}
            {view.unsynced && view.unsynced.pending_batches > 0 ? (
              <p className="status-chip" data-state="blocked">
                还有 {view.unsynced.pending_batches} 批未投递 · {view.unsynced.dropped_events}{' '}
                条事件被丢弃
              </p>
            ) : null}
            <RecentEvents events={view.events} lastSyncAt={view.project.last_sync_at} />
          </>
        ) : null}

        {active === '运行' ? (
          <>
            <h2>运行历史</h2>
            <RunHistory runs={view.runs} />
            <h2>事件</h2>
            <EventList
              events={view.events.slice(-200)}
              redacted={l2}
              lastSyncAt={view.project.last_sync_at}
            />
          </>
        ) : null}

        {active === '材料与成果' ? (
          latest ? (
            <Resources
              key={`resources:${id}:${latest.external_run_id}`}
              projectId={id}
              externalRunId={latest.external_run_id}
            />
          ) : (
            <p className="muted">项目尚无运行，暂无可查看的材料与成果记录。</p>
          )
        ) : null}

        {active === '审计' ? (
          <>
            <ApprovalInbox projectId={id} />
            <CostDashboard projectId={id} />
            <EgressLedger projectId={id} />
            <TokenManager projectId={id} />
          </>
        ) : null}

        {active === '设置' ? <SettingsPanel projectId={id} view={view} /> : null}
        {active === '协作' ? <AccessPanel projectId={id} view={view} /> : null}
      </section>
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
    link: { text: '链接可见', state: 'idle' as const },
    listed: { text: '公开', state: 'idle' as const },
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
      return '出现在公开项目列表中，访客只能查看公开摘要';
  }
}

/**
 * F8.1: Idea 卡片——标题、机制摘要、状态、结论。
 *
 * F8.3: DRAFT_COMPOSITION 徽标——无理由拼接的候选必须标出，不得混入"有效 idea"。
 * F8.5: 假设全文按 hypothesis_disclosure 分级显示。
 * F8.6: 结论徽章——SUPPORTED/NEEDS_REVISION/REJECTED/INVALID_RUN。
 */
function IdeaCard({ idea, papers, experiments, onNavigate }: {
  idea: IdeaSummary; papers: PaperCard[]; experiments: ExperimentResult[]; onNavigate: OutputNavigation;
}) {
  const isDraft = idea.status === 'DRAFT_COMPOSITION';
  const verdictState =
    idea.verdict === 'SUPPORTED'
      ? 'ok'
      : idea.verdict === 'REJECTED' || idea.verdict === 'INVALID_RUN'
        ? 'fail'
        : idea.verdict === 'NEEDS_REVISION'
          ? 'blocked'
          : 'idle';
  return (
    <div
      id={outputId('idea', idea.external_idea_id)}
      tabIndex={-1}
      className="panel output-record"
      style={{ marginBottom: 12 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <strong style={{ fontSize: 15 }}>{idea.title}</strong>
        {isDraft ? (
          <span className="status-chip" data-state="blocked" style={{ fontSize: 13 }}>
            草稿拼接
          </span>
        ) : null}
        <span className="status-chip" data-state="idle" style={{ fontSize: 13 }}>
          v{idea.version}
        </span>
      </div>
      {idea.mechanism_summary ? (
        <div style={{ margin: '0 0 8px', fontSize: 15 }}><ExpandableText text={idea.mechanism_summary} label="机制摘要" /></div>
      ) : null}
      {/* F8.5: 假设全文按 disclosure 分级 */}
      {idea.hypothesis_disclosure === 'full' && idea.hypothesis ? (
        <details style={{ marginBottom: 8 }}>
          <summary className="muted" style={{ cursor: 'pointer', fontSize: 14 }}>
            查看假设全文
          </summary>
          <p style={{ margin: '8px 0', fontSize: 15, whiteSpace: 'pre-wrap' }}>{idea.hypothesis}</p>
        </details>
      ) : idea.hypothesis_disclosure === 'structure' ? (
        <p className="muted" style={{ fontSize: 14, margin: '0 0 8px' }}>
          假设结构已公开，全文需项目所有者授权
        </p>
      ) : (
        <p className="muted" style={{ fontSize: 14, margin: '0 0 8px' }}>
          假设全文未公开
        </p>
      )}
      {/* F8.6: 结论徽章 */}
      {idea.verdict ? (
        <span className="status-chip" data-state={verdictState} title={idea.verdict}>
          {labelOf(idea.verdict)}
        </span>
      ) : (
        <span className="status-chip" data-state="idle">
          无结论
        </span>
      )}
      <IdeaRelations idea={idea} papers={papers} experiments={experiments} onNavigate={onNavigate} />
    </div>
  );
}

/**
 * F9: 证据链追溯组件。
 *
 * F9.1: 论文卡片列表——标题、问题、方法摘要、解析状态。
 * F9.2: claim → 页码定位——点击结论跳到 evidence_ref(page, section)。
 * F9.3: unknown/uncertain 呈现——缺失字段显示"未确认"而非空白或猜测。
 * F9.4: 结论—证据—实验三跳——idea ↔ claim ↔ metric 互链。
 */
export function PaperCardList({ papers, ideas, onNavigate }: {
  papers: PaperCard[]; ideas?: IdeaSummary[]; onNavigate?: OutputNavigation;
}) {
  if (papers.length === 0) return <p className="muted">还没有论文卡片。</p>;
  return (
    <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
      {papers.map((paper) => (
        <div
          key={paper.external_paper_id}
          id={outputId('paper', paper.external_paper_id)}
          tabIndex={-1}
          className="panel output-record"
          style={{ marginBottom: 0 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <strong style={{ fontSize: 14 }}>{paper.title}</strong>
            <span
              className="status-chip"
              data-state={
                paper.parse_status === 'parsed' || paper.parse_status === 'succeeded'
                  ? 'ok'
                  : 'blocked'
              }
              style={{ fontSize: 13 }}
              title={paper.parse_status}
            >
              {paper.parse_status === 'succeeded' ? '已解析' : labelOf(paper.parse_status)}
            </span>
          </div>
          {paper.question ? (
            <div style={{ margin: '0 0 8px', fontSize: 15 }}><ExpandableText text={paper.question} label="论文研究问题" /></div>
          ) : null}
          {paper.method_summary ? (
            <div className="muted" style={{ margin: 0, fontSize: 14 }}>
              <ExpandableText text={paper.method_summary} label="方法摘要" />
            </div>
          ) : null}
          {ideas && onNavigate ? <PaperRelations paper={paper} ideas={ideas} onNavigate={onNavigate} /> : null}
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
          <div style={{ margin: '0 0 8px' }}><ExpandableText text={claim.text} label="结论记录" /></div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span
              className="status-chip"
              data-state={
                claim.support_level === 'supported'
                  ? 'ok'
                  : claim.support_level === 'uncertain'
                    ? 'blocked'
                    : 'idle'
              }
              style={{ fontSize: 13 }}
              title={claim.support_level}
            >
              {labelOf(claim.support_level)}
            </span>
            {/* F9.2: claim → 页码定位 */}
            {claim.evidence_ref?.paper_external_id ? (
              <span className="muted" style={{ fontSize: 14 }}>
                出处：{claim.evidence_ref.paper_external_id}
                {claim.evidence_ref.page ? ` 第 ${claim.evidence_ref.page} 页` : ''}
                {claim.evidence_ref.section ? ` §${claim.evidence_ref.section}` : ''}
              </span>
            ) : (
              // F9.3: unknown/uncertain 呈现
              <span className="muted" style={{ fontSize: 14 }}>
                出处：未确认
              </span>
            )}
          </div>
        </div>
      ))}
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
export function ExperimentResults({ experiments, ideas, onNavigate }: {
  experiments: ExperimentResult[]; ideas?: IdeaSummary[]; onNavigate?: OutputNavigation;
}) {
  if (experiments.length === 0) return <p className="muted">还没有实验结果。</p>;
  return (
    <div style={{ marginTop: 12 }}>
      {experiments.map((exp) => {
        return (
          <div
            key={exp.external_spec_id}
            id={outputId('experiment', exp.external_spec_id)}
            tabIndex={-1}
            className="panel output-record"
            style={{ marginBottom: 8 }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 8,
                flexWrap: 'wrap',
              }}
            >
              <strong className="mono" style={{ fontSize: 15 }}>
                {exp.title ?? exp.external_spec_id}
              </strong>
              {exp.scale && exp.status !== 'simulated' ? <span
                className="status-chip"
                data-state="idle"
                style={{ fontSize: 13 }}
                title={exp.scale}
              >
                {SCALE_LABEL[exp.scale] ?? exp.scale}
                {exp.scale === 'handoff_manifest' ? ' · 未执行' : ''}
              </span> : null}
              <span
                className="status-chip"
                data-state={stateOf(exp.status)}
                style={{ fontSize: 13 }}
                title={exp.status}
              >
                {labelOf(exp.status)}
              </span>
            </div>
            {/* F10.1: 指标表 */}
            {exp.status === 'simulated' ? (
              <p className="muted">此步骤仅演示流程，尚未执行实验，不提供科研指标或有效性结论。</p>
            ) : null}
            <ExperimentEvidence experiment={exp} />
            {exp.status !== 'simulated' && exp.scale !== 'handoff_manifest' && exp.verdict ? (
              <div style={{ marginTop: 8 }}>
                <span
                  className="status-chip"
                  data-state={
                    exp.verdict === 'supported'
                      ? 'ok'
                      : exp.verdict === 'rejected'
                        ? 'fail'
                        : 'blocked'
                  }
                  style={{ fontSize: 13 }}
                  title={exp.verdict}
                >
                  {labelOf(exp.verdict)}
                </span>
              </div>
            ) : null}
            {ideas && onNavigate ? <ExperimentRelations experiment={exp} ideas={ideas} onNavigate={onNavigate} /> : null}
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
            <strong className="mono" style={{ fontSize: 15 }}>
              {proto.external_protocol_id.slice(0, 12)}…
            </strong>
            {proto.locked_at ? (
              <span className="muted" style={{ fontSize: 13 }}>
                锁定于 {new Date(proto.locked_at).toLocaleDateString()}
              </span>
            ) : (
              <span className="status-chip" data-state="blocked" style={{ fontSize: 13 }}>
                未锁定
              </span>
            )}
          </div>
          {/* F10.4: 协议详情——规则来源 */}
          {proto.provenance ? (
            <div className="muted" style={{ margin: 0, fontSize: 14 }}>
              <ExpandableText text={`来源：${proto.provenance}`} label="协议来源" />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/**
 * 论文与想法并列，实验对照独占一行，只展示记录中的明确关联。
 * 各区域复用原有的卡片组件；证据与协议收进折叠区。
 */
export function OutputChain({ view }: { view: ProjectView }) {
  const root = useRef<HTMLDivElement>(null);
  const navigate: OutputNavigation = (kind, id) => {
    const target = document.getElementById(outputId(kind, id));
    if (!target || !root.current?.contains(target)) throw new Error('关联记录不在当前产出中。');
    target.scrollIntoView({ block: 'center' });
    target.focus({ preventScroll: true });
  };
  const papers = view.papers ?? [];
  const claims = view.claims ?? [];
  const ideas = view.ideas ?? [];
  const experiments = view.experiments ?? [];
  const protocols = view.protocols ?? [];
  if (papers.length === 0 && ideas.length === 0 && experiments.length === 0) return null;
  return (
    <div ref={root} style={{ marginTop: 24 }}>
      <h2>产出链</h2>
      <p className="muted">关联仅表示记录的论文引用或实验对象，不代表证据已经核实或实验结论成立。选择关联记录可跳转查看。</p>
      <div className="chain">
        <section className="chain-col">
          <h3 className="chain-title">论文分析</h3>
          <PaperCardList papers={papers} ideas={ideas} onNavigate={navigate} />
          {claims.length > 0 ? (
            <details style={{ marginTop: 8 }}>
              <summary className="muted" style={{ cursor: 'pointer', fontSize: 15 }}>
                结论陈述（{claims.length}）
              </summary>
              <ClaimList claims={claims} />
            </details>
          ) : null}
        </section>
        <section className="chain-col">
          <h3 className="chain-title">研究想法</h3>
          {ideas.length === 0 ? (
            <p className="muted" style={{ marginTop: 12 }}>
              还没有研究想法。
            </p>
          ) : (
            <div style={{ marginTop: 12 }}>
              {ideas.map((idea) => (
                <IdeaCard key={idea.external_idea_id} idea={idea} papers={papers} experiments={experiments} onNavigate={navigate} />
              ))}
            </div>
          )}
        </section>
        <section className="chain-col chain-experiments">
          <h3 className="chain-title">实验验证</h3>
          <ExperimentResults experiments={experiments} ideas={ideas} onNavigate={navigate} />
          {protocols.length > 0 ? (
            <details style={{ marginTop: 8 }}>
              <summary className="muted" style={{ cursor: 'pointer', fontSize: 15 }}>
                实验协议（{protocols.length}）
              </summary>
              <ProtocolList protocols={protocols} />
            </details>
          ) : null}
        </section>
      </div>
    </div>
  );
}

/** 概览页只展示最近几条事件；完整过滤与分页在"运行"面。 */
function RecentEvents({ events, lastSyncAt }: { events: EventRow[]; lastSyncAt: string | null }) {
  if (events.length === 0) return null;
  const recent = events.slice(-8).reverse();
  return (
    <div style={{ marginTop: 24 }}>
      <h2>最近事件</h2>
      <p className="muted" style={{ fontSize: 14, margin: '0 0 8px' }}>
        数据来自 {ago(lastSyncAt)}的一批同步 · 完整事件在"运行"面
      </p>
      <table>
        <tbody>
          {recent.map((event) => (
            <tr key={event.seq}>
              <td className="mono muted" style={{ whiteSpace: 'nowrap' }}>
                {new Date(event.ts).toLocaleTimeString()}
              </td>
              <td>
                {event.summary}
                {event.truncated ? (
                  <span className="muted" title="摘要被截断至 400 字符">
                    {' '}
                    …（已截断）
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// M6: 审批信箱 / 成本 / 外发 / Token 管理
// ---------------------------------------------------------------------------

/**
 * F11: 审批信箱——待确认列表 + 详情 + 意向提交。
 *
 * F11.1: 跨项目聚合 pending 审批请求。
 * F11.2: 审批详情——原因、选项、影响范围、来源事件。
 * F11.3: 提交意向——文案必须说"待确认"，UI 永不显示"已批准/已生效"。
 * F11.4: 冲突意向并列——多个审批人选择不同选项全部列出，不自动合并。
 * F11.5: intent 生命周期——submitted → delivered → consumed。
 * F11.6: autonomous 模式只读——自动通过的门槛不得被 web 阻塞或改写。
 */
function ApprovalInbox({ projectId }: { projectId: string }) {
  const query = useQuery({
    queryKey: ['approvals', projectId],
    queryFn: () =>
      requestJson<{ ok: boolean; approvals: ApprovalRequest[] }>(
        `/functions/v1/app/views/approvals?project_id=${encodeURIComponent(projectId)}`,
      ),
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<string | null>(null);

  if (query.isPending) return <p className="muted">正在加载审批信箱…</p>;
  if (query.error)
    return (
      <p className="status-chip" data-state="fail">
        {(query.error as Error).message}
      </p>
    );
  const approvals = query.data?.approvals ?? [];
  const pending = approvals.filter((a) => a.status === 'pending');
  const selected = selectedId ? approvals.find((a) => a.id === selectedId) : null;

  const handleSubmitIntent = async (choice: string, note: string) => {
    if (!selectedId) return;
    setSubmitting(true);
    setSubmitResult(null);
    try {
      const res = await mutateJson<{ ok: boolean; message: string }>(
        `/functions/v1/app/approvals/${selectedId}/intent`,
        {
          method: 'POST',
          body: JSON.stringify({ choice, note }),
        },
      );
      setSubmitResult(res.ok ? `意向已提交：${res.message}` : `提交失败`);
      void query.refetch();
    } catch (err) {
      setSubmitResult(`提交失败：${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ marginTop: 24 }}>
      <h2>审批信箱</h2>
      {pending.length === 0 ? (
        <p className="muted">没有待确认的审批请求。</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 16 }}>
          {/* F11.1: 待确认列表 */}
          <div>
            <h3 style={{ fontSize: 14 }}>待确认 ({pending.length})</h3>
            {pending.map((approval) => (
              <div
                key={approval.id}
                className="panel"
                style={{
                  marginBottom: 8,
                  cursor: 'pointer',
                  borderLeftColor: selectedId === approval.id ? 'var(--active)' : 'var(--line)',
                }}
                onClick={() => setSelectedId(approval.id)}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                  <span className="status-chip" data-state="blocked" style={{ fontSize: 13 }}>
                    {approval.kind}
                  </span>
                  <strong style={{ fontSize: 15 }}>
                    {approval.external_approval_id.slice(0, 12)}…
                  </strong>
                </div>
                <p style={{ margin: 0, fontSize: 14 }} className="muted">
                  {approval.summary.slice(0, 80)}
                  {approval.summary.length > 80 ? '…' : ''}
                </p>
                <p style={{ margin: '4px 0 0', fontSize: 13 }} className="muted">
                  {ago(approval.created_at)}
                </p>
              </div>
            ))}
          </div>
          {/* F11.2-F11.4: 审批详情 + 意向提交 + 冲突并列 */}
          <div>
            {selected ? (
              <div className="panel">
                <h3 style={{ fontSize: 14, marginTop: 0 }}>审批详情</h3>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  <span className="status-chip" data-state="blocked">
                    {selected.kind}
                  </span>
                  <span className="mono" style={{ fontSize: 14 }}>
                    {selected.external_approval_id}
                  </span>
                </div>
                <p style={{ margin: '0 0 8px' }}>{selected.summary}</p>
                {selected.payload_hash ? (
                  <p className="muted" style={{ fontSize: 14, margin: '0 0 8px' }}>
                    载荷哈希：<code className="mono">{selected.payload_hash.slice(0, 16)}…</code>
                  </p>
                ) : null}
                {/* F11.2: 选项列表 */}
                {selected.options && selected.options.length > 0 ? (
                  <div style={{ marginBottom: 12 }}>
                    <div className="muted" style={{ fontSize: 14, marginBottom: 4 }}>
                      可选方案
                    </div>
                    {selected.options.map((opt) => (
                      <div
                        key={opt}
                        style={{
                          padding: '4px 8px',
                          background: 'var(--bg)',
                          borderRadius: 4,
                          marginBottom: 4,
                          fontSize: 15,
                        }}
                      >
                        {opt}
                      </div>
                    ))}
                  </div>
                ) : null}
                {/* F11.4: 冲突意向并列 */}
                {selected.intents && selected.intents.length > 0 ? (
                  <div style={{ marginBottom: 12 }}>
                    <div className="muted" style={{ fontSize: 14, marginBottom: 4 }}>
                      已提交的意向（{selected.intents.length}）
                    </div>
                    {selected.intents.map((intent) => (
                      <div
                        key={intent.id}
                        style={{
                          padding: '4px 8px',
                          background: 'var(--bg)',
                          borderRadius: 4,
                          marginBottom: 4,
                          fontSize: 14,
                        }}
                      >
                        <span
                          className="status-chip"
                          data-state={
                            intent.consumed_at ? 'ok' : intent.delivered_at ? 'active' : 'blocked'
                          }
                          style={{ fontSize: 13 }}
                        >
                          {intent.consumed_at
                            ? '已生效'
                            : intent.delivered_at
                              ? '已送达'
                              : '已提交'}
                        </span>{' '}
                        {intent.choice}
                        {intent.note ? <span className="muted"> · {intent.note}</span> : null}
                      </div>
                    ))}
                  </div>
                ) : null}
                {/* F11.3: 提交意向——文案必须说"待确认" */}
                <IntentForm
                  onSubmit={handleSubmitIntent}
                  disabled={submitting}
                  options={selected.options ?? []}
                />
                {submitResult ? (
                  <p className="muted" style={{ fontSize: 14, marginTop: 8 }}>
                    {submitResult}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="muted">选择一个审批请求查看详情。</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function IntentForm({
  onSubmit,
  disabled,
  options,
}: {
  onSubmit: (choice: string, note: string) => void;
  disabled: boolean;
  options: string[];
}) {
  const [choice, setChoice] = useState(options[0] ?? '');
  const [note, setNote] = useState('');
  return (
    <div style={{ marginTop: 12 }}>
      <div className="muted" style={{ fontSize: 14, marginBottom: 4 }}>
        提交意向
      </div>
      <label className="form-field">
        处理选择
        {options.length > 0 ? (
          <select
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            style={{
              width: '100%',
              marginBottom: 8,
              background: 'var(--panel)',
              color: 'var(--text)',
              border: '1px solid var(--control-line)',
              borderRadius: 4,
              padding: '6px 8px',
            }}
          >
            {options.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            placeholder="选择"
            style={{
              width: '100%',
              marginBottom: 8,
              background: 'var(--panel)',
              color: 'var(--text)',
              border: '1px solid var(--control-line)',
              borderRadius: 4,
              padding: '6px 8px',
            }}
          />
        )}
      </label>
      <label className="form-field">
        备注（可选）
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="备注（可选）"
          rows={2}
          style={{
            width: '100%',
            marginBottom: 8,
            background: 'var(--panel)',
            color: 'var(--text)',
            border: '1px solid var(--control-line)',
            borderRadius: 4,
            padding: '6px 8px',
            resize: 'vertical',
          }}
        />
      </label>
      <button
        onClick={() => {
          if (choice) {
            onSubmit(choice, note);
            setNote('');
          }
        }}
        disabled={disabled || !choice}
        className="btn-primary"
        style={{
          opacity: disabled || !choice ? 0.5 : 1,
          cursor: disabled || !choice ? 'not-allowed' : 'pointer',
        }}
      >
        提交意向
      </button>
      <p className="muted" style={{ fontSize: 13, margin: '8px 0 0' }}>
        提交后状态为"待确认"——意向需引擎拉取并确认后才会生效。
      </p>
    </div>
  );
}

/**
 * F12: 成本与额度面板——花费汇总 + 预算进度 + 重复标记 + 路由分布。
 *
 * F12.1: 花费汇总——token 数、USD micro。
 * F12.2: 预算进度——spent / budget，接近上限时高亮。
 * F12.3: 重复成本标记——同一 run 内相同 model_route + kind 出现多次。
 * F12.4: 按模型路由分布——各 route 的花费占比。
 * F12.5: 额度耗尽引导——调整预算后继续运行。
 */
function CostDashboard({ projectId }: { projectId: string }) {
  const query = useQuery({
    queryKey: ['costs', projectId],
    queryFn: () =>
      requestJson<{
        ok: boolean;
        runs: CostSummary[];
        summary: {
          total_usd_micro: number;
          total_tokens_in: number;
          total_tokens_out: number;
          by_route: Record<string, number>;
        } | null;
      }>(`/functions/v1/app/views/costs?external_id=${encodeURIComponent(projectId)}`),
  });

  if (query.isPending) return <p className="muted">正在加载成本数据…</p>;
  if (query.error)
    return (
      <p className="status-chip" data-state="fail">
        {(query.error as Error).message}
      </p>
    );
  const data = query.data;
  if (!data || !data.summary)
    return <p className="muted">公开摘要不展示成本数据。</p>;

  const { summary, runs } = data;
  const totalUsd = summary.total_usd_micro / 1_000_000;
  const totalBudget = runs.reduce((sum, r) => sum + r.budget_usd_micro, 0) / 1_000_000;
  const totalSpent = runs.reduce((sum, r) => sum + r.spent_usd_micro, 0) / 1_000_000;
  const budgetRatio = totalBudget > 0 ? totalSpent / totalBudget : 0;
  // F12.2: 接近上限时高亮
  const nearCap = budgetRatio > 0.8;

  return (
    <div style={{ marginTop: 24 }}>
      <h2>成本与额度</h2>
      {/* F12.1: 花费汇总 */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div className="panel" style={{ marginBottom: 0 }}>
          <div className="muted" style={{ fontSize: 14 }}>
            总花费
          </div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>${totalUsd.toFixed(4)}</div>
        </div>
        <div className="panel" style={{ marginBottom: 0 }}>
          <div className="muted" style={{ fontSize: 14 }}>
            Token 输入
          </div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>
            {summary.total_tokens_in.toLocaleString()}
          </div>
        </div>
        <div className="panel" style={{ marginBottom: 0 }}>
          <div className="muted" style={{ fontSize: 14 }}>
            Token 输出
          </div>
          <div style={{ fontSize: 20, fontWeight: 600 }}>
            {summary.total_tokens_out.toLocaleString()}
          </div>
        </div>
      </div>
      {/* F12.2: 预算进度 */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span className="muted" style={{ fontSize: 14 }}>
            预算进度
          </span>
          <span className="mono" style={{ fontSize: 14 }}>
            ${totalSpent.toFixed(4)} / ${totalBudget.toFixed(4)}
          </span>
        </div>
        <div style={{ background: 'var(--bg)', borderRadius: 4, height: 8, overflow: 'hidden' }}>
          <div
            style={{
              width: `${Math.min(budgetRatio * 100, 100)}%`,
              height: '100%',
              background: nearCap ? 'var(--fail)' : 'var(--active)',
              transition: 'width 0.3s',
            }}
          />
        </div>
        {nearCap ? (
          <p className="muted" style={{ fontSize: 14, margin: '8px 0 0', color: 'var(--fail)' }}>
            预算已使用 {Math.round(budgetRatio * 100)}%，接近上限。
          </p>
        ) : null}
      </div>
      {/* F12.4: 按模型路由分布 */}
      {Object.keys(summary.by_route).length > 0 ? (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="muted" style={{ fontSize: 14, marginBottom: 8 }}>
            按模型路由分布
          </div>
          {Object.entries(summary.by_route).map(([route, micro]) => {
            const pct = summary.total_usd_micro > 0 ? (micro / summary.total_usd_micro) * 100 : 0;
            return (
              <div
                key={route}
                style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}
              >
                <span className="mono" style={{ fontSize: 14, minWidth: 100 }}>
                  {route}
                </span>
                <div
                  style={{
                    flex: 1,
                    background: 'var(--bg)',
                    borderRadius: 4,
                    height: 6,
                    overflow: 'hidden',
                  }}
                >
                  <div style={{ width: `${pct}%`, height: '100%', background: 'var(--active)' }} />
                </div>
                <span className="mono" style={{ fontSize: 13 }}>
                  ${(micro / 1_000_000).toFixed(4)} ({pct.toFixed(0)}%)
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
      {/* F12.3: 重复成本标记 */}
      {runs.some((r) => r.duplicate_candidates > 0) ? (
        <div className="panel" style={{ marginBottom: 16, borderLeftColor: 'var(--quota)' }}>
          <div className="muted" style={{ fontSize: 14, marginBottom: 4 }}>
            重复成本标记
          </div>
          {runs
            .filter((r) => r.duplicate_candidates > 0)
            .map((r) => (
              <div key={r.run_external_id} style={{ fontSize: 14, marginBottom: 4 }}>
                <span className="mono">{r.run_external_id.slice(0, 8)}…</span> 有{' '}
                <span className="status-chip" data-state="quota" style={{ fontSize: 13 }}>
                  {r.duplicate_candidates}
                </span>{' '}
                条可能的重复成本（同一 model_route + kind 多次出现，可能是重试导致）
              </div>
            ))}
        </div>
      ) : null}
      {/* F12.5: 额度耗尽引导 */}
      {runs.some((r) => r.spent_usd_micro >= r.budget_usd_micro && r.budget_usd_micro > 0) ? (
        <div className="panel" style={{ borderLeftColor: 'var(--fail)' }}>
          <div className="muted" style={{ fontSize: 14, marginBottom: 4 }}>
            额度耗尽引导
          </div>
          <p style={{ margin: 0, fontSize: 15 }}>
            部分运行已触及预算上限。额度耗尽不是科学失败，调整预算后在概览页继续运行即可。
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * F13: 外发透明度台账——按 run 聚合外发汇总。
 *
 * F13.1: 按 run 聚合——channel / target_class / count / bytes。
 * F13.2: 与启动授权对照——显示是否超出用户授权范围。
 * F13.3: 引擎侧计数来源——若引擎未产生数据，台账为空并显式说明。
 *
 * 缺口⑫：只有类别与计数，没有 prompt 字段，也不该将来加一个。
 */
function EgressLedger({ projectId }: { projectId: string }) {
  const query = useQuery({
    queryKey: ['egress', projectId],
    queryFn: () =>
      requestJson<{
        ok: boolean;
        runs: {
          run_external_id: string;
          entries: EgressEntry[];
          total_event_count: number;
          total_bytes: number;
        }[];
      }>(`/functions/v1/app/views/egress?external_id=${encodeURIComponent(projectId)}`),
  });

  if (query.isPending) return <p className="muted">正在加载外发台账…</p>;
  if (query.error)
    return (
      <p className="status-chip" data-state="fail">
        {(query.error as Error).message}
      </p>
    );
  const runs = query.data?.runs ?? [];

  // F13.3: 若引擎未产生数据，显式说明
  if (runs.length === 0 || runs.every((r) => r.entries.length === 0)) {
    return (
      <div style={{ marginTop: 24 }}>
        <h2>外发透明度台账</h2>
        <p className="muted">
          引擎尚未产生外发计数数据。台账功能已就绪，待引擎侧接入后自动展示（缺口⑫）。
        </p>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 24 }}>
      <h2>外发透明度台账</h2>
      <p className="muted" style={{ fontSize: 14, marginBottom: 12 }}>
        只有类别与计数，不含 prompt 正文（缺口⑫）。
      </p>
      {runs.map((run) => (
        <div key={run.run_external_id} className="panel" style={{ marginBottom: 12 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 8,
            }}
          >
            <strong className="mono" style={{ fontSize: 15 }}>
              {run.run_external_id.slice(0, 12)}…
            </strong>
            <span className="muted" style={{ fontSize: 14 }}>
              {run.total_event_count} 次外发 · {(run.total_bytes / 1024).toFixed(1)} KB
            </span>
          </div>
          {run.entries.length > 0 ? (
            <table style={{ width: '100%', fontSize: 14 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>目标类别</th>
                  <th style={{ textAlign: 'left' }}>数据类别</th>
                  <th style={{ textAlign: 'right' }}>次数</th>
                  <th style={{ textAlign: 'right' }}>字节</th>
                </tr>
              </thead>
              <tbody>
                {run.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono">{entry.destination_class}</td>
                    <td>{entry.data_class ?? 'unknown'}</td>
                    <td style={{ textAlign: 'right' }}>{entry.event_count}</td>
                    <td style={{ textAlign: 'right' }}>
                      {entry.bytes_approx ? `${(entry.bytes_approx / 1024).toFixed(1)} KB` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted" style={{ fontSize: 14 }}>
              该运行无外发记录。
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * F16: Token 管理页——签发 / 名称 / 范围 / 吊销 + 同步健康自检。
 *
 * F16.1: token 管理——只存哈希（NFR-02），明文只在创建时显示一次。
 * F16.2: 同步健康自检——最近批次状态、拒绝原因分布。
 */
function TokenManager({ projectId }: { projectId: string }) {
  const tokenQuery = useQuery({
    queryKey: ['tokens'],
    queryFn: () =>
      requestJson<{ ok: boolean; tokens: SyncToken[] }>('/functions/v1/app/views/tokens'),
  });
  const healthQuery = useQuery({
    queryKey: ['health', projectId],
    queryFn: async () => {
      const result = await requestJson<{
        ok: boolean;
        projection_level: 'full' | 'l2';
        health: SyncHealth | null;
      }>(`/functions/v1/app/views/health?external_id=${encodeURIComponent(projectId)}`);
      if (!(
        (result.projection_level === 'l2' && result.health === null) ||
        (result.projection_level === 'full' &&
          typeof result.health === 'object' &&
          result.health !== null)
      )) {
        throw new ApiError('invalid_response', '服务未返回有效的同步健康数据。');
      }
      return result;
    },
  });
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const operationPending = useRef(false);
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState('sync');

  const handleCreate = async () => {
    if (operationPending.current) return;
    operationPending.current = true;
    setCreating(true);
    setNewToken(null);
    setOperationError(null);
    setNotice(null);
    try {
      const res = await mutateJson<{ ok: boolean; plain_token: string; message: string }>(
        '/functions/v1/app/views/tokens',
        {
          method: 'POST',
          body: JSON.stringify({
            label: label || null,
            scopes: scopes
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
            project_scope: [],
          }),
        },
      );
      if (typeof res.plain_token !== 'string' || res.plain_token.trim().length === 0) {
        throw new ApiError('invalid_response', '服务未返回可保存的同步凭据。');
      }
      setNewToken(res.plain_token);
      void tokenQuery.refetch();
    } catch (error) {
      setOperationError(
        `签发未确认：${error instanceof ApiError ? error.message : '请求未能完成。'} 请先刷新凭据列表核对，再决定是否重试。`,
      );
    } finally {
      operationPending.current = false;
      setCreating(false);
    }
  };

  const handleRevoke = async (tokenId: string) => {
    if (operationPending.current) return;
    if (!confirm('确定要吊销此 token 吗？吊销后不可恢复。')) return;
    operationPending.current = true;
    setRevoking(tokenId);
    setOperationError(null);
    setNotice(null);
    try {
      await mutateJson(`/functions/v1/app/views/tokens/${tokenId}`, { method: 'DELETE' });
      setNotice('同步凭据已吊销。');
      void tokenQuery.refetch();
    } catch (error) {
      setOperationError(
        `吊销未确认：${error instanceof ApiError ? error.message : '请求未能完成。'} 请刷新凭据列表核对状态。`,
      );
    } finally {
      operationPending.current = false;
      setRevoking(null);
    }
  };

  return (
    <div style={{ marginTop: 24 }}>
      <h2>Token 管理</h2>
      {/* F16.1: Token 列表 */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 14, marginTop: 0 }}>同步 Token</h3>
        {tokenQuery.isPending ? <p className="muted">加载中…</p> : null}
        {tokenQuery.error ? (
          <p role="alert" style={{ color: 'var(--fail)' }}>
            凭据列表读取失败，请刷新后核对；已有显示可能不是最新状态。
          </p>
        ) : null}
        <button
          className="btn-secondary"
          disabled={tokenQuery.isFetching || creating || revoking !== null}
          onClick={() => void tokenQuery.refetch()}
        >
          {tokenQuery.isFetching ? '正在刷新凭据列表…' : '刷新凭据列表'}
        </button>
        {operationError ? (
          <p role="alert" style={{ color: 'var(--fail)' }}>
            {operationError}
          </p>
        ) : null}
        {notice ? <p role="status">{notice}</p> : null}
        {!tokenQuery.error && tokenQuery.data?.tokens.length === 0 ? (
          <p className="muted">还没有签发过 token。</p>
        ) : null}
        {tokenQuery.data?.tokens.map((token) => (
          <div
            key={token.id}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '8px 0',
              borderBottom: '1px solid var(--line)',
            }}
          >
            <div>
              <strong style={{ fontSize: 15 }}>{token.label ?? '(未命名)'}</strong>
              <div className="muted" style={{ fontSize: 13 }}>
                范围：{token.scopes.join(', ')} · 创建于 {ago(token.created_at)}
                {token.last_used_at ? ` · 最后使用 ${ago(token.last_used_at)}` : ''}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {token.revoked_at ? (
                <span className="status-chip" data-state="fail" style={{ fontSize: 13 }}>
                  已吊销
                </span>
              ) : (
                <button
                  disabled={creating || revoking !== null || tokenQuery.isError}
                  onClick={() => handleRevoke(token.id)}
                  className="btn-danger"
                >
                  {revoking === token.id ? '吊销中…' : '吊销'}
                </button>
              )}
            </div>
          </div>
        ))}
        {/* 创建新 Token */}
        <div style={{ marginTop: 12, padding: '12px 0', borderTop: '1px solid var(--line)' }}>
          <div className="form-grid">
            <label className="form-field">
              同步凭据名称（可选）
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="名称（可选）"
                style={{
                  flex: 1,
                  minWidth: 120,
                  background: 'var(--panel)',
                  color: 'var(--text)',
                  border: '1px solid var(--control-line)',
                  borderRadius: 4,
                  padding: '4px 8px',
                  fontSize: 16,
                }}
              />
            </label>
            <label className="form-field">
              权限范围（逗号分隔）
              <input
                value={scopes}
                onChange={(e) => setScopes(e.target.value)}
                placeholder="范围（逗号分隔）"
                style={{
                  flex: 1,
                  minWidth: 120,
                  background: 'var(--panel)',
                  color: 'var(--text)',
                  border: '1px solid var(--control-line)',
                  borderRadius: 4,
                  padding: '4px 8px',
                  fontSize: 16,
                }}
              />
            </label>
            <button
              onClick={handleCreate}
              disabled={creating || revoking !== null || tokenQuery.isPending || tokenQuery.isError}
              className="btn-primary"
              style={{ opacity: creating ? 0.5 : 1, cursor: creating ? 'not-allowed' : 'pointer' }}
            >
              签发新 Token
            </button>
          </div>
          {/* F16.1: 明文只显示一次 */}
          {newToken ? (
            <div
              className="panel"
              style={{ marginTop: 8, borderLeftColor: 'var(--ok)', background: 'var(--bg)' }}
            >
              <p style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 600 }}>
                请立即保存此 token，关闭页面后将无法再次查看：
              </p>
              <code className="mono" style={{ fontSize: 15, wordBreak: 'break-all' }}>
                {newToken}
              </code>
            </div>
          ) : null}
        </div>
      </div>
      {/* F16.2: 同步健康自检 */}
      <div className="panel" aria-busy={healthQuery.isFetching}>
        <h3 style={{ fontSize: 14, marginTop: 0 }}>同步健康</h3>
        <button
          className="btn-secondary"
          disabled={healthQuery.isFetching}
          onClick={() => void healthQuery.refetch()}
        >
          {healthQuery.isFetching ? '正在刷新同步健康…' : '刷新同步健康'}
        </button>
        {healthQuery.isPending ? (
          <p className="muted" role="status">
            正在加载同步健康…
          </p>
        ) : null}
        {!healthQuery.isPending && healthQuery.isFetching ? (
          <p className="muted" role="status">
            {healthQuery.isError
              ? '正在重新读取同步健康…'
              : '正在刷新同步健康，当前显示上次读取的结果。'}
          </p>
        ) : null}
        {healthQuery.isError ? (
          <p role="alert" style={{ color: 'var(--fail)' }}>
            同步健康读取失败：
            {healthQuery.error instanceof ApiError ? healthQuery.error.message : '请求未能完成。'}
            {healthQuery.data ? '上次读取的结果已隐藏，请刷新后核对。' : '请刷新后重试。'}
          </p>
        ) : null}
        {!healthQuery.isError && healthQuery.data?.health ? (
          <>
            {healthQuery.data.health.latest_batch ? (
              <div style={{ marginBottom: 8 }}>
                <div className="muted" style={{ fontSize: 14 }}>
                  最近批次
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="mono" style={{ fontSize: 14 }}>
                    {healthQuery.data.health.latest_batch.external_batch_id}
                  </span>
                  <span
                    className="status-chip"
                    data-state={
                      healthQuery.data.health.latest_batch.status === 'accepted' ? 'ok' : 'fail'
                    }
                    style={{ fontSize: 13 }}
                  >
                    {healthQuery.data.health.latest_batch.status}
                  </span>
                  <span className="muted" style={{ fontSize: 13 }}>
                    {ago(healthQuery.data.health.latest_batch.requested_at)}
                  </span>
                </div>
                {healthQuery.data.health.latest_batch.rejected_reasons &&
                healthQuery.data.health.latest_batch.rejected_reasons.length > 0 ? (
                  <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                    拒绝原因：{healthQuery.data.health.latest_batch.rejected_reasons.join(', ')}
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="muted" style={{ fontSize: 14 }}>
                还没有同步批次。
              </p>
            )}
            <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
              <div>
                <div className="muted" style={{ fontSize: 14 }}>
                  待处理批次
                </div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>
                  {healthQuery.data.health.pending_batches}
                </div>
              </div>
            </div>
            {/* 拒绝原因分布 */}
            {Object.keys(healthQuery.data.health.rejected_reason_distribution).length > 0 ? (
              <div style={{ marginTop: 12 }}>
                <div className="muted" style={{ fontSize: 14, marginBottom: 4 }}>
                  拒绝原因分布
                </div>
                {Object.entries(healthQuery.data.health.rejected_reason_distribution).map(
                  ([reason, count]) => (
                    <div
                      key={reason}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        fontSize: 14,
                        padding: '2px 0',
                      }}
                    >
                      <span>{reason}</span>
                      <span className="mono">{count}</span>
                    </div>
                  ),
                )}
              </div>
            ) : null}
          </>
        ) : null}
        {!healthQuery.isError && healthQuery.data?.projection_level === 'l2' ? (
          <p className="muted" style={{ fontSize: 14 }}>
            公开摘要不展示同步详情。
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function App() {
  const [location] = useLocation();
  const isLogin = location === '/login' || location.startsWith('/login?');
  const isRegister = location === '/register' || location.startsWith('/register?');
  const isConsole =
    location === '/console' || location === '/console/' || location.startsWith('/p/');

  // 登录与注册各一个入口，游客横幅上的两个按钮各走一条，省一次"去注册"的点击。
  if (isLogin) return <AuthPanel initialMode="login" />;
  if (isRegister) return <AuthPanel initialMode="register" />;

  if (!isConsole) {
    return (
      <Switch>
        <Route path="/">
          <HomePage />
        </Route>
      </Switch>
    );
  }

  // 没登录也放行：游客能看公开的演示项目，横幅负责把注册/登录的门指清楚。
  return (
    <AuthGate>
      <ConsoleLayout>
        <Switch>
          <Route path="/p/:id">{(params: { id: string }) => <Project id={params.id} />}</Route>
          <Route path="/console">
            <ConsoleHome />
          </Route>
          <Route path="/">
            <ConsoleHome />
          </Route>
        </Switch>
      </ConsoleLayout>
    </AuthGate>
  );
}
