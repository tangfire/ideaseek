import { expect, it } from 'vitest';
import { parseMetricsOutput } from '../src/idea/experiment.js';
import type { ExperimentSpec } from '../src/experiment/spec.js';

const SPEC = {
  metrics: [{ name: 'target_unseen_domain_top1_accuracy' }],
} as unknown as ExperimentSpec;

const line = (extra: Record<string, unknown>) =>
  `some log noise\n${JSON.stringify({ metrics: { target_unseen_domain_top1_accuracy: 0.42 }, ...extra })}`;

it('refuses to record an entry that ran a different scale than asked', () => {
  // Observed: an idea's src/train.py executed the smoke computation and printed
  // "scale": "smoke" while `run-ready --scale quick` recorded the result as a
  // quick experiment, with metrics bit-identical to the smoke run.
  const refused = parseMetricsOutput(line({ scale: 'smoke' }), 0, false, SPEC, 'quick');
  expect(refused.metrics).toEqual([]);
  expect(refused.parseFailure).toMatch(/reports scale="smoke"/);
  expect(refused.parseFailure).toMatch(/--scale quick/);
});

it('accepts a matching scale, and an entry that reports none', () => {
  expect(parseMetricsOutput(line({ scale: 'quick' }), 0, false, SPEC, 'quick').parseFailure).toBe(
    null,
  );
  // Existing ideas print only {"metrics": ...}: the argv the platform built is
  // the evidence for those, so silence must not be read as a contradiction.
  expect(parseMetricsOutput(line({}), 0, false, SPEC, 'quick').parseFailure).toBeNull();
});

const prettyBlock = [
  '{',
  '  "method": "feddg-prototype-alignment",',
  '  "metrics": {',
  '    "target_unseen_domain_top1_accuracy": 0.207451',
  '  }',
  '}',
].join('\n');

it('parses a pretty-printed metrics block that no single line can parse', () => {
  // Observed: the full-run comparison item `python3 smoke.py` exited 0 and
  // printed an indented {"metrics": ...} object; the line scan saw only
  // fragments, so full run failed 3x with DEPENDENCY_NOT_MET "entry produced
  // no metrics JSON line" for a method that had just printed its numbers.
  const parsed = parseMetricsOutput(prettyBlock, 0, false, SPEC);
  expect(parsed.parseFailure).toBeNull();
  expect(parsed.metrics).toEqual([
    { name: 'target_unseen_domain_top1_accuracy', value: 0.207451 },
  ]);
});

it('parses a pretty block surrounded by log noise', () => {
  const parsed = parseMetricsOutput(`starting run...\n${prettyBlock}\ndone in 1.2s`, 0, false, SPEC);
  expect(parsed.parseFailure).toBeNull();
  expect(parsed.metrics).toEqual([
    { name: 'target_unseen_domain_top1_accuracy', value: 0.207451 },
  ]);
});

it('line scan still wins over earlier blocks when several JSON objects stream', () => {
  const first = JSON.stringify({
    metrics: { target_unseen_domain_top1_accuracy: 0.11 },
  });
  const last = JSON.stringify({
    metrics: { target_unseen_domain_top1_accuracy: 0.42 },
  });
  const parsed = parseMetricsOutput(`${first}\n${last}`, 0, false, SPEC);
  expect(parsed.parseFailure).toBeNull();
  expect(parsed.metrics).toEqual([{ name: 'target_unseen_domain_top1_accuracy', value: 0.42 }]);
});
