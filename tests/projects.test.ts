import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_BIN, makeProjectDir } from './helpers.js';
import {
  acquireProjectLock,
  inspectProjectLock,
  releaseProjectLock,
} from '../src/runtime/project-lock.js';
import { listRegisteredProjects, registerProject, registryPath } from '../src/runtime/registry.js';

/**
 * Multi-project registry + project lock (PRODUCT_GAPS #5). The registry is
 * redirected via IDEASEEK_REGISTRY_PATH (set in global-setup) so tests never
 * touch the developer's real ~/.ideaseek.
 */

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Per-test-file registry so parallel workers never race on one JSON file. */
let testRegistry: string | null = null;

function runCli(cwd: string, args: string[], timeoutMs = 60_000): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: {
        ...process.env,
        IDEASEEK_CLI: '1',
        ...(testRegistry ? { IDEASEEK_REGISTRY_PATH: testRegistry } : {}),
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli ${args.join(' ')} timed out; stderr=${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

describe('project registry (unit)', () => {
  it('upserts by root idempotently and lists sorted entries', async () => {
    const previous = process.env.IDEASEEK_REGISTRY_PATH;
    const isolated = join(await mkdtemp(join(tmpdir(), 'ideaseek-reg-')), 'projects.json');
    process.env.IDEASEEK_REGISTRY_PATH = isolated;
    try {
      const rootA = (await makeProjectDir('a')).replace(/\\/g, '/');
      const rootB = (await makeProjectDir('b')).replace(/\\/g, '/');
      await registerProject(rootA, 'alpha');
      await registerProject(rootB, 'beta');
      await registerProject(rootA, 'alpha-renamed'); // idempotent upsert

      const listed = await listRegisteredProjects();
      const aEntries = listed.filter((p) => p.root === rootA);
      expect(aEntries).toHaveLength(1);
      expect(aEntries[0]!.name).toBe('alpha-renamed');
      expect(listed.map((p) => p.name)).toContain('beta');
      expect(registryPath()).toBe(isolated);
    } finally {
      if (previous === undefined) delete process.env.IDEASEEK_REGISTRY_PATH;
      else process.env.IDEASEEK_REGISTRY_PATH = previous;
    }
  });

  it('a corrupt registry fails loudly and is never silently overwritten', async () => {
    // A crash during an old non-atomic write leaves truncated JSON. Treating
    // that as an empty registry made the next registerProject wipe every
    // known project — silent data loss. Now: fail with recovery guidance
    // and leave the file byte-for-byte intact.
    const previous = process.env.IDEASEEK_REGISTRY_PATH;
    const isolated = join(await mkdtemp(join(tmpdir(), 'ideaseek-reg-')), 'projects.json');
    const garbage = '{"version":1,"projects":[{"root":';
    await writeFile(isolated, garbage, 'utf8');
    process.env.IDEASEEK_REGISTRY_PATH = isolated;
    try {
      await expect(registerProject('/some/project', 'p')).rejects.toThrow(/not valid JSON/);
      await expect(listRegisteredProjects()).rejects.toThrow(/not valid JSON/);
      expect(await readFile(isolated, 'utf8')).toBe(garbage);
    } finally {
      if (previous === undefined) delete process.env.IDEASEEK_REGISTRY_PATH;
      else process.env.IDEASEEK_REGISTRY_PATH = previous;
    }
  });
});

describe('project lock (unit)', () => {
  it('refuses a live foreign holder, takes over a stale one, releases idempotently', async () => {
    const project = await makeProjectDir();

    // Fresh acquire by us.
    const first = await acquireProjectLock(project, 'unit-test');
    expect(first).toEqual({ acquired: true, tookOverStale: false });
    // Same-pid re-acquire is allowed (reentrant controllers).
    const again = await acquireProjectLock(project, 'unit-test');
    expect(again.acquired).toBe(true);
    await releaseProjectLock(project);
    expect(await inspectProjectLock(project)).toBeNull();
    // Releasing a lock we do not hold is a no-op.
    await releaseProjectLock(project);

    // A live foreign pid blocks.
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    });
    try {
      await writeFile(
        join(project, '.research', 'project-lock.json'),
        JSON.stringify({ pid: sleeper.pid, purpose: 'other-run', acquiredAt: Date.now() }),
        'utf8',
      );
      await expect(acquireProjectLock(project, 'mine')).rejects.toThrow(/project lock/);

      // Kill the owner → stale takeover.
      sleeper.kill('SIGKILL');
      await new Promise((resolve) => sleeper.on('close', resolve));
      const takeover = await acquireProjectLock(project, 'mine');
      expect(takeover).toEqual({ acquired: true, tookOverStale: true });
      const held = await inspectProjectLock(project);
      expect(held?.alive).toBe(true);
      expect(held?.lock.purpose).toBe('mine');
      await releaseProjectLock(project);
    } finally {
      if (sleeper.exitCode === null) sleeper.kill('SIGKILL');
    }
  }, 30_000);
});

