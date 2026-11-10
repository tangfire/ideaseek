import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { IdeaseekError } from '../core/errors.js';
import { assessIdeaCard, type IdeaCard } from '../idea/card.js';
import { runIdeaChecks, saveCheckReport, scaffoldIdea } from '../idea/check.js';
import { runIdeaExperiment, type IdeaScale } from '../idea/experiment.js';
import {
  IDEA_TRANSITIONS,
  assertEngineeringRevision,
  checkpointCode,
  createWorkspace,
  ideaDir,
  listWorkspaces,
  loadIdeaCard,
  loadVersionRecords,
  loadWorkspaceMeta,
  reviseEngineering,
  setIdeaStatus,
  verifyWorkspace,
  type IdeaRunStatus,
} from '../idea/workspace.js';
import { findProjectRoot } from '../config/paths.js';
import { action, jsonLine } from './shared.js';

async function openRoot(): Promise<string> {
  const root = await findProjectRoot(process.cwd());
  if (!root) {
    throw new IdeaseekError('NOT_INITIALIZED', 'no IdeaSeek project here; run: ideaseek init');
  }
  return root;
}

async function readCardFile(path: string): Promise<IdeaCard> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new IdeaseekError('FILE_NOT_FOUND', `cannot read ${path}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(raw) as IdeaCard;
  } catch (error) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `${path} is not valid JSON: ${(error as Error).message}`,
    );
  }
}

/**
 * `ideaseek idea validate <file>` — IdeaCard contract + mechanism gate.
 * Structural errors exit 2; a DRAFT_COMPOSITION card passes validation but is
 * reported as blocked from the experiment queue (add --require-candidate to
 * make that a failing exit, for pre-experiment checks).
 */
export function registerIdeaCommand(program: Command): void {
  const idea = program
    .command('idea')
    .description('idea cards, workspaces, versions and the mechanism gate');

  idea
    .command('validate')
    .description('validate an IdeaCard JSON and run the DRAFT_COMPOSITION mechanism gate')
    .argument('<file>', 'path to the idea card JSON')
    .option('--require-candidate', 'fail when the card is held at DRAFT_COMPOSITION')
    .option('--json', 'machine-readable output')
    .action(
      action(async (file: string, opts: { requireCandidate?: boolean; json?: boolean }) => {
        let raw: string;
        try {
          raw = await readFile(file, 'utf8');
        } catch (error) {
          throw new IdeaseekError(
            'FILE_NOT_FOUND',
            `cannot read ${file}: ${(error as Error).message}`,
          );
        }
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch (error) {
          throw new IdeaseekError(
            'PARSE_FAILED',
            `${file} is not valid JSON: ${(error as Error).message}`,
          );
        }

        const { validation, gate, ok } = assessIdeaCard(value);
        const ideaId =
          value &&
          typeof value === 'object' &&
          typeof (value as { ideaId?: unknown }).ideaId === 'string'
            ? (value as { ideaId: string }).ideaId
            : null;
        const version =
          value &&
          typeof value === 'object' &&
          typeof (value as { version?: unknown }).version === 'number'
            ? (value as { version: number }).version
            : null;

        if (opts.json) {
          process.stdout.write(
            jsonLine({
              ideaId,
              version,
              valid: ok,
              errors: validation.errors,
              gate: gate.status,
              blockers: gate.blockers,
              eligibleForQueue: ok && gate.ok,
            }),
          );
        } else {
          if (validation.errors.length > 0) {
            process.stdout.write(`invalid idea card (${validation.errors.length} error(s)):\n`);
            for (const error of validation.errors) process.stdout.write(`  ✗ ${error}\n`);
          } else {
            process.stdout.write(`valid idea card: ${ideaId ?? '?'} v${version ?? '?'}\n`);
          }
          process.stdout.write(`mechanism gate: ${gate.status}\n`);
          for (const blocker of gate.blockers) process.stdout.write(`  • ${blocker}\n`);
          if (ok && gate.ok) {
            process.stdout.write(
              'eligible for the experiment queue (subject to user confirmation)\n',
            );
          } else if (ok) {
            process.stdout.write(
              'held at DRAFT_COMPOSITION: complete the mechanism chain before experiments\n',
            );
          }
        }

        if (!ok) return 2;
        if (opts.requireCandidate && !gate.ok) return 2;
        return 0;
      }),
    );

  idea
    .command('create')
    .description(
      'create ideas/<id>/ workspace (card, versions, src/config/data/experiments, README)',
    )
    .argument('<ideaId>', 'kebab-case idea id')
    .requiredOption('--from-card <file>', 'validated IdeaCard JSON (must be version 1)')
    .option(
      '--data <path>',
      'bind an input file hash (repeatable)',
      (v, p: string[]) => [...p, v],
      [] as string[],
    )
    .option('--json', 'machine-readable output')
    .action(
      action(async (ideaId: string, opts: { fromCard: string; data: string[]; json?: boolean }) => {
        const root = await openRoot();
        const card = await readCardFile(opts.fromCard);
        const { meta, resumed } = await createWorkspace(root, {
          ideaId,
          card,
          dataPaths: opts.data,
        });
        if (opts.json) {
          process.stdout.write(
            jsonLine({
              ideaId,
              status: meta.status,
              version: meta.currentVersion,
              resumed,
              workspace: ideaDir(root, ideaId),
            }),
          );
        } else {
          process.stdout.write(
            `${resumed ? 'completed partial workspace' : 'created idea workspace'} ${ideaId} ` +
              `(status=${meta.status}, v${meta.currentVersion})\n`,
          );
          process.stdout.write(`  path: ${ideaDir(root, ideaId)}\n`);
          process.stdout.write(`next: ideaseek idea show ${ideaId}\n`);
        }
        return 0;
      }),
    );

  idea
    .command('list')
    .description('list idea workspaces with lifecycle status and version')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { json?: boolean }) => {
        const root = await openRoot();
        const ideas = await listWorkspaces(root);
        if (opts.json) {
          process.stdout.write(jsonLine({ ideas }));
          return 0;
        }
        if (ideas.length === 0) {
          process.stdout.write(
            'no idea workspaces (ideaseek idea create <id> --from-card <file>)\n',
          );
          return 0;
        }
        process.stdout.write(`${ideas.length} idea(s):\n`);
        for (const entry of ideas) {
          process.stdout.write(
            `  ${entry.ideaId}  ${entry.status.padEnd(15)} v${entry.currentVersion}` +
              `${entry.parentIdeaId ? `  ← ${entry.parentIdeaId}` : ''}` +
              `${entry.childIdeaIds.length > 0 ? `  → ${entry.childIdeaIds.join(',')}` : ''}\n`,
          );
        }
        return 0;
      }),
    );

  idea
    .command('show')
    .description('show one idea workspace: status, version chain, gate and links')
    .argument('<ideaId>', 'idea id')
    .option('--json', 'machine-readable output')
    .action(
      action(async (ideaId: string, opts: { json?: boolean }) => {
        const root = await openRoot();
        const meta = await loadWorkspaceMeta(root, ideaId);
        const card = await loadIdeaCard(root, ideaId);
        const versions = await loadVersionRecords(root, ideaId);
        const assessment = assessIdeaCard(card);
        const next = IDEA_TRANSITIONS[meta.status];
        if (opts.json) {
          process.stdout.write(
            jsonLine({
              ideaId,
              status: meta.status,
              statusReason: meta.statusReason,
              currentVersion: meta.currentVersion,
              parentIdeaId: meta.parentIdeaId,
              childIdeaIds: meta.childIdeaIds,
              cardGate: assessment.gate.status,
              cardValid: assessment.ok,
              versions: versions.map((v) => ({
                version: v.version,
                parentVersion: v.parentVersion,
                changeKind: v.changeKind,
                codeHash: v.codeHash,
                summary: v.summary,
                checkpoint: v.checkpoint ?? null,
              })),
              nextTransitions: next,
              history: meta.history,
            }),
          );
          return 0;
        }
        process.stdout.write(
          `${ideaId}  ${meta.status}  v${meta.currentVersion}  gate=${assessment.gate.status}\n`,
        );
        if (meta.statusReason) process.stdout.write(`  reason: ${meta.statusReason}\n`);
        process.stdout.write(
          `  parent: ${meta.parentIdeaId ?? 'none'}  children: ${meta.childIdeaIds.join(', ') || 'none'}\n`,
        );
        process.stdout.write('  versions:\n');
        for (const v of versions) {
          process.stdout.write(
            `    v${v.version}  ${v.changeKind}  ${v.codeHash ?? '(no checkpoint)'}  ${v.summary}\n`,
          );
        }
        process.stdout.write(`  next: ${next.length > 0 ? next.join(' | ') : '(terminal)'}\n`);
        return 0;
      }),
    );

  idea
    .command('revise')
    .description('engineering revision: bump this idea to a new version (same hypothesis)')
    .argument('<ideaId>', 'idea id')
    .requiredOption('--kind <kind>', 'engineering | scientific (scientific must use idea branch)')
    .requiredOption('--summary <text>', 'what changed and why')
    .option('--json', 'machine-readable output')
    .action(
      action(async (ideaId: string, opts: { kind: string; summary: string; json?: boolean }) => {
        const root = await openRoot();
        assertEngineeringRevision(opts.kind);
        const { version, meta } = await reviseEngineering(root, ideaId, opts.summary);
        if (opts.json) {
          process.stdout.write(
            jsonLine({
              ideaId,
              version: version.version,
              parentVersion: version.parentVersion,
              codeHash: version.codeHash,
              currentVersion: meta.currentVersion,
            }),
          );
        } else {
          process.stdout.write(
            `${ideaId}: v${version.parentVersion} → v${version.version} (engineering)\n`,
          );
          process.stdout.write(`  summary: ${version.summary}\n`);
          process.stdout.write(`  codeHash: ${version.codeHash ?? '(no checkpoint yet)'}\n`);
        }
        return 0;
      }),
    );

  idea
    .command('branch')
    .description('scientific hypothesis change: new idea id linked to its parent idea')
    .argument('<parentIdeaId>', 'existing idea id')
    .argument('<newIdeaId>', 'new kebab-case idea id')
    .requiredOption('--from-card <file>', 'IdeaCard for the new idea (version 1)')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (
          parentIdeaId: string,
          newIdeaId: string,
          opts: { fromCard: string; json?: boolean },
        ) => {
          const root = await openRoot();
          if (parentIdeaId === newIdeaId) {
            throw new IdeaseekError(
              'INVALID_ARGUMENT',
              'branch target must differ from the parent',
            );
          }
          const card = await readCardFile(opts.fromCard);
          const { meta } = await createWorkspace(root, {
            ideaId: newIdeaId,
            card,
            parentIdeaId,
            changeKind: 'scientific-branch',
          });
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                ideaId: newIdeaId,
                parentIdeaId,
                status: meta.status,
                version: meta.currentVersion,
              }),
            );
          } else {
            process.stdout.write(
              `branched ${newIdeaId} from ${parentIdeaId} (scientific change, v1)\n`,
            );
            process.stdout.write(`next: ideaseek idea show ${newIdeaId}\n`);
          }
          return 0;
        },
      ),
    );

  idea
    .command('set-status')
    .description('transition the idea lifecycle (PROPOSED → … → SUPPORTED/REJECTED)')
    .argument('<ideaId>', 'idea id')
    .argument('<status>', 'target lifecycle status')
    .option('--reason <text>', 'required for REJECTED')
    .option('--json', 'machine-readable output')
    .action(
      action(async (ideaId: string, status: string, opts: { reason?: string; json?: boolean }) => {
        const root = await openRoot();
        if (!(status in IDEA_TRANSITIONS)) {
          throw new IdeaseekError(
            'INVALID_ARGUMENT',
            `unknown status "${status}" (valid: ${Object.keys(IDEA_TRANSITIONS).join(', ')})`,
          );
        }
        const meta = await setIdeaStatus(root, ideaId, status as IdeaRunStatus, opts.reason);
        if (opts.json) {
          process.stdout.write(
            jsonLine({
              ideaId,
              status: meta.status,
              statusReason: meta.statusReason,
              nextTransitions: IDEA_TRANSITIONS[meta.status],
            }),
          );
        } else {
          process.stdout.write(
            `${ideaId}: → ${meta.status}${meta.statusReason ? ` (${meta.statusReason})` : ''}\n`,
          );
          const next = IDEA_TRANSITIONS[meta.status];
          process.stdout.write(`  next: ${next.length > 0 ? next.join(' | ') : '(terminal)'}\n`);
        }
        return 0;
      }),
    );

  idea
    .command('checkpoint')
    .description('bind the current src/ content hash to the current idea version')
    .argument('<ideaId>', 'idea id')
    .requiredOption('--message <text>', 'what changed in this checkpoint')
    .option('--json', 'machine-readable output')
    .action(
      action(async (ideaId: string, opts: { message: string; json?: boolean }) => {
        const root = await openRoot();
        const result = await checkpointCode(root, ideaId, opts.message);
        if (opts.json) {
          process.stdout.write(
            jsonLine({
              ideaId,
              version: result.version,
              codeHash: result.codeHash,
              changed: result.changed,
              message: result.message,
            }),
          );
        } else {
          process.stdout.write(
            `checkpoint ${ideaId} v${result.version}: ` +
              (result.changed
                ? `${result.codeHash ?? '(empty src/)'} recorded\n`
                : 'unchanged (idempotent)\n'),
          );
        }
        return 0;
      }),
    );

  idea
    .command('scaffold')
    .description(
      'write the Code Implementer starter skeleton (train/check_data/check_metrics/smoke/tests; never overwrites)',
    )
    .argument('<ideaId>', 'idea id')
    .option('--json', 'machine-readable output')
    .action(
      action(async (ideaId: string, opts: { json?: boolean }) => {
        const root = await openRoot();
        const result = await scaffoldIdea(root, ideaId);
        if (opts.json) {
          process.stdout.write(jsonLine({ ideaId, ...result }));
        } else {
          process.stdout.write(
            `scaffold ${ideaId}: ${result.created.length} file(s) created, ${result.skipped.length} kept\n`,
          );
          for (const file of result.created) process.stdout.write(`  + ${file}\n`);
          if (result.skipped.length > 0) {
            process.stdout.write(`  kept (existing): ${result.skipped.join(', ')}\n`);
          }
          process.stdout.write(`next: ideaseek idea check ${ideaId}\n`);
        }
        return 0;
      }),
    );

  idea
    .command('check')
    .description(
      'Code Implementer gate: static + unit tests + data/metrics interface + smoke micro-run',
    )
    .argument('<ideaId>', 'idea id')
    .option('--timeout <ms>', 'per-phase command timeout', (value) => Number(value), 60_000)
    .option('--json', 'machine-readable output')
    .action(
      action(async (ideaId: string, opts: { timeout: number; json?: boolean }) => {
        const root = await openRoot();
        if (!Number.isFinite(opts.timeout) || opts.timeout < 100) {
          throw new IdeaseekError('INVALID_ARGUMENT', '--timeout must be >= 100 ms');
        }
        const report = await runIdeaChecks(root, ideaId, { timeoutMs: opts.timeout });
        const reportPath = await saveCheckReport(root, report);

        // Queue discipline: a full pass from IMPLEMENTING advances to
        // SMOKE_TESTED (plan §E.3). Failures keep the status — implementation
        // errors are fixed and re-checked, not treated as hypothesis failures.
        let status = (await loadWorkspaceMeta(root, ideaId)).status;
        if (report.outcome === 'passed' && status === 'IMPLEMENTING') {
          status = (await setIdeaStatus(root, ideaId, 'SMOKE_TESTED')).status;
        }

        if (opts.json) {
          process.stdout.write(
            jsonLine({
              ideaId,
              outcome: report.outcome,
              status,
              version: report.version,
              codeHash: report.codeHash,
              reportPath,
              phases: report.phases.map((phase) => ({
                phase: phase.phase,
                ok: phase.ok,
                skipped: phase.skipped,
                failureKind: phase.failureKind ?? null,
                summary: phase.summary ?? null,
              })),
            }),
          );
        } else {
          process.stdout.write(
            `check ${ideaId} v${report.version}: ${report.outcome.toUpperCase()} (status=${status})\n`,
          );
          for (const phase of report.phases) {
            const mark = phase.skipped ? 'skip' : phase.ok ? 'ok  ' : 'FAIL';
            process.stdout.write(
              `  ${mark} ${phase.phase.padEnd(11)} ${phase.durationMs}ms` +
                `${phase.failureKind ? `  ${phase.failureKind}` : ''}` +
                `${phase.summary && !phase.ok ? `  ${phase.summary}` : ''}\n`,
            );
          }
          process.stdout.write(`  report: ${reportPath}\n`);
          if (report.outcome === 'failed') {
            process.stdout.write(
              `next: fix the failing phase, then rerun: ideaseek idea check ${ideaId}\n`,
            );
          } else if (report.outcome === 'smoke-missing') {
            process.stdout.write(
              `next: write src/smoke.py (or ideaseek idea scaffold ${ideaId}) to reach SMOKE_TESTED\n`,
            );
          } else {
            process.stdout.write(
              `next: ideaseek idea set-status ${ideaId} RUNNING   (experiments stay quick/standard)\n`,
            );
          }
        }
        return report.outcome === 'failed' ? 1 : 0;
      }),
    );

  idea
    .command('experiment')
    .description(
      'run a bounded smoke/quick experiment and record unified ExperimentSpec/RunResult (requires passing check)',
    )
    .argument('<ideaId>', 'idea id')
    .option('--scale <scale>', 'smoke | quick (never full training)', 'smoke')
    .option('--timeout <ms>', 'run timeout', (value) => Number(value), 120_000)
    .option('--json', 'machine-readable output')
    .action(
      action(async (ideaId: string, opts: { scale: string; timeout: number; json?: boolean }) => {
        const root = await openRoot();
        if (opts.scale !== 'smoke' && opts.scale !== 'quick') {
          throw new IdeaseekError('INVALID_ARGUMENT', '--scale must be smoke | quick');
        }
        if (!Number.isFinite(opts.timeout) || opts.timeout < 100) {
          throw new IdeaseekError('INVALID_ARGUMENT', '--timeout must be >= 100 ms');
        }
        const { ProjectRuntime } = await import('../workflow/runtime.js');
        const runtime = await ProjectRuntime.open({ cwd: root });
        try {
          const outcome = await runIdeaExperiment(
            root,
            ideaId,
            { scale: opts.scale as IdeaScale, timeoutMs: opts.timeout },
            runtime,
            runtime.db,
          );
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                ideaId,
                specId: outcome.specId,
                version: outcome.version,
                attempt: outcome.attempt,
                scale: opts.scale,
                alreadyRecorded: outcome.alreadyRecorded,
                resultStatus: outcome.resultStatus,
                metrics: outcome.metrics,
                failure: outcome.failure,
                statusAfter: outcome.statusAfter,
              }),
            );
          } else if (outcome.alreadyRecorded) {
            process.stdout.write(
              `experiment ${outcome.specId} v${outcome.version}: already recorded (idempotent)\n`,
            );
          } else if (outcome.resultStatus === 'succeeded') {
            process.stdout.write(
              `experiment ${outcome.specId} v${outcome.version}: SUCCEEDED → ${outcome.statusAfter}\n`,
            );
            for (const metric of outcome.metrics) {
              process.stdout.write(`  ${metric.name} = ${metric.value}\n`);
            }
          } else {
            process.stdout.write(
              `experiment ${outcome.specId} v${outcome.version}: FAILED ` +
                `(${outcome.failure?.category}: ${outcome.failure?.summary ?? ''}) → ${outcome.statusAfter}\n`,
            );
            process.stdout.write(
              `next: fix and re-check, then walk back: ideaseek idea set-status ${ideaId} NEEDS_REVISION\n`,
            );
          }
          return outcome.exitCode;
        } finally {
          await runtime.close();
        }
      }),
    );

  idea
    .command('verify')
    .description('verify structure, version chain, parent links and input hashes')
    .argument('<ideaId>', 'idea id')
    .option('--json', 'machine-readable output')
    .action(
      action(async (ideaId: string, opts: { json?: boolean }) => {
        const root = await openRoot();
        const result = await verifyWorkspace(root, ideaId);
        if (opts.json) {
          process.stdout.write(
            jsonLine({
              ideaId,
              ok: result.ok,
              status: result.status,
              currentVersion: result.currentVersion,
              cardGate: result.cardGate,
              inputsChanged: result.inputsChanged,
              issues: result.issues,
            }),
          );
        } else {
          process.stdout.write(
            `verify ${ideaId}: ${result.ok ? 'OK' : `${result.issues.length} issue(s)`} ` +
              `(${result.status}, v${result.currentVersion}, gate=${result.cardGate})\n`,
          );
          for (const issue of result.issues) {
            process.stdout.write(`  ✗ [${issue.kind}] ${issue.detail}\n`);
          }
        }
        return result.ok ? 0 : 2;
      }),
    );
}
