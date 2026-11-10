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
