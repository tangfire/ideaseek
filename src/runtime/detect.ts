import { spawn } from 'node:child_process';
import { statfs } from 'node:fs/promises';

/**
 * Best-effort external command probe. Never throws: a missing binary, a
 * non-zero exit or a hang all collapse into `available: false` with a reason,
 * so `doctor` can always render a full report.
 */
export interface CommandProbe {
  available: boolean;
  version: string | null;
  detail: string | null;
}

export interface ProbeOptions {
  timeoutMs?: number;
}

export async function probeCommand(
  command: string,
  args: string[],
  opts: ProbeOptions = {},
): Promise<CommandProbe> {
  const timeoutMs = opts.timeoutMs ?? 4000;
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ available: false, version: null, detail: (error as Error).message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (probe: CommandProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(probe);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ available: false, version: null, detail: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr?.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      finish({
        available: false,
        version: null,
        detail: code === 'ENOENT' ? `${command} not found on PATH` : error.message,
      });
    });
    child.on('close', (code) => {
      const output = `${stdout}${stderr}`.trim();
      const firstLine = output.split(/\r?\n/)[0] ?? '';
      const versionMatch = firstLine.match(/\d+\.\d+(\.\d+)?/);
      if (code === 0) {
        finish({
          available: true,
          version: versionMatch ? versionMatch[0] : firstLine || null,
          detail: firstLine || null,
        });
      } else {
        finish({
          available: false,
          version: null,
          detail: output || `exit code ${code ?? 'unknown'}`,
        });
      }
    });
  });
}

export interface DiskUsage {
  freeBytes: number | null;
  totalBytes: number | null;
}

export async function probeDisk(path: string): Promise<DiskUsage> {
  try {
    const info = await statfs(path);
    const blockSize = Number(info.bsize);
    return {
      freeBytes: Number(info.bavail) * blockSize,
      totalBytes: Number(info.blocks) * blockSize,
    };
  } catch {
    return { freeBytes: null, totalBytes: null };
  }
}

export interface EnvironmentReport {
  platform: { os: string; arch: string; release: string };
  node: { version: string; supported: boolean; required: string };
  python: CommandProbe & { candidates: string[] };
  containerRuntimes: { docker: CommandProbe; podman: CommandProbe };
  gpu: { nvidiaSmi: CommandProbe; devices: string[]; cudaVersion: string | null };
  disk: DiskUsage;
  detectedAt: number;
}

export const NODE_REQUIRED = { major: 24, minor: 9 };

function nodeSupported(version: string): boolean {
  const [major = '0', minor = '0'] = version.split('.');
  const m = Number(major);
  const n = Number(minor);
  if (m > NODE_REQUIRED.major) return true;
  return m === NODE_REQUIRED.major && n >= NODE_REQUIRED.minor;
}

/**
 * Probes the host for the toolchain Phase 0 reports on: Node (hard
 * requirement), Python (needed by future workers), container runtimes and
 * NVIDIA GPUs (needed by later experiment phases), plus project disk space.
 * All probes are read-only and network-free.
 */
export async function detectEnvironment(projectRoot: string): Promise<EnvironmentReport> {
  const nodeVersion = process.versions.node;
  const [python3, python, py] = await Promise.all([
    probeCommand('python3', ['--version']),
    probeCommand('python', ['--version']),
    probeCommand('py', ['--version']),
  ]);
  const pythonProbe = python3.available
    ? python3
    : python.available
      ? python
      : py.available
        ? py
        : { available: false, version: null, detail: 'no python3/python/py on PATH' };

  const [docker, podman, nvidiaSmi, nvidiaSummary, disk] = await Promise.all([
    probeCommand('docker', ['--version']),
    probeCommand('podman', ['--version']),
    probeCommand('nvidia-smi', ['-L']),
    probeCommand('nvidia-smi', []),
    probeDisk(projectRoot),
  ]);

  const devices = nvidiaSmi.available
    ? (nvidiaSmi.detail
        ?.split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0) ?? [])
    : [];
  const cudaMatch = `${nvidiaSummary.detail ?? ''}`.match(/CUDA Version:\s*([\d.]+)/);
  const cudaVersion = cudaMatch?.[1] ?? null;

  return {
    platform: {
      os: process.platform,
      arch: process.arch,
      release: process.release.name,
    },
    node: {
      version: nodeVersion,
      supported: nodeSupported(nodeVersion),
      required: `>=${NODE_REQUIRED.major}.${NODE_REQUIRED.minor}`,
    },
    python: { ...pythonProbe, candidates: ['python3', 'python', 'py'] },
    containerRuntimes: { docker, podman },
    gpu: { nvidiaSmi, devices, cudaVersion },
    disk,
    detectedAt: Date.now(),
  };
}
