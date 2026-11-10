import type { Command } from 'commander';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { writeFileAtomic } from '../core/atomic.js';
import { projectPaths } from '../config/paths.js';
import { findProjectRoot } from '../config/paths.js';
import { strategyWording } from '../workflow/strategy.js';
import { action, jsonLine } from './shared.js';
import type { RunEvent, RunRecord, TaskRecord } from '../workflow/types.js';
import { ProjectRuntime } from '../workflow/runtime.js';

function iso(ms: number | null): string {
  return ms ? new Date(ms).toISOString() : '—';
}

function renderReport(
  run: RunRecord,
  tasks: TaskRecord[],
  events: RunEvent[],
  projectName: string,
): string {
  const wording = strategyWording(run.strategy);
  const counts = new Map<string, number>();
  for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  const failed = tasks.filter((task) => task.status === 'failed');
  const succeeded = tasks.filter((task) => task.status === 'succeeded');

  const lines: string[] = [
    `# IdeaSeek Run Report — ${run.runId}`,
    '',
    `- project: ${projectName}`,
    `- question: ${run.question}`,
    `- strategy: **${run.strategy}** — ${wording.label}`,
    `- status: ${run.status} · phase: ${run.phase}`,
    `- created: ${iso(run.createdAt)} · finished: ${iso(run.finishedAt)}`,
    `- tasks: ${tasks.length} total · ${counts.get('succeeded') ?? 0} succeeded · ${counts.get('failed') ?? 0} failed · ${counts.get('canceled') ?? 0} canceled · ${counts.get('queued') ?? 0} queued`,
    `- events: ${events.length} persisted (replay with \`ideaseek events --run ${run.runId}\`)`,
    '',
    '## Strategy wording',
    '',
    wording.disclaimer,
    '',
    '## Tasks',
    '',
    '| task | type | status | attempt | finished |',
    '| --- | --- | --- | --- | --- |',
    ...tasks.map(
      (task) =>
        `| \`${task.taskId}\` | ${task.type} | ${task.status} | ${task.attempt}/${task.maxAttempts} | ${iso(task.finishedAt)} |`,
    ),
    '',
    '## Failures',
    '',
    ...(failed.length === 0
      ? ['_none_']
      : failed.map(
          (task) =>
            `- \`${task.taskId}\` ${task.type}: ${task.error?.code ?? 'UNKNOWN'} — ${task.error?.message ?? ''}`,
        )),
    '',
    '## Completed outputs',
    '',
    ...(succeeded.length === 0
      ? ['_none_']
      : succeeded.map((task) => {
          const refs = task.result?.artifacts.join(', ') ?? '';
          return `- \`${task.taskId}\` ${task.type}: ${task.result?.summary ?? 'committed'}${refs ? ` (artifacts: ${refs})` : ''}`;
        })),
    '',
    '## Provenance',
    '',
    `- run id: ${run.runId}`,
    `- config snapshot: stored inside the run record (config_version ${String(run.config.configVersion ?? 'unknown')})`,
    `- every statement above is derived from persisted tasks/events; no model-generated claims are included in Phase 0 reports.`,
    '',
  ];
  return lines.join('\n');
}

export function registerReportCommand(program: Command): void {
  program
    .command('report')
    .description('render a factual run report with strategy-appropriate wording')
    .option('--run <runId>', 'run id (default: latest)')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { run?: string; json?: boolean }) => {
        const root = await findProjectRoot(process.cwd());
        if (!root) {
          throw new IdeaseekError(
            'NOT_INITIALIZED',
            'no IdeaSeek project here; run: ideaseek init',
          );
        }
        const paths = projectPaths(root);
        const runtime = await ProjectRuntime.open({ cwd: process.cwd() });
        try {
          const run = opts.run
            ? await runtime.db.getRun(opts.run)
            : await runtime.db.getLatestRun(runtime.project.id);
          if (!run) {
            if (opts.json) {
              process.stdout.write(jsonLine({ run: null, reportPath: null }));
            } else {
              process.stdout.write('尚无 run 可生成报告；先执行 ideaseek run --question "..."\n');
            }
            return 0;
          }
          const tasks = await runtime.db.listTasks(run.runId);
          const events = await runtime.db.listEvents(run.runId, { limit: 10_000 });
          const content = renderReport(run, tasks, events, runtime.project.name);
          const reportPath = join(paths.reportsDir, `${run.runId}.md`);
          await writeFileAtomic(reportPath, content);

          if (opts.json) {
            process.stdout.write(
              jsonLine({
                run: { runId: run.runId, status: run.status, strategy: run.strategy },
                reportPath,
                tasks: tasks.length,
                events: events.length,
                wording: strategyWording(run.strategy),
              }),
            );
            return 0;
          }
          process.stdout.write(content);
          process.stdout.write(`\nreport written: ${reportPath}\n`);
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );
}
