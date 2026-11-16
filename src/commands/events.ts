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
    .option(
      '--tail <n>',
      'show only the N most recent events (printed oldest-first), for "what has been happening"',
      (value) => Number(value),
    )
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (opts: {
          run?: string;
          since?: number;
          limit?: number;
          tail?: number;
          json?: boolean;
        }) => {
          const runtime = await ProjectRuntime.open({ cwd: process.cwd() });
          try {
            const run = await resolveRun(runtime, opts.run);
            const hardLimit = Number.isFinite(opts.limit) ? opts.limit : 1000;
            const events = await runtime.db.listEvents(run.runId, {
              since: Number.isFinite(opts.since) ? opts.since : 0,
              // A tail request cannot be satisfied by the replay query, which
              // returns from the oldest row: read the window, keep its end.
              limit: hardLimit,
            });
            const tail = Number.isFinite(opts.tail) ? Math.max(1, Math.floor(opts.tail!)) : null;
            const shown = tail === null ? events : events.slice(-tail);
            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  runId: run.runId,
                  events: shown.map((event) => ({
                    ...event,
                    summary: redactSecrets(event.summary),
                  })),
                  truncatedAtLimit: events.length === hardLimit,
                }),
              );
              return 0;
            }
            for (const event of shown) {
              const ts = new Date(event.ts).toISOString().replace('T', ' ').slice(0, 19);
              const object = event.objectId ? ` ${event.objectId}` : '';
              process.stdout.write(
                `[#${event.seq}] ${ts} ${event.eventType}${object} — ${redactSecrets(event.summary)}\n`,
              );
            }
            process.stdout.write(`(${shown.length} event(s))\n`);
            if (events.length === hardLimit) {
              // Saying so is the point: a replay read that filled its window is
              // not the whole history, and "the last event I show is the newest
              // thing that happened" is a false conclusion a reader would
              // otherwise draw silently.
              process.stdout.write(
                `  note: the read window (${hardLimit}) was filled — there may be newer events; ` +
                  (tail === null
                    ? 'use --tail <n> for the most recent, or --since <seq> to continue a replay\n'
                    : 'raise --limit, or use --since <seq> to continue a replay\n'),
              );
            }
            return 0;
          } finally {
            await runtime.close();
          }
        },
      ),
    );
}
