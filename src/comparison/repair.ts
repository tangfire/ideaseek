import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { sha256Of } from '../core/hash.js';
import { redactSecrets } from '../core/redact.js';
import { ensureDir, writeFileAtomic } from '../core/atomic.js';
import { runGit } from './importer.js';
import type {
  RepairAttempt,
  RepairChangeClass,
  RepairFailureKind,
  RepairRecord,
  RepairRoundOutcome,
} from './types.js';

/**
 * Baseline Repair engine (docs/plan.md §C.5–C.7): runs a method entry inside
 * its isolated worktree, classifies failures deterministically, applies only
 * safe environment fixes within a round budget, and records every round for
 * crash recovery. Algorithm-semantic changes are never auto-applied or
 * auto-accepted — code diffs are flagged for user confirmation.
 */

export interface RepairFailure {
  kind: RepairFailureKind;
  /** First matching log line (redacted, truncated). */
  summary: string;
}

/** Strips common credential shapes from logs before they are persisted. */
export { redactSecrets };

/**
 * Splits an entry command string into argv, honouring single/double quotes so
 * `python -c "import time; time.sleep(1)"` survives intact.
 */
export function parseEntryCommand(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    const token = match[1] ?? match[2] ?? match[3];
    if (token) out.push(token);
  }
  return out;
}

function firstMatchingLine(log: string, patterns: RegExp[]): string | null {
  for (const line of log.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (patterns.some((p) => p.test(trimmed))) {
      return redactSecrets(trimmed).slice(0, 200);
    }
  }
  return null;
}

/**
 * Deterministic failure taxonomy. Order matters: timeout first, then the most
 * specific Python/runtime signals, then generic fallbacks.
 */
export function classifyRepairFailure(
  log: string,
  exitCode: number,
  timedOut: boolean,
): RepairFailure {
  if (timedOut) {
    return { kind: 'timeout', summary: 'command timed out' };
  }
  const checks: { kind: RepairFailureKind; patterns: RegExp[] }[] = [
    {
      kind: 'missing-dependency',
      patterns: [
        /modulenotfounderror/i,
        /no module named/i,
        /cannot find module/i,
        /err_module_not_found/i,
        /\bimporterror\b/i,
        /command not found/i,
        /is not recognized as an internal or external command/i,
        /modulenotfoundexception/i,
      ],
    },
    {
      kind: 'path-error',
      patterns: [
        /filenotfounderror/i,
        /\berrno 2\b/i,
        /no such file or directory/i,
        /path not found/i,
        /系统找不到/i,
      ],
    },
    {
      kind: 'syntax-error',
      patterns: [/syntaxerror/i, /indentationerror/i, /invalid syntax/i, /parse error/i],
    },
    {
      kind: 'permission-error',
      patterns: [/permission denied/i, /\beacces\b/i, /access is denied/i],
    },
    {
      kind: 'device-error',
      patterns: [
        /out of memory/i,
        /cuda/i,
        /device-side assert/i,
        /no gpu/i,
        /torch\.cuda/i,
        /nvidia-smi/i,
        /mlu.*not found/i,
      ],
    },
  ];
  for (const check of checks) {
    const summary = firstMatchingLine(log, check.patterns);
    if (summary) return { kind: check.kind, summary };
  }
  const anyLine = log
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  return {
    kind: 'unknown',
    summary: anyLine
      ? `exit ${exitCode}: ${redactSecrets(anyLine).slice(0, 200)}`
      : `exit ${exitCode} with no output`,
  };
}

/** Parses `git status --porcelain` into repo-relative changed paths. */
export function parsePorcelainPaths(porcelain: string): string[] {
  const paths: string[] = [];
  for (const line of porcelain.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const body = line.slice(3);
    const path = body.includes(' -> ') ? body.split(' -> ').pop()! : body;
    paths.push(path.trim().replace(/^"|"$/g, ''));
  }
  return paths;
}

/** Generated/virtual artifacts that never count as a semantic diff. */
export function isGeneratedPath(path: string): boolean {
  return (
    /(^|\/)(\.venv|node_modules|__pycache__|\.pytest_cache|\.mypy_cache|build|dist)(\/|$)/.test(
      path,
    ) ||
    /\.pyc$/.test(path) ||
    /\.egg-info(\/|$)/.test(path) ||
    path === 'repair.json'
  );
}

