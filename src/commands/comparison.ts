import type { Command } from 'commander';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { ensureDir, writeFileAtomic } from '../core/atomic.js';
import { findProjectRoot } from '../config/paths.js';
import { stringify } from 'yaml';
import { importComparisonRepo } from '../comparison/importer.js';
import {
  COMPARISON_TRANSITIONS,
  assertTransition,
  validateComparisonMethod,
  type ComparisonMethod,
  type ComparisonStatus,
} from '../comparison/types.js';

import { action, jsonLine } from './shared.js';

async function openRuntime(root: string) {
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  return ProjectRuntime.open({ cwd: root });
}

async function openRoot(): Promise<string> {
  const root = await findProjectRoot(process.cwd());
  if (!root) {
    throw new IdeaseekError('NOT_INITIALIZED', 'no IdeaSeek project here; run: ideaseek init');
  }
  return root;
}

/** DB is authoritative; this keeps the human-readable export in sync. */
async function exportMethodYaml(root: string, method: ComparisonMethod): Promise<string> {
  const dir = join(root, 'comparisons', method.methodId);
  await ensureDir(dir);
  const path = join(dir, 'method.yaml');
  await writeFileAtomic(path, stringify(method, { lineWidth: 100 }));
  return path;
}

function toMethod(record: Record<string, unknown>): ComparisonMethod {
  return record as unknown as ComparisonMethod;
}

