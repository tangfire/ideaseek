import type { Command } from 'commander';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import {
  assertWorktree,
  collectWorktreeDiff,
  executeRepair,
  parseEntryCommand,
  repairStore,
} from '../comparison/repair.js';
import type {
  ComparisonMethod,
  ComparisonStatus,
  RepairRecord,
  RepairSummary,
} from '../comparison/types.js';
import { exportMethodYaml } from './comparison.js';
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

function toMethod(record: Record<string, unknown>): ComparisonMethod {
  return record as unknown as ComparisonMethod;
}

/** Statuses a repair session may start from (graph-legal entry points). */
const REPAIRABLE: readonly ComparisonStatus[] = [
  'implemented',
  'repairing',
  'blocked',
  'smoke-tested',
];

function resolveEntry(method: ComparisonMethod, override?: string): string[] {
  if (override) {
    const parsed = parseEntryCommand(override);
    if (parsed.length === 0) {
      throw new IdeaseekError('INVALID_ARGUMENT', '--entry resolved to an empty command');
    }
    return parsed;
  }
  if (Array.isArray(method.entry) && method.entry.length > 0) return method.entry;
  if (typeof method.entry === 'string' && method.entry.trim()) {
    const parsed = parseEntryCommand(method.entry);
    if (parsed.length > 0) return parsed;
  }
  throw new IdeaseekError(
    'INVALID_ARGUMENT',
    `method has no entry command; pass --entry "python train.py" (persisted for later runs)`,
  );
}

/**
 * `ideaseek baseline repair --method <id>` — deterministic repair loop in the
 * method's isolated worktree (docs/CLI_SPEC, plan §C.5–C.7). Classifies
 * failures, applies only safe environment fixes within a round budget, keeps
 * upstream read-only, and gates code diffs behind user confirmation.
 */
