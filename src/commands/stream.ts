import type { Command } from 'commander';
import { redactSecrets } from '../core/redact.js';
import { ProjectRuntime } from '../workflow/runtime.js';
import { followEvents } from '../workflow/follow.js';
import type { RunEvent } from '../workflow/types.js';
import { action, jsonLine, resolveRun } from './shared.js';

function formatEvent(event: RunEvent): string {
  const ts = new Date(event.ts).toISOString().replace('T', ' ').slice(0, 19);
  const object = event.objectId ? ` ${event.objectId}` : '';
  return `[#${event.seq}] ${ts} ${event.eventType}${object} — ${redactSecrets(event.summary)}`;
}

function exitForRunStatus(status: string): number {
  switch (status) {
    case 'COMPLETED':
      return 0;
    case 'FAILED':
      return 1;
    case 'CANCELED':
      return 4;
    case 'QUOTA_EXHAUSTED':
    case 'AUTH_REQUIRED':
    case 'NETWORK_BLOCKED':
    case 'FAILED_RECOVERABLE':
      return 2;
    case 'PAUSED':
      return 3;
    default:
      return 3; // still RUNNING
  }
}

interface StreamOptions {
  run?: string;
  since?: number;
  json?: boolean;
  poll?: number;
  workerTimeout?: number;
}

async function stream(mode: 'attach' | 'watch', opts: StreamOptions): Promise<number> {
  const runtime = await ProjectRuntime.open({ cwd: process.cwd() });
  try {
    const run = await resolveRun(runtime, opts.run);
    const controller = new AbortController();
    const onSignal = () => controller.abort();
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    try {
      const result = await followEvents({
        db: runtime.db,
        runId: run.runId,
        since: Number.isFinite(opts.since) ? (opts.since as number) : 0,
        pollMs: Number.isFinite(opts.poll) ? (opts.poll as number) : 300,
        stopOnTerminal: true,
        workerLostAfterMs:
          mode === 'watch'
            ? Number.isFinite(opts.workerTimeout)
              ? (opts.workerTimeout as number)
              : 10_000
            : null,
        workerStaleMs: runtime.config.runtime.leaseTtlSeconds * 3000,
        signal: controller.signal,
        onEvent: (event) => {
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                seq: event.seq,
                runId: event.runId,
                ts: event.ts,
                type: event.eventType,
                phase: event.phase,
                role: event.role,
                object: event.objectId,
                summary: redactSecrets(event.summary),
                status: event.status,
              }),
            );
          } else {
            process.stdout.write(`${formatEvent(event)}\n`);
          }
        },
        onWarn: (message) => process.stderr.write(`warning: ${message}\n`),
      });

      const finalRun = await runtime.db.getRun(run.runId);
      const status = finalRun?.status ?? 'CANCELED';
      if (!opts.json) {
        process.stdout.write(
          `${mode} stopped (${result.stopReason}); run=${status}, events=${result.replayed}\n`,
        );
      } else {
        process.stdout.write(
          jsonLine({
            mode,
            stopReason: result.stopReason,
            runId: run.runId,
            status,
            replayed: result.replayed,
            lastSeq: result.lastSeq,
          }),
        );
      }
      if (result.stopReason === 'signal') return 0;
      if (result.stopReason === 'worker-lost') return 3;
      return exitForRunStatus(status);
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
  } finally {
    await runtime.close();
  }
}

export function registerStreamCommands(program: Command): void {
  program
    .command('attach')
    .description('replay run events from the start (or --since) and follow live ones until Ctrl-C')
    .option('--run <runId>', 'run id (default: latest)')
    .option('--since <seq>', 'only events with seq > since', (value) => Number(value))
    .option('--poll <ms>', 'live poll interval', (value) => Number(value))
    .option('--json', 'one JSON line per event')
    .action(
      action(async (opts: StreamOptions) => {
        try {
          return await stream('attach', opts);
        } catch (error) {
          // Ctrl-C during an active follow exits cleanly with code 0.
          if (error instanceof Error && error.name === 'AbortError') return 0;
          throw error;
        }
      }),
    );

  program
    .command('watch')
    .description('follow run events until the run finishes, pauses or loses its worker')
    .option('--run <runId>', 'run id (default: latest)')
    .option('--since <seq>', 'only events with seq > since', (value) => Number(value))
    .option('--poll <ms>', 'live poll interval', (value) => Number(value))
    .option(
      '--worker-timeout <ms>',
      'exit when no live worker persists this long (watch only)',
      (value) => Number(value),
    )
    .option('--json', 'one JSON line per event')
    .action(action(async (opts: StreamOptions) => stream('watch', opts)));
}
