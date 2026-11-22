import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Route, Switch, useLocation } from 'wouter';
import { ApiError, loginHref, requestJson } from './api';
import { openLive, type Transport } from './live';
import type { EventRow, IndexView, LiveFrame, ProjectView, RunSummary } from './types';

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

function Pipeline({ stages }: { stages: ProjectView['stages'] }) {
  const byName = new Map(stages.map((s) => [s.stage, s]));
  return (
    <ol className="pipeline" style={{ listStyle: 'none', display: 'flex', flexWrap: 'wrap', gap: 4, padding: 0 }}>
      {STAGES.map((stage) => {
        const row = byName.get(stage);
        const state = row ? stateOf(row.state) : 'idle';
        return (
          <li key={stage} className="status-chip" data-state={state} title={row?.gate_note ?? row?.blocker_code ?? ''}>
            {stage}
          </li>
        );
      })}
    </ol>
  );
}

function EventList({ events, redacted }: { events: EventRow[]; redacted: boolean }) {
  // L2 的事件摘要是被有意扣下的，不是这条运行没有事件——两者混说就是把降级读成空数据。
  if (events.length === 0) return <p className="muted">{redacted ? '事件摘要不在公开降级投影（L2）这一级。' : '云端还没有这条运行的事件。'}</p>;
  return (
    <table>
      <tbody>
        {events.map((event) => (
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
              {event.summary}
              {event.truncated ? <span className="muted"> …（已截断）</span> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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
      <div className="banner">
        科研引擎运行在<strong>你自己的机器</strong>上。云端只有脱敏后的运行状态与事件投影——不含论文正文、数据集与凭据。
      </div>
      <h1>IdeaSeek 控制台</h1>
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
        <p className="muted">还没有可见项目。在本地运行 <code className="mono">ideaseek cloud link</code> 建立投影。</p>
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
      <h1>{view.project.title}</h1>
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
      {latest ? <Chips run={latest} /> : <p className="muted">云端还没有这个项目的运行。</p>}
      <Pipeline stages={view.stages} />
      {view.unsynced && view.unsynced.pending_batches > 0 ? (
        <p className="status-chip" data-state="blocked">
          本地还有 {view.unsynced.pending_batches} 批未投递 · {view.unsynced.dropped_events} 条事件被丢弃
        </p>
      ) : null}
      <h2>事件</h2>
      <EventList events={[...view.events, ...liveEvents].slice(-80)} redacted={l2} />
    </>
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
