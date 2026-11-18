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
import { inferDependencies } from '../comparison/dep-inference.js';
import { classifyFailureWithAgent } from '../comparison/failure-judge.js';
import {
  blueprintMetricNames,
  checkMetricFeasibility,
  computeAlgorithmFingerprint,
  defaultEntry,
  resolveSource,
  validateReproductionBlueprint,
} from '../comparison/reproduce.js';
import type {
  ComparisonMethod,
  ComparisonStatus,
  RepairFailureKind,
  RepairRecord,
  RepairSummary,
  ReproductionBlueprint,
  ReproductionPhase,
  ReproductionRecord,
  ReproductionSummary,
} from '../comparison/types.js';
import { exportMethodYaml } from './comparison.js';
import { assertEffectiveAutonomy } from '../workflow/autonomy.js';
import { buildHarness, resolveHarnessKind } from './shared.js';
import type { HarnessAdapter } from '../dsh/adapter.js';
import { action, jsonLine } from './shared.js';

async function openRuntime(root: string, harness?: HarnessAdapter) {
  const { ProjectRuntime } = await import('../workflow/runtime.js');
  return ProjectRuntime.open({ cwd: root, ...(harness ? { harness } : {}) });
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
    .option(
      '--harness <kind>',
      'agent harness for dependency inference: fake | dsh (default: dsh when a key is configured, else fake with a warning)',
    )
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (opts: {
          method: string;
          entry?: string;
          harness?: string;
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
          // Dependency inference is a model call; without a harness the repair
          // loop silently falls back to "no fix", which reads as a dead end.
          const runtime = await openRuntime(root, buildHarness(resolveHarnessKind(opts.harness)));
          try {
            await assertEffectiveAutonomy(root, runtime.config.policy.autonomyMode, 'write-code');
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
              pipIndexUrl: runtime.config.runtime.pipIndexUrl,
              projectRoot: root,
              methodId: current,
              worktreeDir,
              entry,
              maxRounds: opts.rounds,
              timeoutMs: opts.timeout,
              store: repairStore(root, current),
              // Repositories without a requirements file are the common case
              // in conference code; inference keeps repair general.
              allowNetworkInstall: runtime.config.runtime.allowNetwork,
              // Repairs can run before any research run exists; the harness
              // call still needs an attribution id, and inventing a run would
              // be worse than a clearly synthetic one.
              inferDependencies: runtime.harness
                ? async (failure, runOutput) =>
                    inferDependencies({
                      harness: runtime.harness!,
                      worktreeDir,
                      entry,
                      failureLog: runOutput || failure.summary,
                      runId:
                        (await runtime.db.getLatestRun(runtime.project.id))?.runId ??
                        `repair-${current}`,
                      taskId: `repair-${current}`,
                      now: Date.now(),
                    })
                : undefined,
              // Agent-first failure classification: the keyword table stays
              // as prior and fallback (see failure-judge.ts), so a configured
              // model may correct a misreading without ever being able to
              // override a fact or invent a kind.
              classifyFailure: runtime.harness
                ? async (log, exitCode, timedOut) =>
                    classifyFailureWithAgent({
                      harness: runtime.harness!,
                      log,
                      exitCode,
                      timedOut,
                      runId:
                        (await runtime.db.getLatestRun(runtime.project.id))?.runId ??
                        `repair-${current}`,
                      taskId: `repair-${current}-classify`,
                      now: Date.now(),
                    })
                : undefined,
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

  baseline
    .command('reproduce')
    .description(
      'generate an auditable paper reimplementation in the worktree and validate it (no official code)',
    )
    .requiredOption(
      '--method <methodId>',
      'comparison method id (sourceKind paper-reimplementation)',
    )
    .option(
      '--blueprint <path>',
      'reproduction blueprint JSON (default: comparisons/<id>/blueprint.json)',
    )
    .option('--code <path>', 'implementation .py file (overrides blueprint.algorithm.source)')
    .option('--data <path>', 'data path forwarded to `check-data --data <path>`')
    .option('--algorithm-modified', 'declare that semantics differ from the prior reproduction')
    .option('--reason <text>', 'required with --algorithm-modified')
    // Budgets sized for what the phases actually do. The earlier defaults came
    // from a numpy-only program: importing torch on a cold venv does not fit in
    // 60 s, and a first real timeout was indistinguishable from a hang.
    .option('--timeout <ms>', 'per-check command timeout', (value) => Number(value), 180_000)
    .option(
      '--smoke-timeout <ms>',
      'smoke command timeout (bounded real training, not a full run)',
      (value) => Number(value),
      600_000,
    )
    .option('--json', 'machine-readable output')
    .action(
      action(
        async (opts: {
          method: string;
          blueprint?: string;
          code?: string;
          data?: string;
          algorithmModified?: boolean;
          reason?: string;
          timeout: number;
          smokeTimeout: number;
          json?: boolean;
        }) => {
          const root = await openRoot();
          if (!Number.isFinite(opts.timeout) || opts.timeout < 100) {
            throw new IdeaseekError('INVALID_ARGUMENT', '--timeout must be >= 100 ms');
          }
          if (!Number.isFinite(opts.smokeTimeout) || opts.smokeTimeout < 100) {
            throw new IdeaseekError('INVALID_ARGUMENT', '--smoke-timeout must be >= 100 ms');
          }
          if (opts.algorithmModified && !(opts.reason && opts.reason.trim())) {
            throw new IdeaseekError(
              'USER_INPUT_REQUIRED',
              '--algorithm-modified requires --reason (semantic changes must be declared, never silent)',
            );
          }
          const runtime = await openRuntime(root);
          try {
            await assertEffectiveAutonomy(root, runtime.config.policy.autonomyMode, 'write-code');
            const prepared = await prepareReproduction(root, runtime, opts);
            return await executeReproduction(root, runtime, opts, prepared);
          } finally {
            await runtime.close();
          }
        },
      ),
    );
}

type ReproduceOpts = {
  method: string;
  blueprint?: string;
  code?: string;
  data?: string;
  algorithmModified?: boolean;
  reason?: string;
  timeout: number;
  smokeTimeout: number;
  json?: boolean;
};

interface PreparedReproduction {
  methodId: string;
  blueprint: ReproductionBlueprint;
  source: string;
  sourceOrigin: string;
  fingerprint: string;
  algorithmModified: boolean;
  algorithmModifiedReason?: string;
  entry: string[];
  cardSources: string[];
  protocolId: string | null;
}

/**
 * Fail-fast preparation: contract checks, blueprint validation and source
 * resolution all happen BEFORE any status transition or worktree write, so a
 * missing paper grounding or missing code never leaves partial state.
 */
async function prepareReproduction(
  root: string,
  runtime: Awaited<ReturnType<typeof openRuntime>>,
  opts: ReproduceOpts,
): Promise<PreparedReproduction> {
  const doc = await runtime.db.getComparison(opts.method);
  if (!doc) throw new IdeaseekError('TASK_NOT_FOUND', `comparison ${opts.method} not found`);
  const method = toMethod(doc.record);

  if (method.sourceKind !== 'paper-reimplementation') {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `${opts.method} is sourceKind=${method.sourceKind}; reproduction only applies to paper-reimplementation methods` +
        (method.sourceKind === 'official-code'
          ? ' — official code uses: ideaseek baseline repair --method ' + opts.method
          : ''),
    );
  }
  const upstreamDir = join(root, 'comparisons', opts.method, 'upstream');
  try {
    await (await import('node:fs/promises')).stat(upstreamDir);
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `${opts.method} has an upstream/ clone — official code present, use ideaseek baseline repair`,
    );
  } catch (error) {
    if (error instanceof IdeaseekError) throw error;
    // no upstream → continue
  }

  const REPRODUCIBLE: readonly ComparisonStatus[] = [
    'candidate',
    'accepted',
    'source-resolved',
    'implemented',
    'repairing',
    'blocked',
    'smoke-tested',
  ];
  if (!REPRODUCIBLE.includes(method.status)) {
    throw new IdeaseekError(
      'INVALID_STATE',
      `cannot reproduce ${opts.method} from status ${method.status}; ` +
        `use set-status to move it back to repairing first`,
      { status: method.status },
    );
  }

  const blueprintPath = opts.blueprint ?? join(root, 'comparisons', opts.method, 'blueprint.json');
  const { readFile } = await import('node:fs/promises');
  let raw: string;
  try {
    raw = await readFile(blueprintPath, 'utf8');
  } catch (error) {
    throw new IdeaseekError(
      'FILE_NOT_FOUND',
      `cannot read blueprint ${blueprintPath}: ${(error as Error).message}`,
    );
  }
  let blueprintValue: unknown;
  try {
    blueprintValue = JSON.parse(raw);
  } catch (error) {
    throw new IdeaseekError(
      'PARSE_FAILED',
      `blueprint ${blueprintPath} is not valid JSON: ${(error as Error).message}`,
    );
  }
  const validation = validateReproductionBlueprint(blueprintValue, {
    methodId: opts.method,
    paperRefs: method.paperRefs,
  });
  if (!validation.ok) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `incomplete paper grounding: ${validation.errors.join('; ')}`,
    );
  }
  const blueprint = blueprintValue as ReproductionBlueprint;

  // Same deterministic path generateWorktree uses, so an implementation
  // written by `comparison implement` is found here without a second copy of
  // the path logic drifting.
  const { source, origin } = await resolveSource(
    blueprint,
    opts.code,
    join(root, 'comparisons', opts.method, 'worktree'),
  );
  const entry = defaultEntry(blueprint.algorithm);
  if (origin === 'code-path') {
    // A hand-supplied program is the one source that never passed the
    // authoring gates. If it cannot parse, the four reproduction checks all
    // fail on the same missing colon and the diagnosis points at the method.
    const { checkPythonSyntax } = await import('../knowledge/materialize.js');
    const { mkdtemp, writeFile: writeTmp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const scratch = await mkdtemp(join(tmpdir(), 'ideaseek-code-gate-'));
    const probe = join(scratch, 'candidate.py');
    try {
      await writeTmp(probe, source, 'utf8');
      const syntax = await checkPythonSyntax(probe);
      if (!syntax.ok) {
        throw new IdeaseekError(
          'INVALID_ARTIFACT',
          `the program passed with --code does not compile: line ${syntax.line}: ${syntax.message} — fix the file; the blueprint and worktree were not touched`,
        );
      }
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  const fingerprint = computeAlgorithmFingerprint({
    source,
    entry,
    dataInterface: blueprint.algorithm.dataInterface,
    metrics: blueprint.algorithm.metrics,
    hyperparameters: blueprint.algorithm.hyperparameters,
  });

  const { loadReproduction } = await import('../comparison/reproduce.js');
  const prior = await loadReproduction(root, opts.method);
  const algorithmModified = opts.algorithmModified === true;
  const algorithmModifiedReason = opts.reason?.trim();
  if (prior && prior.fingerprint !== fingerprint && !algorithmModified) {
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `algorithm semantics changed since the last reproduction (fingerprint ${prior.fingerprint.slice(0, 12)}… → ${fingerprint.slice(0, 12)}…); ` +
        'pass --algorithm-modified --reason "<why>" so results cannot pose as the original method',
    );
  }
  if (algorithmModified && !algorithmModifiedReason) {
    throw new IdeaseekError('USER_INPUT_REQUIRED', '--algorithm-modified requires --reason');
  }

  // PaperCards linked by paper id / source path (recorded, not required).
  const { loadCards } = await import('../knowledge/cards.js');
  const cards = await loadCards(runtime).catch(() => []);
  const cardSources = cards
    .filter(
      (loaded) =>
        method.paperRefs.includes(String(loaded.card.paper_id ?? '')) ||
        method.paperRefs.includes(loaded.source),
    )
    .map((loaded) => loaded.source);

  // Protocol linkage plus a feasibility check: the locked protocol names the
  // metrics a conclusion must be measured in, and an implementation that
  // produces none of them can still emit a confident-looking number that means
  // nothing. Comparing name sets keeps this domain-neutral — the platform never
  // decides what a metric should be.
  // Read through the same module `comparison blueprint` uses; this block used
  // to parse the artifact itself and count only primaryMetrics, so the two
  // gates could disagree about what the protocol demands.
  const { protocolMetricNames, readLockedProtocol } =
    await import('../experiment/protocol-source.js');
  const storedProtocol = await readLockedProtocol(runtime);
  const protocolId = storedProtocol?.protocolId ?? null;
  const protocolMetrics = protocolMetricNames(storedProtocol);

  const implementationMetrics = blueprintMetricNames(blueprint);
  const feasibility = checkMetricFeasibility(protocolMetrics, implementationMetrics);
  if (feasibility.status === 'blocked') {
    throw new IdeaseekError(
      'USER_INPUT_REQUIRED',
      `the locked protocol measures [${protocolMetrics.join(', ')}] but this implementation reports ` +
        `[${implementationMetrics.join(', ')}] — none of the protocol's metrics can come from it. ` +
        'Reproduce would produce numbers that cannot answer the protocol, so it is blocked: ' +
        'widen the implementation, or revise the protocol metrics with a new confirmed version.',
      { protocolMetrics, implementationMetrics },
    );
  }
  if (feasibility.status === 'partial') {
    process.stderr.write(
      `feasibility: implementation covers ${feasibility.covered.length}/${protocolMetrics.length} ` +
        `protocol metrics — missing [${feasibility.uncovered.join(', ')}]; ` +
        'results will be partial against the protocol\n',
    );
  }

  return {
    methodId: opts.method,
    blueprint,
    source,
    sourceOrigin: origin,
    fingerprint,
    algorithmModified,
    algorithmModifiedReason,
    entry,
    cardSources,
    protocolId,
  };
}

async function executeReproduction(
  root: string,
  runtime: Awaited<ReturnType<typeof openRuntime>>,
  opts: ReproduceOpts,
  prepared?: PreparedReproduction,
): Promise<number> {
  const prep = prepared ?? (await prepareReproduction(root, runtime, opts));
  const { methodId, blueprint, fingerprint, entry } = prep;

  // --- status discipline: reach source-resolved before generation.
  const doc = (await runtime.db.getComparison(methodId))!;
  let status = doc.status as ComparisonStatus;
  if (status === 'candidate') {
    await runtime.db.transitionComparison(methodId, 'accepted', 'reproduction approved');
    status = 'accepted';
  }
  if (status === 'accepted') {
    await runtime.db.transitionComparison(
      methodId,
      'source-resolved',
      'paper source + blueprint resolved',
    );
    status = 'source-resolved';
  }

  // --- record: resume an in-progress session with the same fingerprint.
  const {
    loadReproduction,
    saveReproduction,
    generateWorktree,
    runValidationPhases,
    runSmoke,
    reproductionPatchHash,
  } = await import('../comparison/reproduce.js');
  const prior = await loadReproduction(root, methodId);
  const resume =
    prior !== null && prior.outcome === 'in-progress' && prior.fingerprint === fingerprint;
  const now = Date.now();
  const record: ReproductionRecord = resume
    ? {
        ...prior!,
        algorithmModified: prior!.algorithmModified || prep.algorithmModified,
        algorithmModifiedReason: prep.algorithmModifiedReason ?? prior!.algorithmModifiedReason,
      }
    : {
        methodId,
        fingerprint,
        outcome: 'in-progress',
        startedAt: now,
        updatedAt: now,
        completedPhases: ['brief'],
        phases: [],
        paperExplicit: blueprint.paperExplicit,
        assumptions: blueprint.assumptions,
        missingDetails: blueprint.missingDetails,
        confidence: blueprint.confidence,
        algorithmModified: prep.algorithmModified,
        algorithmModifiedReason: prep.algorithmModifiedReason,
        cardSources: prep.cardSources,
        protocolId: prep.protocolId,
        patchHash: null,
        specId: null,
      };
  await saveReproduction(root, record);

  const onPhase = (r: ReproductionRecord) => saveReproduction(root, r);
  const printFailure = (failed: {
    phase: ReproductionPhase;
    failureKind?: RepairFailureKind;
    summary?: string;
    logPath?: string;
  }): void => {
    if (opts.json) {
      process.stdout.write(
        jsonLine({
          methodId,
          outcome: 'failed',
          failedPhase: failed.phase,
          failureKind: failed.failureKind ?? null,
          summary: failed.summary ?? null,
          logPath: failed.logPath ?? null,
        }),
      );
    } else {
      process.stdout.write(
        `reproduce ${methodId}: FAILED at ${failed.phase} (${failed.failureKind ?? 'unknown'})\n`,
      );
      process.stdout.write(`  ${failed.summary ?? ''}\n`);
      if (failed.logPath) process.stdout.write(`  log: ${failed.logPath}\n`);
      process.stdout.write(
        `next: fix the implementation, then rerun: ideaseek baseline reproduce --method ${methodId}\n`,
      );
    }
  };

  // Mirror a failure into the method record + status graph (plan §C.7:
  // failures are recorded, never silent).
  const failMethod = async (failed: {
    phase: ReproductionPhase;
    failureKind?: RepairFailureKind;
    summary?: string;
  }): Promise<void> => {
    const current = (await runtime.db.getComparison(methodId))!;
    const currentStatus = current.status as ComparisonStatus;
    const summary: ReproductionSummary = {
      outcome: 'failed',
      failedPhase: failed.phase,
      failureKind: failed.failureKind ?? null,
      confidence: blueprint.confidence,
      algorithmModified: record.algorithmModified,
      fingerprint,
      patchHash: null,
      specId: null,
      updatedAt: Date.now(),
    };
    const reason = truncateReason(
      `reproduction ${failed.phase} failed: ${failed.failureKind ?? 'unknown'} - ${failed.summary ?? ''}`,
    );
    await runtime.db.upsertComparison({
      methodId,
      status: currentStatus,
      required: current.required,
      record: {
        ...toMethod(current.record),
        reproduction: summary,
        statusReason: reason,
        updatedAt: summary.updatedAt,
      } as unknown as Record<string, unknown>,
      updatedAt: summary.updatedAt,
    });
    if (currentStatus === 'source-resolved' || currentStatus === 'smoke-tested') {
      await runtime.db.transitionComparison(
        methodId,
        currentStatus === 'smoke-tested' ? 'repairing' : 'blocked',
        reason,
      );
    } else if (currentStatus === 'implemented') {
      await runtime.db.transitionComparison(methodId, 'repairing', reason);
    }
    // repairing / blocked keep their status; reason already recorded above.
    const finalDoc = await runtime.db.getComparison(methodId);
    if (finalDoc) await exportMethodYaml(root, toMethod(finalDoc.record));
  };

  try {
    // --- generate (skipped when resuming past it).
    if (!record.completedPhases.includes('generate')) {
      const generated = await generateWorktree(root, {
        methodId,
        blueprint,
        source: prep.source,
        sourceOrigin: prep.sourceOrigin,
        fingerprint,
        algorithmModified: record.algorithmModified,
        algorithmModifiedReason: record.algorithmModifiedReason,
        cardSources: prep.cardSources,
        protocolId: prep.protocolId,
      });
      void generated;
      record.completedPhases.push('generate');
      await onPhase(record);
    }
  } catch (error) {
    const message = (error as Error).message;
    record.outcome = 'failed';
    record.phases.push({
      phase: 'generate',
      at: Date.now(),
      durationMs: 0,
      exitCode: 1,
      ok: false,
      failureKind: 'unknown',
      summary: message.slice(0, 300),
    });
    await onPhase(record);
    await failMethod({ phase: 'generate', failureKind: 'unknown', summary: message });
    printFailure({
      phase: 'generate',
      failureKind: 'unknown',
      summary: message,
    });
    return 1;
  }

  const worktreeDir = join(root, 'comparisons', methodId, 'worktree');
  // Checks run inside the worktree, so a relative --data would resolve
  // against the wrong root and the method would truthfully report zero
  // samples instead of "path not found". Resolve against the project and
  // refuse a path that does not exist.
  let dataPath = opts.data;
  if (dataPath) {
    const { stat } = await import('node:fs/promises');
    const { isAbsolute, resolve: resolvePath } = await import('node:path');
    const absolute = isAbsolute(dataPath) ? dataPath : resolvePath(root, dataPath);
    const info = await stat(absolute).catch(() => null);
    if (!info) {
      throw new IdeaseekError(
        'FILE_NOT_FOUND',
        `--data path does not exist: ${dataPath} (looked at ${absolute})`,
      );
    }
    dataPath = absolute;
  }

  // Dependencies come from two places: what the blueprint declares, and what
  // the code it ships actually imports. Union them — a declaration that
  // contradicts the source is surfaced, not silently preferred, because either
  // side can be the wrong one.
  const { deriveRequirementsForWorktree } = await import('../comparison/dep-inference.js');
  const declared = (blueprint.algorithm?.requirements ?? []).filter(
    (spec) => typeof spec === 'string' && spec.trim(),
  );
  const derived = await deriveRequirementsForWorktree(
    blueprint.algorithm?.source ?? '',
    worktreeDir,
  );
  const requirements = [...new Set([...declared, ...derived])].sort();
  let extraEnv: Record<string, string> | undefined;
  if (requirements.length > 0) {
    const mismatch =
      declared.length > 0 && derived.length > 0
        ? derived.filter((spec) => !declared.includes(spec))
        : [];
    process.stderr.write(
      `method venv: installing ${requirements.length} package(s) [${requirements.join(', ')}]` +
        (mismatch.length > 0
          ? ` — blueprint did not declare: ${mismatch.join(', ')}`
          : declared.length === 0
            ? ' (derived from the implementation imports)'
            : '') +
        '\n',
    );
    const { ensureMethodVenv, venvEnv } = await import('../comparison/repair.js');
    const venv = await ensureMethodVenv(worktreeDir, {
      packages: requirements,
      pipIndexUrl: runtime.config.runtime.pipIndexUrl,
    });
    if (!venv.ok) {
      // An unavailable dependency is what the validation phases are built to
      // classify (missing-dependency → blocked, resumable). Turning the helper
      // into a hard precondition would replace that report with an abort.
      process.stderr.write(
        `warning: method venv could not be built: ${venv.detail}\n` +
          '  continuing without it; the checks will classify the missing dependency instead\n',
      );
    } else {
      extraEnv = venvEnv(worktreeDir);
    }
  }

  const checkOpts = {
    projectRoot: root,
    methodId,
    worktreeDir,
    entry,
    dataPath,
    timeoutMs: opts.timeout,
    smokeTimeoutMs: opts.smokeTimeout,
    extraEnv,
    onPhase,
  };

  const failedPhase = await runValidationPhases(record, checkOpts);
  if (failedPhase) {
    await failMethod(failedPhase);
    printFailure(failedPhase);
    return 1;
  }

  const { failure: smokeFailure, smoke } = await runSmoke(
    record,
    checkOpts,
    blueprint.algorithm.metrics,
  );
  if (smokeFailure) {
    await failMethod(smokeFailure);
    printFailure(smokeFailure);
    return 1;
  }

  // --- success: patch hash, validated record, status walk, spec + result.
  const patchHash = await reproductionPatchHash(worktreeDir);
  record.outcome = 'validated';
  record.patchHash = patchHash;
  if (!record.completedPhases.includes('record')) record.completedPhases.push('record');

  const methodNow = toMethod((await runtime.db.getComparison(methodId))!.record);
  const summary: ReproductionSummary = {
    outcome: 'validated',
    failedPhase: null,
    failureKind: null,
    confidence: blueprint.confidence,
    algorithmModified: record.algorithmModified,
    fingerprint,
    patchHash,
    specId: `repro-${methodId}`,
    updatedAt: Date.now(),
  };
  const notes = [...methodNow.notes];
  if (record.algorithmModified && !notes.some((n) => n.startsWith('algorithm-modified:'))) {
    notes.push(
      `algorithm-modified: ${record.algorithmModifiedReason ?? 'declared'} (results are a revised method, not the original baseline)`,
    );
  }
  await runtime.db.upsertComparison({
    methodId,
    status: methodNow.status,
    required: methodNow.required,
    record: {
      ...methodNow,
      entry,
      reproduction: summary,
      notes,
      statusReason: undefined,
      updatedAt: summary.updatedAt,
    } as unknown as Record<string, unknown>,
    updatedAt: summary.updatedAt,
  });

  // Legal walk to smoke-tested from wherever the session started.
  let walk = (await runtime.db.getComparison(methodId))!.status as ComparisonStatus;
  const hop = async (to: ComparisonStatus, reason?: string) => {
    if (walk === to) return;
    await runtime.db.transitionComparison(methodId, to, reason);
    walk = to;
  };
  if (walk === 'blocked') {
    await hop('source-resolved', 'reproduction validated');
    await hop('implemented', 'reimplementation generated and checked');
    await hop('smoke-tested');
  } else if (walk === 'source-resolved') {
    await hop('implemented', 'reimplementation generated and checked');
    await hop('smoke-tested');
  } else if (walk === 'implemented' || walk === 'repairing') {
    await hop('smoke-tested');
  }
  // smoke-tested and beyond: no status change.

  record.specId = `repro-${methodId}`;
  await saveReproduction(root, record);

  // --- unified ExperimentSpec/RunResult attachment (scale=smoke only).
  const { computeSpecHash, validateExperimentSpec } = await import('../experiment/spec.js');
  const specId = `repro-${methodId}`;
  const existingSpec = await runtime.db.getExperiment(specId);
  const spec = {
    specId,
    version: existingSpec ? existingSpec.version : 1,
    idea: null,
    comparisonIds: [methodId],
    codeCommit: null,
    dataSnapshotId: opts.data
      ? `local:${opts.data.split(/[\\/]/).pop() ?? 'data'}`
      : 'synthetic:reproduction-fixture',
    sliceIds: [],
    environment: {
      python: process.version,
      notes: [
        `paper-reproduction smoke (scale=smoke)`,
        `algorithm-fingerprint:${fingerprint}`,
        // Read by `scaleOf()` in the analysis layer, which is what pairs a
        // baseline with an idea run. Without a `scale:` note here the value is
        // permanently "unknown", so a same-scale comparison is impossible by
        // construction and the ladder can only ever compare across scales —
        // which is the methodological error the pairing rule exists to stop.
        // Added only on the entry's own confirmation (#21), never because the
        // platform asked for smoke.
        ...(smoke?.scaleConfirmed ? [`scale:${smoke.reportedScale ?? 'smoke'}`] : []),
      ],
    },
    command: [...entry, 'smoke'],
    metrics: blueprint.algorithm.metrics,
    seeds: [42],
    resources: {},
    budget: { maxMinutes: 5 },
    protocolId: prep.protocolId,
    createdAt: Date.now(),
  };
  const specValidation = validateExperimentSpec(spec);
  if (!specValidation.ok) {
    // The reproduction itself succeeded; a spec problem is reported but does
    // not invalidate the validated record.
    process.stderr.write(
      `warning: experiment spec not recorded: ${specValidation.errors.join('; ')}\n`,
    );
  } else {
    const specHash = computeSpecHash(spec);
    const hashChanged = existingSpec !== null && existingSpec.specHash !== specHash;
    const nextVersion = existingSpec
      ? hashChanged
        ? existingSpec.version + 1
        : existingSpec.version
      : 1;
    spec.version = nextVersion;
    const finalHash = computeSpecHash(spec);
    await runtime.db.upsertExperiment({
      specId,
      version: nextVersion,
      specHash: finalHash,
      status:
        existingSpec && existingSpec.specHash === finalHash && existingSpec.result
          ? existingSpec.status
          : 'planned',
      spec: spec as unknown as Record<string, unknown>,
      result: existingSpec && existingSpec.specHash === finalHash ? existingSpec.result : null,
      updatedAt: Date.now(),
    });
    const currentSpec = await runtime.db.getExperiment(specId);
    if (currentSpec && !currentSpec.result && smoke) {
      const startedAt = Math.min(...record.phases.map((p) => p.at), Date.now());
      await runtime.db.attachExperimentResult(
        specId,
        {
          specId,
          status: 'succeeded',
          logRefs: [`.research/logs/reproduce-${methodId}-smoke.log`],
          artifactRefs: [],
          metrics: smoke.metrics,
          resourcesUsed: {},
          failure: null,
          startedAt,
          finishedAt: Date.now(),
          explanation: `reproduction smoke (scale=smoke), confidence=${blueprint.confidence}${record.algorithmModified ? ', algorithm-modified' : ''}`,
        } as unknown as Record<string, unknown>,
        'succeeded',
      );
    }
  }

  const finalDoc = await runtime.db.getComparison(methodId);
  if (finalDoc) await exportMethodYaml(root, toMethod(finalDoc.record));

  const finalStatus = finalDoc?.status ?? 'smoke-tested';
  if (opts.json) {
    process.stdout.write(
      jsonLine({
        methodId,
        outcome: 'validated',
        status: finalStatus,
        confidence: blueprint.confidence,
        algorithmModified: record.algorithmModified,
        fingerprint,
        patchHash,
        specId: record.specId,
        phases: record.phases.map((p) => ({ phase: p.phase, ok: p.ok, exitCode: p.exitCode })),
        smokeMetrics: smoke?.metrics ?? [],
        missingDetails: blueprint.missingDetails.length,
        assumptions: blueprint.assumptions.length,
      }),
    );
  } else {
    process.stdout.write(
      `reproduce ${methodId}: VALIDATED → ${finalStatus} (confidence=${blueprint.confidence}${record.algorithmModified ? ', algorithm-modified' : ''})\n`,
    );
    for (const phase of record.phases) {
      process.stdout.write(
        `  ${phase.ok ? 'ok  ' : 'FAIL'} ${phase.phase.padEnd(14)} ${phase.durationMs}ms${phase.failureKind ? `  ${phase.failureKind}` : ''}\n`,
      );
    }
    process.stdout.write(`  worktree: ${worktreeDir}\n`);
    process.stdout.write(`  patch: ${patchHash ?? '(none)'}\n`);
    process.stdout.write(
      `  spec: ${record.specId} v${spec?.version ?? 1} + smoke result attached\n`,
    );
    process.stdout.write(
      `  paper-explicit ${blueprint.paperExplicit.length} · assumptions ${blueprint.assumptions.length} · missing ${blueprint.missingDetails.length}\n`,
    );
    process.stdout.write(
      'next: ideaseek comparison gate   (quick/standard runs stay hands-off; no full training here)\n',
    );
  }
  return 0;
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
