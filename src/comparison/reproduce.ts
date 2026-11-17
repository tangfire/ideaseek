import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { sha256Of, type ContentHash } from '../core/hash.js';
import { redactSecrets } from '../core/redact.js';
import { metricKey } from '../core/metric-id.js';
import { ensureDir, writeFileAtomic } from '../core/atomic.js';
import {
  classifyRepairFailure,
  collectWorktreeDiff,
  runRepairCommand,
  writeRepairLog,
} from './repair.js';
import { stableJson } from '../experiment/spec.js';
import { RUN_ENV_KEYS, mergeRunEnv } from '../experiment/run-env.js';
import { validateRequirementSpec } from './dep-inference.js';
import type {
  RepairFailureKind,
  ReproductionBlueprint,
  ReproductionConfidence,
  ReproductionPhase,
  ReproductionPhaseResult,
  ReproductionRecord,
} from './types.js';

/**
 * Baseline Reproduction engine (docs/plan.md §C.7 / AGENT_ROLES): when no
 * official code exists, turn paper evidence + a structured blueprint into an
 * auditable reimplementation inside comparisons/<id>/worktree. There is no
 * upstream clone for a reimplementation — the platform never touches user
 * repositories. Every run records paper-explicit content, assumptions,
 * missing details, confidence and the code diff; a changed algorithm
 * fingerprint can only proceed with an explicit algorithm-modified flag.
 */

export const REPRODUCTION_PHASES: ReproductionPhase[] = [
  'brief',
  'generate',
  'check-code',
  'check-data',
  'check-metrics',
  'smoke',
  'record',
];

const CONFIDENCE_LEVELS: ReproductionConfidence[] = ['high', 'medium', 'low'];

export interface BlueprintValidation {
  ok: boolean;
  errors: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structural + evidence validation. Fails fast with no side effects so an
 * incomplete paper grounding never reaches the worktree (requirement:
 * 论文细节缺失 is an error, not a silent downgrade).
 */
export function validateReproductionBlueprint(
  value: unknown,
  opts: { methodId: string; paperRefs: string[] },
): BlueprintValidation {
  const errors: string[] = [];
  if (!isObject(value)) {
    return { ok: false, errors: ['blueprint must be an object'] };
  }
  if (value.methodId !== opts.methodId) {
    errors.push(
      `blueprint.methodId "${String(value.methodId)}" does not match --method ${opts.methodId}`,
    );
  }
  if (opts.paperRefs.length === 0) {
    errors.push(
      'method has no paperRefs — register the paper source first (comparison register --paper)',
    );
  }
  if (!Array.isArray(value.paperExplicit) || value.paperExplicit.length === 0) {
    errors.push('paperExplicit must list at least one paper-explicit statement');
  } else {
    for (const [i, entry] of value.paperExplicit.entries()) {
      if (!isObject(entry)) {
        errors.push(`paperExplicit[${i}] must be { statement, evidence }`);
        continue;
      }
      if (typeof entry.statement !== 'string' || !entry.statement.trim()) {
        errors.push(`paperExplicit[${i}].statement must be a non-empty string`);
      }
      if (typeof entry.evidence !== 'string' || !entry.evidence.trim()) {
        errors.push(`paperExplicit[${i}].evidence must cite a paper location`);
      }
    }
  }
  for (const field of ['assumptions', 'missingDetails'] as const) {
    const list = value[field];
    if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) {
      errors.push(`${field} must be an array of strings`);
    }
  }
  if (
    typeof value.confidence !== 'string' ||
    !CONFIDENCE_LEVELS.includes(value.confidence as never)
  ) {
    errors.push(`confidence must be one of ${CONFIDENCE_LEVELS.join(' | ')}`);
  }
  if (!isObject(value.algorithm)) {
    errors.push('algorithm block is required');
  } else {
    const algorithm = value.algorithm;
    if (algorithm.source !== undefined && typeof algorithm.source !== 'string') {
      errors.push('algorithm.source must be a string when present');
    }
    if (algorithm.entry !== undefined) {
      if (!Array.isArray(algorithm.entry) || algorithm.entry.some((c) => typeof c !== 'string')) {
        errors.push('algorithm.entry must be an argv array of strings');
      }
    }
    if (algorithm.requirements !== undefined) {
      if (!Array.isArray(algorithm.requirements)) {
        errors.push('algorithm.requirements must be an array of pip requirement specs');
      } else {
        for (const [i, spec] of algorithm.requirements.entries()) {
          if (typeof spec !== 'string' || !validateRequirementSpec(spec)) {
            errors.push(
              `algorithm.requirements[${i}] is not a bare requirement spec (got ${JSON.stringify(
                spec,
              )}): no flags, paths, URLs or shell`,
            );
          }
        }
      }
    }
    if (
      !isObject(algorithm.dataInterface) ||
      typeof algorithm.dataInterface.description !== 'string'
    ) {
      errors.push('algorithm.dataInterface.description is required');
    }
    if (!Array.isArray(algorithm.metrics) || algorithm.metrics.length === 0) {
      errors.push('algorithm.metrics must list at least one metric');
    } else {
      for (const [i, metric] of algorithm.metrics.entries()) {
        if (!isObject(metric) || typeof metric.name !== 'string' || !metric.name) {
          errors.push(`algorithm.metrics[${i}].name is required`);
        } else if (metric.direction !== 'higher' && metric.direction !== 'lower') {
          errors.push(`algorithm.metrics[${i}].direction must be higher | lower`);
        }
      }
    }
    if (algorithm.hyperparameters !== undefined && !isObject(algorithm.hyperparameters)) {
      errors.push('algorithm.hyperparameters must be an object');
    }
  }
  return { ok: errors.length === 0, errors };
}

