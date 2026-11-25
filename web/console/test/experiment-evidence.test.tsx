import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExperimentResults } from '../src/app';
import type { ExperimentResult } from '../src/types';

const experiment: ExperimentResult = {
  external_spec_id: 'experiment-full-record-id',
  title: '完整实验名称',
  idea_id: null,
  status: 'succeeded',
  scale: 'quick',
  metric_rows: [
    {
      name: 'accuracy',
      value: 0.812345678,
      direction: 'higher',
      stdev: 0,
      n: 2,
      controls: [
        { method_id: 'control-one', value: 0.8, stdev: 0.01, delta: 0.012345678 },
        { method_id: 'control-zero', value: 0, stdev: null, delta: 0.812345678 },
      ],
    },
    {
      name: 'loss',
      value: 0.2,
      direction: 'lower',
      stdev: null,
      n: null,
      controls: [{ method_id: 'control-one', value: 0.4, stdev: null, delta: -0.2 }],
    },
  ],
  context: {
    workflow_run_id: 'workflow-full-record-id',
    kind: 'run_result',
    spec_id: 'spec-full-id',
    result_spec_id: 'spec-full-id',
    code_commit: 'full-code-commit',
    data_snapshot_id: 'snapshot-full-id',
    protocol_id: 'protocol-full-id',
    slice_ids: ['slice-one', 'slice-two'],
    seeds: [0, 7],
  },
};
const render = (value: ExperimentResult) =>
  renderToStaticMarkup(<ExperimentResults experiments={[value]} />);

describe('指标对照与运行来源', () => {
  it('保留原始精度、零值、统计、方向和同次运行对照，不转换百分比或推断结论', () => {
    const html = render(experiment);
    for (const text of [
      '完整实验名称',
      '0.812345678',
      '标准差 0',
      '重复 2 次',
      '越高越好',
      '越低越好',
      'control-one',
      'control-zero',
      '+0.012345678',
      '-0.2',
      '同次运行记录',
      '原始单位',
    ])
      expect(html).toContain(text);
    expect(html).toContain('data-label="对照值">0<');
    expect(html).not.toContain('%');
    expect(html).not.toContain('有证据支持');
  });

  it('来源展示完整编号、快照、代码、协议、切片及零种子', () => {
    const html = render(experiment);
    for (const text of [
      'experiment-full-record-id',
      'workflow-full-record-id',
      'spec-full-id',
      'snapshot-full-id',
      'full-code-commit',
      'protocol-full-id',
      'slice-one、slice-two',
      '0、7',
      '结果绑定规格',
    ])
      expect(html).toContain(text);
  });

  it('旧指标保留零和小数，缺失来源、方向和基线明确标注且不计算提升', () => {
    const html = render({
      ...experiment,
      metric_rows: undefined,
      context: undefined,
      metrics: { error: 0, tiny: 1e-12 },
    });
    expect(html).toContain('data-label="实验值">0<');
    expect(html).toContain('1e-12');
    expect(html).toContain('未记录');
    expect(html).toContain('旧指标记录');
    expect(html).toContain('不计算提升幅度');
    expect(html).not.toContain('+0.012345678');
    expect(html).not.toContain('workflow-full-record-id');
  });

  it('已记录但条件不足的对照不呈现差值，空结果不显示数值', () => {
    const html = render({
      ...experiment,
      status: 'partial',
      metric_rows: [
        {
          ...experiment.metric_rows![0]!,
          controls: [{ method_id: 'control-one', value: 0.8, stdev: null, delta: null }],
        },
      ],
    });
    expect(html).toContain('暂不计算差值');
    expect(html).toContain('部分完成');
    expect(html).toContain('data-label="差值">不计算<');
    expect(html).not.toContain('+0.012345678');
    expect(render({ ...experiment, metric_rows: [], metrics: null })).toContain(
      '尚无已记录的实验指标',
    );
  });

  it('模拟记录即使注入指标和来源也不显示，交付清单不显示指标或结论', () => {
    const simulated = render({ ...experiment, status: 'simulated', verdict: 'supported' });
    for (const text of [
      '0.812345678',
      'control-one',
      'workflow-full-record-id',
      '运行来源与比较条件',
      '有证据支持',
    ])
      expect(simulated).not.toContain(text);
    const handoff = render({ ...experiment, scale: 'handoff_manifest', verdict: 'supported' });
    expect(handoff).toContain('尚无可展示的执行指标');
    expect(handoff).toContain('未执行');
    for (const text of ['0.812345678', '实验指标对照', '有证据支持'])
      expect(handoff).not.toContain(text);
  });
});
