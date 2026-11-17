import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Clock } from '../src/core/clock.js';
import type { HarnessAdapter } from '../src/dsh/adapter.js';
import { ProjectRuntime } from '../src/workflow/runtime.js';
import type { RunRecord, TaskRecord } from '../src/workflow/types.js';
import type { FaultSpec } from '../src/worker/types.js';
import { initInternals } from '../src/commands/init.js';
import { enqueueDemoPipeline } from '../src/commands/shared.js';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CLI_BIN = join(REPO_ROOT, 'dist', 'cli.js');

/** Creates a minimal initialized project directory (same files `init` writes). */
export async function makeProjectDir(name = 'test-project'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ideaseek-test-'));
  for (const workspaceDir of initInternals.WORKSPACE_DIRS) {
    await mkdir(join(dir, workspaceDir), { recursive: true });
  }
  await writeFile(join(dir, 'research.yaml'), initInternals.researchYaml(name), 'utf8');
  await writeFile(join(dir, 'README.md'), initInternals.readmeMd(name), 'utf8');
  return dir;
}

export interface TestRuntime {
  runtime: ProjectRuntime;
  dir: string;
  close(): Promise<void>;
}

export async function openRuntime(
  dir: string,
  opts: {
    clock?: Clock;
    recover?: boolean;
    staleTempMs?: number;
    workerStaleMs?: number;
    harness?: HarnessAdapter;
  } = {},
): Promise<ProjectRuntime> {
  return ProjectRuntime.open({ cwd: dir, ...opts });
}

export async function createDemoRun(
  runtime: ProjectRuntime,
  question = 'test question',
  faults: Record<string, FaultSpec> = {},
): Promise<RunRecord> {
  const run = await runtime.db.createRun({
    projectId: runtime.project.id,
    question,
    config: runtime.config,
    strategy: runtime.config.research.mode,
  });
  await enqueueDemoPipeline(runtime, run, question, faults);
  return run;
}

export async function taskById(runtime: ProjectRuntime, taskId: string): Promise<TaskRecord> {
  const task = await runtime.db.getTask(taskId);
  if (!task) throw new Error(`task ${taskId} vanished`);
  return task;
}

/**
 * Replace an idea scaffold's starter smoke with code that computes a value.
 *
 * `ideaseek idea scaffold` writes a template that prints 0.5 for every metric
 * and declares `"synthetic": true`. `idea check` refuses that — correctly,
 * because a template constant that reaches a results record is worse than a
 * failing check. Suites that need a *passed* check as a fixture therefore have
 * to implement something, and this keeps twelve copies of the same five lines
 * from becoming twelve ways to assert a number that means nothing.
 */
export async function implementIdeaSmoke(
  projectRoot: string,
  ideaId: string,
  metricName?: string,
  value = 0.87,
): Promise<void> {
  const { mkdir, readFile, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const src = join(projectRoot, 'ideas', ideaId, 'src');
  await mkdir(src, { recursive: true });
  // Read the metric name off the idea's own config when the caller does not
  // say: `idea check` cross-checks the smoke keys against config/train.json,
  // so a fixed default name silently fails fixtures whose cards use another.
  let name = metricName;
  if (!name) {
    try {
      const cfg = JSON.parse(
        await readFile(join(projectRoot, 'ideas', ideaId, 'config', 'train.json'), 'utf8'),
      ) as { metrics?: unknown[] };
      const first = cfg.metrics?.[0];
      name =
        typeof first === 'string'
          ? first
          : String((first as { name?: unknown })?.name ?? 'accuracy');
    } catch {
      name = 'accuracy';
    }
  }
  await writeFile(
    join(src, 'smoke.py'),
    [
      'import json',
      '',
      `METRICS = {"${name}": ${value}}`,
      '',
      'print(json.dumps({"metrics": METRICS}))',
      '',
    ].join('\n'),
    'utf8',
  );
}
/**
 * A budget multiplier for interactive e2e, not a weaker assertion.
 *
 * These tests drive a real child process: node boot, the TUI, and in two cases
 * a DSH handshake. The handshake now retries (one cold start under load is not
 * evidence the runtime is broken), which is the right product behaviour and
 * lengthens the worst case by design — so a fixed deadline set when the worst
 * case was a single 30s attempt would report a reliability improvement as a
 * test failure. On a loaded machine that is exactly what the full suite did:
 * `models setup …` timed out at 120s while the same file passes in 56s alone.
 *
 * The multiplier scales the clock, never a wait condition or an expectation:
 * a test that cannot finish in `budget * scale` still fails, and the reason it
 * prints is the child's own output tail rather than a bare "test timed out".
 * CI machines with less headroom set IDEASEEK_TEST_TIMEOUT_SCALE=2 or 3.
 */
export const TIMEOUT_SCALE = (() => {
  const raw = Number((process.env.IDEASEEK_TEST_TIMEOUT_SCALE ?? '1').trim());
  return Number.isFinite(raw) && raw >= 1 && raw <= 6 ? Math.floor(raw * 100) / 100 : 1;
})();

/** One test budget, scaled. */
export const budget = (ms: number): number => Math.round(ms * TIMEOUT_SCALE);
