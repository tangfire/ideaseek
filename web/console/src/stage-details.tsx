import { useQuery } from '@tanstack/react-query';
import { requestJson } from './api';
import { ExpandableText } from './expandable-text';
import type { StageProgress, StageTask, StageTasksView, TaskDetailValue } from './types';

export const TASK_LABEL: Record<string, string> = {
  calibrate: '可行性校准',
  analyze_paper: '分析论文',
  prepare_data: '制定数据计划',
  propose_protocol: '生成评测协议',
  discover_comparison: '发现对比方法',
  reproduce_comparison: '复现对比方法',
  validate_baseline: '验证基线',
  generate_idea: '生成研究想法',
  screen_idea: '筛选研究想法',
  run_experiment: '执行实验',
};

const TASK_STATUS: Record<string, string> = {
  queued: '等待执行',
  claimed: '已领取',
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
  expired: '已超时',
  simulated: '模拟演示 · 未执行真实实验',
  input_unverified: '材料来源待核验',
};

function DetailValue({ value }: { value: TaskDetailValue }) {
  if (Array.isArray(value)) {
    return value.length > 0 ? (
      <ul>
        {value.map((item, index) => (
          <li key={index}>
            <DetailValue value={item} />
          </li>
        ))}
      </ul>
    ) : (
      <span>空列表</span>
    );
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    return entries.length > 0 ? (
      <dl>
        {entries.map(([label, item]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <DetailValue value={item} />
            </dd>
          </div>
        ))}
      </dl>
    ) : (
      <span>未记录可展示的字段</span>
    );
  }
  if (typeof value === 'string') return <ExpandableText text={value} label="已返回内容" />;
  return <span>{typeof value === 'boolean' ? (value ? '是' : '否') : value}</span>;
}

function TaskFields({ fields, empty }: { fields: StageTask['input']; empty: string }) {
  return fields.length > 0 ? (
    <dl className="task-fields">
      {fields.map((field) => (
        <div key={field.label}>
          <dt>{field.label}</dt>
          <dd>
            <DetailValue value={field.value} />
            {field.truncated ? <p className="muted">内容较长，仅展示部分记录。</p> : null}
          </dd>
        </div>
      ))}
    </dl>
  ) : (
    <p className="muted">{empty}</p>
  );
}

export function StageTaskList({ tasks }: { tasks: StageTask[] }) {
  if (tasks.length === 0)
    return <p className="muted">此阶段尚无任务记录；部分阶段仅检查进入条件，不创建独立任务。</p>;
  return (
    <ul className="stage-tasks">
      {tasks.map((task) => (
        <li key={task.external_task_id} className="panel">
          <h4>{TASK_LABEL[task.kind] ?? task.kind}</h4>
          <p>
            {TASK_STATUS[task.status] ?? task.status} · 已尝试 {task.attempt} 次
            {task.max_attempts !== null ? `，最多 ${task.max_attempts} 次` : ''}
          </p>
          <details>
            <summary>任务记录与时间</summary>
            <p className="mono">{task.external_task_id}</p>
            <p>
              开始：{task.started_at ? new Date(task.started_at).toLocaleString() : '未记录'}
              <br />
              结束：{task.ended_at ? new Date(task.ended_at).toLocaleString() : '未记录'}
            </p>
          </details>
          <h4>输入记录</h4>
          <TaskFields fields={task.input} empty="未记录可展示的任务输入。" />
          <p className="muted">
            这里只展示已保存的任务输入；执行时读取的其他上下文尚未保存完整快照。
          </p>
          <h4>产出记录</h4>
          {task.simulated ? (
            <p className="status-chip" data-state="blocked">
              此任务仅演示流程，不提供科研指标或有效性结论。
            </p>
          ) : task.status === 'input_unverified' ? (
            <p className="muted">输入来源未核验，不能将旧结果认定为已完成的论文分析。</p>
          ) : (
            <TaskFields fields={task.output} empty="未记录可展示的任务产出。" />
          )}
        </li>
      ))}
    </ul>
  );
}

export function StageDetails({
  projectId,
  externalRunId,
  stage,
  title,
  progress,
}: {
  projectId: string;
  externalRunId: string;
  stage: string;
  title: string;
  progress?: StageProgress;
}) {
  const query = useQuery({
    queryKey: ['stage', projectId, externalRunId, stage],
    queryFn: ({ signal }) =>
      requestJson<StageTasksView>(
        `/functions/v1/app/views/stage?${new URLSearchParams({ external_id: projectId, external_run_id: externalRunId, stage })}`,
        signal,
      ),
    refetchInterval: (query) => (query.state.error ? false : 5000),
    retry: false,
    gcTime: 0,
  });
  return (
    <section
      id="stage-detail"
      className="panel stage-detail"
      aria-labelledby="stage-detail-title"
      aria-busy={query.isFetching}
    >
      <h3 id="stage-detail-title">{title} · 阶段详情</h3>
      {progress?.gate_note ? <p>{progress.gate_note}</p> : null}
      {progress?.blocker_code ? (
        <p>
          阻断原因：<code>{progress.blocker_code}</code>
        </p>
      ) : null}
      {!progress || !progress.stage_known ? <p className="muted">尚未上报此阶段状态。</p> : null}
      <button
        className="btn-secondary"
        disabled={query.isFetching}
        onClick={() => void query.refetch()}
      >
        {query.isFetching ? '正在读取…' : '刷新详情'}
      </button>
      {query.error ? (
        <p role="alert">{query.error.message} 请点击“刷新详情”重试。</p>
      ) : query.isPending ? (
        <p role="status">正在读取任务记录…</p>
      ) : (
        <>
          {query.data.truncated ? (
            <p className="muted">仅展示此阶段最新 100 条任务，记录可能不完整。</p>
          ) : null}
          <StageTaskList tasks={query.data.tasks} />
        </>
      )}
    </section>
  );
}