export interface FingerprintInput {
  source: string;
  entry: string[];
  dataInterface: { description: string };
  metrics: unknown[];
  hyperparameters?: Record<string, unknown>;
}

/**
 * Semantic identity of the implementation: source + entry + data interface +
 * metrics + hyperparameters. A changed fingerprint is a potential algorithm
 * semantic change and requires --algorithm-modified (requirement 6).
 */
export function computeAlgorithmFingerprint(algorithm: FingerprintInput): ContentHash {
  return sha256Of(
    stableJson({
      source: algorithm.source,
      entry: algorithm.entry,
      dataInterface: algorithm.dataInterface,
      metrics: algorithm.metrics,
      hyperparameters: algorithm.hyperparameters ?? null,
    }),
  );
}

export function defaultEntry(algorithm: ReproductionBlueprint['algorithm']): string[] {
  if (Array.isArray(algorithm.entry) && algorithm.entry.length > 0) return [...algorithm.entry];
  return ['python', 'reproduce.py'];
}

/**
 * Resolves the implementation source. `--code` wins, then a program already in
 * the worktree (written by `comparison implement`), then the blueprint's inline
 * source. The worktree path exists so a plan can stay a plan: asking one JSON
 * response to carry both the blueprint and a 700-line program is what produced
 * truncated and non-compiling output.
 */
