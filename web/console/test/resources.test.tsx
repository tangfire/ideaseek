import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResourceRecords } from '../src/resources';
import type { ResourcesView } from '../src/types';

const data: ResourcesView = {
  ok: true,
  external_run_id: 'run-one',
  tasks_truncated: false,
  artifacts_truncated: false,
  tasks: [
    {
      external_task_id: 'paper-empty',
      kind: 'analyze_paper',
      stage: 'PAPER_ANALYSIS',
      status: 'queued',
      attempt: 0,
      max_attempts: 3,
      started_at: null,
      ended_at: null,
      simulated: false,
      input: [],
      output: [],
    },
  ],
  artifacts: [],
};

describe('材料与成果清单', () => {
  it('缺材料与无交付物明确说明，不制造上传、下载或成功状态', () => {
    const html = renderToStaticMarkup(<ResourceRecords data={data} />);
    expect(html).toContain('尚缺论文正文或摘要');
    expect(html).toContain('当前运行尚无已登记的文件交付物');
    expect(html).toContain('查看输入与产出');
    expect(html).not.toContain('已记录论文文本');
    expect(html).not.toContain('download=');
    expect(html).not.toContain('type="file"');
  });

  it('论文输入、模拟与待核验记录区分，文本转义，不把内容自动变成链接', () => {
    const html = renderToStaticMarkup(
      <ResourceRecords
        data={{
          ...data,
          tasks: [
            {
              ...data.tasks[0]!,
              input: [{ label: '论文摘要', value: '摘要', truncated: false }],
              output: [{ label: '标题', value: '<script>论文</script>', truncated: false }],
            },
            {
              ...data.tasks[0]!,
              external_task_id: 'simulated',
              kind: 'run_experiment',
              simulated: true,
              status: 'simulated',
            },
            { ...data.tasks[0]!, external_task_id: 'legacy', status: 'input_unverified' },
          ],
        }}
      />,
    );
    expect(html).toContain('已记录论文文本');
    expect(html).toContain('模拟演示，不提供真实实验结果');
    expect(html).toContain('输入来源待核验');
    expect(html).toContain('&lt;script&gt;论文&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('文件引用保留零字节、编号和指纹，暂存/中止不显示已提交，明确截断', () => {
    const html = renderToStaticMarkup(
      <ResourceRecords
        data={{
          ...data,
          tasks_truncated: true,
          artifacts_truncated: true,
          artifacts: ['committed', 'staged', 'aborted'].map((status) => ({
            external_artifact_id: `artifact-${status}`,
            external_task_id: null,
            kind: 'report',
            status,
            size_bytes: 0,
            content_hash: 'sha256:recorded-hash',
            committed_at: null,
          })),
        }}
      />,
    );
    for (const text of [
      '已登记提交',
      '暂存中 · 尚未提交',
      '已中止',
      'sha256:recorded-hash',
      '0 字节',
      '最新 100 条记录',
      '尚无法在此预览或下载',
    ])
      expect(html).toContain(text);
    expect(html).not.toContain('<a ');
  });
});
