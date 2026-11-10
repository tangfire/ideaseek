import type { Command } from 'commander';
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

interface PapersReport {
  indexed: number;
  pages: number;
  byParser: Record<string, number>;
  sources: string[];
  failures: { taskId: string; type: string; code: string; message: string }[];
}

/**
 * `ideaseek papers` — paper indexing progress and parse failures, read from
 * the knowledge index and the latest run's persisted task records.
 */
export async function buildPapersReport(root: string): Promise<PapersReport> {
  const runtime = await openRuntime(root);
  try {
    const papers = await runtime.db.listIndexedPapers();
    const byParser: Record<string, number> = {};
    let pages = 0;
    for (const paper of papers) {
      byParser[paper.parser] = (byParser[paper.parser] ?? 0) + 1;
      pages += paper.pageCount;
    }
    const latest = await runtime.db.getLatestRun(runtime.project.id);
    const failures: PapersReport['failures'] = [];
    if (latest) {
      const tasks = await runtime.db.listTasks(latest.runId);
      for (const task of tasks) {
        if (task.status !== 'failed') continue;
        if (!task.type.startsWith('paper.')) continue;
        failures.push({
          taskId: task.taskId,
          type: task.type,
          code: task.error?.code ?? 'FAILED',
          message: redactSecrets(task.error?.message ?? '').slice(0, 300),
        });
      }
    }
    return {
      indexed: papers.length,
      pages,
      byParser,
      sources: papers.map((paper) => paper.source).slice(0, 8),
      failures: failures.slice(-5),
    };
  } finally {
    await runtime.close();
  }
}

export function registerPapersCommand(program: Command): void {
  program
    .command('papers')
    .description('paper indexing progress and parse failures')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { json?: boolean }) => {
        const root = await openRoot();
        const report = await buildPapersReport(root);
        if (opts.json) {
          process.stdout.write(jsonLine(report));
          return report.failures.length > 0 ? 0 : 0;
        }
        const parsers = Object.entries(report.byParser)
          .map(([name, count]) => `${name}:${count}`)
          .join(' ');
        process.stdout.write(
          `papers: ${report.indexed} indexed · ${report.pages} pages${parsers ? ` (${parsers})` : ''}\n`,
        );
        if (report.sources.length > 0) {
          process.stdout.write(`sources: ${report.sources.join(', ')}\n`);
        }
        if (report.failures.length === 0) {
          process.stdout.write('parse failures: none\n');
        } else {
          process.stdout.write(`parse failures: ${report.failures.length}\n`);
          for (const failure of report.failures) {
            process.stdout.write(
              `  ${failure.taskId} ${failure.type} ${failure.code}: ${failure.message}\n`,
            );
          }
        }
        return 0;
      }),
    );
}
