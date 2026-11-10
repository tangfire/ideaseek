import type { Command } from 'commander';
import { join } from 'node:path';
import { IdeaseekError } from '../core/errors.js';
import { ensureDir, writeFileAtomic } from '../core/atomic.js';
import { computeAdmission, probeCapacity, type CapacityRequest } from '../runtime/capacity.js';
import { listWorkspaces } from '../idea/workspace.js';
import { action, jsonLine } from './shared.js';

async function openRoot(): Promise<string> {
  const { findProjectRoot } = await import('../config/paths.js');
  const root = await findProjectRoot(process.cwd());
  if (!root) {
    throw new IdeaseekError('NOT_INITIALIZED', 'no IdeaSeek project here; run: ideaseek init');
  }
  return root;
}

interface TrainConfig {
  resources?: { gpus?: unknown; memoryGiB?: unknown };
}

async function requestForIdea(
  root: string,
  ideaId: string,
  createdAt: number,
): Promise<CapacityRequest> {
  let gpus = 0;
  let memoryGiB = 1;
  try {
    const { readFile } = await import('node:fs/promises');
    const cfg = JSON.parse(
      await readFile(join(root, 'ideas', ideaId, 'config', 'train.json'), 'utf8'),
    ) as TrainConfig;
    if (typeof cfg.resources?.gpus === 'number' && cfg.resources.gpus >= 0) {
      gpus = Math.floor(cfg.resources.gpus);
    }
    if (typeof cfg.resources?.memoryGiB === 'number' && cfg.resources.memoryGiB > 0) {
      memoryGiB = cfg.resources.memoryGiB;
    }
  } catch {
    // no config yet — conservative CPU-only default
  }
  return { ideaId, gpus, memoryGiB, createdAt };
}

/**
 * `ideaseek capacity` — the GPU Capacity Planner surface: live host probe +
 * ready-idea resource requests + max_parallel_ideas → safe concurrency N.
 * Advisory only (exit 0): queued ideas wait; nothing is force-started here.
 */
export function registerCapacityCommand(program: Command): void {
  program
    .command('capacity')
    .description(
      'probe host resources and compute the safe concurrent-idea admission plan (no over-assignment)',
    )
    .option('--json', 'machine-readable output')
    .action(
      action(async (opts: { json?: boolean }) => {
        const root = await openRoot();
        const { ProjectRuntime } = await import('../workflow/runtime.js');
        const runtime = await ProjectRuntime.open({ cwd: root });
        try {
          const maxParallelIdeas = runtime.config.resources.maxParallelIdeas;
          const probe = await probeCapacity(root);

          // Ready requests: ideas parked at SMOKE_TESTED waiting for experiments.
          const workspaces = await listWorkspaces(root);
          const ready = workspaces.filter((idea) => idea.status === 'SMOKE_TESTED');
          const requests: CapacityRequest[] = [];
          for (const idea of ready) {
            requests.push(await requestForIdea(root, idea.ideaId, 0));
          }
          // Stable order: workspace creation time via card createdAt fallback.
          for (const request of requests) {
            try {
              const { loadIdeaCard } = await import('../idea/workspace.js');
              request.createdAt = (await loadIdeaCard(root, request.ideaId)).createdAt;
            } catch {
              request.createdAt = 0;
            }
          }

          const plan = computeAdmission(probe, requests, { maxParallelIdeas });
          const payload = {
            probedAt: probe.probedAt,
            probe: {
              gpus: probe.gpus,
              cpuCores: probe.cpuCores,
              freeMemGiB: probe.freeMemGiB,
              diskFreeGiB: probe.diskFreeGiB,
              nvidiaSmiAvailable: probe.nvidiaSmiAvailable,
            },
            plan,
            running: workspaces.filter((idea) => idea.status === 'RUNNING').map((i) => i.ideaId),
          };

          const outPath = join(root, 'knowledge', 'capacity-plan.json');
          await ensureDir(join(root, 'knowledge'));
          await writeFileAtomic(outPath, `${JSON.stringify(payload, null, 2)}\n`);

          if (opts.json) {
            process.stdout.write(jsonLine(payload));
            return 0;
          }
          process.stdout.write(
            `host: ${probe.cpuCores} cores · ${probe.freeMemGiB} GiB free` +
              `${probe.diskFreeGiB !== null ? ` · disk ${probe.diskFreeGiB} GiB free` : ''}\n`,
          );
          if (probe.gpus.length === 0) {
            process.stdout.write(
              `gpu: ${probe.nvidiaSmiAvailable ? '0 device(s)' : 'nvidia-smi unavailable (CPU-only plan)'}\n`,
            );
          } else {
            process.stdout.write(`gpu: ${probe.gpus.length} device(s)\n`);
            for (const gpu of probe.gpus) {
              process.stdout.write(
                `  #${gpu.index}  free ${gpu.memFreeMiB}/${gpu.memTotalMiB} MiB  util ${gpu.utilizationPct}%\n`,
              );
            }
          }
          process.stdout.write(
            `plan: N=${plan.effectiveN} (limit ${plan.parallelLimit}) · ` +
              `${plan.admitted.length} admitted · ${plan.queued.length} queued\n`,
          );
          for (const entry of plan.admitted) {
            process.stdout.write(
              `  RUN   ${entry.ideaId}  ${entry.gpus > 0 ? `gpu×${entry.gpus} dev=[${entry.deviceIndices.join(',')}]` : 'cpu-only'}  mem ${entry.memoryGiB}GiB\n`,
            );
          }
          for (const entry of plan.queued) {
            process.stdout.write(`  WAIT  ${entry.ideaId}  ${entry.reason}\n`);
          }
          if (plan.constraints.length > 0) {
            process.stdout.write(`binding: ${plan.constraints.join(' · ')}\n`);
          }
          if (payload.running.length > 0) {
            process.stdout.write(`already RUNNING: ${payload.running.join(', ')}\n`);
          }
          process.stdout.write(`plan written: ${outPath}\n`);
          return 0;
        } finally {
          await runtime.close();
        }
      }),
    );
}