/** Dependency/environment files whose edits are safe compatibility fixes. */
export function isEnvironmentFile(path: string): boolean {
  return /(^|\/)(requirements[^/]*\.txt|constraints[^/]*\.txt|environment[^/]*\.ya?ml|pyproject\.toml|setup\.(py|cfg)|Pipfile(\.lock)?|poetry\.lock|package\.json|package-lock\.json|yarn\.lock|conda\.ya?ml|Dockerfile[^/]*|[^/]*\.lock)$/i.test(
    path,
  );
}

/**
 * Classifies the worktree diff relative to baseline trust:
 * - `none`: no meaningful changes,
 * - `environment`: only dependency/packaging files changed,
 * - `code-review`: any source/config change → user confirmation required
 *   (plan §C.7: semantic changes must not pass as the original baseline).
 */
export function classifyChange(paths: string[]): RepairChangeClass {
  const meaningful = paths.filter((p) => !isGeneratedPath(p));
  if (meaningful.length === 0) return 'none';
  if (meaningful.every((p) => isEnvironmentFile(p))) return 'environment';
  return 'code-review';
}

export interface WorktreeDiff {
  paths: string[];
  patchHash: string | null;
  changeClass: RepairChangeClass;
}

/** Collects the worktree diff vs upstream HEAD (upstream itself stays clean). */
export async function collectWorktreeDiff(worktreeDir: string): Promise<WorktreeDiff> {
  const status = await runGit(['status', '--porcelain'], { cwd: worktreeDir, timeoutMs: 30_000 });
  if (status.code !== 0) {
    throw new IdeaseekError(
      'INVALID_STATE',
      `cannot read worktree status: ${status.out.slice(0, 200)}`,
    );
  }
  const diff = await runGit(['diff', 'HEAD'], { cwd: worktreeDir, timeoutMs: 30_000 });
  const paths = parsePorcelainPaths(status.out).filter((p) => !isGeneratedPath(p));
  const patchHash = paths.length > 0 ? sha256Of(`${status.out}\n---\n${diff.out}`) : null;
  return { paths, patchHash, changeClass: classifyChange(paths) };
}

export interface RunCommandResult {
  exitCode: number;
  timedOut: boolean;
  out: string;
  durationMs: number;
}

/** Runs argv in cwd with a hard timeout; no shell, secrets never passed. */
export function runRepairCommand(
  command: string[],
  cwd: string,
  timeoutMs: number,
  extraEnv?: Record<string, string>,
): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command[0]!, command.slice(1), {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
      });
    } catch (error) {
      reject(new IdeaseekError('ENV_UNSUPPORTED', String(error)));
      return;
    }
    let out = '';
    child.stdout?.on('data', (chunk) => (out += String(chunk)));
    child.stderr?.on('data', (chunk) => (out += String(chunk)));
    const started = Date.now();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        timedOut: false,
        out: `${out}\n[spawn failed: ${error.message}]`,
        durationMs: Date.now() - started,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? -1,
        timedOut,
        out,
        durationMs: Date.now() - started,
      });
    });
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function findRequirementsFile(worktreeDir: string): Promise<string | null> {
  for (const name of ['requirements.txt', 'requirements-locked.txt']) {
    if (await pathExists(join(worktreeDir, name))) return name;
  }
  return null;
}

export interface FixPlan {
  kind: 'none' | 'venv-install';
  detail: string;
}

/**
 * Chooses a safe, deterministic fix for a classified failure. Only
 * missing-dependency failures with a requirements file and no existing venv
 * get an automated fix; everything else stops the loop (no blind retries).
 */
export async function planFix(failure: RepairFailure, worktreeDir: string): Promise<FixPlan> {
  if (failure.kind !== 'missing-dependency') {
    return { kind: 'none', detail: `no automated fix for ${failure.kind}` };
  }
  const requirements = await findRequirementsFile(worktreeDir);
  if (!requirements) {
    return { kind: 'none', detail: 'no requirements file to install from' };
  }
  if (await pathExists(join(worktreeDir, '.venv'))) {
    return { kind: 'none', detail: 'venv already present; failure persists' };
  }
  return {
    kind: 'venv-install',
    detail: `python -m venv .venv && .venv pip install -r ${requirements}`,
  };
}

