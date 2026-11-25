import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExpandableText } from '../src/expandable-text';
import { OutputChain, PaperCardList } from '../src/app';
import { StageTaskList } from '../src/stage-details';
import type { ProjectView, StageTask } from '../src/types';

describe('长文本预览与详情', () => {
  it('短内容直接展示，180 字与三行以内不增加空的展开操作', () => {
    for (const text of ['短文本', '文'.repeat(180), '一\n二\n三']) {
      const html = renderToStaticMarkup(<ExpandableText text={text} label="内容" />);
      expect(html).toContain(text);
      expect(html).not.toContain('<details');
    }
  });

  it('长内容保留全部原文，预览不切坏 emoji；多行短文本也可收起', () => {
    const text = `${'文'.repeat(179)}😀\n原始尾部内容`;
    const html = renderToStaticMarkup(<ExpandableText text={text} label="方法摘要" />);
    expect(html).toContain('展开方法摘要');
    expect(html).toContain('收起方法摘要');
    expect(html).toContain(`${'文'.repeat(179)}😀…`);
    expect(html).toContain(text);
    expect(html).not.toContain('\uFFFD');
    expect(html).not.toContain('<details open');
    const multiline = renderToStaticMarkup(
      <ExpandableText text={'一\r\n二\r\n三\r\n四'} label="多行记录" />,
    );
    expect(multiline).toContain('一\n二\n三…');
    expect(multiline).toContain('一\r\n二\r\n三\r\n四');
  });

  it('预览与展开内容都转义 HTML，不删除末尾文本', () => {
    const html = renderToStaticMarkup(
      <ExpandableText text={`${'<script>内容</script>'.repeat(20)}<img src=x>末尾`} label="内容" />,
    );
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img src=x&gt;末尾');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
  });

  it('论文研究问题和方法分别展开，短文本仍保持直接可见', () => {
    const html = renderToStaticMarkup(
      <PaperCardList
        papers={[
          {
            external_paper_id: 'paper',
            title: '论文标题',
            question: '问题'.repeat(120),
            method_summary: '方法'.repeat(150),
            parse_status: 'succeeded',
          },
        ]}
      />,
    );
    expect(html).toContain('展开论文研究问题');
    expect(html).toContain('展开方法摘要');
    expect(html).toContain('已解析');
  });

  it('想法机制可展开，未授权的假设即使载荷存在也不进入页面', () => {
    const view: ProjectView = {
      ok: true,
      generated_at: '2026-11-25T00:00:00Z',
      visibility: 'private',
      projection_level: 'full',
      project: { external_id: 'project', title: '项目', question: null, last_sync_at: null },
      runs: [],
      stages: [],
      events: [],
      unsynced: null,
      ideas: [
        {
          external_idea_id: 'idea',
          title: '想法',
          mechanism_summary: '机制'.repeat(150),
          hypothesis: 'private-hypothesis-sentinel',
          hypothesis_disclosure: 'withheld',
          status: 'proposed',
          version: 1,
        },
      ],
    };
    const html = renderToStaticMarkup(<OutputChain view={view} />);
    expect(html).toContain('展开机制摘要');
    expect(html).not.toContain('private-hypothesis-sentinel');
    expect(html).toContain('假设全文未公开');
  });

  it('任务字段只展开已返回内容，保留服务端截断提示和模拟保护', () => {
    const task: StageTask = {
      external_task_id: 'task',
      kind: 'analyze_paper',
      status: 'succeeded',
      attempt: 1,
      max_attempts: 3,
      started_at: null,
      ended_at: null,
      simulated: false,
      input: [{ label: '论文正文', value: '文'.repeat(2000), truncated: true }],
      output: [{ label: '说明', value: [{ 内容: '内容'.repeat(200) }], truncated: false }],
    };
    const html = renderToStaticMarkup(<StageTaskList tasks={[task]} />);
    expect(html).toContain('展开已返回内容');
    expect(html).toContain('仅展示部分记录');
    expect(html).not.toContain('展开全文');
    const simulated = renderToStaticMarkup(
      <StageTaskList
        tasks={[
          {
            ...task,
            simulated: true,
            status: 'simulated',
            output: [
              { label: '指标', value: 'private-simulated-sentinel'.repeat(20), truncated: false },
            ],
          },
        ]}
      />,
    );
    expect(simulated).not.toContain('private-simulated-sentinel');
  });
});
