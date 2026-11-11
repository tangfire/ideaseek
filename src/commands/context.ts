import type { Command } from 'commander';
import { action, jsonLine } from './shared.js';

/**
 * `ideaseek context` — cross-session recovery summary (Phase 4.5B): when
 * the previous session ended (clean vs crash), the latest run, last
 * events, pending approvals and artifact/idea references — rebuild the
 * session's context from persisted state (ADR-002).
 */
export function registerContextCommand(program: Command): void {
  program
    .command('context')
    .description(
      'cross-session recovery summary: previous session, run state, last events, approvals, references',
    )
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { json?: boolean }) => {
        const { requireProjectRoot } = await import('../session/context.js');
        const root = await requireProjectRoot();
        const { collectContext } = await import('../session/context.js');
        const report = await collectContext(root);

        if (opts.json) {
          process.stdout.write(jsonLine(report));
          return 0;
        }
        if (report.previousSession) {
          const previous = report.previousSession;
          process.stdout.write(
            `previous session: pid ${previous.pid} started ${new Date(previous.startedAt).toISOString()}` +
              `${previous.endedAt ? ` ended ${new Date(previous.endedAt).toISOString()}` : ' (never ended)'}` +
              ` — ${previous.endedCleanly ? 'clean exit' : 'CRASHED/INTERRUPTED'}\n`,
          );
        } else {
          process.stdout.write('no previous session recorded\n');
        }
        process.stdout.write(`session mode: ${report.sessionMode}\n`);
        if (report.run) {
          process.stdout.write(
            `run ${report.run.runId}: ${report.run.status} (${report.run.phase})\n`,
          );
        } else {
          process.stdout.write('no run yet\n');
        }
        if (report.lastEvents.length > 0) {
          process.stdout.write('last events:\n');
          for (const event of report.lastEvents) {
            process.stdout.write(`  #${event.seq} ${event.type}: ${event.summary}\n`);
          }
        }
        process.stdout.write(`pending approvals: ${report.pendingApprovals}\n`);
        if (report.artifacts.length > 0) {
          process.stdout.write('recent artifacts:\n');
          for (const artifact of report.artifacts) {
            process.stdout.write(`  ${artifact.kind} ${artifact.hash.slice(0, 19)}…\n`);
          }
        }
        for (const idea of report.ideas) {
          const refs = [
            idea.plan ? `plan ${idea.plan}` : null,
            idea.novelty ? `novelty ${idea.novelty}` : null,
            idea.review ? `review ${idea.review}` : null,
          ].filter(Boolean);
          process.stdout.write(
            `  idea ${idea.ideaId}: ${refs.length > 0 ? refs.join(' · ') : 'no plan/novelty/review yet'}\n`,
          );
        }
        process.stdout.write(
          'next: ideaseek attach --json (event replay) · ideaseek pending (approvals) · ideaseek next\n',
        );
        return 0;
      }),
    );
}
