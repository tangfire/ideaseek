import { describe, expect, it } from 'vitest';
import { formatEventLine } from '../src/cli/format.js';
import type { RunEvent } from '../src/workflow/types.js';

function event(over: Partial<RunEvent>): RunEvent {
  return {
    seq: 1,
    runId: 'run-1',
    ts: Date.parse('2026-11-15T01:21:12Z'),
    phase: 'USAGE',
    role: 'deepseek-v4-flash',
    eventType: 'model_usage',
    summary: '',
    status: null,
    objectId: null,
    artifactRefs: [],
    ...over,
  } as RunEvent;
}

/**
 * Usage events used to carry their JSON payload as the human summary, so the
 * transcript printed a wire object on every model call. The record itself
 * stays as written — events are append-only audit data — the rendering is what
 * changes.
 */
describe('formatEventLine for usage', () => {
  it('renders the numbers without the JSON', () => {
    const line = formatEventLine(
      event({
        summary: JSON.stringify({
          in: 3193,
          out: 2242,
          cost: null,
          model: 'deepseek-v4-flash',
          taskId: 'blueprint-fedavg',
        }),
      }),
      { plain: true },
    );
    expect(line).toContain('3193 in / 2242 out tokens');
    expect(line).toContain('task blueprint-fedavg');
    expect(line).not.toContain('{"in"');
    // A null cost is stated as what it is instead of printing null, and in
    // fewer characters than the event line cap allows for.
    expect(line).toContain('cost unset (no rates)');
    expect(line.length).toBeLessThanOrEqual(124);
  });

  it('keeps a computed cost when one exists', () => {
    const line = formatEventLine(
      event({ summary: JSON.stringify({ in: 10, out: 20, cost: 0.0412 }) }),
      { plain: true },
    );
    expect(line).toContain('cost 0.0412');
  });

  it('leaves non-usage summaries alone, including unparseable JSON', () => {
    expect(
      formatEventLine(event({ eventType: 'task_started', summary: '{"in":5}' }), { plain: true }),
    ).toContain('{"in":5}');
    expect(formatEventLine(event({ summary: 'protocol locked at v1' }), { plain: true })).toContain(
      'protocol locked at v1',
    );
  });
});
