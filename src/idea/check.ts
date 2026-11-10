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
   */
  outcome: 'passed' | 'smoke-missing' | 'failed';
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

  // 1. static: py_compile every src .py + parse config/*.json in-process.
  {
    const files = await collectPythonFiles(srcDir);
    const command = files.length
      ? ['python', '-m', 'py_compile', ...files.map((f) => join(srcDir, f))]
      : ['python', '-c', 'raise SystemExit("no python files under src/")'];
    const run = await runRepairCommand(command, workspace, timeoutMs);
    let failure: { kind: string; summary: string } | null = null;
    if (run.exitCode !== 0 || run.timedOut) {
      const classified = classifyRepairFailure(run.out, run.exitCode, run.timedOut);
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
    const durationMs = run.durationMs;
    const logPath = await pushLog('static', command, run.exitCode, run.out);
    phases.push({
      phase: 'static',
      ok: failure === null && run.exitCode === 0 && !run.timedOut,
      skipped: false,
      exitCode: run.exitCode,
      durationMs,
      command,
      ...(failure ? { failureKind: failure.kind, summary: failure.summary } : {}),
      logPath,
    });
  }

  // 2. unit tests (only when test files exist).
  const testDir = join(srcDir, 'tests');
  const testFiles = (await readdir(testDir).catch(() => [] as string[])).filter((name) =>
    /^test_.*\.py$/.test(name),
  );
  if (testFiles.length > 0) {
    const command = ['python', '-m', 'unittest', 'discover', '-s', 'src/tests', '-p', 'test_*.py'];
    const run = await runRepairCommand(command, workspace, timeoutMs);
    const logPath = await pushLog('unit-tests', command, run.exitCode, run.out);
    const failed = run.exitCode !== 0 || run.timedOut;
    const classified = classifyRepairFailure(run.out, run.exitCode, run.timedOut);
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
    const run = await runRepairCommand(command, workspace, timeoutMs);
    const logPath = await pushLog('data', command, run.exitCode, run.out);
    const failed = run.exitCode !== 0 || run.timedOut;
    const classified = classifyRepairFailure(run.out, run.exitCode, run.timedOut);
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
    const run = await runRepairCommand(command, workspace, timeoutMs);
    const logPath = await pushLog('metrics', command, run.exitCode, run.out);
    const failed = run.exitCode !== 0 || run.timedOut;
    const classified = classifyRepairFailure(run.out, run.exitCode, run.timedOut);
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
  if (await pathExists(join(srcDir, 'smoke.py'))) {
    smokeRan = true;
    const command = ['python', 'src/smoke.py'];
    const run = await runRepairCommand(command, workspace, timeoutMs);
    const logPath = await pushLog('smoke', command, run.exitCode, run.out);
    let failed = run.exitCode !== 0 || run.timedOut;
    let failureKind: string | undefined;
    let summary: string | undefined;
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
      if (!parsed || entries.length === 0) {
        failed = true;
        failureKind = 'unknown';
        summary = 'smoke produced no {"metrics": {...}} JSON line';
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
    if (failed && !failureKind) {
      const classified = classifyRepairFailure(run.out, run.exitCode, run.timedOut);
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

  const executedFailed = phases.some((phase) => !phase.skipped && !phase.ok);
  const outcome: IdeaCheckReport['outcome'] = executedFailed
    ? 'failed'
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

  const checkDataPy = `"""Data interface check: exit 0 when the configured data file holds."""
import json
import os
import sys


def workspace_root():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    root = workspace_root()
    cfg_path = os.path.join(root, "config", "train.json")
    with open(cfg_path, "r", encoding="utf-8") as fh:
        cfg = json.load(fh)
    data_path = os.path.join(root, cfg.get("data_path", "data/synthetic.csv"))
    if not os.path.exists(data_path):
        sys.stderr.write("missing data file: %s\\n" % data_path)
        return 1
    with open(data_path, "r", encoding="utf-8") as fh:
        header = fh.readline().strip().split(",")
    if "label" not in header:
        sys.stderr.write("data interface violation: no label column in %s\\n" % data_path)
        return 1
    return 0


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
