import { describe, expect, it } from 'vitest';
import { renderMarkdownLines } from '../src/cli/shell/markdown.js';
import { stripAnsi, visualWidth } from '../src/cli/text-width.js';

describe('terminal Markdown and diff renderer', () => {
  it('renders headings, bullets, inline code and bold cleanly within width', () => {
    const md = [
      '# Research Findings',
      '',
      '- **FedBN** reduces `domain_shift` across [PACS](https://example.org)',
      '1. Run `ideaseek status` before launching experiments',
    ].join('\n');
    const lines = renderMarkdownLines(md, { width: 44 });
    expect(lines.some((l) => l.includes('\x1b[1m') && l.includes('Research Findings'))).toBe(true);
    expect(lines.some((l) => l.includes('•'))).toBe(true);
    expect(lines.some((l) => l.includes('1.'))).toBe(true);
    for (const line of lines) {
      expect(visualWidth(line)).toBeLessThanOrEqual(44);
    }
  });

  it('renders fenced code blocks and colorizes diff additions/removals', () => {
    const md = ['```diff', '- old_lr = 0.1', '+ new_lr = 0.01', '```'].join('\n');
    const lines = renderMarkdownLines(md, { width: 50 });
    expect(lines[0]).toContain('┌─ diff');
    expect(lines.some((l) => l.includes('\x1b[31m') && l.includes('- old_lr'))).toBe(true);
    expect(lines.some((l) => l.includes('\x1b[32m') && l.includes('+ new_lr'))).toBe(true);
    expect(lines[lines.length - 1]).toContain('└');
  });

  it('aligns Markdown pipe tables with CJK headers inside column budget', () => {
    const md = ['| 方法 | 准确率 |', '|---|---|', '| FedAvg | 70.1% |', '| FedBN | 74.8% |'].join(
      '\n',
    );
    const lines = renderMarkdownLines(md, { width: 40 });
    expect(lines.some((l) => l.includes('┌') && l.includes('┬'))).toBe(true);
    expect(lines.some((l) => stripAnsi(l).includes('FedBN'))).toBe(true);
    for (const line of lines) {
      expect(visualWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  it('strips ANSI formatting in plain mode', () => {
    const lines = renderMarkdownLines('## Title\n- **item** `code`', { width: 60, plain: true });
    const joined = lines.join('\n');
    // eslint-disable-next-line no-control-regex
    expect(joined).not.toMatch(/\x1b\[/);
    expect(joined).toContain('Title');
    expect(joined).toContain('item code');
  });
});