export async function resolveSource(
  blueprint: ReproductionBlueprint,
  codePath?: string,
  worktreeDir?: string,
): Promise<{ source: string; origin: string }> {
  if (codePath) {
    const { readFile } = await import('node:fs/promises');
    try {
      const source = await readFile(codePath, 'utf8');
      if (!source.trim()) {
        throw new IdeaseekError('INVALID_ARGUMENT', `code file ${codePath} is empty`);
      }
      return { source, origin: codePath };
    } catch (error) {
      if (error instanceof IdeaseekError) throw error;
      throw new IdeaseekError(
        'INVALID_ARGUMENT',
        `code generation failed: cannot read --code ${codePath}: ${(error as Error).message}`,
      );
    }
  }
  const inline = blueprint.algorithm.source;
  if (typeof inline === 'string' && inline.trim()) {
    return { source: inline, origin: 'blueprint.algorithm.source' };
  }
  if (worktreeDir) {
    const entryFile = defaultEntry(blueprint.algorithm).slice(-1)[0] ?? 'reproduce.py';
    const { readFile } = await import('node:fs/promises');
    const generated = await readFile(join(worktreeDir, entryFile), 'utf8').catch(() => null);
    if (generated?.trim()) {
      return { source: generated, origin: `worktree:${entryFile}` };
    }
    throw new IdeaseekError(
      'INVALID_ARGUMENT',
      `code generation failed: no implementation source. Generate one with: ideaseek comparison implement ${blueprint.methodId} --data <path> ` +
        '(or pass --code <file>, or set blueprint.algorithm.source)',
    );
  }
  throw new IdeaseekError(
    'INVALID_ARGUMENT',
    'code generation failed: no implementation source (provide --code <file> or blueprint.algorithm.source)',
  );
}

export function reproductionPath(projectRoot: string, methodId: string): string {
  return join(projectRoot, 'comparisons', methodId, 'reproduction.json');
}

export async function loadReproduction(
  projectRoot: string,
  methodId: string,
): Promise<ReproductionRecord | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    return JSON.parse(
      await readFile(reproductionPath(projectRoot, methodId), 'utf8'),
    ) as ReproductionRecord;
  } catch {
    return null;
  }
}

