import type { Command } from 'commander';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { ensureDir, writeFileAtomic } from '../core/atomic.js';
import { findProjectRoot } from '../config/paths.js';
import { stringify } from 'yaml';
import { importComparisonRepo } from '../comparison/importer.js';
import { buildCandidates } from '../comparison/discover.js';
import { evaluateComparisonGate } from '../comparison/gate.js';
import { assertAutonomy, parseAutonomyMode, recordDecision } from '../workflow/autonomy.js';
import {
  COMPARISON_TRANSITIONS,
  REASON_REQUIRED,
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
export async function exportMethodYaml(root: string, method: ComparisonMethod): Promise<string> {
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
    .argument(
      '[url]',
      'public HTTPS git URL (credentials are never provided; defaults to the registered --repo url)',
    )
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
          url: string | undefined,
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
          const rt = await openRuntime(root);
          let existing: Awaited<ReturnType<typeof rt.db.getComparison>> = null;
          try {
            existing = await rt.db.getComparison(methodId);
          } finally {
            await rt.close();
          }
          const cloneUrl = url ?? (existing?.record.repo as { url?: unknown } | undefined)?.url;
          if (typeof cloneUrl !== 'string' || !cloneUrl) {
            throw new IdeaseekError(
              'INVALID_ARGUMENT',
              'no repository url: pass one or register first (ideaseek comparison register <id> --repo <url>)',
            );
          }
          // Status discipline: a registered candidate/accepted record advances
          // through its legal hops to source-resolved; later-stage methods must
          // be moved back explicitly via set-status (no silent re-imports).
          if (existing && !['candidate', 'accepted', 'source-resolved'].includes(existing.status)) {
            throw new IdeaseekError(
              'INVALID_STATE',
              `cannot import ${methodId} from status ${existing.status}; use: ideaseek comparison set-status ${methodId} source-resolved`,
            );
          }
          const imported = await importComparisonRepo(root, {
            methodDir: `comparisons/${methodId}`,
            url: cloneUrl,
            branch: opts.branch,
          });
          const now = Date.now();
          const history: ComparisonMethod['history'] = existing
            ? [...((existing.record.history as ComparisonMethod['history']) ?? [])]
            : [];
          const from: ComparisonStatus = (existing?.status as ComparisonStatus) ?? 'candidate';
          // Record the legal hops a fresh/registered method walks on import.
          if (from === 'candidate') {
            history.push({
              at: now,
              from: 'candidate',
              to: 'accepted',
              reason: 'import approved',
            });
            history.push({
              at: now,
              from: 'accepted',
              to: 'source-resolved',
              reason: 'imported with upstream + worktree',
            });
          } else if (from === 'accepted') {
            history.push({
              at: now,
              from: 'accepted',
              to: 'source-resolved',
              reason: 'imported with upstream + worktree',
            });
          }
          const existingMethod = existing ? toMethod(existing.record) : null;
          const method: ComparisonMethod = {
            methodId,
            paperRefs: [...new Set([...(existingMethod?.paperRefs ?? []), ...(opts.paper ?? [])])],
            required: existingMethod?.required ?? opts.referenceOnly !== true,
            sourceKind:
              existingMethod?.sourceKind ?? (opts.source as ComparisonMethod['sourceKind']),
            repo: {
              url: cloneUrl,
              branch: opts.branch ?? existingMethod?.repo?.branch,
              commit: imported.commit,
              license: imported.license,
              licenseKind: imported.licenseKind,
              clonedAt: now,
            },
            status: 'source-resolved',
            statusReason: 'imported with upstream + worktree isolation',
            notes: [
              ...new Set([
                ...(existingMethod?.notes ?? []),
                'cloned anonymously; upstream is read-only, edits go to worktree/',
              ]),
            ],
            history,
            createdAt: existingMethod?.createdAt ?? now,
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
          const rt2 = await openRuntime(root);
          try {
            await rt2.db.upsertComparison({
              methodId,
              status: method.status,
              required: method.required,
              record,
              updatedAt: now,
            });
          } finally {
            await rt2.close();
          }
          const yamlPath = await exportMethodYaml(root, method);
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                methodId,
                status: method.status,
                commit: imported.commit,
                license: imported.license,
                licenseKind: imported.licenseKind,
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
            process.stdout.write(
              `  license: ${imported.license ?? 'none found'} (${imported.licenseKind})\n`,
            );
            process.stdout.write(`  method: ${yamlPath}\n`);
            process.stdout.write('next: ideaseek comparison smoke ' + methodId + '\n');
          }
          return 0;
        },
      ),
    );

  comparison
    .command('register')
    .description('register a candidate method without cloning (from discovery or user input)')
    .argument('<methodId>', 'kebab-case method id')
    .option('--repo <url>', 'recorded repository url (cloned later by comparison import)')
    .option(
      '--paper <ref>',
      'paper reference (repeatable)',
      (value, prev: string[]) => [...prev, value],
      [] as string[],
    )
    .option('--source <kind>', 'user | official-code | paper-reimplementation', 'official-code')
    .option('--reference-only', 'reference-only (default is required for the gate)')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (
          methodId: string,
          opts: {
            repo?: string;
            paper?: string[];
            source?: string;
            referenceOnly?: boolean;
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
          const now = Date.now();
          const method: ComparisonMethod = {
            methodId,
            paperRefs: opts.paper ?? [],
            required: opts.referenceOnly !== true,
            sourceKind: opts.source as ComparisonMethod['sourceKind'],
            ...(opts.repo ? { repo: { url: opts.repo } } : {}),
            status: 'candidate',
            notes: ['registered without clone; next: comparison import ' + methodId],
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
          const rt = await openRuntime(root);
          try {
            const existingDoc = await rt.db.getComparison(methodId);
            if (existingDoc) {
              throw new IdeaseekError(
                'ALREADY_INITIALIZED',
                `comparison ${methodId} already registered (status ${existingDoc.status})`,
              );
            }
            await rt.db.upsertComparison({
              methodId,
              status: method.status,
              required: method.required,
              record: method as unknown as Record<string, unknown>,
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
                required: method.required,
                repo: opts.repo ?? null,
                methodYaml: yamlPath,
              }),
            );
          } else {
            process.stdout.write(
              `registered ${methodId} (candidate${method.required ? ', required' : ', reference-only'})\n`,
            );
            process.stdout.write(`  method: ${yamlPath}\n`);
            process.stdout.write(
              `next: ideaseek comparison import ${methodId}${opts.repo ? '' : ' <url>'}\n`,
            );
          }
          return 0;
        },
      ),
    );

  comparison
    .command('discover')
    .description('scan indexed papers for repository urls (deterministic official-code candidates)')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { json?: boolean }) => {
        const root = await openRoot();
        const rt = await openRuntime(root);
        let mentions: Awaited<ReturnType<typeof rt.db.findRepoUrlMentions>>;
        try {
          mentions = await rt.db.findRepoUrlMentions();
        } finally {
          await rt.close();
        }
        const candidates = buildCandidates(mentions);
        const payload = {
          generatedAt: Date.now(),
          mentionCount: mentions.length,
          candidates,
        };
        const outPath = join(root, 'knowledge', 'comparison-candidates.json');
        await ensureDir(join(root, 'knowledge'));
        await writeFileAtomic(outPath, `${JSON.stringify(payload, null, 2)}\n`);
        if (opts.json) {
          process.stdout.write(jsonLine(payload));
          return 0;
        }
        if (candidates.length === 0) {
          process.stdout.write(
            'no repository urls found in indexed papers (run ideaseek ingest first)\n',
          );
          process.stdout.write(`  candidates: ${outPath}\n`);
          return 0;
        }
        process.stdout.write(
          `${candidates.length} candidate repo(s) from ${mentions.length} mention(s):\n`,
        );
        for (const candidate of candidates.slice(0, 20)) {
          process.stdout.write(
            `  ${candidate.repoUrl}  papers=${candidate.paperRefs.length} mentions=${candidate.mentions}\n`,
          );
        }
        process.stdout.write(`  candidates: ${outPath}\n`);
        process.stdout.write(
          'next: ideaseek comparison register <id> --repo <url> --paper <ref>\n',
        );
        return 0;
      }),
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
    .command('gate')
    .description(
      'required-comparison gate: every required method needs a runnable result before idea generation',
    )
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { json?: boolean }) => {
        const root = await openRoot();
        const runtime = await openRuntime(root);
        try {
          const gate = await evaluateComparisonGate(runtime.db);
          const { ok, required, passed, skipped, blocking, note } = gate;
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                ok,
                required,
                passed,
                skipped,
                blocking,
                note,
              }),
            );
            return ok ? 0 : 2;
          }
          if (required === 0) {
            process.stdout.write(
              'gate: no required comparisons registered (ideaseek comparison import <id> <url>)\n',
            );
            return 0;
          }
          process.stdout.write(
            `gate: ${passed.length}/${required} required method(s) runnable` +
              (skipped.length > 0 ? ` · ${skipped.length} excluded` : '') +
              (blocking.length > 0 ? ` · ${blocking.length} blocking` : '') +
              '\n',
          );
          for (const entry of passed) {
            process.stdout.write(
              `  PASS  ${entry.methodId}  ${entry.status}` +
                `${entry.via === 'experiment' ? ' (experiment result)' : ''}` +
                `${entry.algorithmModified ? ' (algorithm-modified, revised method)' : ''}\n`,
            );
          }
          for (const entry of skipped) {
            process.stdout.write(
              `  SKIP  ${entry.methodId}  excluded (${entry.reason ?? 'no reason'})\n`,
            );
          }
          for (const entry of blocking) {
            process.stdout.write(`  FAIL  ${entry.methodId}  ${entry.status}\n`);
            process.stdout.write(`        next: ${entry.hint}\n`);
          }
          if (ok) {
            process.stdout.write('gate PASSED: all required comparisons have runnable results\n');
          } else {
            process.stdout.write(
              'gate FAILED: idea generation stays blocked until every required method passes or is explicitly excluded\n',
            );
          }
          return ok ? 0 : 2;
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
    .option('--confirm', 'guided-mode confirmation for protected changes (Decision/Event recorded)')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (
          methodId: string,
          status: string,
          opts: { reason?: string; confirm?: boolean; json?: boolean },
        ) => {
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
            // State-machine rule first: reason-required statuses fail fast
            // before any policy confirmation is considered.
            if (
              REASON_REQUIRED.includes(status as ComparisonStatus) &&
              !(opts.reason && opts.reason.trim())
            ) {
              throw new IdeaseekError(
                'USER_INPUT_REQUIRED',
                `status ${status} requires --reason (no silent skips; docs: EXCLUDED 必须有用户或配置原因)`,
                { status },
              );
            }
            // Protected change: excluding a REQUIRED method needs the mode's
            // approval and always leaves a Decision/Event (AUTONOMY_POLICY).
            let decision: { seq: number } | null = null;
            if (status === 'excluded' && before.required) {
              const mode = parseAutonomyMode(runtime.config.policy.autonomyMode);
              const check = assertAutonomy(mode, 'change-required-comparison', {
                confirmed: opts.confirm,
              });
              if (check.needsDecision) {
                decision = await recordDecision(runtime.db, runtime.project.id, {
                  action: 'change-required-comparison',
                  target: methodId,
                  mode,
                  reason: opts.reason ?? undefined,
                });
              }
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
                  decisionSeq: decision?.seq ?? null,
                }),
              );
            } else {
              process.stdout.write(
                `${methodId}: ${before.status} → ${after.status}${opts.reason ? ` (${opts.reason})` : ''}\n`,
              );
              if (decision) process.stdout.write(`  decision recorded (event #${decision.seq})\n`);
              else if (status === 'excluded' && before.required) {
                process.stdout.write('  decision not recorded (no run exists yet)\n');
              }
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

          // Reuse the shared bounded runner (same path as baseline repair) —
          // commands never hand-roll subprocess handling (ADR-006).
          const { runRepairCommand, writeRepairLog } = await import('../comparison/repair.js');
          const outcome = await runRepairCommand(command, worktreeDir, timeoutMs);
          const durationMs = outcome.durationMs;
          const passed = outcome.exitCode === 0 && !outcome.timedOut;
          const tail = outcome.out.slice(-1500);
          const logPath = `.research/logs/smoke-${methodId}.log`;
          await writeRepairLog(
            root,
            `smoke-${methodId}.log`,
            command,
            outcome.exitCode,
            outcome.out,
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
          const failReason = `smoke failed (exit ${outcome.exitCode}); log: ${logPath}`;
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
                exitCode: outcome.exitCode,
                durationMs,
                status: record.status,
                logPath,
              }),
            );
          } else {
            process.stdout.write(
              `smoke ${methodId}: ${passed ? 'PASSED' : 'FAILED'} (exit ${outcome.exitCode}, ${durationMs}ms) → status ${record.status}\n`,
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
