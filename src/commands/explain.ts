import type { Command } from 'commander';
import { IdeaseekError } from '../core/errors.js';
import { redactSecrets } from '../core/redact.js';
import { verifyFileHash } from '../core/hash.js';
import { action, jsonLine } from './shared.js';

/**
 * `ideaseek explain <task|decision|artifact>` (PRODUCT_REQUIREMENTS P0):
 * reconstructs provenance from persisted state only — which run created it,
 * which inputs/versions produced it, retries and errors, and whether an
 * artifact's bytes still match their declared hash. Never re-runs anything.
 */

function parseArgs(argv: string[]): { kind: string; id: string } {
  const [kind, id] = argv;
  if (!kind || !['task', 'decision', 'artifact'].includes(kind)) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      'usage: ideaseek explain <task|decision|artifact> <id>',
    );
  }
  if (!id) {
    throw new IdeaseekError('INVALID_ARGUMENT', `explain ${kind} requires an id`);
  }
  return { kind, id };
}

export function registerExplainCommand(program: Command): void {
  program
    .command('explain')
    .description('explain how a task/decision/artifact was produced (inputs, versions, rules)')
    .argument('<kind>', 'task | decision | artifact')
    .argument('<id>', 'task id, event seq, or artifact id')
    .option('--json', 'machine-readable output')
    .action(
      action(async (kindArg: string, idArg: string, opts: { json?: boolean }) => {
        const { kind, id } = parseArgs([kindArg, idArg]);
        const root = await openRoot();
        const { ProjectRuntime } = await import('../workflow/runtime.js');
        const runtime = await ProjectRuntime.open({ cwd: root });
        try {
          if (kind === 'task') {
            return await explainTask(runtime, id, opts.json === true);
          }
          if (kind === 'decision') {
            return await explainDecision(runtime, id, opts.json === true);
          }
          return await explainArtifact(runtime, id, opts.json === true);
        } finally {
          await runtime.close();
        }
      }),
    );
}

async function openRoot(): Promise<string> {
  const { findProjectRoot } = await import('../config/paths.js');
  const root = await findProjectRoot(process.cwd());
  if (!root) {
    throw new IdeaseekError('NOT_INITIALIZED', 'no IdeaSeek project here; run: ideaseek init');
  }
  return root;
}

import type { ProjectRuntime } from '../workflow/runtime.js';

type Runtime = ProjectRuntime;

async function explainTask(runtime: Runtime, taskId: string, json: boolean): Promise<number> {
  const task = await runtime.db.getTask(taskId);
  if (!task) throw new IdeaseekError('TASK_NOT_FOUND', `task ${taskId} not found`);
  const artifacts = await runtime.db.listArtifacts(taskId);
  const run = await runtime.db.getRun(task.runId);
  const events = await runtime.db.listEvents(task.runId, { limit: 10_000 });
  const related = events.filter(
    (event) =>
      event.objectId === taskId ||
      (event.eventType.startsWith('task_') && event.summary.includes(taskId)),
  );

  const payload = {
    taskId: task.taskId,
    run: run
      ? { runId: run.runId, status: run.status, phase: run.phase, strategy: run.strategy }
      : null,
    type: task.type,
    status: task.status,
    attempt: `${task.attempt}/${task.maxAttempts}`,
    idempotencyKey: task.idempotencyKey ?? null,
    dependsOn: task.dependsOn ?? [],
    error: task.error
      ? { code: task.error.code, message: redactSecrets(task.error.message) }
      : null,
    resultSummary: task.result?.summary ? redactSecrets(task.result.summary) : null,
    artifacts: artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      contentHash: artifact.contentHash,
      relPath: artifact.relPath,
      status: artifact.status,
    })),
    events: related.map((event) => ({
      seq: event.seq,
      ts: event.ts,
      type: event.eventType,
      summary: redactSecrets(event.summary),
      status: event.status,
    })),
    producedBy:
      'this task was claimed by a worker under the run config snapshot; ' +
      'handlers are registered in the composition layer (src/commands/shared.ts)',
    rules: [
      'task states: queued → leased → running → committing → succeeded/failed/canceled',
      'committed artifacts are hash-verified and immutable; retries keep attempt history',
    ],
  };

  if (json) {
    process.stdout.write(jsonLine(payload));
    return 0;
  }
  process.stdout.write(
    `task ${task.taskId}  ${task.type}  ${task.status}  attempt=${payload.attempt}\n`,
  );
  process.stdout.write(
    `  run: ${payload.run?.runId ?? '?'} (${payload.run?.status ?? '?'}/${payload.run?.phase ?? '?'})\n`,
  );
  if (payload.error)
    process.stdout.write(`  error: ${payload.error.code}: ${payload.error.message}\n`);
  if (payload.resultSummary) process.stdout.write(`  result: ${payload.resultSummary}\n`);
  process.stdout.write('  artifacts:\n');
  for (const artifact of payload.artifacts) {
    process.stdout.write(
      `    ${artifact.kind} ${artifact.relPath} (${artifact.status}) ${artifact.contentHash}\n`,
    );
  }
  process.stdout.write('  events:\n');
  for (const event of payload.events.slice(-8)) {
    process.stdout.write(`    [#${event.seq}] ${event.type} ${event.summary}\n`);
  }
  process.stdout.write(`  produced by: ${payload.producedBy}\n`);
  for (const rule of payload.rules) process.stdout.write(`  rule: ${rule}\n`);
  return 0;
}