export function registerBaselineCommand(program: Command): void {
  const baseline = program.command('baseline').description('baseline repair and reproduction');

  baseline
    .command('repair')
    .description('diagnose and safely repair a method entry inside its worktree')
    .requiredOption('--method <methodId>', 'comparison method id')
    .option('--entry <cmd>', 'entry command (quoted argv string; persisted to the method)')
    .option('--rounds <n>', 'max repair rounds (1-10)', (value) => Number(value), 3)
    .option('--timeout <ms>', 'per-round command timeout', (value) => Number(value), 120_000)
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (opts: {
          method: string;
          entry?: string;
          rounds: number;
          timeout: number;
          json?: boolean;
        }) => {
          const root = await openRoot();
          if (!Number.isFinite(opts.rounds) || opts.rounds < 1 || opts.rounds > 10) {
            throw new IdeaseekError('INVALID_ARGUMENT', '--rounds must be between 1 and 10');
          }
          if (!Number.isFinite(opts.timeout) || opts.timeout < 100) {
            throw new IdeaseekError('INVALID_ARGUMENT', '--timeout must be >= 100 ms');
          }
          const runtime = await openRuntime(root);
          try {
            const doc = await runtime.db.getComparison(opts.method);
            if (!doc) {
              throw new IdeaseekError('TASK_NOT_FOUND', `comparison ${opts.method} not found`);
            }
            const method = toMethod(doc.record);
            if (!REPAIRABLE.includes(method.status)) {
              throw new IdeaseekError(
                'INVALID_STATE',
                `cannot repair ${opts.method} from status ${method.status}; run: ideaseek comparison set-status ${opts.method} implemented`,
                { status: method.status },
              );
            }
            const entry = resolveEntry(method, opts.entry);
            const worktreeDir = join(root, 'comparisons', opts.method, 'worktree');
            await assertWorktree(worktreeDir);

            const now = Date.now();
            // Persist an explicit --entry so later runs (and smoke) reuse it.
            if (opts.entry) {
              const withEntry: ComparisonMethod = { ...method, entry, updatedAt: now };
              await runtime.db.upsertComparison({
                methodId: opts.method,
                status: withEntry.status,
                required: withEntry.required,
                record: withEntry as unknown as Record<string, unknown>,
                updatedAt: now,
              });
            }

            // Uniform session start: everything below runs from `repairing`.
            const current = opts.method;
            /** Keeps the human-readable method.yaml in sync with the DB. */
            const syncYaml = async () => {
              const finalDoc = await runtime.db.getComparison(current);
              if (finalDoc) await exportMethodYaml(root, toMethod(finalDoc.record));
            };
            if (method.status !== 'repairing') {
              await runtime.db.transitionComparison(
                current,
                'repairing',
                'baseline repair session started',
              );
            }

            const result = await executeRepair({
              projectRoot: root,
              methodId: current,
              worktreeDir,
              entry,
              maxRounds: opts.rounds,
              timeoutMs: opts.timeout,
              store: repairStore(root, current),
            });

            const attempts = result.record.attempts;
            const diff = await collectWorktreeDiff(worktreeDir).catch(() => ({
              paths: [] as string[],
              patchHash: null,
              changeClass: 'none' as const,
            }));
            const baseSummary = {
              attempts: attempts.length,
              lastFailureKind: result.lastFailure?.kind ?? null,
              patchHash: diff.patchHash,
              changeClass: diff.changeClass,
              updatedAt: Date.now(),
            };

            if (result.outcome === 'passed') {
              if (diff.changeClass === 'code-review') {
                // plan §C.7: code diffs are never accepted as the baseline
                // automatically — record and ask the user.
                const summary: RepairSummary = {
                  ...baseSummary,
                  outcome: 'confirmation-required',
                };
                const docNow = await runtime.db.getComparison(current);
                const rec = toMethod(docNow!.record);
                await runtime.db.upsertComparison({
                  methodId: current,
                  status: rec.status,
                  required: rec.required,
                  record: {
                    ...rec,
                    repair: summary,
                    statusReason: `repair passed; code changes need review: ${diff.paths.slice(0, 5).join(', ')}`,
                    updatedAt: summary.updatedAt,
                  } as unknown as Record<string, unknown>,
                  updatedAt: summary.updatedAt,
                });
                await syncYaml();
                if (opts.json) {
                  process.stdout.write(
                    jsonLine({
                      methodId: current,
                      outcome: summary.outcome,
                      status: rec.status,
                      attempts: summary.attempts,
                      changeClass: summary.changeClass,
                      patchHash: summary.patchHash,
                      changedFiles: diff.paths,
                      requiresConfirmation: true,
                    }),
                  );
                } else {
                  printRounds(attempts);
                  process.stdout.write(
                    `repair ${current}: PASSED with code changes requiring confirmation (${attempts.length} round(s))\n`,
                  );
                  process.stdout.write(`  changed: ${diff.paths.slice(0, 8).join(', ')}\n`);
                  process.stdout.write(
                    `next: ideaseek comparison set-status ${current} smoke-tested --reason "user accepted code revision"\n`,
                  );
                }
                return 0;
              }
              const summary: RepairSummary = { ...baseSummary, outcome: 'smoke-tested' };
              const docNow = await runtime.db.getComparison(current);
              const rec = toMethod(docNow!.record);
              await runtime.db.upsertComparison({
                methodId: current,
                status: rec.status,
                required: rec.required,
                record: {
                  ...rec,
                  repair: summary,
                  statusReason: undefined,
                  updatedAt: summary.updatedAt,
                } as unknown as Record<string, unknown>,
                updatedAt: summary.updatedAt,
              });
              await runtime.db.transitionComparison(current, 'smoke-tested');
              await syncYaml();
              if (opts.json) {
                process.stdout.write(
                  jsonLine({
                    methodId: current,
                    outcome: summary.outcome,
                    status: 'smoke-tested',
                    attempts: summary.attempts,
                    changeClass: summary.changeClass,
                    patchHash: summary.patchHash,
                    requiresConfirmation: false,
                  }),
                );
              } else {
                printRounds(attempts);
                process.stdout.write(
                  `repair ${current}: PASSED → smoke-tested (${attempts.length} round(s), change=${summary.changeClass})\n`,
                );
                process.stdout.write(
                  `next: ideaseek comparison set-status ${current} evaluated ...\n`,
                );
              }
              return 0;
            }

            // blocked-* outcomes: record diagnosis, transition to blocked.
            const reason = truncateReason(
              `repair ${result.outcome}: ${result.lastFailure?.kind ?? 'unknown'} - ${result.lastFailure?.summary ?? 'no diagnosis'}`,
            );
            const summary: RepairSummary = { ...baseSummary, outcome: 'blocked' };
            const docNow = await runtime.db.getComparison(current);
            const rec = toMethod(docNow!.record);
            await runtime.db.upsertComparison({
              methodId: current,
              status: rec.status,
              required: rec.required,
              record: {
                ...rec,
                repair: summary,
                statusReason: reason,
                updatedAt: summary.updatedAt,
              } as unknown as Record<string, unknown>,
              updatedAt: summary.updatedAt,
            });
            if (rec.status === 'repairing') {
              await runtime.db.transitionComparison(current, 'blocked', reason);
            }
            await syncYaml();
            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  methodId: current,
                  outcome: summary.outcome,
                  repairOutcome: result.outcome,
                  status: 'blocked',
                  attempts: summary.attempts,
                  lastFailureKind: summary.lastFailureKind,
                  failureSummary: result.lastFailure?.summary ?? null,
                  changeClass: summary.changeClass,
                }),
              );
            } else {
              printRounds(attempts);
              process.stdout.write(
                `repair ${current}: BLOCKED after ${attempts.length} round(s) (${result.outcome})\n`,
              );
              process.stdout.write(
                `  diagnosis: ${summary.lastFailureKind ?? 'unknown'} - ${result.lastFailure?.summary ?? ''}\n`,
              );
              process.stdout.write(
                `  log: ${attempts[attempts.length - 1]?.logPath ?? '(none)'}\n`,
              );
              process.stdout.write(
                `next: fix the worktree, then rerun: ideaseek baseline repair --method ${current}\n`,
              );
            }
            return 1;
          } finally {
            await runtime.close();
          }
        },
      ),
    );
}

function printRounds(attempts: RepairRecord['attempts']): void {
  for (const attempt of attempts) {
    const failure = attempt.failureKind ?? 'ok';
    const fix = attempt.fixApplied === 'none' ? '' : ` fix=${attempt.fixApplied}`;
    const fixMark = attempt.fixOk === undefined ? '' : attempt.fixOk ? ' ok' : ' FAIL';
    process.stdout.write(
      `  r${attempt.round}  ${failure}${fix}${fixMark}  ${attempt.durationMs}ms  ${attempt.failureSummary ?? ''}\n`,
    );
  }
}

function truncateReason(reason: string): string {
  return reason.length > 400 ? `${reason.slice(0, 397)}...` : reason;
}
