import type { Command } from 'commander';
import { redactSecrets } from '../core/redact.js';
import { ProjectRuntime } from '../workflow/runtime.js';
import { action, jsonLine, resolveRun } from './shared.js';

export function registerEventsCommand(program: Command): void {
  program
    .command('events')
    .description('replay persisted run events from a sequence number')
    .option('--run <runId>', 'run id (default: latest)')
    .option('--since <seq>', 'only events with seq > since', (value) => Number(value))
    .option('--limit <n>', 'maximum events to print', (value) => Number(value))
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { run?: string; since?: number; limit?: number; json?: boolean }) => {
        const runtime = await ProjectRuntime.open({ cwd: process.cwd() });
        try {
          const run = await resolveRun(runtime, opts.run);
          const events = await runtime.db.listEvents(run.runId, {
            since: Number.isFinite(opts.since) ? opts.since : 0,
            limit: Number.isFinite(opts.limit) ? opts.limit : 1000,
          });
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                runId: run.runId,
                events: events.map((event) => ({
                  ...event,
                  summary: redactSecrets(event.summary),
                })),
              }),
            );
            return 0;
          }
          for (const event of events) {
            const ts = new Date(event.ts).toISOString().replace('T', ' ').slice(0, 19);
            const object = event.objectId ? ` ${event.objectId}` : '';
            process.stdout.write(
              `[#${event.seq}] ${ts} ${event.eventType}${object} — ${redactSecrets(event.summary)}\n`,
            );
          }
          process.stdout.write(`(${events.length} event(s))\n`);
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );
}