async function explainDecision(runtime: Runtime, id: string, json: boolean): Promise<number> {
  const seq = Number(id);
  if (!Number.isInteger(seq) || seq < 1) {
    throw new IdeaseekError('INVALID_ARGUMENT', 'decision id must be the event seq number');
  }
  const latest = await runtime.db.getLatestRun(runtime.project.id);
  let found: Awaited<ReturnType<typeof runtime.db.listEvents>>[number] | null = null;
  let foundRunId: string | null = null;
  if (latest) {
    const events = await runtime.db.listEvents(latest.runId, { limit: 10_000 });
    found = events.find((event) => event.seq === seq && event.eventType === 'decision') ?? null;
    if (found) foundRunId = latest.runId;
  }
  if (!found) {
    throw new IdeaseekError(
      'TASK_NOT_FOUND',
      `decision event #${seq} not found on the latest run (decisions are run-bound)`,
    );
  }
  const run = foundRunId ? await runtime.db.getRun(foundRunId) : null;

  const payload = {
    seq: found.seq,
    runId: found.runId,
    ts: found.ts,
    role: found.role,
    status: found.status,
    summary: redactSecrets(found.summary),
    run: run ? { runId: run.runId, status: run.status, phase: run.phase } : null,
    rule: 'decisions are persisted RunEvents; they cannot be silently rewritten',
  };
  if (json) {
    process.stdout.write(jsonLine(payload));
    return 0;
  }
  process.stdout.write(`decision #${payload.seq} @ ${new Date(payload.ts).toISOString()}\n`);
  process.stdout.write(`  ${payload.summary}\n`);
  process.stdout.write(
    `  role=${payload.role ?? '?'} status=${payload.status ?? '?'} run=${payload.runId}\n`,
  );
  process.stdout.write(
    `  run state: ${payload.run?.status ?? '?'} / ${payload.run?.phase ?? '?'}\n`,
  );
  process.stdout.write(`  rule: ${payload.rule}\n`);
  return 0;
}

async function explainArtifact(runtime: Runtime, id: string, json: boolean): Promise<number> {
  const artifact = await runtime.db.getArtifact(id);
  if (!artifact) {
    throw new IdeaseekError('TASK_NOT_FOUND', `artifact ${id} not found`);
  }
  const run = await runtime.db.getRun(artifact.runId);
  const task = artifact.taskId ? await runtime.db.getTask(artifact.taskId) : null;

  // Integrity: bytes on disk must still match the committed hash.
  let integrity: 'verified' | 'missing' | 'mismatch' = 'missing';
  try {
    const path = runtime.store.resolvePath(artifact.contentHash);
    integrity = (await verifyFileHash(path, artifact.contentHash)) ? 'verified' : 'mismatch';
  } catch {
    integrity = 'missing';
  }

  const payload = {
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    status: artifact.status,
    contentHash: artifact.contentHash,
    size: artifact.size,
    relPath: artifact.relPath,
    integrity,
    committedAt: artifact.committedAt ?? null,
    run: run ? { runId: run.runId, status: run.status, phase: run.phase } : null,
    task: task ? { taskId: task.taskId, type: task.type, status: task.status } : null,
    meta: artifact.meta,
    provenance:
      'committed by a worker through the two-phase artifact store ' +
      '(stage → hash verify → atomic promote); content is immutable once committed',
  };
  if (json) {
    process.stdout.write(jsonLine(payload));
    return integrity === 'verified' ? 0 : 1;
  }
  process.stdout.write(`artifact ${artifact.artifactId}  ${artifact.kind}  ${artifact.status}\n`);
  process.stdout.write(`  hash: ${artifact.contentHash} (${artifact.size} bytes)\n`);
  process.stdout.write(`  path: ${artifact.relPath}\n`);
  process.stdout.write(`  integrity: ${integrity}\n`);
  process.stdout.write(
    `  run: ${payload.run?.runId ?? '?'} · task: ${payload.task?.taskId ?? '(none)'}\n`,
  );
  process.stdout.write(`  provenance: ${payload.provenance}\n`);
  return integrity === 'verified' ? 0 : 1;
}