export function registerComparisonCommand(program: Command): void {
  const comparison = program
    .command('comparison')
    .description('comparison methods: import, inspect, transition and smoke-test');

  comparison
    .command('import')
    .description(
      'anonymous-clone a public repo into comparisons/<id> with upstream/worktree isolation',
    )
    .argument('<methodId>', 'kebab-case method id')
    .argument('<url>', 'public HTTPS git URL (credentials are never provided)')
    .option('--branch <branch>', 'branch/tag to shallow-clone')
    .option('--reference-only', 'register as reference-only (default is required for the gate)')
    .option(
      '--paper <ref>',
      'paper reference (repeatable)',
      (value, prev: string[]) => [...prev, value],
      [] as string[],
    )
    .option('--source <kind>', 'user | official-code | paper-reimplementation', 'official-code')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (
          methodId: string,
          url: string,
          opts: {
            branch?: string;
            referenceOnly?: boolean;
            paper?: string[];
            source?: string;
            json?: boolean;
          },
        ) => {
          const root = await openRoot();
          if (!['user', 'official-code', 'paper-reimplementation'].includes(opts.source ?? '')) {
            throw new IdeaseekError(
              'INVALID_ARGUMENT',
              '--source must be user | official-code | paper-reimplementation',
            );
          }
          const imported = await importComparisonRepo(root, {
            methodDir: `comparisons/${methodId}`,
            url,
            branch: opts.branch,
          });
          const now = Date.now();
          const method: ComparisonMethod = {
            methodId,
            paperRefs: opts.paper ?? [],
            required: opts.referenceOnly !== true,
            sourceKind: opts.source as ComparisonMethod['sourceKind'],
            repo: {
              url,
              branch: opts.branch,
              commit: imported.commit,
              license: imported.license,
              clonedAt: now,
            },
            status: 'source-resolved',
            statusReason: 'imported with upstream + worktree isolation',
            notes: ['cloned anonymously; upstream is read-only, edits go to worktree/'],
            createdAt: now,
            updatedAt: now,
          };
          const errors = validateComparisonMethod(method);
          if (!errors.ok) {
            throw new IdeaseekError(
              'INVALID_ARGUMENT',
              `invalid method: ${errors.errors.join('; ')}`,
            );
          }
          const record = method as unknown as Record<string, unknown>;
          const rt = await openRuntime(root);
          try {
            await rt.db.upsertComparison({
              methodId,
              status: method.status,
              required: method.required,
              record,
              updatedAt: now,
            });
          } finally {
            await rt.close();
          }
          const yamlPath = await exportMethodYaml(root, method);
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                methodId,
                status: method.status,
                commit: imported.commit,
                license: imported.license,
                upstream: imported.upstreamDir,
                worktree: imported.worktreeDir,
                methodYaml: yamlPath,
              }),
            );
          } else {
            process.stdout.write(
              `imported ${methodId} @ ${imported.commit.slice(0, 10)} (${method.sourceKind}${method.required ? ', required' : ', reference-only'})\n`,
            );
            process.stdout.write(`  upstream: ${imported.upstreamDir} (read-only)\n`);
            process.stdout.write(`  worktree: ${imported.worktreeDir} (edits go here)\n`);
            process.stdout.write(`  license: ${imported.license ?? 'none found'}\n`);
            process.stdout.write(`  method: ${yamlPath}\n`);
            process.stdout.write('next: ideaseek comparison smoke ' + methodId + '\n');
          }
          return 0;
        },
      ),
    );

  comparison
    .command('list')
    .description('list registered comparison methods')
    .option('--required', 'only required methods')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { required?: boolean; json?: boolean }) => {
        const root = await openRoot();
        const runtime = await openRuntime(root);
        try {
          const methods = await runtime.db.listComparisons(
            opts.required === undefined ? {} : { required: opts.required },
          );
          if (opts.json) {
            process.stdout.write(jsonLine({ methods }));
            return 0;
          }
          if (methods.length === 0) {
            process.stdout.write(
              'no comparison methods registered (ideaseek comparison import <id> <url>)\n',
            );
            return 0;
          }
          process.stdout.write(`${methods.length} comparison method(s):\n`);
          for (const method of methods) {
            const record = toMethod(method.record);
            process.stdout.write(
              `  ${method.methodId}  ${method.status.padEnd(16)} ${method.required ? 'required' : 'reference-only'}  ${record.sourceKind ?? '?'}${record.repo?.commit ? `  @ ${String(record.repo.commit).slice(0, 10)}` : ''}\n`,
            );
          }
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );

  comparison
    .command('set-status')
    .description('transition a method through the comparison state machine')
    .argument('<methodId>', 'method id')
    .argument('<status>', 'target status')
    .option('--reason <text>', 'required for excluded/blocked/partial')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (methodId: string, status: string, opts: { reason?: string; json?: boolean }) => {
          const root = await openRoot();
          if (!(status in COMPARISON_TRANSITIONS)) {
            throw new IdeaseekError(
              'INVALID_ARGUMENT',
              `unknown status "${status}" (valid: ${Object.keys(COMPARISON_TRANSITIONS).join(', ')})`,
            );
          }
          const runtime = await openRuntime(root);
          try {
            const before = await runtime.db.getComparison(methodId);
            if (!before) {
              throw new IdeaseekError('TASK_NOT_FOUND', `comparison ${methodId} not found`);
            }
            const after = await runtime.db.transitionComparison(methodId, status, opts.reason);
            // Keep the directory export in sync with the authoritative record.
            await exportMethodYaml(root, toMethod(after.record));
            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  methodId,
                  from: before.status,
                  to: after.status,
                  reason: opts.reason ?? null,
                }),
              );
            } else {
              process.stdout.write(
                `${methodId}: ${before.status} → ${after.status}${opts.reason ? ` (${opts.reason})` : ''}\n`,
              );
            }
            return 0;
          } finally {
            await runtime.close();
          }
        },
      ),
    );

  comparison
    .command('smoke')
    .description('run the method smoke command inside its worktree (isolation test)')
    .argument('<methodId>', 'method id')
    .option('--timeout <ms>', 'bound on the smoke command', (value) => Number(value))
    .option('--json', 'machine-readable output')
    .action(
      action(async (methodId: string, opts: { timeout?: number; json?: boolean }) => {
        const root = await openRoot();
        const runtime = await openRuntime(root);
        try {
          const doc = await runtime.db.getComparison(methodId);
          if (!doc) throw new IdeaseekError('TASK_NOT_FOUND', `comparison ${methodId} not found`);
          const method = toMethod(doc.record);
          const worktreeDir = join(root, 'comparisons', methodId, 'worktree');
          const command: string[] = Array.isArray(method.entry)
            ? method.entry
            : typeof method.entry === 'string' && method.entry.trim()
              ? method.entry.trim().split(/\s+/)
              : ['python', '--version'];
          const timeoutMs = Number.isFinite(opts.timeout) ? (opts.timeout as number) : 120_000;

          const { spawn } = await import('node:child_process');
          const started = Date.now();
          const outcome = await new Promise<{ code: number; out: string }>((resolve, reject) => {
            let child;
            try {
              child = spawn(command[0]!, command.slice(1), {
                cwd: worktreeDir,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
              });
            } catch (error) {
              reject(new IdeaseekError('ENV_UNSUPPORTED', String(error)));
              return;
            }
            let out = '';
            child.stdout?.on('data', (chunk) => (out += String(chunk)));
            child.stderr?.on('data', (chunk) => (out += String(chunk)));
            const timer = setTimeout(() => {
              child.kill('SIGKILL');
              resolve({ code: -1, out: `${out}\n[smoke timed out after ${timeoutMs}ms]` });
            }, timeoutMs);
            child.on('error', (error) => {
              clearTimeout(timer);
              resolve({ code: -1, out: `${out}\n[spawn failed: ${error.message}]` });
            });
            child.on('close', (code) => {
              clearTimeout(timer);
              resolve({ code: code ?? -1, out });
            });
          });

          const durationMs = Date.now() - started;
          const passed = outcome.code === 0;
          const tail = outcome.out.slice(-1500);
          const { ensureDir } = await import('../core/atomic.js');
          const { writeFile } = await import('node:fs/promises');
          const logPath = join(root, '.research', 'logs', `smoke-${methodId}.log`);
          await ensureDir(join(root, '.research', 'logs'));
          await writeFile(
            logPath,
            `$ ${command.join(' ')}\n(exit ${outcome.code})\n\n${outcome.out}`,
            'utf8',
          );

          const smoke = {
            passed,
            at: Date.now(),
            durationMs,
            tail,
            command,
          };
          // Enforce the state machine on smoke outcomes: a pass advances to
          // smoke-tested only when the graph allows it (e.g. from implemented/
          // repairing; a fresh source-resolved import keeps its status with the
          // smoke evidence recorded). A failing re-smoke of a tested method
          // falls back to repairing; anything else keeps its status (failure is
          // recorded in smoke/statusReason without a silent skip).
          const from = method.status as ComparisonStatus;
          const to: ComparisonStatus = passed
            ? COMPARISON_TRANSITIONS[from].includes('smoke-tested')
              ? 'smoke-tested'
              : from
            : from === 'smoke-tested'
              ? 'repairing'
              : from;
          const failReason = `smoke failed (exit ${outcome.code}); log: ${logPath}`;
          if (to !== from) {
            assertTransition(from, to, passed ? undefined : failReason);
          }
          const now = Date.now();
          const history = Array.isArray(method.history) ? [...method.history] : [];
          if (to !== from) {
            history.push({ at: now, from, to, reason: passed ? null : failReason });
          }
          const record: ComparisonMethod = {
            ...method,
            smoke,
            status: to,
            statusReason: passed ? (to === from ? method.statusReason : undefined) : failReason,
            history,
            updatedAt: now,
          };
          const validation = validateComparisonMethod(record);
          if (!validation.ok) {
            throw new IdeaseekError(
              'INVALID_ARGUMENT',
              `smoke produced invalid method record: ${validation.errors.join('; ')}`,
            );
          }
          const updated = {
            ...doc,
            status: record.status,
            record: record as unknown as Record<string, unknown>,
            updatedAt: record.updatedAt,
          };
          await runtime.db.upsertComparison(updated);
          await exportMethodYaml(root, record);

          if (opts.json) {
            process.stdout.write(
              jsonLine({
                methodId,
                passed,
                exitCode: outcome.code,
                durationMs,
                status: record.status,
                logPath,
              }),
            );
          } else {
            process.stdout.write(
              `smoke ${methodId}: ${passed ? 'PASSED' : 'FAILED'} (exit ${outcome.code}, ${durationMs}ms) → status ${record.status}\n`,
            );
            process.stdout.write(`  log: ${logPath}\n`);
          }
          return passed ? 0 : 1;
        } finally {
          await runtime.close();
        }
      }),
    );
}
