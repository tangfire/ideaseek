import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { action, jsonLine } from './shared.js';
import { collectPendingApprovals } from '../approval/pending.js';

/**
 * `ideaseek pending` — lists the approvals waiting on the user (protocol
 * lock, baseline code revisions, pending-approval Decisions) with the exact
 * command that resolves each one. Exit 0 when nothing waits, 2 when items
 * are pending (scriptable, like `next`'s advice codes). The REPL renders
 * the same list as a confirmation block.
 */
export function registerPendingCommand(program: Command): void {
  program
    .command('pending')
    .description('list approvals waiting for you and the command that resolves each')
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
        const items = await collectPendingApprovals(root);
        if (opts.json) {
          process.stdout.write(jsonLine({ pending: items.length, items }));
          return items.length > 0 ? 2 : 0;
        }
        if (items.length === 0) {
          process.stdout.write('nothing waiting for approval\n');
          return 0;
        }
        process.stdout.write(`${items.length} item(s) waiting for approval:\n`);
        for (const [index, item] of items.entries()) {
          process.stdout.write(`  [${index + 1}] ${item.kind.padEnd(9)} ${item.summary}\n`);
          process.stdout.write(
            item.approve
              ? `      → ideaseek ${item.approve.cliArgs.join(' ')}\n`
              : '      → review: ideaseek events · apply with the equivalent command --confirm · reject: ideaseek reject <reason>\n',
          );
        }
        process.stdout.write(
          'next: run the → command above · in the REPL: /approve [n] · /reject <reason>\n',
        );
        return 2;
      }),
    );
}