describe('ideaseek projects (CLI)', () => {
  beforeEach(async () => {
    testRegistry = join(await mkdtemp(join(tmpdir(), 'ideaseek-projreg-')), 'projects.json');
  });
  afterEach(() => {
    testRegistry = null;
  });

  it('lists registered projects with live status after init', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-projects-'));
    const init = await runCli(project, ['init']);
    expect(init.code).toBe(0);

    const listed = await runCli(project, ['projects', '--json']);
    expect(listed.code, listed.stdout + listed.stderr).toBe(0);
    const payload = JSON.parse(listed.stdout) as {
      projects: {
        root: string;
        name: string;
        exists: boolean;
        lastRun: { runId: string; status: string } | null;
        lock: unknown;
      }[];
    };
    const entry = payload.projects.find((p) =>
      p.root.replace(/\\/g, '/').includes('ideaseek-projects-'),
    );
    expect(entry, 'init must register the project').toBeTruthy();
    expect(entry!.exists).toBe(true);
    expect(entry!.name).toBeTruthy();
    expect(entry!.lastRun).toBeNull(); // no runs yet

    const plain = await runCli(project, ['projects']);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain('ideaseek-projects-');
    expect(plain.stdout).toContain('current directory operates on its own project only');
  }, 60_000);
});

describe('project lock vs concurrent run (CLI)', () => {
  let slowRun: ChildProcess | null = null;

  afterEach(() => {
    if (slowRun && slowRun.exitCode === null) slowRun.kill('SIGKILL');
    slowRun = null;
  });

  it('a second run refuses while the project lock is held, then works after release', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ideaseek-lock-'));
    expect((await runCli(project, ['init'])).code).toBe(0);

    // First run holds the lock while a slow fault keeps it busy.
    slowRun = spawn(
      process.execPath,
      [
        CLI_BIN,
        'run',
        '--question',
        'lock conflict',
        '--fault',
        JSON.stringify({ 'demo.ingest': { slowMs: 4_000 } }),
      ],
      {
        cwd: project,
        env: { ...process.env, IDEASEEK_CLI: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let slowErr = '';
    slowRun.stderr?.on('data', (chunk) => (slowErr += String(chunk)));

    // Wait for the lock file to appear.
    const lockFile = join(project, '.research', 'project-lock.json');
    const started = Date.now();
    while (!(await fileExists(lockFile))) {
      if (Date.now() - started > 15_000) {
        throw new Error(`lock never appeared; stderr=${slowErr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Second run must refuse fast with a clear message.
    const conflict = await runCli(project, ['run', '--question', 'second']);
    expect(conflict.code).not.toBe(0);
    expect(conflict.stderr).toContain('project lock');

    // First run finishes and releases the lock.
    const firstCode = await new Promise<number>((resolve) => {
      slowRun!.on('close', (code) => resolve(code ?? -1));
    });
    expect([0, 3]).toContain(firstCode); // completed or running-state exit
    const released = Date.now();
    while (await fileExists(lockFile)) {
      if (Date.now() - released > 5_000) throw new Error('lock not released after run finished');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    slowRun = null;
  }, 90_000);
});

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf8');
    return true;
  } catch {
    return false;
  }
}
