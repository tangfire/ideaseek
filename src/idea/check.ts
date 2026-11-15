import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensureDir, writeFileAtomic } from '../core/atomic.js';
import { classifyRepairFailure, runRepairCommand, writeRepairLog } from '../comparison/repair.js';
import { hashIdeaSource, ideaDir, loadIdeaCard, loadWorkspaceMeta } from './workspace.js';
import type { IdeaCard } from './card.js';

/**
 * Code Implementer gate (docs/plan.md §E.3): idea code must pass static
 * checks, unit tests, data/metric interface checks and a tiny smoke run
 * BEFORE any experiment queue entry. All steps are deterministic subprocesses
 * over ideas/<id>/ — no model calls, no full training, no GPU.
 *
 * Conventions (scaffolded by `ideaseek idea scaffold`):
 *   src/**.py            static (py_compile) + config/*.json must parse
 *   src/tests/test_*.py  unit tests (stdlib unittest)
 *   src/check_data.py    data interface check (exit 0 = holds)
 *   src/check_metrics.py metric computability check (exit 0 = holds)
 *   src/smoke.py         micro-run printing {"metrics": {...}} JSON
 */

export type IdeaCheckPhase = 'static' | 'unit-tests' | 'data' | 'metrics' | 'smoke';

export interface IdeaCheckPhaseResult {
  phase: IdeaCheckPhase;
  ok: boolean;
  skipped: boolean;
  exitCode: number;
  durationMs: number;
  command: string[];
  failureKind?: string;
  summary?: string;
  logPath?: string;
}

export interface IdeaCheckReport {
  ideaId: string;
  /** Idea version the check ran against (bound like a checkpoint). */
  version: number;
  /** src/ content hash at check time (null when src/ is empty). */
  codeHash: string | null;
  startedAt: number;
  finishedAt: number;
  /**
   * passed      — every executed phase ok AND smoke ran (queue-eligible)
   * smoke-missing — executed phases ok but src/smoke.py absent
   * failed      — at least one executed phase failed
   * not-implemented — src/ holds no python at all; nothing was run, so there is
   *                   no verdict about code quality (docs/CLI_SPEC exit 2)
   * scaffold-placeholder — the code runs, but smoke only returns the template's
   *                   own synthetic numbers: implemented in form, not substance
   */
  outcome: 'passed' | 'smoke-missing' | 'failed' | 'not-implemented' | 'scaffold-placeholder';
  phases: IdeaCheckPhaseResult[];
}

async function collectPythonFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === '__pycache__' || entry.name === '.venv' || entry.name === '.git') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await collectPythonFiles(join(dir, entry.name), rel)));
    } else if (entry.name.endsWith('.py')) {
      out.push(rel);
    }
  }
  return out;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await (await import('node:fs/promises')).stat(path);
    return true;
  } catch {
    return false;
  }
}

export interface RunChecksOptions {
  timeoutMs?: number;
}

