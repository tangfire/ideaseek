import { describe, expect, it } from 'vitest';
import { formatStepLine } from '../src/dsh/session.js';

/**
 * Step-level transcript lines (docs/TERMINAL_UX 实时事件): tool/call and
 * tool/result events render as `⚙ …` rows; everything else stays out of
 * the activity pane. Display-only — RunEvent persistence remains the
 * registered step-level gap.
 */

describe('formatStepLine (unit)', () => {
  it('renders a tool request with a one-line argument excerpt', () => {
    const calls = new Map<string, string>();
    expect(
      formatStepLine(
        'tool/call',
        { callId: 'c1', name: 'pwsh', arguments: '{"command":"ls"}' },
        calls,
      ),
    ).toBe('⚙ pwsh {"command":"ls"}');
    // callId is remembered for the paired result.
    expect(calls.get('c1')).toBe('pwsh');
  });

  it('clips long arguments and collapses newlines', () => {
    const line = formatStepLine(
      'tool/call',
      { callId: 'c2', name: 'read', arguments: `{\n  "path": "${'x'.repeat(200)}"\n}` },
      new Map(),
    );
    expect(line!.startsWith('⚙ read {')).toBe(true);
    expect(line!.length).toBeLessThanOrEqual('⚙ read '.length + 121);
    expect(line).not.toContain('\n');
  });

  it('pairs results back to the announced tool name and clears the map', () => {
    const calls = new Map([['c3', 'grep']]);
    expect(
      formatStepLine('tool/result', { message: { callId: 'c3', isError: false } }, calls),
    ).toBe('⚙ ✓ grep');
    expect(calls.has('c3')).toBe(false);
    expect(
      formatStepLine(
        'tool/result',
        { message: { callId: 'c3', isError: true }, error: { name: 'ENOENT' } },
        calls,
      ),
    ).toBe('⚙ ✗ tool — ENOENT');
  });

  it('ignores unrelated event types and malformed payloads', () => {
    const calls = new Map<string, string>();
    expect(formatStepLine('turn/start', { turn: 1 }, calls)).toBeNull();
    expect(formatStepLine('step/end', { turn: 1, step: 2 }, calls)).toBeNull();
    expect(formatStepLine('assistant/message', {}, calls)).toBeNull();
    expect(formatStepLine('tool/call', null, calls)).toBe('⚙ tool');
  });
});