function venvPython(venvDir: string): string {
  return process.platform === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python');
}

function venvPathDir(venvDir: string): string {
  return process.platform === 'win32' ? join(venvDir, 'Scripts') : join(venvDir, 'bin');
}

/** Applies a planned fix inside the worktree only (never upstream/system). */
export async function applyFix(
  plan: FixPlan,
  worktreeDir: string,
  opts: { installTimeoutMs?: number; python?: string } = {},
): Promise<{ ok: boolean; detail: string }> {
  if (plan.kind !== 'venv-install') {
    return { ok: true, detail: plan.detail };
  }
  const venvDir = join(worktreeDir, '.venv');
  const python = opts.python ?? 'python';
  const create = await runRepairCommand([python, '-m', 'venv', '.venv'], worktreeDir, 180_000);
  if (create.exitCode !== 0) {
    // Some hosts only expose python3.
    const retry = await runRepairCommand(['python3', '-m', 'venv', '.venv'], worktreeDir, 180_000);
    if (retry.exitCode !== 0) {
      return {
        ok: false,
        detail: redactSecrets(`venv create failed: ${(retry.out || create.out).slice(-400)}`),
      };
    }
  }
  const requirements = await findRequirementsFile(worktreeDir);
  if (!requirements) {
    return { ok: false, detail: 'requirements file vanished before install' };
  }
  const install = await runRepairCommand(
    [
      venvPython(venvDir),
      '-m',
      'pip',
      'install',
      '-r',
      requirements,
      '--disable-pip-version-check',
    ],
    worktreeDir,
    opts.installTimeoutMs ?? 300_000,
  );
  if (install.exitCode !== 0) {
    return {
      ok: false,
      detail: redactSecrets(`pip install failed: ${install.out.slice(-400)}`),
    };
  }
  return { ok: true, detail: plan.detail };
}

/**
 * Prepends an existing worktree venv to PATH so entries resolve its python.
 * Only call after confirming `<worktree>/.venv` exists.
 */
export function venvEnv(worktreeDir: string): Record<string, string> {
  const dir = venvPathDir(join(worktreeDir, '.venv'));
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const sep = process.platform === 'win32' ? ';' : ':';
  const base = process.env[pathKey] ?? '';
  return { [pathKey]: `${dir}${sep}${base}` };
}

export interface ExecuteRepairInput {
  projectRoot: string;
  methodId: string;
  worktreeDir: string;
  entry: string[];
  maxRounds: number;
  timeoutMs: number;
  /** Crash-safe persistence; called after every round. */
  store: {
    load(): Promise<RepairRecord | null>;
    save(record: RepairRecord): Promise<void>;
  };
}

export interface ExecuteRepairResult {
  record: RepairRecord;
  /** Terminal reason the loop stopped. */
  outcome: RepairRoundOutcome;
  lastFailure: RepairFailure | null;
  roundsRun: number;
}

function isTerminal(outcome: RepairRoundOutcome): boolean {
  return outcome !== 'in-progress';
}

/**
 * Runs the repair loop: each round runs the entry, classifies a failure,
 * plans/applies a safe fix, and persists the attempt before continuing.
 * A terminal record from a previous session is reset (new session); an
 * in-progress record resumes at the next round (crash recovery).
 */
