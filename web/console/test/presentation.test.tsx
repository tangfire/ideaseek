import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Chips, ExperimentResults, OutputChain, PaperCardList } from '../src/app';
import { StepPump } from '../src/panels';
import { StageTaskList } from '../src/stage-details';
import type { ProjectView, RunSummary, StageTask } from '../src/types';

describe('运行状态与阶段分离', () => {
  const run: RunSummary = { external_run_id: 'run', phase_tag: 'COMPLETED', stage_known: true, started_at: null, finished_at: null, status: 'succeeded' };
  it('完成只显示一个状态，其他阶段保持中性且不伪装为成功', () => {
    const complete = renderToStaticMarkup(<Chips run={run} />);
    expect(complete.match(/status-chip/g)).toHaveLength(1);
    const active = renderToStaticMarkup(<Chips run={{ ...run, phase_tag: 'PROTOCOL_REVIEW', status: 'running' }} />);
    expect(active).toContain('data-state="active"');
    expect(active).toContain('data-state="idle" title="PROTOCOL_REVIEW"');
    expect(active).toContain('阶段：协议评审');
  });
  it('额度只显示一个状态，公开摘要不补出不可见状态', () => {
    const quota = renderToStaticMarkup(<Chips run={{ ...run, phase_tag: 'PAPER_ANALYSIS', status: 'QUOTA_EXHAUSTED' }} />);
    expect(quota.match(/data-state="quota"/g)).toHaveLength(1);
    const publicRun = renderToStaticMarkup(<Chips run={{ ...run, status: undefined }} />);
    expect(publicRun).not.toContain('data-state="ok"');
    expect(publicRun).toContain('阶段：完成');
  });
});

describe('实验结果真实性', () => {
  it('模拟结果不显示指标、实验规模或支持结论', () => {
    const html = renderToStaticMarkup(<ExperimentResults experiments={[{
      external_spec_id: 'experiment-demo', idea_id: 'idea-demo', scale: 'standard',
      status: 'simulated', metrics: { accuracy: 0.9876 }, verdict: 'supported',
    }]} />);
    expect(html).toContain('模拟演示');
    expect(html).not.toContain('0.9876');
    expect(html).not.toContain('有证据支持');
    expect(html).not.toContain('>标准<');
  });

  it('真实实验保留指标，未记录的规模不会补成标准', () => {
    const html = renderToStaticMarkup(<ExperimentResults experiments={[{
      external_spec_id: 'experiment-real', idea_id: 'idea-real', scale: null,
      status: 'completed', metrics: { accuracy: 0.8123 },
    }]} />);
    expect(html).toContain('0.8123');
    expect(html).not.toContain('>标准<');
  });
});

it('无来源的旧论文明确待核验，不显示已解析', () => {
  const html = renderToStaticMarkup(<PaperCardList papers={[{
    external_paper_id: 'old', title: '旧论文', parse_status: 'input_unverified',
  }]} />);
  expect(html).toContain('材料来源待核验');
  expect(html).not.toContain('已解析');
});

it('有输入来源的成功论文仍显示已解析，失败论文保持失败', () => {
  const html = renderToStaticMarkup(<PaperCardList papers={[
    { external_paper_id: 'valid', title: '有材料的论文', parse_status: 'succeeded' },
    { external_paper_id: 'failed', title: '失败论文', parse_status: 'failed' },
  ]} />);
  expect(html).toContain('已解析');
  expect(html).toContain('>失败<');
  expect(html).not.toContain('材料来源待核验');
});

describe('运行控制说明', () => {
  it('新运行显示开始，并说明页面和暂停的影响', () => {
    const html = renderToStaticMarkup(<StepPump projectId="project" externalRunId="run" notStarted />);
    expect(html).toContain('开始运行');
    expect(html).toContain('尚未开始');
    expect(html).toContain('离开项目、刷新或关闭页面后停止推进');
    expect(html).toContain('已发出的步骤仍可能在云端完成，并保留结果');
  });

  it('已有运行等待手动继续', () => {
    const html = renderToStaticMarkup(<StepPump projectId="project" externalRunId="run" notStarted={false} />);
    expect(html).toContain('继续运行');
    expect(html).toContain('等待继续');
    expect(html).not.toContain('开始运行');
  });

  it('已完成运行不再提供开始或继续按钮', () => {
    const html = renderToStaticMarkup(<StepPump projectId="project" externalRunId="run" notStarted={false} completed />);
    expect(html).toContain('研究流程已完成');
    expect(html).not.toContain('<button');
  });
});

