import { spawn } from 'node:child_process';
import { cpus, freemem } from 'node:os';
import { probeDisk } from './detect.js';

/**
 * GPU Capacity Planner (docs/plan.md §E): merges a live host probe with per-
 * idea resource requests, the user's max_parallel_ideas limit and budget-free
 * safety rules to compute how many idea experiments may run concurrently.
 * Golden rule: never over-assign GPUs — each admitted GPU request binds
 * distinct devices with enough free memory.
 */

export interface GpuDevice {
  index: number;
  memTotalMiB: number;
  memFreeMiB: number;
  utilizationPct: number;
}

export interface CapacityProbe {
  gpus: GpuDevice[];
  cpuCores: number;
  freeMemGiB: number;
  diskFreeGiB: number | null;
  nvidiaSmiAvailable: boolean;
  probedAt: number;
}

export interface CapacityRequest {
  ideaId: string;
  gpus: number;
  memoryGiB: number;
  createdAt: number;
}

export interface AdmittedIdea {
  ideaId: string;
  gpus: number;
  memoryGiB: number;
  /** GPU indices bound to this request (empty for CPU-only runs). */
  deviceIndices: number[];
}

export interface QueuedIdea {
  ideaId: string;
  reason: string;
}

export interface AdmissionPlan {
  /** Configured user ceiling (resources.max_parallel_ideas). */
  parallelLimit: number;
  /** min(user ceiling, hardware headroom) — the safe concurrency N. */
  effectiveN: number;
  admitted: AdmittedIdea[];
  queued: QueuedIdea[];
  /** Which constraints actually bound the plan (for the report). */
  constraints: string[];
}

export interface AdmissionOptions {
  maxParallelIdeas: number;
  /** CPU-seconds style core reservation per CPU-only idea. */
  coresPerIdea?: number;
  /** GiB kept free per idea (host safety headroom). */
  headroomGiB?: number;
}

function runQuery(args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('nvidia-smi', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => (out += String(chunk)));
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 ? out : null));
  });
}

/** Live probe: per-GPU free/total memory + utilization, CPU, RAM, disk. */
export async function probeCapacity(projectRoot: string): Promise<CapacityProbe> {
  const csv = await runQuery(
    ['--query-gpu=index,memory.total,memory.free,utilization.gpu', '--format=csv,noheader,nounits'],
    5_000,
  );
  const gpus: GpuDevice[] = [];
  if (csv) {
    for (const line of csv.split(/\r?\n/)) {
      const parts = line.split(',').map((part) => Number(part.trim()));
      if (parts.length < 4 || parts.some((n) => Number.isNaN(n))) continue;
      gpus.push({
        index: parts[0]!,
        memTotalMiB: parts[1]!,
        memFreeMiB: parts[2]!,
        utilizationPct: parts[3]!,
      });
    }
  }
  const disk = await probeDisk(projectRoot).catch(() => null);
  const diskFreeBytes = disk?.freeBytes;
  return {
    gpus,
    cpuCores: cpus().length,
    freeMemGiB: Math.round((freemem() / 1024 ** 3) * 10) / 10,
    diskFreeGiB:
      typeof diskFreeBytes === 'number' ? Math.round((diskFreeBytes / 1024 ** 3) * 10) / 10 : null,
    nvidiaSmiAvailable: csv !== null,
    probedAt: Date.now(),
  };
}

/**
 * Greedy admission in stable (createdAt, ideaId) order. GPU requests bind
 * distinct qualifying devices; CPU-only requests reserve cores + memory with
 * headroom. The result NEVER exceeds the user limit or available hardware —
 * excess requests are queued with an explicit reason.
 */
export function computeAdmission(
  probe: CapacityProbe,
  requests: CapacityRequest[],
  opts: AdmissionOptions,
): AdmissionPlan {
  const maxParallel = Math.max(1, Math.floor(opts.maxParallelIdeas));
  const coresPerIdea = opts.coresPerIdea ?? 1;
  const headroomGiB = opts.headroomGiB ?? 1;

  const sorted = [...requests].sort(
    (a, b) => a.createdAt - b.createdAt || a.ideaId.localeCompare(b.ideaId),
  );

  const admitted: AdmittedIdea[] = [];
  const queued: QueuedIdea[] = [];
  const usedDevices = new Set<number>();
  let reservedMemGiB = 0;
  let reservedCores = 0;
  const constraints = new Set<string>();

  for (const request of sorted) {
    if (admitted.length >= maxParallel) {
      constraints.add(`user limit: max_parallel_ideas=${maxParallel}`);
      queued.push({
        ideaId: request.ideaId,
        reason: `queued by user limit max_parallel_ideas=${maxParallel}`,
      });
      continue;
    }

    if (request.gpus > 0) {
      const needMiB = request.memoryGiB * 1024;
      const qualifying = probe.gpus.filter(
        (gpu) => !usedDevices.has(gpu.index) && gpu.memFreeMiB >= needMiB + headroomGiB * 1024,
      );
      if (qualifying.length < request.gpus) {
        constraints.add('GPU free memory / count');
        queued.push({
          ideaId: request.ideaId,
          reason:
            `insufficient free GPU: need ${request.gpus}×${request.memoryGiB}GiB ` +
            `(+${headroomGiB}GiB headroom), ${qualifying.length} device(s) qualify ` +
            `of ${probe.gpus.length} visible`,
        });
        continue;
      }
      const bound = qualifying.slice(0, request.gpus);
      for (const gpu of bound) usedDevices.add(gpu.index);
      admitted.push({
        ideaId: request.ideaId,
        gpus: request.gpus,
        memoryGiB: request.memoryGiB,
        deviceIndices: bound.map((gpu) => gpu.index),
      });
      continue;
    }

    // CPU-only idea: reserve cores + memory with host headroom.
    if (reservedCores + coresPerIdea > probe.cpuCores) {
      constraints.add('CPU cores');
      queued.push({
        ideaId: request.ideaId,
        reason: `insufficient CPU cores: need ${coresPerIdea}, ${probe.cpuCores - reservedCores} free`,
      });
      continue;
    }
    if (reservedMemGiB + request.memoryGiB + headroomGiB > probe.freeMemGiB) {
      constraints.add('host free memory');
      queued.push({
        ideaId: request.ideaId,
        reason:
          `insufficient free memory: need ${request.memoryGiB}+${headroomGiB}GiB headroom, ` +
          `${probe.freeMemGiB}GiB free`,
      });
      continue;
    }
    reservedCores += coresPerIdea;
    reservedMemGiB += request.memoryGiB;
    admitted.push({
      ideaId: request.ideaId,
      gpus: 0,
      memoryGiB: request.memoryGiB,
      deviceIndices: [],
    });
  }

  if (admitted.length < maxParallel && queued.length === 0) {
    constraints.add(`demand: ${admitted.length} ready idea(s) < limit ${maxParallel}`);
  }
  if (probe.gpus.length === 0 && sorted.some((r) => r.gpus > 0)) {
    constraints.add('no visible GPU (nvidia-smi unavailable)');
  }

  return {
    parallelLimit: maxParallel,
    effectiveN: admitted.length,
    admitted,
    queued,
    constraints: [...constraints],
  };
}
