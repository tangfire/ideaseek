import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExperimentResults } from '../src/app';

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