describe('阶段任务详情', () => {
  const task: StageTask = {
    external_task_id: 'stage-task', kind: 'analyze_paper', status: 'succeeded', attempt: 1,
    max_attempts: 3, started_at: null, ended_at: null, simulated: false,
    input: [{ label: '论文摘要', value: '<script>材料</script>', truncated: true }],
    output: [{ label: '结论记录', value: [{ 内容: '已保存结论', 置信度: 'high' }], truncated: false }],
  };

  it('展示已保存输入与嵌套产出，转义内容并说明截断', () => {
    const html = renderToStaticMarkup(<StageTaskList tasks={[task]} />);
    expect(html).toContain('论文摘要');
    expect(html).toContain('&lt;script&gt;材料&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('已保存结论');
    expect(html).toContain('仅展示部分记录');
    expect(html).toContain('尚未保存完整快照');
  });

  it('模拟或输入未核验时，前端也禁止把载荷呈现为真实产出', () => {
    for (const patch of [{ simulated: true, status: 'simulated' }, { status: 'input_unverified' }]) {
      const html = renderToStaticMarkup(<StageTaskList tasks={[{ ...task, ...patch, output: [{ label: '指标', value: 0.9997, truncated: false }] }]} />);
      expect(html).not.toContain('0.9997');
      expect(html).not.toContain('已完成 · 已尝试');
    }
  });

  it('空阶段与缺少任务输入、产出分别说明，不显示成功结果', () => {
    expect(renderToStaticMarkup(<StageTaskList tasks={[]} />)).toContain('此阶段尚无任务记录');
    const html = renderToStaticMarkup(<StageTaskList tasks={[{ ...task, status: 'queued', input: [], output: [] }]} />);
    expect(html).toContain('未记录可展示的任务输入');
    expect(html).toContain('未记录可展示的任务产出');
    expect(html).not.toContain('已完成');
  });
});

describe('产出来源关联', () => {
  const view: ProjectView = {
    ok: true, generated_at: '2026-11-25T00:00:00Z', visibility: 'private', projection_level: 'full',
    project: { external_id: 'test', title: '项目', question: null, last_sync_at: null },
    runs: [], stages: [], events: [], unsynced: null,
    papers: [{ external_paper_id: 'paper/中文#', title: '来源论文', parse_status: 'succeeded' }],
    ideas: [{ external_idea_id: 'idea-one', title: '关联想法', status: 'proposed', hypothesis_disclosure: 'withheld', version: 1,
      paper_sources: [{ reference_id: 'source-one', paper_id: 'paper/中文#', title: '来源论文', status: 'linked' }] }],
    experiments: [{ external_spec_id: 'experiment-one', idea_id: 'idea-one', scale: null, status: 'simulated', metrics: { accuracy: 0.9997 } }],
  };

  it('论文、想法与实验包含双向查看入口，不再用全局箭头暗示全部关联', () => {
    const html = renderToStaticMarkup(<OutputChain view={view} />);
    expect(html).toContain('引用此论文的想法');
    expect(html).toContain('来源论文');
    expect(html).toContain('关联实验');
    expect(html).toContain('实验对象');
    expect(html).toContain('experiment-one（模拟演示）');
    expect(html).toContain('output-paper-paper%2F%E4%B8%AD%E6%96%87%23');
    expect(html).not.toContain('chain-arrow');
    expect(html).not.toContain('0.9997');
  });

  it('缺失、歧义、未核验及未记录的来源有明确说明，不制造来源入口', () => {
    const html = renderToStaticMarkup(<OutputChain view={{ ...view,
      ideas: [
        { ...view.ideas![0]!, external_idea_id: 'unknown', paper_sources: null },
        { ...view.ideas![0]!, external_idea_id: 'empty', paper_sources: [] },
        { ...view.ideas![0]!, external_idea_id: 'bad', paper_sources: [
          { reference_id: 'missing', paper_id: null, title: null, status: 'missing' },
          { reference_id: 'ambiguous', paper_id: null, title: null, status: 'ambiguous' },
          { reference_id: 'unverified', paper_id: 'paper/中文#', title: '来源论文', status: 'unverified' },
        ] },
      ],
      experiments: [{ ...view.experiments![0]!, idea_id: null }, { ...view.experiments![0]!, external_spec_id: 'orphan', idea_id: 'foreign' }],
    }} />);
    expect(html).toContain('未记录可核验的来源论文编号');
    expect(html).toContain('记录中未关联来源论文');
    expect(html).toContain('当前运行未找到来源论文');
    expect(html).toContain('编号对应多个记录');
    expect(html).toContain('材料或分析状态待核验');
    expect(html).toContain('未记录关联想法编号');
    expect(html).toContain('当前运行未找到关联想法');
  });
});
