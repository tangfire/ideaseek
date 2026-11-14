import type { ProgressLine } from './checkpoint.js';

/**
 * Experiment progress → RunEvent (PROGRESS 86: 训练进度心跳实时进
 * RunEvent 流). Long training emits `{"progress": {...}}` lines; the
 * spec runner streams them through `onProgress`, and this recorder
 * appends ONE `experiment_progress` event per distinct line to the
 * project's latest run — so status/attach/TUI see step-level progress
 * live instead of only the monitor snapshot. No run exists → progress
 * stays in the progress file (honest no-op). Telemetry never fails the
 * run: every error is swallowed after the fact.
 */

export interface ProgressEventAppend {
  appendEvent(event: {
    runId: string;
    phase: string;
    objectId: string | null;
    role: string | null;
    eventType: string;
    summary: string;
    status: string | null;
  }): Promise<{ seq: number }>;
  /** Latest project run (progress events are run-bound by schema). */
  getLatestRunId(): Promise<string | null>;
}

export function makeExperimentProgressRecorder(opts: {
  sink: ProgressEventAppend;
  specId: string;
  role?: string;
}): (line: ProgressLine) => void {
  let cachedRunId: string | null | undefined;
  let lastKey = '';
  return (line) => {
    const key = JSON.stringify(line);
    if (key === lastKey) return; // consecutive duplicate heartbeats
    lastKey = key;
    void (async () => {
      try {
        if (cachedRunId === undefined) {
          cachedRunId = await opts.sink.getLatestRunId().catch(() => null);
        }
        const runId = cachedRunId;
        if (!runId) return;
        await opts.sink.appendEvent({
          runId,
          phase: 'EXPERIMENTING',
          objectId: opts.specId,
          role: opts.role ?? 'experiment',
          eventType: 'experiment_progress',
          summary: JSON.stringify({
            step: line.step ?? null,
            epoch: line.epoch ?? null,
            checkpoint: line.checkpoint ?? null,
          }),
          status: null,
        });
      } catch {
        // telemetry never fails the run itself
      }
    })();
  };
}
