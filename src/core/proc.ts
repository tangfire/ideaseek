import { spawn } from 'node:child_process';
import treeKill from 'tree-kill';

/**
 * Cross-platform subprocess adapter (DEPENDENCY_POLICY: 子进程 = 成熟
 * 跨平台能力 + IdeaSeek 自己的超时/取消/失败语义).
 *
 * The gap this closes: `child.kill('SIGKILL')` on Windows terminates only
 * the DIRECT child — a `node` relay that spawned a python worker, or a
 * `cmd` wrapper around pip, leaves grandchildren running as orphans.
 * `tree-kill` (MIT, tiny, battle-tested) does `taskkill /T /F` on win32
 * and a recursive ppid walk on POSIX; everything else — timeout, abort,
 * exit codes, failure flags — stays here so every call site shares one
 * set of semantics.
 */

/** Kills `pid` and all of its descendants. Idempotent: a dead pid is fine. */
export function killTree(pid: number | undefined | null, signal = 'SIGKILL'): Promise<void> {
  return new Promise((resolve) => {
    if (!pid || pid <= 0 || pid === process.pid) {
      resolve();
      return;
    }
    // tree-kill reports ESRCH/already-dead through the callback — a second
    // kill racing the first must never reject a cleanup path.
    treeKill(pid, signal, () => resolve());
  });
}

/** Fire-and-forget variant for synchronous timer callbacks. */
export function killTreeSafe(pid: number | undefined | null): void {
  void killTree(pid).catch(() => undefined);
}

export interface RunProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** After this long, the WHOLE tree is killed; result carries `timedOut`. */
  timeoutMs?: number;
  /** Aborting kills the whole tree; result carries `canceled`. */
  signal?: AbortSignal;
  /** Written to the child's stdin, then stdin is closed. */
  input?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface RunProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  canceled: boolean;
}

/**
 * Buffered spawn with shared timeout/cancel/tree-kill semantics. Resolves
 * for every completed run (including killed ones — check the flags);
 * rejects only when the process could not be spawned at all.
 */
export function runProcess(
  file: string,
  args: string[],
  opts: RunProcessOptions = {},
): Promise<RunProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true, // never flash a console window on Windows
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let canceled = false;
    let spawnFailed = false;

    const stop = (): void => {
      if (child.pid) killTreeSafe(child.pid);
    };

    const timer =
      opts.timeoutMs !== undefined && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            stop();
          }, opts.timeoutMs)
        : null;

    const onAbort = (): void => {
      canceled = true;
      stop();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk);
      stdout += text;
      opts.onStdout?.(text);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk);
      stderr += text;
      opts.onStderr?.(text);
    });

    if (opts.input !== undefined) {
      child.stdin?.on('error', () => {
        // child may exit before reading stdin (EPIPE) — not a spawn failure
      });
      child.stdin?.end(opts.input);
    } else {
      child.stdin?.end();
    }

    child.on('error', (error) => {
      spawnFailed = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code, closeSignal) => {
      if (spawnFailed) return;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        code,
        signal: closeSignal,
        stdout,
        stderr,
        timedOut,
        canceled,
      });
    });
  });
}