export async function saveReproduction(
  projectRoot: string,
  record: ReproductionRecord,
): Promise<void> {
  record.updatedAt = Date.now();
  const dir = join(projectRoot, 'comparisons', record.methodId);
  await ensureDir(dir);
  await writeFileAtomic(
    reproductionPath(projectRoot, record.methodId),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

export interface GenerateResult {
  written: string[];
  worktreeDir: string;
}

function renderReadme(
  blueprint: ReproductionBlueprint,
  opts: {
    fingerprint: string;
    algorithmModified: boolean;
    algorithmModifiedReason?: string;
    sourceOrigin: string;
    cardSources: string[];
    protocolId: string | null;
  },
): string {
  const lines: string[] = [
    `# Paper reimplementation — ${blueprint.methodId}`,
    '',
    '> sourceKind: **paper-reimplementation** — this is NOT official code.',
    `> algorithm fingerprint: \`${opts.fingerprint}\``,
    ...(opts.algorithmModified
      ? [
          `> **algorithm-modified**: ${opts.algorithmModifiedReason ?? 'declared by user'}`,
          '> results below belong to the revised method, not the original paper baseline.',
        ]
      : []),
    '',
    '## Paper-explicit content',
    '',
    ...blueprint.paperExplicit.map((item) => `- ${item.statement} — _${item.evidence}_`),
    '',
    '## Platform implementation assumptions',
    '',
    ...(blueprint.assumptions.length > 0
      ? blueprint.assumptions.map((item) => `- ${item}`)
      : ['- _none declared_']),
    '',
    '## Missing details (not specified by the paper)',
    '',
    ...(blueprint.missingDetails.length > 0
      ? blueprint.missingDetails.map((item) => `- ${item}`)
      : ['- _none_']),
    '',
    `## Reproduction confidence: **${blueprint.confidence}**`,
    '',
    `- code origin: ${opts.sourceOrigin}`,
    `- linked PaperCards: ${opts.cardSources.length > 0 ? opts.cardSources.join(', ') : 'none'}`,
    `- protocol: ${opts.protocolId ?? 'none'}`,
    `- data interface: ${blueprint.algorithm.dataInterface.description}`,
    `- metrics: ${blueprint.algorithm.metrics.map((m) => `${m.name}(${m.direction})`).join(', ')}`,
    `- hyperparameters: ${JSON.stringify(blueprint.algorithm.hyperparameters ?? {})}`,
    '',
    '## Validation contract (entry argv prefix, default `python reproduce.py`)',
    '',
    '```text',
    '<entry> check-data [--data PATH]  # exit 0 when the data interface holds',
    '<entry> check-metrics             # exit 0 when metrics are computable, on synthetic input:',
    '                                  # it must not load the corpus or train anything',
    '<entry> smoke                     # minimal run; prints {"metrics": {...}} JSON',
    '```',
    '',
    'Only check-data is handed a path. smoke and check-metrics must locate the corpus through',
    'IDEASEEK_DATA_PATH (the exact selection requested, injected into every phase), then',
    'IDEASEEK_DATASET_ROOTS (usable corpus roots, OS path-delimiter separated), then',
    'IDEASEEK_PROJECT_ROOT — never the working directory, which is this worktree and holds no data.',
    '',
    'Top-level module code must not execute on import (the platform imports it',
    'for the dependency check). Scale is smoke-only — no full training here.',
    '',
  ];
  return lines.join('\n');
}

/**
 * Writes the implementation + provenance README + plan snapshot into the
 * worktree and prepares a git repo (empty scaffold commit) so the generated
 * code is captured as a reviewable diff. No upstream directory exists for a
 * reimplementation — nothing user-owned is ever written.
 */
export async function generateWorktree(
  projectRoot: string,
  input: {
    methodId: string;
    blueprint: ReproductionBlueprint;
    source: string;
    sourceOrigin: string;
    fingerprint: string;
    algorithmModified: boolean;
    algorithmModifiedReason?: string;
    cardSources: string[];
    protocolId: string | null;
  },
): Promise<GenerateResult> {
  const worktreeDir = join(projectRoot, 'comparisons', input.methodId, 'worktree');
  await ensureDir(worktreeDir);

  const { runGit } = await import('./importer.js');
  const gitDir = join(worktreeDir, '.git');
  let hasGit = false;
  try {
    await stat(gitDir);
    hasGit = true;
  } catch {
    hasGit = false;
  }
  if (!hasGit) {
    const init = await runGit(['init'], { cwd: worktreeDir, timeoutMs: 60_000 });
    if (init.code !== 0) {
      throw new IdeaseekError(
        'INVALID_STATE',
        `cannot git-init reproduction worktree: ${init.out.slice(-300)}`,
      );
    }
    const commit = await runGit(
      [
        '-c',
        'user.name=ideaseek',
        '-c',
        'user.email=ideaseek@local',
        'commit',
        '--allow-empty',
        '-m',
        'reproduction scaffold (empty baseline for diff review)',
      ],
      { cwd: worktreeDir, timeoutMs: 60_000 },
    );
    if (commit.code !== 0) {
      throw new IdeaseekError(
        'INVALID_STATE',
        `cannot create scaffold commit: ${commit.out.slice(-300)}`,
      );
    }
  }

  const entry = defaultEntry(input.blueprint.algorithm);
  const entryScript = entry[1] && entry[1].endsWith('.py') ? entry[1] : 'reproduce.py';
  const written: string[] = [];
  const write = async (name: string, content: string) => {
    await writeFileAtomic(join(worktreeDir, name), content);
    written.push(name);
  };
  await write(entryScript, input.source);
  await write(
    'README.md',
    renderReadme(input.blueprint, {
      fingerprint: input.fingerprint,
      algorithmModified: input.algorithmModified,
      algorithmModifiedReason: input.algorithmModifiedReason,
      sourceOrigin: input.sourceOrigin,
      cardSources: input.cardSources,
      protocolId: input.protocolId,
    }),
  );
  await write('reproduction-plan.json', `${JSON.stringify(input.blueprint, null, 2)}\n`);
  return { written, worktreeDir };
}

/**
 * Feasibility between a locked protocol and an implementation's reported
 * metrics, by name only. The platform never decides what a metric should be —
 * it only checks that what the protocol measures can come from what the
 * implementation produces. Zero overlap is blocking: the run would emit a
 * reproducible number that cannot answer the question.
 */
/**
 * Metric names an implementation claims to report, taken from the blueprint.
 * Shared because both the authoring gate and the reproduce gate need the same
 * reading; three copies of `algorithm.metrics[].name` filtering is how the
 * previous two-source-of-truth defects kept appearing.
 */
export function blueprintMetricNames(blueprint: ReproductionBlueprint): string[] {
  return (blueprint.algorithm?.metrics ?? [])
    .map((metric) => metric.name)
    .filter((name) => typeof name === 'string' && name.trim());
}

/**
 * Comparable identity of a metric name.
 *
 * Protocol proposals put the definition inside the identifier — a locked FDG
 * metric is literally `target_unseen_domain_top1_accuracy (held-out domain
 * value, all samples, %)`. Comparing whole strings made the gate depend on
 * whether a model copied that prose exactly, so the same plan flipped between
 * covered and blocked across runs. The identifier is the part that has to
 * agree; the parenthetical is documentation. Tightening the contract itself is
 * tracked separately, because it needs a migrator for already-locked protocols.
 */
/** The name as it should be written: identifier only, definition dropped. */

export function checkMetricFeasibility(
  protocolMetrics: string[],
  implementationMetrics: string[],
): {
  status: 'no-protocol' | 'no-implementation-metrics' | 'blocked' | 'partial' | 'covered';
  covered: string[];
  uncovered: string[];
} {
  if (protocolMetrics.length === 0) {
    return { status: 'no-protocol', covered: [], uncovered: [] };
  }
  if (implementationMetrics.length === 0) {
    return { status: 'no-implementation-metrics', covered: [], uncovered: [...protocolMetrics] };
  }
  const implemented = new Set(implementationMetrics.map(metricKey));
  const covered = protocolMetrics.filter((name) => implemented.has(metricKey(name)));
  const uncovered = protocolMetrics.filter((name) => !implemented.has(metricKey(name)));
  if (covered.length === 0) return { status: 'blocked', covered, uncovered };
  return {
    status: uncovered.length > 0 ? 'partial' : 'covered',
    covered,
    uncovered,
  };
}

export interface CheckOptions {
  projectRoot: string;
  methodId: string;
  worktreeDir: string;
  entry: string[];
  /** Optional data path forwarded to `check-data --data <path>`. */
  dataPath?: string;
  timeoutMs: number;
  smokeTimeoutMs: number;
  /** Method venv and other per-check environment (see ensureMethodVenv). */
  extraEnv?: Record<string, string>;
  /** Called after each phase so crashes resume from the last OK phase. */
  onPhase: (record: ReproductionRecord) => Promise<void>;
}

/**
 * Environment for one entry invocation.
 *
 * `--data` reaches only check-data; smoke and check-metrics are called with no
 * path at all. A program that then looks in its working directory — the
 * worktree, which holds no data — reports an existing corpus as missing, which
 * is what happened on the first real reimplementation run. The specific
 * selection the caller asked for therefore travels through the environment too,
 * because argv cannot be extended for official code whose CLI is not ours.
 */
async function entryEnv(opts: CheckOptions): Promise<Record<string, string>> {
  return mergeRunEnv(opts.projectRoot, {
    ...opts.extraEnv,
    ...(opts.dataPath ? { [RUN_ENV_KEYS.dataPath]: opts.dataPath } : {}),
  });
}

async function pythonFiles(worktreeDir: string): Promise<string[]> {
  const names = await readdir(worktreeDir).catch(() => [] as string[]);
  return names.filter((name) => name.endsWith('.py'));
}

function moduleOf(entry: string[]): string | null {
  const script = entry[1];
  if (!script || !script.endsWith('.py')) return null;
  const base = script.replace(/\.py$/, '');
  return base.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Runs the validation ladder in order (code → data → metrics → smoke),
 * persisting each phase result before moving on. Stops at the first failure.
 */
export async function runValidationPhases(
  record: ReproductionRecord,
  opts: CheckOptions,
): Promise<ReproductionPhaseResult | null> {
  const done = new Set(record.completedPhases);

  const runPhase = async (
    phase: ReproductionPhase,
    command: string[],
    timeoutMs: number,
    classify: (log: string, exitCode: number, timedOut: boolean) => RepairFailureKind | null,
  ): Promise<ReproductionPhaseResult | null> => {
    if (done.has(phase)) return null;
    const started = Date.now();
    const run = await runRepairCommand(command, opts.worktreeDir, timeoutMs, await entryEnv(opts));
    const logName = `reproduce-${opts.methodId}-${phase}.log`;
    const logPath = `.research/logs/${logName}`;
    await writeRepairLog(opts.projectRoot, logName, command, run.exitCode, run.out);
    const failed = run.exitCode !== 0 || run.timedOut;
    const result: ReproductionPhaseResult = {
      phase,
      at: started,
      durationMs: Date.now() - started,
      exitCode: run.exitCode,
      ok: !failed,
      logPath,
    };
    if (failed) {
      const kind = classify(run.out, run.exitCode, run.timedOut);
      const classified = kind
        ? { kind }
        : classifyRepairFailure(run.out, run.exitCode, run.timedOut);
      result.failureKind = classified.kind;
      const firstLine = run.out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      result.summary = redactSecrets(
        run.timedOut ? `timed out after ${timeoutMs}ms` : (firstLine ?? `exit ${run.exitCode}`),
      ).slice(0, 300);
    }
    record.phases.push(result);
    if (result.ok) record.completedPhases.push(phase);
    else record.outcome = 'failed';
    await opts.onPhase(record);
    return failed ? result : null;
  };

  // 1. code check: py_compile every root *.py, then import the entry module.
  //    Both steps merge into ONE phase result so resume bookkeeping stays
  //    consistent (a failed import must not leave check-code "completed").
  if (!done.has('check-code')) {
    const phaseStarted = Date.now();
    const files = await pythonFiles(opts.worktreeDir);
    const fail = async (
      kind: RepairFailureKind,
      summary: string,
      exitCode: number,
      durationMs: number,
    ): Promise<ReproductionPhaseResult> => {
      const result: ReproductionPhaseResult = {
        phase: 'check-code',
        at: phaseStarted,
        durationMs,
        exitCode,
        ok: false,
        failureKind: kind,
        summary: redactSecrets(summary).slice(0, 300),
      };
      record.phases.push(result);
      record.outcome = 'failed';
      await opts.onPhase(record);
      return result;
    };

    if (files.length === 0) {
      return fail('syntax-error', 'no .py files generated in the worktree', 1, 0);
    }
    const compile = await runRepairCommand(
      [opts.entry[0] ?? 'python', '-m', 'py_compile', ...files],
      opts.worktreeDir,
      opts.timeoutMs,
    );
    await writeRepairLog(
      opts.projectRoot,
      `reproduce-${opts.methodId}-compile.log`,
      [opts.entry[0] ?? 'python', '-m', 'py_compile', ...files],
      compile.exitCode,
      compile.out,
    );
    if (compile.exitCode !== 0 || compile.timedOut) {
      const classified = classifyRepairFailure(compile.out, compile.exitCode, compile.timedOut);
      return fail(classified.kind, classified.summary, compile.exitCode, Date.now() - phaseStarted);
    }

    const mod = moduleOf(opts.entry);
    if (mod) {
      const importRun = await runRepairCommand(
        [opts.entry[0] ?? 'python', '-c', `import ${mod}`],
        opts.worktreeDir,
        opts.timeoutMs,
      );
      await writeRepairLog(
        opts.projectRoot,
        `reproduce-${opts.methodId}-import.log`,
        [opts.entry[0] ?? 'python', '-c', `import ${mod}`],
        importRun.exitCode,
        importRun.out,
      );
      if (importRun.exitCode !== 0 || importRun.timedOut) {
        const classified = classifyRepairFailure(
          importRun.out,
          importRun.exitCode,
          importRun.timedOut,
        );
        return fail(
          classified.kind,
          classified.summary,
          importRun.exitCode,
          Date.now() - phaseStarted,
        );
      }
    }

    record.phases.push({
      phase: 'check-code',
      at: phaseStarted,
      durationMs: Date.now() - phaseStarted,
      exitCode: 0,
      ok: true,
      logPath: `.research/logs/reproduce-${opts.methodId}-compile.log`,
    });
    record.completedPhases.push('check-code');
    await opts.onPhase(record);
  }

  // 2. data interface check.
  const dataCommand = [...opts.entry, 'check-data'];
  if (opts.dataPath) dataCommand.push('--data', opts.dataPath);
  const dataFail = await runPhase('check-data', dataCommand, opts.timeoutMs, () => null);
  if (dataFail) return dataFail;

  // 3. metric computability check.
  const metricsFail = await runPhase(
    'check-metrics',
    [...opts.entry, 'check-metrics'],
    opts.timeoutMs,
    () => null,
  );
  if (metricsFail) return metricsFail;

  return null;
}

export interface SmokeOutcome {
  metrics: { name: string; value: number }[];
  raw: string;
  /**
   * The scale the entry itself reported having run at.
   *
   * The platform asks for `smoke` by appending the word to the entry command,
   * which is a request, not evidence. #21 established the rule on the idea side
   * and this applies the same one here: the comparison record may only carry a
   * scale the program agreed to, otherwise a baseline would be paired with an
   * idea run by a number nobody verified — which is exactly how a smoke result
   * came to be recorded as a quick experiment once before.
   */
  reportedScale?: string;
  /** True when the entry confirmed the scale it was asked to run at. */
  scaleConfirmed: boolean;
}

/**
 * Runs the bounded smoke (scale=smoke — never full training) and parses the
 * `{"metrics": {...}}` line against the blueprint's metric list.
 */
export async function runSmoke(
  record: ReproductionRecord,
  opts: CheckOptions,
  expectedMetrics: { name: string; direction: string }[],
): Promise<{ failure: ReproductionPhaseResult | null; smoke: SmokeOutcome | null }> {
  if (record.completedPhases.includes('smoke')) {
    return {
      failure: null,
      // A resumed run has the metrics in its record but not the entry's own
      // output line, so the scale the program reported is genuinely unknown
      // here. Saying `false` rather than guessing `true` is the point: the
      // record must not claim a confirmation nobody observed.
      smoke: { metrics: record.smokeMetrics ?? [], raw: '', scaleConfirmed: false },
    };
  }
  const started = Date.now();
  const command = [...opts.entry, 'smoke'];
  const run = await runRepairCommand(
    command,
    opts.worktreeDir,
    opts.smokeTimeoutMs,
    await entryEnv(opts),
  );
  const logName = `reproduce-${opts.methodId}-smoke.log`;
  const logPath = `.research/logs/${logName}`;
  await writeRepairLog(opts.projectRoot, logName, command, run.exitCode, run.out);

  const base = {
    phase: 'smoke' as const,
    at: started,
    durationMs: Date.now() - started,
    exitCode: run.exitCode,
    logPath,
  };
  if (run.exitCode !== 0 || run.timedOut) {
    const classified = classifyRepairFailure(run.out, run.exitCode, run.timedOut);
    // When nothing matches a known failure shape, the entry's own last
    // diagnostic is the only explanation available, and it is otherwise hidden
    // three levels down in the log file. The first real smoke failure this ran
    // said "exit 2: unknown" while the program had printed exactly which
    // directories it had searched and what domains it expected.
    const ownWords = run.out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('{'))
      .reverse()
      .find((line) => /error|not found|missing|expected|cannot|no such/i.test(line));
    const summary = classified.summary.slice(0, 120);
    const failure: ReproductionPhaseResult = {
      ...base,
      ok: false,
      failureKind: run.timedOut ? 'timeout' : classified.kind,
      summary: run.timedOut
        ? `smoke timed out after ${opts.smokeTimeoutMs}ms`
        : classified.kind === 'unknown' && ownWords && !summary.includes(ownWords)
          ? `${summary} — ${ownWords.slice(0, 200)}`
          : classified.summary.slice(0, 300),
    };
    record.phases.push(failure);
    record.outcome = 'failed';
    await opts.onPhase(record);
    return { failure, smoke: null };
  }

  // Parse the last JSON line carrying {"metrics": {...}}.
  const lines = run.out.split(/\r?\n/).filter((line) => line.trim());
  let parsed: { metrics?: Record<string, unknown>; scale?: unknown } | null = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const candidate = JSON.parse(lines[i]!) as {
        metrics?: Record<string, unknown>;
        status?: unknown;
        scale?: unknown;
      };
      // A line that declares itself skipped, ephemeral or partial is not a
      // result even if it also carries numbers: generated code can report
      // metrics it never computed, and everything downstream would trust them.
      const declared = typeof candidate.status === 'string' ? candidate.status.toLowerCase() : '';
      if (
        candidate &&
        typeof candidate.metrics === 'object' &&
        candidate.metrics &&
        !/skip|ephemeral|partial|not run|unavailable/.test(declared)
      ) {
        parsed = candidate;
        break;
      }
    } catch {
      continue;
    }
  }
  if (!parsed) {
    const failure: ReproductionPhaseResult = {
      ...base,
      ok: false,
      failureKind: 'unknown',
      summary: 'smoke produced no {"metrics": {...}} JSON line',
    };
    record.phases.push(failure);
    record.outcome = 'failed';
    await opts.onPhase(record);
    return { failure, smoke: null };
  }

  const metrics: SmokeOutcome['metrics'] = [];
  const missing: string[] = [];
  const metricMap = parsed.metrics ?? {};
  for (const expected of expectedMetrics) {
    const value = metricMap[expected.name];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      missing.push(expected.name);
      continue;
    }
    metrics.push({ name: expected.name, value });
  }
  if (missing.length > 0) {
    const failure: ReproductionPhaseResult = {
      ...base,
      ok: false,
      failureKind: 'unknown',
      summary: `smoke metrics missing or non-finite: ${missing.join(', ')}`,
    };
    record.phases.push(failure);
    record.outcome = 'failed';
    await opts.onPhase(record);
    return { failure, smoke: null };
  }

  // Scale honesty, the same rule the idea side applies (#21). The word
  // `smoke` in the command line is what the platform ASKED for; only the
  // entry's own report says what it did. A record carrying an unverified scale
  // would let the analysis layer pair a baseline with an idea run "at the same
  // scale" on the strength of a hope.
  const reported = typeof parsed.scale === 'string' ? parsed.scale.trim().toLowerCase() : '';
  const asked = 'smoke';
  if (reported && reported !== asked) {
    const failure: ReproductionPhaseResult = {
      ...base,
      ok: false,
      failureKind: 'unknown',
      summary:
        `the entry reports scale="${reported}" but the platform ran it as smoke; the numbers ` +
        'cannot be recorded under a scale the program did not run. Make the entry honor its ' +
        'scale argument and report the value it used',
    };
    record.phases.push(failure);
    record.outcome = 'failed';
    await opts.onPhase(record);
    return { failure, smoke: null };
  }
  const success: ReproductionPhaseResult = { ...base, ok: true };
  record.phases.push(success);
  record.completedPhases.push('smoke');
  record.smokeMetrics = metrics;
  await opts.onPhase(record);
  return {
    failure: null,
    smoke: {
      metrics,
      raw: run.out.slice(-2000),
      reportedScale: reported || undefined,
      scaleConfirmed: reported === asked,
    },
  };
}

/** Worktree diff hash for the record (generated code is uncommitted by design). */
export async function reproductionPatchHash(worktreeDir: string): Promise<string | null> {
  try {
    const diff = await collectWorktreeDiff(worktreeDir);
    return diff.patchHash;
  } catch {
    return null;
  }
}
