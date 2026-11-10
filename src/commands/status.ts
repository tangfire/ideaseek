import type { Command } from 'commander';
import { ProjectRuntime } from '../workflow/runtime.js';
import type { RunRecord } from '../workflow/types.js';
import { action, countByStatus, formatTaskLine, jsonLine, resolveRun } from './shared.js';

/** Exit codes reflect run state (docs/CLI_SPEC.md). */
export function exitCodeForRun(run: RunRecord | null): number {
  if (!run) return 0;
  switch (run.status) {
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
    default:
      return 3; // RUNNING / PAUSED still have work
  }
}

function timestamp(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('show run state, task progress, workers and recent events')
    .option('--run <runId>', 'specific run id')
    .option('--detail', 'per-task lines and more events')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { run?: string; detail?: boolean; json?: boolean }) => {
        const runtime = await ProjectRuntime.open({ cwd: process.cwd() });
        try {
          const run = await resolveRun(runtime, opts.run);
          const tasks = await runtime.db.listTasks(run.runId);
          const counts = countByStatus(tasks);
          const workers = await runtime.db.listWorkers(run.runId);
          const cutoff = runtime.clock.now() - runtime.config.runtime.leaseTtlSeconds * 3000;
          const liveWorkers = workers.filter((worker) => worker.heartbeatAt >= cutoff);
          const events = await runtime.db.listEvents(run.runId, {
            limit: opts.detail ? 20 : 5,
          });
          const failed = tasks.filter((task) => task.status === 'failed');
          const total = tasks.length;
          const done = counts.succeeded ?? 0;

          if (opts.json) {
            process.stdout.write(
              jsonLine({
                project: runtime.project.name,
                run: {
                  runId: run.runId,
                  status: run.status,
                  phase: run.phase,
                  question: run.question,
                  blockReason: run.blockReason,
                  createdAt: run.createdAt,
                  finishedAt: run.finishedAt,
                },
                tasks: counts,
                total,
                liveWorkers: liveWorkers.length,
                failed: failed.map((task) => ({
                  taskId: task.taskId,
                  type: task.type,
                  error: task.error,
                })),
                recovery: runtime.recovery,
                events: events.map((event) => ({
                  seq: event.seq,
                  ts: event.ts,
                  type: event.eventType,
                  object: event.objectId,
                  summary: event.summary,
                })),
                exitCode: exitCodeForRun(run),
              }),
            );
            return exitCodeForRun(run);
          }

          process.stdout.write(`项目：${runtime.project.name}\n`);
          process.stdout.write(`Run：${run.runId}  状态：${run.status}  阶段：${run.phase}\n`);
          process.stdout.write(
            `任务：${done}/${total} 完成 · 排队 ${counts.queued ?? 0} · 执行中 ${(counts.leased ?? 0) + (counts.running ?? 0) + (counts.committing ?? 0)} · 失败 ${counts.failed ?? 0} · 取消 ${counts.canceled ?? 0}\n`,
          );
          process.stdout.write(`活动 Worker：${liveWorkers.length}\n`);
          if (run.blockReason) process.stdout.write(`阻塞原因：${run.blockReason}\n`);
          if (runtime.recovery.resumedCommits.length || runtime.recovery.reclaimedLeases.length) {
            process.stdout.write(
              `本次启动恢复：reclaimed=${runtime.recovery.reclaimedLeases.length} resumedCommits=${runtime.recovery.resumedCommits.length} stoppedWorkers=${runtime.recovery.stoppedWorkers.length}\n`,
            );
          }
          if (failed.length > 0) {
            process.stdout.write('失败任务：\n');
            for (const task of failed) {
              process.stdout.write(
                `  ${task.taskId} ${task.type} ${task.error ? `${task.error.code}: ${task.error.message}` : ''}\n`,
              );
            }
          }
          process.stdout.write('最近事件：\n');
          for (const event of events) {
            process.stdout.write(
              `  [#${event.seq}] ${timestamp(event.ts)}  ${event.eventType.padEnd(20)} ${event.summary}\n`,
            );
          }
          if (opts.detail) {
            process.stdout.write('任务明细：\n');
            for (const task of tasks) process.stdout.write(`${formatTaskLine(task)}\n`);
          }
          return exitCodeForRun(run);
        } finally {
          await runtime.close();
        }
      }),
    );
}
