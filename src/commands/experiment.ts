import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { IdeaseekError } from '../core/errors.js';
import { assertAgainstSchema } from '../core/schema/index.js';
import {
  computeSpecHash,
  validateExperimentSpec,
  validateRunResult,
  type ExperimentSpec,
  type RunResult,
} from '../experiment/spec.js';
import {
  assertAutonomy,
  checkAutonomy,
  parseAutonomyMode,
  recordDecision,
} from '../workflow/autonomy.js';
import type { ExperimentDoc } from '../workflow/db.js';
import { ensureActiveRun } from './ingest.js';
import {
  action,
  assertConfigUsable,
  buildHarness,
  buildHandlers,
  jsonLine,
  runWorkerInteractive,
} from './shared.js';

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

async function readJsonFile(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new IdeaseekError('FILE_NOT_FOUND', `cannot read ${path}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `${path} is not valid JSON: ${(error as Error).message}`,
    );
  }
}

function shortHash(hash: string): string {
  return hash.replace(/^sha256:/, '').slice(0, 12);
}

function metricSummary(doc: ExperimentDoc): string {
  if (!doc.result) return '';
  const metrics = Array.isArray(doc.result.metrics) ? doc.result.metrics : [];
  return metrics
    .slice(0, 3)
    .map((m) => {
      const entry = m as { name?: unknown; value?: unknown };
      return `${String(entry.name)}=${Number(entry.value).toFixed(4)}`;
    })
    .join(' ');
}

/**
 * `ideaseek experiment spec|result|list|show|plan|bridge` — unified
 * ExperimentSpec / RunResult registry (docs/DATA_CONTRACTS.md, CLI_SPEC) plus
 * the Phase 4.5 ARIS plan/bridge backend: `plan` renders the vendored
 * `experiment-plan` skill through the harness into a plan Artifact + planned
 * spec; `bridge` executes a current plan through IdeaSeek's runner (check
 * gate, comparison gate, capacity admission, RunResult, checkpoint).
 * Specs are validated and content-hashed before persistence; results attach
 * exactly once per spec version (re-attach refuses — record a new version).
 */
export function registerExperimentCommand(program: Command): void {
  const experiment = program
    .command('experiment')
    .description('unified experiment specs and run results (ARIS plan/bridge backend)');

  experiment
    .command('spec')
    .description('validate, hash and record an ExperimentSpec from a JSON file')
    .argument('<file>', 'path to the spec JSON')
    .option('--json', 'machine-readable output')
    .action(
      action(async (file: string, opts: { json?: boolean }) => {
        const root = await openRoot();
        const value = await readJsonFile(file);
        const validation = validateExperimentSpec(value);
        // Defense in depth (JSON Schema authority): the semantic validator
        // runs first (stable messages); the shared contract then re-checks
        // structure so a future loosened validator cannot widen the gate.
        if (validation.ok) assertAgainstSchema('experiment-spec-v1', value);
        if (!validation.ok) {
          throw new IdeaseekError(
            'INVALID_ARGUMENT',
            `invalid experiment spec: ${validation.errors.join('; ')}`,
          );
        }
        const spec = value as ExperimentSpec;
        const specHash = computeSpecHash(spec);
        const runtime = await openRuntime(root);
        try {
          const existing = await runtime.db.getExperiment(spec.specId);
          await runtime.db.upsertExperiment({
            specId: spec.specId,
            version: spec.version,
            specHash,
            status: existing && existing.specHash === specHash ? existing.status : 'planned',
            spec: spec as unknown as Record<string, unknown>,
            // Identical-hash re-record keeps any attached result (handled in
            // upsert); a new hash/version starts planned with no result.
            result: existing && existing.specHash === specHash ? existing.result : null,
            updatedAt: Date.now(),
          });
          const after = await runtime.db.getExperiment(spec.specId);
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                specId: spec.specId,
                version: spec.version,
                specHash,
                status: after?.status ?? 'planned',
                idempotent: existing?.specHash === specHash,
              }),
            );
          } else {
            process.stdout.write(
              `recorded ${spec.specId} v${spec.version} (${shortHash(specHash)}) status=${after?.status ?? 'planned'}\n`,
            );
            if (existing && existing.specHash === specHash) {
              process.stdout.write('  identical spec already recorded (idempotent)\n');
            } else if (existing) {
              process.stdout.write(`  replaced version ${existing.version} (hash changed)\n`);
            }
            process.stdout.write('next: run it, then ideaseek experiment result <file>\n');
          }
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );

  experiment
    .command('result')
    .description('validate and attach a RunResult to its spec')
    .argument('<file>', 'path to the result JSON')
    .option('--json', 'machine-readable output')
    .action(
      action(async (file: string, opts: { json?: boolean }) => {
        const root = await openRoot();
        const value = await readJsonFile(file);
        const validation = validateRunResult(value);
        if (validation.ok) assertAgainstSchema('run-result-v1', value);
        if (!validation.ok) {
          throw new IdeaseekError(
            'INVALID_ARGUMENT',
            `invalid run result: ${validation.errors.join('; ')}`,
          );
        }
        const result = value as RunResult;
        const runtime = await openRuntime(root);
        try {
          const spec = await runtime.db.getExperiment(result.specId);
          if (!spec) {
            throw new IdeaseekError(
              'TASK_NOT_FOUND',
              `experiment ${result.specId} not found; record the spec first (ideaseek experiment spec <file>)`,
            );
          }
          const updated = await runtime.db.attachExperimentResult(
            result.specId,
            result as unknown as Record<string, unknown>,
            result.status,
          );
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                specId: result.specId,
                version: updated.version,
                status: updated.status,
                metrics: (result.metrics ?? []).map((m) => ({
                  name: m.name,
                  value: m.value,
                })),
              }),
            );
          } else {
            process.stdout.write(
              `result attached: ${result.specId} v${updated.version} → ${updated.status}\n`,
            );
            const summary = metricSummary(updated);
            if (summary) process.stdout.write(`  metrics: ${summary}\n`);
            if (result.failure) {
              process.stdout.write(
                `  failure: ${result.failure.category} - ${result.failure.summary}\n`,
              );
            }
          }
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );

  experiment
    .command('list')
    .description('list recorded experiment specs and their statuses')
    .option('--status <status>', 'filter: planned | succeeded | failed | partial | invalid')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { status?: string; json?: boolean }) => {
        const root = await openRoot();
        const valid = ['planned', 'succeeded', 'failed', 'partial', 'invalid'];
        if (opts.status !== undefined && !valid.includes(opts.status)) {
          throw new IdeaseekError(
            'INVALID_ARGUMENT',
            `--status must be one of ${valid.join(' | ')}`,
          );
        }
        const runtime = await openRuntime(root);
        try {
          const docs = await runtime.db.listExperiments(
            opts.status === undefined ? {} : { status: opts.status as ExperimentDoc['status'] },
          );
          if (opts.json) {
            process.stdout.write(
              jsonLine({
                experiments: docs.map((doc) => ({
                  specId: doc.specId,
                  version: doc.version,
                  status: doc.status,
                  specHash: doc.specHash,
                  hasResult: doc.result !== null,
                  updatedAt: doc.updatedAt,
                })),
              }),
            );
            return 0;
          }
          if (docs.length === 0) {
            process.stdout.write('no experiments recorded (ideaseek experiment spec <file>)\n');
            return 0;
          }
          process.stdout.write(`${docs.length} experiment(s):\n`);
          for (const doc of docs) {
            const summary = metricSummary(doc);
            process.stdout.write(
              `  ${doc.specId}  v${doc.version}  ${doc.status.padEnd(10)}  ${summary}\n`,
            );
          }
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );

  experiment
    .command('show')
    .description('show one experiment spec with its attached result')
    .argument('<specId>', 'spec id')
    .option('--json', 'machine-readable output')
    .action(
      action(async (specId: string, opts: { json?: boolean }) => {
        const root = await openRoot();
        const runtime = await openRuntime(root);
        try {
          const doc = await runtime.db.getExperiment(specId);
          if (!doc) {
            throw new IdeaseekError('TASK_NOT_FOUND', `experiment ${specId} not found`);
          }
          if (opts.json) {
            process.stdout.write(jsonLine(doc));
          } else {
            process.stdout.write(
              `${doc.specId} v${doc.version} ${doc.status} (${shortHash(doc.specHash)})\n`,
            );
            const spec = doc.spec as { command?: unknown; comparisonIds?: unknown };
            if (Array.isArray(spec.command)) {
              process.stdout.write(`  command: ${spec.command.join(' ')}\n`);
            }
            if (Array.isArray(spec.comparisonIds)) {
              process.stdout.write(`  comparisons: ${spec.comparisonIds.join(', ')}\n`);
            }
            const summary = metricSummary(doc);
            if (summary) process.stdout.write(`  metrics: ${summary}\n`);
            if (doc.result) {
              const result = doc.result as { explanation?: string; failure?: { summary?: string } };
              if (result.explanation)
                process.stdout.write(`  explanation: ${result.explanation}\n`);
              if (result.failure?.summary) {
                process.stdout.write(`  failure: ${result.failure.summary}\n`);
              }
            }
          }
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );

  experiment
    .command('plan')
    .description(
      "plan an idea's experiments via the ARIS experiment-plan skill (plan Artifact + planned ExperimentSpec)",
    )
    .argument('<ideaId>', 'idea id')
    .option(
      '--harness <kind>',
      'model harness: fake | dsh (default: dsh when a key is configured, else fake)',
    )
    .option('--json', 'machine-readable output')
    .action(
      action(async (ideaId: string, opts: { harness?: string; json?: boolean }) => {
        const root = await openRoot();
        // Fail fast on a tampered/missing skill — before any run, task or
        // model call (ARIS conformance: integrity refusal writes nothing).
        const { loadArisSkill } = await import('../aris/skill.js');
        const skill = await loadArisSkill('experiment-plan');
        const keyPresent = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
        const kind =
          opts.harness ?? process.env.IDEASEEK_ASK_HARNESS ?? (keyPresent ? 'dsh' : 'fake');
        const { ProjectRuntime } = await import('../workflow/runtime.js');
        const runtime = await ProjectRuntime.open({ cwd: root, harness: buildHarness(kind) });
        try {
          assertConfigUsable(runtime.configLoad);
          const { buildPlanContext, computePlanInputHash, loadStoredPlan } =
            await import('../experiment/plan.js');
          const context = await buildPlanContext(root, runtime, ideaId);
          const inputHash = computePlanInputHash(context, skill);
          const idempotencyKey = `experiment-plan:${inputHash.slice(7, 31)}`;
          const skillInfo = { name: skill.name, sha256: skill.sha256 };

          // Restart-safe incremental skip: identical inputs already planned.
          const existing = await loadStoredPlan(runtime, ideaId, { inputHash });
          if (existing) {
            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  ideaId,
                  reused: true,
                  inputHash,
                  skill: skillInfo,
                  harness: kind,
                  scale: existing.spec.scale,
                  spec: existing.spec,
                  blocks: existing.plan.blocks.length,
                  seeds: existing.plan.seeds,
                  budgetMinutes: existing.plan.budgetMinutes,
                  eventSeq: null,
                }),
              );
            } else {
              process.stdout.write(
                `experiment plan current for ${ideaId} ` +
                  `(input ${inputHash.slice(0, 12)}…, scale ${existing.spec.scale}, ` +
                  `${existing.plan.blocks.length} block(s), skill ${skill.name}@${skill.sha256.slice(0, 12)})\n`,
              );
              process.stdout.write(`next: ideaseek experiment bridge ${ideaId}\n`);
            }
            return 0;
          }

          const { runId } = await ensureActiveRun(runtime);
          const { created } = await runtime.db.enqueueTask({
            runId,
            type: 'experiment.plan',
            phase: 'DEMO',
            payload: { ideaId },
            dependsOn: [],
            idempotencyKey,
            maxAttempts: runtime.config.runtime.maxAttempts,
          });

          const { exit } = await runWorkerInteractive(runtime, runId, {
            kind: 'inline',
            handlers: buildHandlers(),
            onLog: opts.json ? undefined : (message) => process.stderr.write(`  · ${message}\n`),
          });

          if (exit.reason === 'failed') {
            const tasks = await runtime.db.listTasks(runId);
            const failed = [...tasks]
              .reverse()
              .find((task) => task.type === 'experiment.plan' && task.status === 'failed');
            if (failed?.error) {
              process.stderr.write(`error: [${failed.error.code}] ${failed.error.message}\n`);
            }
          } else if (exit.reason === 'blocked' && !opts.json) {
            process.stderr.write(
              `experiment plan blocked (${exit.runStatus}) — restore quota/credentials and rerun: ` +
                `ideaseek experiment plan ${ideaId}\n`,
            );
          }

          const stored = await loadStoredPlan(runtime, ideaId, { inputHash });
          let eventSeq: number | null = null;
          if (exit.reason === 'completed' && stored && !stored.reused) {
            const run = await runtime.db.getLatestRun(runtime.project.id);
            if (run) {
              const event = await runtime.db.appendEvent({
                runId: run.runId,
                phase: 'EXPERIMENTING',
                objectId: ideaId,
                role: 'system',
                eventType: 'experiment_plan',
                summary:
                  `planned ${ideaId} v${stored.ideaVersion}: ${stored.plan.blocks.length} block(s) ` +
                  `scale=${stored.spec.scale} seeds=${stored.plan.seeds.join(',')} ` +
                  `(ARIS experiment-plan)`,
                status: 'planned',
              });
              eventSeq = event.seq;
            }
          }

          if (opts.json) {
            process.stdout.write(
              jsonLine({
                runId,
                ideaId,
                enqueued: created,
                reason: exit.reason,
                inputHash,
                skill: skillInfo,
                harness: kind,
                reused: stored?.reused ?? false,
                scale: stored?.spec.scale ?? null,
                spec: stored?.spec ?? null,
                blocks: stored?.plan.blocks.length ?? 0,
                mustRun:
                  stored?.plan.blocks.filter((block) => block.priority === 'MUST-RUN').length ?? 0,
                seeds: stored?.plan.seeds ?? [],
                budgetMinutes: stored?.plan.budgetMinutes ?? null,
                eventSeq,
              }),
            );
          } else if (exit.reason === 'completed' && stored) {
            process.stdout.write(
              `experiment plan: ${ideaId} (ARIS ${skill.name} @ ${skill.sha256.slice(0, 12)}, ` +
                `harness ${kind})\n`,
            );
            process.stdout.write(
              `  ${stored.plan.blocks.length} block(s) ` +
                `(${stored.plan.blocks.filter((block) => block.priority === 'MUST-RUN').length} must-run) · ` +
                `scale ${stored.spec.scale} · dataScale ${stored.plan.blocks[0]?.dataScale ?? '?'} · ` +
                `seeds ${stored.plan.seeds.join(',')} · budget ≤${stored.plan.budgetMinutes} min\n`,
            );
            process.stdout.write(
              `  spec ${stored.spec.specId} v${stored.spec.version} planned (${stored.spec.specHash.slice(0, 19)}…)\n`,
            );
            if (eventSeq !== null) process.stdout.write(`  event #${eventSeq} recorded\n`);
            process.stdout.write(
              `next: ideaseek experiment bridge ${ideaId}   (requires a passing ideaseek idea check)\n`,
            );
          }

          switch (exit.reason) {
            case 'completed':
              return 0;
            case 'failed':
              return 1;
            case 'canceled':
              return 4;
            case 'blocked':
              return 2;
            default:
              return exit.runStatus === 'RUNNING' ? 3 : 0;
          }
        } finally {
          await runtime.close();
        }
      }),
    );

  experiment
    .command('bridge')
    .description(
      'ARIS experiment-bridge: plan-gated execution (comparison gate + capacity admission → unified RunResult)',
    )
    .argument('<ideaId>', 'idea id')
    .option('--timeout <ms>', 'run timeout', (value) => Number(value), 120_000)
    .option('--resume', 'resume from the last compatible checkpoint (task-level recovery refuses)')
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (ideaId: string, opts: { timeout: number; resume?: boolean; json?: boolean }) => {
          const root = await openRoot();
          if (!Number.isFinite(opts.timeout) || opts.timeout < 100) {
            throw new IdeaseekError('INVALID_ARGUMENT', '--timeout must be >= 100 ms');
          }
          const { ProjectRuntime } = await import('../workflow/runtime.js');
          const runtime = await ProjectRuntime.open({ cwd: root });
          try {
            // Permission denial first: review-only never starts experiments.
            assertAutonomy(
              parseAutonomyMode(runtime.config.policy.autonomyMode),
              'start-experiment',
            );
            const { runExperimentBridge } = await import('../experiment/bridge.js');
            const result = await runExperimentBridge(
              root,
              ideaId,
              { timeoutMs: opts.timeout, resume: opts.resume },
              runtime,
            );

            if (result.outcome && !result.outcome.alreadyRecorded) {
              const mode = parseAutonomyMode(runtime.config.policy.autonomyMode);
              const check = checkAutonomy(mode, 'start-experiment');
              if (check.needsDecision) {
                const decision = await recordDecision(runtime.db, runtime.project.id, {
                  action: 'start-experiment',
                  target: `bridge ${ideaId} ${result.plan.scale}`,
                  mode,
                });
                if (decision && !opts.json) {
                  process.stdout.write(`  decision recorded (event #${decision.seq})\n`);
                }
              }
            }

            const outcome = result.outcome;
            if (opts.json) {
              process.stdout.write(
                jsonLine({
                  ideaId,
                  plan: result.plan,
                  gate: { ok: result.gate.ok, blocking: result.gate.blocking },
                  admitted: result.admitted,
                  queuedReason: result.queuedReason,
                  constraints: result.constraints,
                  specId: outcome?.specId ?? null,
                  version: outcome?.version ?? null,
                  attempt: outcome?.attempt ?? null,
                  alreadyRecorded: outcome?.alreadyRecorded ?? false,
                  resultStatus: outcome?.resultStatus ?? null,
                  metrics: outcome?.metrics ?? [],
                  failure: outcome?.failure ?? null,
                  statusAfter: outcome?.statusAfter ?? null,
                  eventSeq: result.eventSeq,
                }),
              );
              return result.admitted && outcome ? outcome.exitCode : 0;
            }

            if (!result.admitted) {
              process.stdout.write(
                `experiment bridge: ${ideaId} QUEUED by the capacity planner — ${result.queuedReason}\n`,
              );
              if (result.constraints.length > 0) {
                process.stdout.write(`  constraints: ${result.constraints.join(' · ')}\n`);
              }
              process.stdout.write(
                `  plan ${result.plan.inputHash.slice(0, 12)}… kept · nothing executed\n` +
                  `next: ideaseek capacity   (free GPU/disk or lower the request, then rerun)\n`,
              );
              return 0;
            }
            if (!outcome) return 0;

            process.stdout.write(
              `experiment bridge: ${ideaId} plan ${result.plan.inputHash.slice(0, 12)}… ` +
                `scale=${result.plan.scale} → ${outcome.specId} v${outcome.version}: ` +
                `${outcome.alreadyRecorded ? 'ALREADY RECORDED' : outcome.resultStatus === 'succeeded' ? 'SUCCEEDED' : 'FAILED'} ` +
                `→ ${outcome.statusAfter}\n`,
            );
            if (outcome.alreadyRecorded) {
              for (const metric of outcome.metrics) {
                process.stdout.write(`  ${metric.name} = ${metric.value}\n`);
              }
            } else if (outcome.resultStatus === 'succeeded') {
              for (const metric of outcome.metrics) {
                process.stdout.write(`  ${metric.name} = ${metric.value}\n`);
              }
            } else {
              process.stdout.write(
                `  failure: ${outcome.failure?.category}: ${outcome.failure?.summary ?? ''}\n`,
              );
              process.stdout.write(
                `next: fix and re-check, then walk back: ideaseek idea set-status ${ideaId} NEEDS_REVISION\n`,
              );
            }
            if (result.eventSeq !== null)
              process.stdout.write(`  event #${result.eventSeq} recorded\n`);
            if (outcome.resultStatus === 'succeeded') {
              process.stdout.write(
                `next: ideaseek idea ablate ${ideaId}   ·   ideaseek idea analyze ${ideaId}\n`,
              );
            }
            return outcome.exitCode;
          } finally {
            await runtime.close();
          }
        },
      ),
    );
}
