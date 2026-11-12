import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { killTree, runProcess } from '../src/core/proc.js';

/**
 * Cross-platform subprocess adapter (DEPENDENCY_POLICY): timeouts and
 * cancellation must kill the whole PROCESS TREE — on Windows a plain
 * child.kill() leaves grandchildren (python workers behind a node relay,
 * cmd wrappers around pip) running as orphans. These tests prove the tree
 * semantics on the host platform; the POSIX branch (recursive ppid walk)
 * runs the same suite on Linux/WSL.
 */

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

/** Parent node process that spawns a heartbeating grandchild. */
const PARENT_SCRIPT = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const dir = process.argv[1];
spawn(process.execPath, ['-e',
  "const fs=require('node:fs');const f=process.argv[1];fs.writeFileSync(f,String(process.pid));setInterval(()=>fs.appendFileSync(f,'.'),50);",
  dir + '/grand.pid'], { stdio: 'ignore' });
fs.writeFileSync(dir + '/parent.pid', String(process.pid));
setInterval(() => {}, 1000);
`;

async function readTreePids(dir: string): Promise<{ parentPid: number; grandPid: number }> {
  const parentPid = Number(await readFile(join(dir, 'parent.pid'), 'utf8'));
  const grandPid = Number((await readFile(join(dir, 'grand.pid'), 'utf8')).split('.')[0]);
  return { parentPid, grandPid };
}

async function spawnTreeFixture(): Promise<{
  dir: string;
  parentPid: number;
  grandPid: number;
  proc: ChildProcess;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'ideaseek-proc-'));
  const proc = spawn(process.execPath, ['-e', PARENT_SCRIPT, dir], { stdio: 'ignore' });
  const ready = await waitFor(
    () => existsSync(join(dir, 'parent.pid')) && existsSync(join(dir, 'grand.pid')),
  );
  if (!ready) {
    proc.kill('SIGKILL');
    throw new Error('tree fixture did not start');
  }
  const { parentPid, grandPid } = await readTreePids(dir);
  return { dir, parentPid, grandPid, proc };
}

describe('runProcess', () => {
  it('captures stdout/stderr and the exit code', async () => {
    const result = await runProcess(process.execPath, [
      '-e',
      "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)",
    ]);
    expect(result.code).toBe(3);
    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
    expect(result.timedOut).toBe(false);
    expect(result.canceled).toBe(false);
  });

  it('feeds stdin from input and closes it', async () => {
    const result = await runProcess(
      process.execPath,
      [
        '-e',
        "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(s))",
      ],
      { input: 'ping' },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('ping');
  });

  it('rejects when the executable does not exist', async () => {
    await expect(runProcess('ideaseek-no-such-binary-xyz', [])).rejects.toThrow();
  });

  it('timeout marks timedOut and kills the whole tree', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ideaseek-proc-'));
    const result = await runProcess(process.execPath, ['-e', PARENT_SCRIPT, dir], {
      timeoutMs: 700,
    });
    expect(result.timedOut).toBe(true);
    // Never exited cleanly. (Windows reports taskkill deaths as a non-zero
    // code rather than a signal — the flag above is the portable signal.)
    expect(result.code).not.toBe(0);
    const { parentPid, grandPid } = await readTreePids(dir);
    // Both the direct child AND the grandchild are gone.
    expect(await waitFor(() => !alive(parentPid))).toBe(true);
    expect(await waitFor(() => !alive(grandPid))).toBe(true);
  }, 20_000);

  it('AbortSignal cancels a running process', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const promise = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 300);
    const result = await promise;
    expect(result.canceled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);
});

describe('killTree', () => {
  it('kills descendants, not just the direct child', async () => {
    const { parentPid, grandPid } = await spawnTreeFixture();
    expect(alive(parentPid)).toBe(true);
    expect(alive(grandPid)).toBe(true);

    await killTree(parentPid);
    expect(await waitFor(() => !alive(parentPid))).toBe(true);
    expect(await waitFor(() => !alive(grandPid))).toBe(true);
  }, 20_000);

  it('is idempotent for already-dead pids and never kills itself', async () => {
    const { parentPid } = await spawnTreeFixture();
    await killTree(parentPid);
    await waitFor(() => !alive(parentPid));
    await expect(killTree(parentPid)).resolves.toBeUndefined();
    await expect(killTree(process.pid)).resolves.toBeUndefined();
    expect(alive(process.pid)).toBe(true);
  }, 20_000);
});
