import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { action, jsonLine } from './shared.js';

/**
 * `ideaseek watchdog` — one-shot stalled/dead/stale detection over
 * supervisor, project lock, worker heartbeats and experiment progress
 * (Phase 4.5B, ARIS watchdog contract: detection ONLY, never a quality
 * verdict). Exit 0 when healthy, 2 when findings exist (scriptable).
 */
export function registerWatchdogCommand(program: Command): void {
  program
    .command('watchdog')
    .description('detect stalled/dead/stale workers, supervisor, lock and experiment progress')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { json?: boolean }) => {
        const { findProjectRoot } = await import('../config/paths.js');
        const root = await findProjectRoot(process.cwd());
        if (!root) {
          throw new IdeaseekError(
            'NOT_INITIALIZED',
            'no IdeaSeek project here; run: ideaseek init',
          );
        }
        const { detectWatchdog } = await import('../runtime/watchdog.js');
        const report = await detectWatchdog(root);

        if (opts.json) {
          process.stdout.write(jsonLine(report));
          return report.healthy ? 0 : 2;
        }
        if (report.healthy) {
          process.stdout.write(
            `watchdog: healthy (checked ${report.checked.workers} worker(s), ` +
              `${report.checked.experiments} experiment progress file(s)` +
              `${report.checked.supervisor ? ', supervisor' : ''}` +
              `${report.checked.lock ? ', lock' : ''})\n`,
          );
          return 0;
        }
        process.stdout.write(`${report.findings.length} finding(s):\n`);
        for (const finding of report.findings) {
          process.stdout.write(
            `  [${finding.state}] ${finding.scope} ${finding.target}\n    ${finding.detail}\n`,
          );
        }
        process.stdout.write('next: resolve the finding above (detection only — no verdicts)\n');
        return 2;
      }),
    );
}
