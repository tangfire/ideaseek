import type { Command } from 'commander';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { redactSecrets } from '../core/redact.js';
import { action, jsonLine } from './shared.js';

async function openRuntime(root: string) {
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  return ProjectRuntime.open({ cwd: root });
}

async function openRoot(): Promise<string> {
  const { findProjectRoot } = await import('../config/paths.js');
  const root = await findProjectRoot(process.cwd());
  if (!root) {
    throw new IdeaseekError('NOT_INITIALIZED', 'no IdeaSeek project here; run: ideaseek init');
  }
  return root;
}

function tail(text: string, lines: number): string {
  const all = text.split(/\r?\n/);
  return all.slice(Math.max(0, all.length - lines)).join('\n');
}

/**
 * `ideaseek logs <taskId>` — task detail, persisted error/result and the
 * redacted tail of any matching file under .research/logs. This is the only
 * log viewer; `/logs` in the REPL relays it.
 */
export function registerLogsCommand(program: Command): void {
  program
    .command('logs')
    .description('task detail with redacted error and log tails')
    .argument('<taskId>', 'task id')
    .option('--tail <n>', 'log lines to show', (value) => Number(value), 40)
    .option('--json', 'machine-readable output')
    .action(
      action(async (taskId: string, opts: { tail: number; json?: boolean }) => {
        const root = await openRoot();
        const runtime = await openRuntime(root);
        try {
          const task = await runtime.db.getTask(taskId);
          if (!task) {
            throw new IdeaseekError('TASK_NOT_FOUND', `task ${taskId} not found`);
          }
          const artifacts = await runtime.db.listArtifacts(taskId);

          // Matching log files written by workers/repair under .research/logs.
          const logDir = join(root, '.research', 'logs');
          const logFiles: { name: string; tail: string }[] = [];
          try {
            const names = await readdir(logDir);
            for (const name of names) {
              if (!name.includes(taskId)) continue;
              const content = await readFile(join(logDir, name), 'utf8').catch(() => '');
              logFiles.push({ name, tail: redactSecrets(tail(content, opts.tail)) });
            }
          } catch {
            // no logs directory yet
          }

          const payload = {
            taskId: task.taskId,
            runId: task.runId,
            type: task.type,
            status: task.status,
            attempt: `${task.attempt}/${task.maxAttempts}`,
            error: task.error
              ? { code: task.error.code, message: redactSecrets(task.error.message) }
              : null,
            summary: task.result?.summary ? redactSecrets(task.result.summary) : null,
            artifacts: artifacts.map((artifact) => ({
              artifactId: artifact.artifactId,
              kind: artifact.kind,
              relPath: artifact.relPath,
              status: artifact.status,
            })),
            logs: logFiles,
          };

          if (opts.json) {
            process.stdout.write(jsonLine(payload));
            return 0;
          }
          process.stdout.write(
            `${task.taskId}  ${task.type}  ${task.status}  attempt=${payload.attempt}\n`,
          );
          if (payload.error) {
            process.stdout.write(`error: ${payload.error.code}: ${payload.error.message}\n`);
          }
          if (payload.summary) process.stdout.write(`result: ${payload.summary}\n`);
          if (payload.artifacts.length > 0) {
            process.stdout.write('artifacts:\n');
            for (const artifact of payload.artifacts) {
              process.stdout.write(`  ${artifact.kind} ${artifact.relPath} (${artifact.status})\n`);
            }
          }
          if (logFiles.length === 0) {
            process.stdout.write('log files: none matching this task\n');
          } else {
            for (const file of logFiles) {
              process.stdout.write(`log ${file.name} (tail):\n${file.tail}\n`);
            }
          }
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );
}