/** Executes the check ladder and returns the report (caller persists it). */
export async function runIdeaChecks(
  projectRoot: string,
  ideaId: string,
  opts: RunChecksOptions = {},
): Promise<IdeaCheckReport> {
  const meta = await loadWorkspaceMeta(projectRoot, ideaId);
  const workspace = ideaDir(projectRoot, ideaId);
  const srcDir = join(workspace, 'src');
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const startedAt = Date.now();
  const phases: IdeaCheckPhaseResult[] = [];
  const codeHash = await hashIdeaSource(projectRoot, ideaId);
  // An empty src/ is a workspace nobody has implemented yet, which is a
  // different fact from "the implementation fails" and needs a different next
  // step. The old code ran a synthetic failing command, so both printed
  // FAILED static and the reader went hunting for a bug in files that do not
  // exist.
  let notImplemented = false;

  const pushLog = async (
    phase: IdeaCheckPhase,
    command: string[],
    exitCode: number,
    out: string,
  ): Promise<string> => {
    const logName = `idea-${ideaId}-${phase}.log`;
    await writeRepairLog(projectRoot, logName, command, exitCode, out);
    return `.research/logs/${logName}`;
  };

  /**
   * Every phase runs with the project's run environment injected, exactly as
   * the comparison ladder does. Idea code was told to resolve its corpus from
   * IDEASEEK_DATASET_ROOTS / IDEASEEK_DATA_PATH while `idea check` handed it
   * neither, so a correct implementation reported "data root not found; tried
   * []" — the empty list is the tell that the contract was never delivered.
   *
   * The method venv is built here too. The comparison ladder had one and the
   * idea ladder did not, so generated idea code that imported numpy hit the
   * host's numpy and failed as `missing-dependency` on a version conflict the
   * platform could have resolved. A venv that cannot be built is a warning,
   * never an abort: the phases then classify the missing dependency honestly.
   */
  let venvOverride: Record<string, string> | undefined;
  {
    const { readFile } = await import('node:fs/promises');
    const sources = (await collectPythonFiles(srcDir)).slice(0, 12);
    const joined: string[] = [];
    for (const file of sources) {
      joined.push(await readFile(join(srcDir, file), 'utf8').catch(() => ''));
    }
    if (joined.join('\n').trim()) {
      const { deriveRequirementsForWorktree } = await import('../comparison/dep-inference.js');
      const { ensureMethodVenv, venvEnv } = await import('../comparison/repair.js');
      const requirements = await deriveRequirementsForWorktree(joined.join('\n'), workspace);
      // No import probe: a distribution's module name is not derivable from its
      // package name (pillow is PIL), so probing produces false "missing" and
      // builds venvs that were never needed. The derivation is what decides —
      // stdlib-only code derives nothing and runs on the host python.
      if (requirements.length > 0) {
        const venv = await ensureMethodVenv(workspace, { packages: requirements });
        if (venv.ok) venvOverride = venvEnv(workspace);
        else {
          process.stderr.write(
            `warning: idea venv could not be built: ${venv.detail.slice(0, 200)}\n` +
              '  continuing with the host python; the phases will classify the missing dependency\n',
          );
        }
      }
    }
  }

  /**
   * Classify a phase failure, with the idea ladder's own blind spot corrected.
   *
   * `classifyRepairFailure` reports any ModuleNotFoundError as
   * `missing-dependency`, which on the comparison side is then resolved by
   * planFix checking whether the module lives inside the tree. The idea ladder
   * has no planFix, so "No module named 'src'" was printed as a dependency
   * problem and pointed the reader at pip — for a name that no package
   * provides and that the workspace itself contains. Relabelling here keeps
   * the two ladders telling the same story about the same evidence.
   */
  const classifyPhase = async (
    out: string,
    exitCode: number,
    timedOut: boolean,
  ): Promise<{ kind: string; summary: string }> => {
    const classified = classifyRepairFailure(out, exitCode, timedOut);
    if (classified.kind !== 'missing-dependency' || !classified.module) return classified;
    const { isLocalModule } = await import('../comparison/dep-inference.js');
    if (await isLocalModule(workspace, classified.module)) {
      return {
        kind: 'internal-module',
        summary:
          `${classified.summary} — '${classified.module}' is a module of this idea workspace, ` +
          'not a pip package: import it by bare name (src/ is on the search path when the ' +
          'platform runs the file), do not install it',
      };
    }
    return classified;
  };

  const runPhase = async (
    command: string[],
  ): Promise<Awaited<ReturnType<typeof runRepairCommand>>> => {
    const { mergeRunEnv } = await import('../experiment/run-env.js');
    return runRepairCommand(
      command,
      workspace,
      timeoutMs,
      await mergeRunEnv(projectRoot, venvOverride),
    );
  };

  // 1. static: py_compile every src .py + parse config/*.json in-process.
  {
    const files = await collectPythonFiles(srcDir);
    if (files.length === 0) {
      // Nothing to check is not a failing check. The old version ran a
      // synthetic `python -c raise SystemExit(...)` so an untouched workspace
      // reported the same FAILED static phase as broken code, and the reader
      // went looking for a bug in files that do not exist.
      notImplemented = true;
      phases.push({
        phase: 'static',
        ok: false,
        skipped: true,
        exitCode: 0,
        durationMs: 0,
        command: [],
        failureKind: 'not-implemented',
        summary: `no python files under src/ yet — run: ideaseek idea scaffold ${ideaId}`,
      });
    } else {
      const command = ['python', '-m', 'py_compile', ...files.map((f) => join(srcDir, f))];
      const run = await runPhase(command);
      let failure: { kind: string; summary: string } | null = null;
      if (run.exitCode !== 0 || run.timedOut) {
        const classified = await classifyPhase(run.out, run.exitCode, run.timedOut);
        failure = { kind: classified.kind, summary: classified.summary };
      } else {
        // config JSON must parse (invalid config is a static error).
        const configDir = join(workspace, 'config');
        try {
          const { readFile } = await import('node:fs/promises');
          for (const name of await readdir(configDir)) {
            if (!name.endsWith('.json')) continue;
            try {
              JSON.parse(await readFile(join(configDir, name), 'utf8'));
            } catch (error) {
              failure = {
                kind: 'syntax-error',
                summary: `config/${name} is not valid JSON: ${(error as Error).message}`,
              };
              break;
            }
          }
        } catch {
          // no config dir yet — nothing to parse
        }
      }
      const logPath = await pushLog('static', command, run.exitCode, run.out);
      phases.push({
        phase: 'static',
        ok: failure === null && run.exitCode === 0 && !run.timedOut,
        skipped: false,
        exitCode: run.exitCode,
        durationMs: run.durationMs,
        command,
        ...(failure ? { failureKind: failure.kind, summary: failure.summary } : {}),
        logPath,
      });
    }
  }

  // 2. unit tests (only when test files exist).
  const testDir = join(srcDir, 'tests');
  const testFiles = (await readdir(testDir).catch(() => [] as string[])).filter((name) =>
    /^test_.*\.py$/.test(name),
  );
  if (testFiles.length > 0) {
    const command = ['python', '-m', 'unittest', 'discover', '-s', 'src/tests', '-p', 'test_*.py'];
    const run = await runPhase(command);
    const logPath = await pushLog('unit-tests', command, run.exitCode, run.out);
    const failed = run.exitCode !== 0 || run.timedOut;
    const classified = await classifyPhase(run.out, run.exitCode, run.timedOut);
    phases.push({
      phase: 'unit-tests',
      ok: !failed,
      skipped: false,
      exitCode: run.exitCode,
      durationMs: run.durationMs,
      command,
      ...(failed
        ? { failureKind: classified.kind, summary: classified.summary.slice(0, 300) }
        : {}),
      logPath,
    });
  } else {
    phases.push(skippedPhase('unit-tests', 'no src/tests/test_*.py files'));
  }

  // 3. data interface (only when src/check_data.py exists).
  if (await pathExists(join(srcDir, 'check_data.py'))) {
    const command = ['python', 'src/check_data.py'];
    const run = await runPhase(command);
    const logPath = await pushLog('data', command, run.exitCode, run.out);
    const failed = run.exitCode !== 0 || run.timedOut;
    const classified = await classifyPhase(run.out, run.exitCode, run.timedOut);
    phases.push({
      phase: 'data',
      ok: !failed,
      skipped: false,
      exitCode: run.exitCode,
      durationMs: run.durationMs,
      command,
      ...(failed
        ? { failureKind: classified.kind, summary: classified.summary.slice(0, 300) }
        : {}),
      logPath,
    });
  } else {
    phases.push(skippedPhase('data', 'src/check_data.py not present'));
  }

  // 4. metric computability (only when src/check_metrics.py exists).
  if (await pathExists(join(srcDir, 'check_metrics.py'))) {
    const command = ['python', 'src/check_metrics.py'];
    const run = await runPhase(command);
    const logPath = await pushLog('metrics', command, run.exitCode, run.out);
    const failed = run.exitCode !== 0 || run.timedOut;
    const classified = await classifyPhase(run.out, run.exitCode, run.timedOut);
    phases.push({
      phase: 'metrics',
      ok: !failed,
      skipped: false,
      exitCode: run.exitCode,
      durationMs: run.durationMs,
      command,
      ...(failed
        ? { failureKind: classified.kind, summary: classified.summary.slice(0, 300) }
        : {}),
      logPath,
    });
  } else {
    phases.push(skippedPhase('metrics', 'src/check_metrics.py not present'));
  }

  // 5. smoke micro-run (only when src/smoke.py exists) — never full training.
  let smokeRan = false;
  // Set when the only smoke output is the scaffold's own placeholder numbers.
  let scaffoldOnly = false;
  if (await pathExists(join(srcDir, 'smoke.py'))) {
    smokeRan = true;
    const command = ['python', 'src/smoke.py'];
    const run = await runPhase(command);
    const logPath = await pushLog('smoke', command, run.exitCode, run.out);
    let failed = run.exitCode !== 0 || run.timedOut;
    let failureKind: string | undefined;
    let summary: string | undefined;
    let scaffoldPlaceholder = false;
    if (!failed) {
      // Require a {"metrics": {...}} line with finite values.
      const lines = run.out.split(/\r?\n/).filter((line) => line.trim());
      let parsed: { metrics?: Record<string, unknown> } | null = null;
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          const candidate = JSON.parse(lines[i]!) as { metrics?: Record<string, unknown> };
          if (candidate && typeof candidate.metrics === 'object' && candidate.metrics) {
            parsed = candidate;
            break;
          }
        } catch {
          continue;
        }
      }
      const metricValues = parsed?.metrics ?? {};
      const entries = Object.entries(metricValues);
      // A smoke line that declares itself synthetic is a placeholder, not a
      // measurement. The scaffolded starter prints exactly this — `0.5` for
      // every metric with "synthetic": true — and used to be graded PASSED,
      // which then told the user to set the idea RUNNING on numbers invented by
      // a template. The same fake pass was already banned on the comparison
      // side; this was the half left open.
      const declared = parsed
        ? String((parsed as Record<string, unknown>)['status'] ?? '').toLowerCase()
        : '';
      const selfDeclaredSynthetic =
        (parsed as Record<string, unknown> | null)?.['synthetic'] === true ||
        declared.includes('scaffold') ||
        declared.includes('not-implemented');
      if (!parsed || entries.length === 0) {
        failed = true;
        failureKind = 'unknown';
        summary = 'smoke produced no {"metrics": {...}} JSON line';
      } else if (selfDeclaredSynthetic) {
        failed = true;
        scaffoldPlaceholder = true;
        failureKind = 'scaffold-placeholder';
        summary =
          'smoke reports synthetic values from the scaffold template — the idea is not ' +
          'implemented yet, and these numbers mean nothing';
      } else {
        for (const [name, value] of entries) {
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            failed = true;
            failureKind = 'unknown';
            summary = `smoke metric ${name} is not a finite number`;
            break;
          }
        }
        // Cross-check against config/train.json metric names when present.
        if (!failed) {
          try {
            const { readFile } = await import('node:fs/promises');
            const cfg = JSON.parse(
              await readFile(join(workspace, 'config', 'train.json'), 'utf8'),
            ) as { metrics?: unknown[] };
            const expected = (cfg.metrics ?? []).map((m) =>
              typeof m === 'string' ? m : String((m as { name?: unknown }).name ?? ''),
            );
            const missing = expected.filter((name) => !(name in metricValues));
            if (missing.length > 0) {
              failed = true;
              failureKind = 'unknown';
              summary = `smoke metrics missing configured names: ${missing.join(', ')}`;
            }
          } catch {
            // no config — metrics object alone is enough
          }
        }
      }
    }
    if (scaffoldPlaceholder) scaffoldOnly = true;
    if (failed && !failureKind) {
      const classified = await classifyPhase(run.out, run.exitCode, run.timedOut);
      failureKind = run.timedOut ? 'timeout' : classified.kind;
      summary = run.timedOut
        ? `smoke timed out after ${timeoutMs}ms`
        : classified.summary.slice(0, 300);
    }
    phases.push({
      phase: 'smoke',
      ok: !failed,
      skipped: false,
      exitCode: run.exitCode,
      durationMs: run.durationMs,
      command,
      ...(failed ? { failureKind: failureKind!, summary: summary! } : {}),
      logPath,
    });
  } else {
    phases.push(skippedPhase('smoke', 'src/smoke.py not present (write it to reach SMOKE_TESTED)'));
  }

  // A real failure outranks the placeholder signal — breaking static must not
  // be reported as the softer "not implemented yet". The placeholder's own
  // phase result is excluded from that count, or it would outrank itself and
  // every scaffolded idea would read as a fault rather than as unfinished work.
  const executedFailed = phases.some(
    (phase) => !phase.skipped && !phase.ok && phase.failureKind !== 'scaffold-placeholder',
  );
  // Order matters: a phase that genuinely failed must outrank the
  // scaffold-placeholder signal, otherwise breaking static would report the
  // softer "not implemented yet" and hide the real fault. An empty src/ wins
  // over both because nothing was executed at all.
  const outcome: IdeaCheckReport['outcome'] = executedFailed
    ? 'failed'
    : notImplemented
      ? 'not-implemented'
      : scaffoldOnly
        ? 'scaffold-placeholder'
        : smokeRan
          ? 'passed'
          : 'smoke-missing';

  return {
    ideaId,
    version: meta.currentVersion,
    codeHash,
    startedAt,
    finishedAt: Date.now(),
    outcome,
    phases,
  };
}

