import { describe, expect, it } from 'vitest';
import { parseSupervisorOutput } from '../src/commands/ask.js';

/**
 * Live model output is untrusted shape: a numeric `answer` used to reach
 * `parsed.answer?.trim()` and crash the whole ask turn on otherwise-fine
 * JSON. The parser must coerce field types, not trust them.
 */
describe('parseSupervisorOutput field guards', () => {
  it('passes through well-formed output unchanged', () => {
    const parsed = parseSupervisorOutput(
      JSON.stringify({
        kind: 'query',
        answer: 'all good',
        cliArgs: ['ideaseek', 'status'],
        reason: 'r',
        summary: 's',
      }),
    );
    expect(parsed).toEqual({
      kind: 'query',
      answer: 'all good',
      cliArgs: ['ideaseek', 'status'],
      reason: 'r',
      summary: 's',
    });
  });

  it('coerces a numeric answer to undefined instead of crashing on trim', () => {
    const parsed = parseSupervisorOutput(
      JSON.stringify({ kind: 'query', answer: 42, cliArgs: ['ideaseek', 'status'] }),
    );
    expect(parsed?.kind).toBe('query');
    expect(parsed?.answer).toBeUndefined();
    expect(parsed?.cliArgs).toEqual(['ideaseek', 'status']);
  });

  it('nulls a non-array cliArgs and drops non-string entries', () => {
    expect(
      parseSupervisorOutput(JSON.stringify({ kind: 'query', cliArgs: 'status' }))?.cliArgs,
    ).toBeNull();
    expect(
      parseSupervisorOutput(JSON.stringify({ kind: 'query', cliArgs: ['ideaseek', 7, 'status'] }))
        ?.cliArgs,
    ).toEqual(['ideaseek', 'status']);
  });

  it('returns null for non-JSON and for a missing/non-string kind', () => {
    expect(parseSupervisorOutput('not json at all')).toBeNull();
    expect(parseSupervisorOutput(JSON.stringify({ answer: 'hi' }))).toBeNull();
    expect(parseSupervisorOutput(JSON.stringify({ kind: 42 }))).toBeNull();
  });
});
