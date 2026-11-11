import type { Command } from 'commander';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { action, jsonLine } from './shared.js';
import { listRegisteredProjects, type RegisteredProject } from '../runtime/registry.js';
import { daemonSummary, inspectProjectLock } from '../runtime/project-lock.js';

/**
 * `ideaseek projects` (PRODUCT_GAPS #5): the user-level registry of project
 * directories with a live, read-only status probe each (no recovery writes,
 * recover:false). Missing directories and held/stale locks are surfaced so a
 * shared server never hides conflicting runs.
 */

interface ProjectStatusEntry extends RegisteredProject {
  exists: boolean;
  lastRun: { runId: string; status: string } | null;
  lock: { pid: number; purpose: string; alive: boolean } | null;
  daemon: { pid: number; state: string } | null;
}

async function probeProject(entry: RegisteredProject): Promise<ProjectStatusEntry> {
  const base: ProjectStatusEntry = {
    ...entry,
    exists: false,
    lastRun: null,
    lock: null,
    daemon: null,
  };
  try {
    await access(join(entry.root, 'research.yaml'));
  } catch {
    return base; // registered but no longer present on disk
  }
  base.exists = true;
  const inspected = await inspectProjectLock(entry.root);
  base.lock = inspected
    ? { pid: inspected.lock.pid, purpose: inspected.lock.purpose, alive: inspected.alive }
    : null;
  base.daemon = daemonSummary(entry.root);
  try {
    const { ProjectRuntime } = await import('../workflow/runtime.js');
    const runtime = await ProjectRuntime.open({ cwd: entry.root, recover: false });
    try {
      const run = await runtime.db.getLatestRun(runtime.project.id);
      base.lastRun = run ? { runId: run.runId, status: run.status } : null;
    } finally {
      await runtime.close();
    }
  } catch {
    // unreadable project (config/db issues) — listed with lastRun=null
  }
  return base;
}

export function registerProjectsCommand(program: Command): void {
  program
    .command('projects')
    .description('list registered IdeaSeek projects with live status and lock state')
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { json?: boolean }) => {
        const registered = await listRegisteredProjects();
        const projects: ProjectStatusEntry[] = [];
        for (const entry of registered) {
          projects.push(await probeProject(entry));
        }

        if (opts.json) {
          process.stdout.write(jsonLine({ projects }));
          return 0;
        }
        if (projects.length === 0) {
          process.stdout.write(
            'no registered projects (ideaseek init registers the current directory)\n',
          );
          return 0;
        }
        process.stdout.write(`${projects.length} project(s):\n`);
        for (const project of projects) {
          const mark = project.exists ? ' ' : '!';
          process.stdout.write(
            ` ${mark} ${project.name}  ${project.root}\n` +
              `     last: ${project.lastRun ? `${project.lastRun.runId} ${project.lastRun.status}` : 'no runs'}` +
              `${project.lock ? ` · lock: pid ${project.lock.pid} ${project.lock.alive ? 'HELD' : 'stale'} (${project.lock.purpose})` : ''}` +
              `${project.daemon ? ` · supervisor: ${project.daemon.state}` : ''}\n`,
          );
          if (!project.exists) process.stdout.write('     (directory missing on disk)\n');
        }
        process.stdout.write('current directory operates on its own project only\n');
        return 0;
      }),
    );
}