function skippedPhase(phase: IdeaCheckPhase, reason: string): IdeaCheckPhaseResult {
  return {
    phase,
    ok: true,
    skipped: true,
    exitCode: 0,
    durationMs: 0,
    command: [],
    summary: reason,
  };
}

export function checkReportPath(projectRoot: string, ideaId: string): string {
  return join(ideaDir(projectRoot, ideaId), 'experiments', 'check-report.json');
}

export async function saveCheckReport(
  projectRoot: string,
  report: IdeaCheckReport,
): Promise<string> {
  const path = checkReportPath(projectRoot, report.ideaId);
  await ensureDir(join(ideaDir(projectRoot, report.ideaId), 'experiments'));
  await writeFileAtomic(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

export interface ScaffoldResult {
  created: string[];
  skipped: string[];
}

function scaffoldFiles(card: IdeaCard): { path: string; content: string }[] {
  const trainPy = `"""Idea training entry (scaffold).

Quick/standard experiments only — full training runs via experiment handoff.
Replace this stub with the real implementation (Code Implementer).
Read data through dataset_ref.resolve(cfg["dataset_ref"]) so the same code runs
on any host; see src/dataset_ref.py and docs/DATA_CONTRACTS.md §RunEnv.
"""
import json
import os
import sys


def workspace_root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_config(path=None):
    path = path or os.path.join(workspace_root(), "config", "train.json")
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def main(argv=None):
    cfg = load_config()
    print(json.dumps({
        "idea_id": cfg.get("idea_id", "${card.ideaId}"),
        "status": "scaffold-not-implemented",
        "scale": cfg.get("data_scale", "smoke"),
        "metrics": [m["name"] if isinstance(m, dict) else str(m) for m in cfg.get("metrics", [])],
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;

  const datasetRefPy = `"""Read-only dataset resolution (docs/DATA_CONTRACTS.md §RunEnv).

The project's inputs.readonly_datasets arrive as IDEASEEK_DATASET_ROOTS, so one
idea works on the author's machine, WSL2 and a Linux server unchanged. Never
hardcode a machine-specific path in idea code: put it in config/train.json
"dataset_ref" and resolve it here.
"""
import os
import sys


def roots():
    raw = os.environ.get("IDEASEEK_DATASET_ROOTS", "")
    return [p for p in raw.split(os.pathsep) if p.strip()]


def resolve(ref):
    """Absolute path for a dataset ref, looked up under every read-only root."""
    if os.path.isabs(ref):
        if os.path.exists(ref):
            return ref
        sys.stderr.write("absolute dataset_ref does not exist: %s\\n" % ref)
        raise SystemExit(1)
    available = roots()
    if not available:
        sys.stderr.write(
            "IDEASEEK_DATASET_ROOTS is empty: set inputs.readonly_datasets in "
            "research.yaml so the runner can locate datasets\\n"
        )
        raise SystemExit(2)
    for root in available:
        candidate = os.path.join(root, ref)
        if os.path.exists(candidate):
            return candidate
    sys.stderr.write(
        "dataset_ref %r not found under: %s\\n" % (ref, ", ".join(available))
    )
    raise SystemExit(1)
`;

  const checkDataPy = `"""Data interface check: exit 0 when the configured data holds."""
import json
import os
import sys


def workspace_root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def check_csv(path):
    if not os.path.exists(path):
        sys.stderr.write("missing data file: %s\\n" % path)
        return 1
    with open(path, "r", encoding="utf-8") as fh:
        header = fh.readline().strip().split(",")
    if "label" not in header:
        sys.stderr.write("data interface violation: no label column in %s\\n" % path)
        return 1
    return 0


def main():
    root = workspace_root()
    cfg_path = os.path.join(root, "config", "train.json")
    with open(cfg_path, "r", encoding="utf-8") as fh:
        cfg = json.load(fh)
    ref = cfg.get("dataset_ref")
    if ref:
        from dataset_ref import resolve

        target = resolve(ref)
        if os.path.isdir(target):
            if not os.listdir(target):
                sys.stderr.write("dataset directory is empty: %s\\n" % target)
                return 1
            return 0
        return check_csv(target)
    return check_csv(os.path.join(root, cfg.get("data_path", "data/synthetic.csv")))


if __name__ == "__main__":
    sys.exit(main())
`;

  const checkMetricsPy = `"""Metric computability check (SCAFFOLD placeholder metrics).

Code Implementer must replace compute_metrics with the real metric
implementation from the idea's minimal experiment.
"""
import json
import math
import os
import sys


def _metric_names():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(root, "config", "train.json"), "r", encoding="utf-8") as fh:
        cfg = json.load(fh)
    names = []
    for m in cfg.get("metrics", []):
        names.append(m["name"] if isinstance(m, dict) else str(m))
    return names


def compute_metrics():
    """SCAFFOLD: deterministic placeholder values for every configured metric."""
    return {name: 0.5 for name in _metric_names()}


def main():
    metrics = compute_metrics()
    if not metrics:
        sys.stderr.write("no metrics configured\\n")
        return 1
    for name, value in metrics.items():
        if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            sys.stderr.write("metric %s is not finite: %r\\n" % (name, value))
            return 1
    print(json.dumps({"metrics": metrics}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;

  const smokePy = `"""Smoke micro-run: synthetic only — no training, no GPU, no full data."""
import json
import sys

from check_metrics import compute_metrics


def main():
    metrics = compute_metrics()
    print(json.dumps({"metrics": metrics, "synthetic": True, "steps": 2}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;

  const testSmokePy = `import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from check_metrics import compute_metrics


class ScaffoldMetricsTest(unittest.TestCase):
    def test_metrics_are_finite_numbers(self):
        metrics = compute_metrics()
        self.assertGreater(len(metrics), 0)
        for value in metrics.values():
            self.assertTrue(math.isfinite(float(value)))


if __name__ == "__main__":
    unittest.main()
`;

  const configTrain = `${JSON.stringify(
    {
      idea_id: card.ideaId,
      data_scale: 'smoke',
      data_path: 'data/synthetic.csv',
      dataset_ref: null,
      seeds: [42],
      metrics: card.minimalExperiment.metrics,
      baselines: card.minimalExperiment.baselines,
      ablations: card.minimalExperiment.ablations,
      resources: { gpus: 0, memoryGiB: 1 },
      note: 'scaffold — quick/standard only; full runs go through experiment handoff',
    },
    null,
    2,
  )}\n`;

  const syntheticRows = ['x0,x1,label'];
  for (let i = 0; i < 10; i += 1) {
    syntheticRows.push(`${i / 10},${(i % 3) / 3},${i % 2}`);
  }
  const syntheticCsv = `${syntheticRows.join('\n')}\n`;

  return [
    { path: 'src/train.py', content: trainPy },
    { path: 'src/dataset_ref.py', content: datasetRefPy },
    { path: 'src/check_data.py', content: checkDataPy },
    { path: 'src/check_metrics.py', content: checkMetricsPy },
    { path: 'src/smoke.py', content: smokePy },
    { path: 'src/tests/__init__.py', content: '' },
    { path: 'src/tests/test_smoke.py', content: testSmokePy },
    { path: 'config/train.json', content: configTrain },
    { path: 'data/synthetic.csv', content: syntheticCsv },
  ];
}

/**
 * Writes the Code Implementer starter skeleton. NEVER overwrites existing
 * files (idempotent; user/agent code always wins).
 */
export async function scaffoldIdea(projectRoot: string, ideaId: string): Promise<ScaffoldResult> {
  const card = await loadIdeaCard(projectRoot, ideaId);
  const workspace = ideaDir(projectRoot, ideaId);
  const created: string[] = [];
  const skipped: string[] = [];
  for (const file of scaffoldFiles(card)) {
    const target = join(workspace, file.path);
    if (await pathExists(target)) {
      skipped.push(file.path);
      continue;
    }
    await ensureDir(dirname(target));
    await writeFileAtomic(target, file.content);
    created.push(file.path);
  }
  return { created, skipped };
}
