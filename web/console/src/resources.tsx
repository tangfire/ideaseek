import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { requestJson } from './api';
import { StageTaskList, TASK_LABEL } from './stage-details';
import type { ResourcesView } from './types';

const ARTIFACT_STATUS: Record<string, string> = {
  committed: '已登记提交',
  staged: '暂存中 · 尚未提交',
  aborted: '已中止',
};

export function ResourceRecords({ data }: { data: ResourcesView }) {
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<string | null>(null);
  const materials = data.tasks.filter((task) => task.kind === 'analyze_paper');
  const outputs = data.tasks.filter(
    (task) => task.output.length > 0 || task.simulated || task.status === 'input_unverified',
  );
  const visible = filter === 'papers' ? materials : filter === 'outputs' ? outputs : data.tasks;
  return (
    <>
      <div className="resource-summary">
        <div className="panel">
          <strong>论文材料</strong>
          <p>{materials.length} 条任务记录</p>
          <p className="muted">逐条检查任务是否保存正文或摘要；分析卡片不代表原始 PDF 已上传。</p>
        </div>
        <div className="panel">
          <strong>阶段产出</strong>
          <p>{outputs.length} 条产出或待核验记录</p>
          <p className="muted">
            数据计划、协议草案和模拟步骤均按原记录展示，不代表数据或实验已就绪。
          </p>
        </div>
        <div className="panel">
          <strong>文件引用</strong>
          <p>{data.artifacts.length} 条登记</p>
          <p className="muted">引用仅提供编号和内容指纹；当前尚未接通文件预览与下载。</p>
        </div>
      </div>
      {data.tasks_truncated || data.artifacts_truncated ? (
        <p className="banner">此处每类最多展示最新 100 条记录，数量不代表运行总量。</p>
      ) : null}
      <h3>材料与产出记录</h3>
      <label>
        查看范围{' '}
        <select
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
            setSelected(null);
          }}
        >
          <option value="all">全部任务</option>
          <option value="papers">论文材料</option>
          <option value="outputs">阶段产出</option>
        </select>
      </label>
      {visible.length === 0 ? (
        <p className="muted">当前范围尚无已保存的记录。</p>
      ) : (
        <ul className="resource-list">
          {visible.map((item) => {
            const paperInput = item.input.some(
              (field) => field.label === '论文正文' || field.label === '论文摘要',
            );
            const title = item.output.find(
              (field) => field.label === '标题' && typeof field.value === 'string',
            );
            return (
              <li key={item.external_task_id} className="panel">
                <strong>
                  {title ? String(title.value) : (TASK_LABEL[item.kind] ?? item.kind)}
                </strong>
                <p className="muted">
                  {item.kind === 'analyze_paper'
                    ? paperInput
                      ? '已记录论文文本'
                      : '尚缺论文正文或摘要'
                    : '阶段任务记录'}
                  {item.simulated ? ' · 模拟演示，不提供真实实验结果' : ''}
                  {item.status === 'input_unverified' ? ' · 输入来源待核验' : ''}
                </p>
                <button
                  className="btn-secondary"
                  aria-expanded={selected === item.external_task_id}
                  aria-controls="resource-task-detail"
                  onClick={() =>
                    setSelected(selected === item.external_task_id ? null : item.external_task_id)
                  }
                >
                  {selected === item.external_task_id ? '收起记录' : '查看输入与产出'}
                </button>
                {selected === item.external_task_id ? (
                  <section id="resource-task-detail" aria-label="材料与产出详情">
                    <StageTaskList tasks={[item]} />
                  </section>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <h3>文件与交付物引用</h3>
      {data.artifacts.length === 0 ? (
        <p className="muted">
          当前运行尚无已登记的文件交付物，不能据此下载论文原件、代码包或研究报告。
        </p>
      ) : (
        <ul className="resource-list">
          {data.artifacts.map((artifact) => (
            <li className="panel" key={artifact.external_artifact_id}>
              <strong>{artifact.external_artifact_id}</strong>
              <p>
                {ARTIFACT_STATUS[artifact.status] ?? artifact.status} · {artifact.kind}
              </p>
              <dl>
                <dt>内容指纹</dt>
                <dd>{artifact.content_hash}</dd>
                <dt>文件大小</dt>
                <dd>{artifact.size_bytes} 字节</dd>
                <dt>关联任务</dt>
                <dd>{artifact.external_task_id ?? '未记录'}</dd>
              </dl>
              <p className="muted">仅有文件引用，尚无法在此预览或下载。</p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function Resources({
  projectId,
  externalRunId,
}: {
  projectId: string;
  externalRunId: string;
}) {
  const query = useQuery({
    queryKey: ['resources', projectId, externalRunId],
    queryFn: ({ signal }) =>
      requestJson<ResourcesView>(
        `/functions/v1/app/views/resources?${new URLSearchParams({ external_id: projectId, external_run_id: externalRunId })}`,
        signal,
      ),
    retry: false,
    gcTime: 0,
    refetchInterval: (query) => (query.state.error ? false : 15000),
  });
  return (
    <section className="resources" aria-labelledby="resources-title" aria-busy={query.isFetching}>
      <h2 id="resources-title">材料与成果</h2>
      <p className="muted">当前运行：{externalRunId}。这里只展示此运行的已保存记录。</p>
      <p className="banner">
        论文上传、数据集接入及代码包/报告下载尚未接通。当前入口用于检查材料缺口与已保存产出，不会启动分析或实验。
      </p>
      <button
        className="btn-secondary"
        disabled={query.isFetching}
        onClick={() => void query.refetch()}
      >
        {query.isFetching ? '正在读取…' : '刷新材料与成果'}
      </button>
      {query.error ? (
        <p role="alert">{query.error.message} 请刷新重试。</p>
      ) : query.isPending ? (
        <p role="status">正在读取材料与成果…</p>
      ) : (
        <ResourceRecords key={`${projectId}:${externalRunId}`} data={query.data} />
      )}
    </section>
  );
}
