import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { action, jsonLine } from './shared.js';

/**
 * `ideaseek notify [test|list]` — the notification entry point (Phase 7):
 * `test` sends a probe through the real delivery path (user config →
 * local JSONL record → webhook when configured); `list` shows the recent
 * local delivery records. Enabled/disabled lives in the USER config —
 * the project never stores notification settings or secrets.
 */
export function registerNotifyCommand(program: Command): void {
  program
    .command('notify')
    .description('send a test notification or list recent local notification records')
    .argument('[action]', 'test (default) | list')
    .option('--json', 'machine-readable output')
    .action(
      action(async (actionName: string | undefined, opts: { json?: boolean }) => {
        const { findProjectRoot } = await import('../config/paths.js');
        const root = await findProjectRoot(process.cwd());
        if (!root) {
          throw new IdeaseekError(
            'NOT_INITIALIZED',
            'no IdeaSeek project here; run: ideaseek init',
          );
        }

        if (actionName === 'list') {
          const { listNotifications } = await import('../runtime/notify.js');
          const records = await listNotifications(root, 10);
          if (opts.json) {
            process.stdout.write(jsonLine({ count: records.length, notifications: records }));
            return 0;
          }
          if (records.length === 0) {
            process.stdout.write('no notifications recorded yet\n');
            return 0;
          }
          process.stdout.write(`${records.length} notification(s), newest first:\n`);
          for (const record of records) {
            process.stdout.write(
              `  ${new Date(record.ts).toISOString()} [${record.kind}] ${record.title}` +
                ` — ${record.delivery}${record.webhookDetail ? ` (${record.webhookDetail})` : ''}\n`,
            );
          }
          return 0;
        }

        if (actionName !== undefined && actionName !== 'test') {
          throw new IdeaseekError(
            'INVALID_ARGUMENT',
            `unknown notify action "${actionName}" — use test or list`,
          );
        }
        const { notifyUser } = await import('../runtime/notify.js');
        const result = await notifyUser(root, {
          kind: 'test',
          title: 'IdeaSeek test notification',
          summary: `test notification from ${root}`,
        });
        if (opts.json) {
          process.stdout.write(
            jsonLine({ sent: result.sent, reason: result.reason, record: result.record }),
          );
          return 0;
        }
        if (result.sent) {
          process.stdout.write(
            `notification ${result.reason === 'recorded' ? 'recorded locally' : `delivered (${result.reason})`}\n`,
          );
          process.stdout.write('next: ideaseek notify list\n');
        } else {
          process.stdout.write(
            'notifications disabled — set notifications.enabled: true in ~/.ideaseek/config.yaml\n',
          );
        }
        return 0;
      }),
    );
}