export async function executeRepair(input: ExecuteRepairInput): Promise<ExecuteRepairResult> {
  if (input.entry.length === 0) {
    throw new IdeaseekError('INVALID_ARGUMENT', 'repair entry command is empty');
  }
  if (input.maxRounds < 1 || input.maxRounds > 10) {
    throw new IdeaseekError('INVALID_ARGUMENT', '--rounds must be between 1 and 10');
  }
  const now = Date.now();
  let record = await input.store.load();
  if (!record || isTerminal(record.outcome)) {
    record = {
      methodId: input.methodId,
      budget: { maxRounds: input.maxRounds, timeoutMs: input.timeoutMs },
      startedAt: now,
      updatedAt: now,
      attempts: [],
      outcome: 'in-progress',
    };
  } else {
    // Resume: budget flags come from this invocation.
    record.budget = { maxRounds: input.maxRounds, timeoutMs: input.timeoutMs };
  }

  let lastFailure: RepairFailure | null = null;
  let roundsRun = 0;

  while (true) {
    const round = record.attempts.length + 1;
    if (round > record.budget.maxRounds) {
      record.outcome = 'blocked-budget';
      break;
    }
    // Recompute each round: a fix may have just created the venv.
    const venvReady = await pathExists(join(input.worktreeDir, '.venv'));
    const run = await runRepairCommand(
      input.entry,
      input.worktreeDir,
      record.budget.timeoutMs,
      venvReady ? venvEnv(input.worktreeDir) : undefined,
    );
    roundsRun += 1;
    const logName = `repair-${input.methodId}-r${round}.log`;
    const logPath = `.research/logs/${logName}`;
    await writeRepairLog(input.projectRoot, logName, input.entry, run.exitCode, run.out);

    if (run.exitCode === 0 && !run.timedOut) {
      record.attempts.push({
        round,
        at: Date.now(),
        durationMs: run.durationMs,
        command: input.entry,
        exitCode: 0,
        timedOut: false,
        fixApplied: 'none',
        logPath,
      });
      record.outcome = 'passed';
      record.updatedAt = Date.now();
      await input.store.save(record);
      break;
    }

    const failure = classifyRepairFailure(run.out, run.exitCode, run.timedOut);
    lastFailure = failure;
    const plan = await planFix(failure, input.worktreeDir);
    const attempt: RepairAttempt = {
      round,
      at: Date.now(),
      durationMs: run.durationMs,
      command: input.entry,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      failureKind: failure.kind,
      failureSummary: failure.summary,
      fixApplied: plan.kind,
      logPath,
    };
    record.attempts.push(attempt);
    record.updatedAt = Date.now();
    await input.store.save(record);

    if (plan.kind === 'none') {
      record.outcome = 'blocked-no-fix';
      break;
    }
    const applied = await applyFix(plan, input.worktreeDir);
    attempt.fixOk = applied.ok;
    attempt.fixDetail = applied.detail;
    record.updatedAt = Date.now();
    await input.store.save(record);
    if (!applied.ok) {
      record.outcome = 'blocked-fix-failed';
      break;
    }
    // Loop continues: next round re-runs the entry with the fix in place.
  }

  record.updatedAt = Date.now();
  await input.store.save(record);
  return { record, outcome: record.outcome, lastFailure, roundsRun };
}

/** File-backed store for comparisons/<id>/repair.json (atomic, per round). */
export function repairStore(
  projectRoot: string,
  methodId: string,
): { load(): Promise<RepairRecord | null>; save(record: RepairRecord): Promise<void> } {
  const path = join(projectRoot, 'comparisons', methodId, 'repair.json');
  return {
    async load() {
      try {
        const { readFile } = await import('node:fs/promises');
        const raw = await readFile(path, 'utf8');
        return JSON.parse(raw) as RepairRecord;
      } catch {
        return null;
      }
    },
    async save(record) {
      await ensureDir(join(projectRoot, 'comparisons', methodId));
      await writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
    },
  };
}

/** Writes the full redacted round log to .research/logs/. */
export async function writeRepairLog(
  projectRoot: string,
  fileName: string,
  command: string[],
  exitCode: number,
  out: string,
): Promise<string> {
  const dir = join(projectRoot, '.research', 'logs');
  await ensureDir(dir);
  const path = join(dir, fileName);
  await writeFileAtomic(
    path,
    `$ ${command.join(' ')}\n(exit ${exitCode})\n\n${redactSecrets(out)}`,
  );
  return path;
}

/** Guard: refuses to run repair against a missing worktree. */
export async function assertWorktree(worktreeDir: string): Promise<void> {
  try {
    const info = await stat(worktreeDir);
    if (!info.isDirectory()) throw new Error('not a directory');
  } catch {
    throw new IdeaseekError(
      'DEPENDENCY_NOT_MET',
      `worktree not found at ${worktreeDir}; import the method first`,
    );
  }
}
