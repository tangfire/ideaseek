import { describe, expect, it } from 'vitest';
import { ShellEngine, toEngineKey } from '../src/cli/shell/engine.js';
import {
  TranscriptWrapCache,
  computeViewportSlice,
  formatElapsed,
  styleTranscriptLine,
} from '../src/cli/shell/transcript.js';
import { visualWidth } from '../src/cli/text-width.js';

describe('TUI transcript styling and soft-wrap cache', () => {
  it('styles user prompts, tool calls, events and errors while stripping dangerous escapes', () => {
    expect(styleTranscriptLine('❯ /status')).toContain('\x1b[1m\x1b[36m');
    expect(styleTranscriptLine('⚙ ✓ pwsh')).toContain('\x1b[32m');
    expect(styleTranscriptLine('⚙ ✗ pwsh — failed')).toContain('\x1b[31m');
    expect(styleTranscriptLine('error: bad path')).toContain('\x1b[31m');
    expect(styleTranscriptLine('warning: queue paused')).toContain('\x1b[33m');
    expect(styleTranscriptLine('[13:21:04] PAPER_ANALYSIS  done  completed')).toContain('\x1b[32m');
    expect(styleTranscriptLine('\x1b[2J\x1b[31mkept\x1b[0m')).toBe('\x1b[31mkept\x1b[0m');
    expect(styleTranscriptLine('error: plain', true)).toBe('error: plain');
  });

  it('soft-wraps long lines without losing characters and recomputes on width change', () => {
    const cache = new TranscriptWrapCache();
    const rows60 = cache.wrapAll(
      [
        'error: [USER_INPUT_REQUIRED] Analysis → Research blocked by material gaps: question-missing',
      ],
      40,
    );
    expect(rows60.length).toBeGreaterThan(1);
    for (const row of rows60) {
      expect(visualWidth(row.text)).toBeLessThanOrEqual(40);
    }
    expect(rows60.map((r) => r.text).join(' ')).toContain('question-missing');

    const rowsWide = cache.wrapAll(
      [
        'error: [USER_INPUT_REQUIRED] Analysis → Research blocked by material gaps: question-missing',
      ],
      120,
    );
    expect(rowsWide.length).toBe(1);
  });

  it('computes viewport slices clamped to history bounds', () => {
    expect(computeViewportSlice(100, 20, 0)).toEqual({
      start: 80,
      end: 100,
      effOffset: 0,
      maxOffset: 80,
      totalRows: 100,
    });
    expect(computeViewportSlice(100, 20, 999)).toEqual({
      start: 0,
      end: 20,
      effOffset: 80,
      maxOffset: 80,
      totalRows: 100,
    });
    expect(computeViewportSlice(5, 20, 10)).toEqual({
      start: 0,
      end: 5,
      effOffset: 0,
      maxOffset: 0,
      totalRows: 5,
    });
  });

  it('formats elapsed durations cleanly', () => {
    expect(formatElapsed(350)).toBe('350ms');
    expect(formatElapsed(3240)).toBe('3.2s');
    expect(formatElapsed(75_000)).toBe('1m 15s');
  });
});

describe('ShellEngine raw control bytes and sanitization', () => {
  it('maps raw Ctrl-U (0x15) to clear-to-start instead of inserting control noise', () => {
    const engine = new ShellEngine();
    engine.handle({ sequence: 'abc' });
    const mapped = toEngineKey('\x15', {});
    expect(mapped).toEqual({ name: 'u', ctrl: true });
    const snap = engine.handle(mapped);
    expect(snap.line).toBe('');
    expect(snap.cursor).toBe(0);
  });

  it('strips stray ASCII control bytes from pasted sequences', () => {
    const engine = new ShellEngine();
    const snap = engine.handle({ sequence: 'hi\x15there\x07' });
    expect(snap.line).toBe('hithere');
  });
});
