import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

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

export function runCli(
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntryPath(), ...args], {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, IDEASEEK_CLI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ideaseek ${args.join(' ')} timed out`));
    }, opts.timeoutMs ?? 30_000);
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
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
