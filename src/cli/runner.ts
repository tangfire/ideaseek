import { resolve } from 'node:path';
import { runProcess } from '../core/proc.js';

/**
 * Runs this same CLI in a child process so slash commands reuse the exact
 * business logic of their non-interactive counterparts (docs/TERMINAL_UX:
 * 每个斜杠命令都有等价的非交互 CLI 命令). No service layer is duplicated —
 * the REPL is a thin relay over `ideaseek <cmd>`.
 */
export interface CliRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Resolved once at module load (original cwd): the REPL may chdir when the
// session switches projects, so a relative argv[1] must not be re-resolved
// against the new working directory on the next relay spawn.
const ENTRY_AT_START = process.argv[1] ? resolve(process.argv[1]) : null;

export function cliEntryPath(): string {
  if (!ENTRY_AT_START) throw new Error('cannot locate ideaseek entry script');
  return ENTRY_AT_START;
}

export async function runCli(
  args: string[],
  opts: {
    cwd?: string;
    timeoutMs?: number;
    /** Incremental chunks as they arrive — line framing is the caller's job. */
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    /** Abort kills the whole tree; the promise still resolves with what ran. */
    signal?: AbortSignal;
  } = {},
): Promise<CliRunResult> {
  // Shared subprocess adapter: timeout kills the WHOLE tree (a relay child
  // may itself have spawned python workers) instead of orphaning them.
  const timeoutMs = opts.timeoutMs ?? 30_000;
  // Spawn failures keep the historical rejection contract (runProcess
  // rejects only when the process could not be started).
  const result = await runProcess(process.execPath, [cliEntryPath(), ...args], {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, IDEASEEK_CLI: '1' },
    timeoutMs,
    ...(opts.onStdout ? { onStdout: opts.onStdout } : {}),
    ...(opts.onStderr ? { onStderr: opts.onStderr } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (result.timedOut) {
    throw new Error(`ideaseek ${args.join(' ')} timed out`);
  }
  return { code: result.code ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** Runs a CLI command and parses its single JSON-line payload. */
export async function runCliJson<T = unknown>(
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ code: number; data: T | null; stdout: string; stderr: string }> {
  const result = await runCli(args, opts);
  const line = result.stdout
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .pop();
  let data: T | null = null;
  if (line) {
    try {
      data = JSON.parse(line) as T;
    } catch {
      data = null;
    }
  }
  return { ...result, data };
}
