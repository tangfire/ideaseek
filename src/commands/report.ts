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
    `- every statement above is derived from persisted tasks/events; the report adds no model-generated claims.`,
    '',
  ];
  return lines.join('\n');
}

/** Full structured mirror of the run report (no model-generated claims). */
export interface JsonRunReport {
  contract: 'run-report-v1';
  generatedAt: number;
  project: string;
  run: {
    runId: string;
    question: string;
    strategy: string;
    status: string;
    phase: string;
    createdAt: number;
    finishedAt: number | null;
    configVersion: unknown;
  };
  stats: Record<string, number>;
  tasks: {
    taskId: string;
    type: string;
    status: string;
    attempt: number;
    maxAttempts: number;
    error: { code: string; message: string } | null;
    summary: string | null;
    artifacts: string[];
  }[];
  events: {
    seq: number;
    phase: string;
    eventType: string;
    summary: string;
    status: string | null;
    ts: number;
  }[];
  references: { paperId: string; title: string; documentHash: string | null }[];
  provenance: { runId: string; statement: string };
}

export function buildJsonReport(
  run: RunRecord,
  tasks: TaskRecord[],
  events: RunEvent[],
  projectName: string,
  references: JsonRunReport['references'],
): JsonRunReport {
  const stats: Record<string, number> = {};
  for (const task of tasks) stats[task.status] = (stats[task.status] ?? 0) + 1;
  return {
    contract: 'run-report-v1',
    generatedAt: Date.now(),
    project: projectName,
    run: {
      runId: run.runId,
      question: run.question,
      strategy: run.strategy,
      status: run.status,
      phase: run.phase,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt ?? null,
      configVersion: (run.config as { configVersion?: unknown }).configVersion ?? null,
    },
    stats,
    tasks: tasks.map((task) => ({
      taskId: task.taskId,
      type: task.type,
      status: task.status,
      attempt: task.attempt,
      maxAttempts: task.maxAttempts,
      error: task.error ? { code: task.error.code, message: task.error.message } : null,
      summary: task.result?.summary ?? null,
      artifacts: task.result?.artifacts ?? [],
    })),
    events: events.map((event) => ({
      seq: event.seq,
      phase: event.phase,
      eventType: event.eventType,
      summary: event.summary,
      status: event.status,
      ts: event.ts,
    })),
    references,
    provenance: {
      runId: run.runId,
      statement:
        'derived entirely from persisted tasks/events/corpus cards; no model-generated claims are included',
    },
  };
}

/** BibTeX-safe field value (escapes LaTeX-special characters). */
export function escapeBibValue(value: string): string {
  return value
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([{}%&#_])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}');
}

/**
 * Run-report BibTeX: the run itself plus corpus paper cards. Authors /
 * years the extractor never captured are NOT invented — they land in
 * `note` for the researcher to complete before submission.
 */
export function buildBibtexReport(
  run: RunRecord,
  projectName: string,
  references: JsonRunReport['references'],
): string {
  const entries: string[] = [];
  entries.push(
    [
      `@misc{ideaseek-run-${run.runId.replace(/[^a-z0-9]+/gi, '')},`,
      `  title = {${escapeBibValue(`IdeaSeek run report: ${run.question}`)}},`,
      `  note = {Project ${escapeBibValue(projectName)}; run ${run.runId}; status ${run.status}; generated by IdeaSeek report --format bibtex},`,
      '}',
    ].join('\n'),
  );
  for (const ref of references) {
    entries.push(
      [
        `@misc{${escapeBibValue(ref.paperId)},`,
        `  title = {${escapeBibValue(ref.title)}},`,
        `  note = {IdeaSeek corpus paper card ${ref.paperId}` +
          `${ref.documentHash ? `; document ${ref.documentHash}` : ''}` +
          '; authors/year not extracted — complete before submission},',
        '}',
      ].join('\n'),
    );
  }
  return `${entries.join('\n\n')}\n`;
}

/** Reads corpus paper cards for the references section (title + hash only). */
export async function loadCorpusReferences(root: string): Promise<JsonRunReport['references']> {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join: joinPath } = await import('node:path');
  const dir = joinPath(root, 'knowledge', 'paper-cards');
  const refs: JsonRunReport['references'] = [];
  for (const name of (await readdir(dir).catch(() => [])).sort()) {
    if (!name.endsWith('.json')) continue;
    try {
      const payload = JSON.parse(await readFile(joinPath(dir, name), 'utf8')) as {
        card?: { title?: unknown; paper_id?: unknown; document_hash?: unknown };
      };
      const title = typeof payload.card?.title === 'string' ? payload.card.title : null;
      if (!title) continue;
      refs.push({
        paperId:
          typeof payload.card?.paper_id === 'string'
            ? payload.card.paper_id
            : name.replace(/\.json$/, ''),
        title,
        documentHash:
          typeof payload.card?.document_hash === 'string' ? payload.card.document_hash : null,
      });
    } catch {
      continue;
    }
  }
  return refs;
}

export function registerReportCommand(program: Command): void {
  program
    .command('report')
    .description('render a factual run report (md | json | bibtex export)')
    .option('--run <runId>', 'run id (default: latest)')
    .option('--format <format>', 'report format: md | json | bibtex', 'md')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { run?: string; format?: string; json?: boolean }) => {
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
          const format = (opts.format ?? 'md').toLowerCase();
          if (!['md', 'json', 'bibtex'].includes(format)) {
            throw new IdeaseekError(
              'INVALID_ARGUMENT',
              `--format must be md | json | bibtex (got "${format}")`,
            );
          }

          if (format === 'json') {
            const references = await loadCorpusReferences(root);
            const report = buildJsonReport(run, tasks, events, runtime.project.name, references);
            const reportPath = join(paths.reportsDir, `${run.runId}.json`);
            await writeFileAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  run: { runId: run.runId, status: run.status, strategy: run.strategy },
                  format,
                  reportPath,
                  tasks: tasks.length,
                  events: events.length,
                  references: references.length,
                  report,
                }),
              );
              return 0;
            }
            process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
            process.stdout.write(`\nreport written: ${reportPath}\n`);
            return 0;
          }

          if (format === 'bibtex') {
            const references = await loadCorpusReferences(root);
            const bib = buildBibtexReport(run, runtime.project.name, references);
            const reportPath = join(paths.reportsDir, `${run.runId}.bib`);
            await writeFileAtomic(reportPath, bib);
            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  run: { runId: run.runId, status: run.status },
                  format,
                  reportPath,
                  references: references.length,
                }),
              );
              return 0;
            }
            process.stdout.write(bib);
            process.stdout.write(`\nbibliography written: ${reportPath}\n`);
            return 0;
          }

          const content = renderReport(run, tasks, events, runtime.project.name);
          const reportPath = join(paths.reportsDir, `${run.runId}.md`);
          await writeFileAtomic(reportPath, content);

          if (opts.json) {
            process.stdout.write(
              jsonLine({
                run: { runId: run.runId, status: run.status, strategy: run.strategy },
                format,
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
