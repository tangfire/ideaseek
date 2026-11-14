import { describe, expect, it } from 'vitest';
import {
  padVisualEnd,
  sanitizeAnsiForInk,
  stripAnsi,
  truncateVisual,
  visualWidth,
  wrapAnsiLines,
} from '../src/cli/text-width.js';

describe('terminal visual width and ANSI-safe wrapping', () => {
  it('measures CJK, emoji and ANSI sequences accurately', () => {
    expect(visualWidth('hello')).toBe(5);
    expect(visualWidth('论文分析')).toBe(8);
    expect(visualWidth('中a文')).toBe(5);
    expect(visualWidth('\x1b[36m论文\x1b[0m')).toBe(4);
    expect(stripAnsi('\x1b[31merror\x1b[0m')).toBe('error');
  });

  it('truncates CJK and ANSI strings within exact display columns', () => {
    const cjk = truncateVisual('这是一段很长的中文状态描述', 10);
    expect(visualWidth(cjk)).toBeLessThanOrEqual(10);
    expect(cjk.endsWith('…')).toBe(true);

    const colored = truncateVisual('\x1b[33mwarning: long message\x1b[0m', 12);
    expect(visualWidth(colored)).toBeLessThanOrEqual(12);
    expect(colored).toContain('\x1b[0m…');
  });

  it('pads strings based on display width rather than UTF-16 length', () => {
    const padded = padVisualEnd('中文', 8);
    expect(visualWidth(padded)).toBe(8);
    expect(padded).toBe('中文    ');
  });

  it('soft-wraps long lines while preserving SGR styles across line breaks', () => {
    const lines = wrapAnsiLines('\x1b[31merror: very long failure message here\x1b[0m', 16);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(visualWidth(line)).toBeLessThanOrEqual(16);
    }
    expect(lines[1]).toContain('\x1b[31m');
  });

  it('wraps CJK runs cleanly without overflowing columns', () => {
    const lines = wrapAnsiLines('实验协议生成失败需要用户确认样本单位和主指标', 14);
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) {
      expect(visualWidth(line)).toBeLessThanOrEqual(14);
    }
  });

  it('keeps SGR colors while stripping cursor/screen control escapes', () => {
    const cleaned = sanitizeAnsiForInk('\x1b[2J\x1b[H\x1b[32mok\x1b[0m\r\nnext');
    expect(cleaned).toBe('\x1b[32mok\x1b[0m\nnext');
  });
});
