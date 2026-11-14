import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerProject } from '../src/runtime/registry.js';
import { CLI_BIN, makeProjectDir } from './helpers.js';

/**
 * `ideaseek open <project>` (docs/CLI_SPEC, TERMINAL_UX): two-step project
 * selection with a mode/project/permission summary, registry-name and path
 * resolution, document fallback, and the global `--project <path>` override.
 */

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 60_000,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1', ...env },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli ${args.join(' ')} timed out`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function isolatedRegistry(): string {
  return join(
    tmpdir(),
    `ideaseek-open-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
}

async function registerIsolated(root: string, name: string): Promise<string> {
  const registry = isolatedRegistry();
  const previous = process.env.IDEASEEK_REGISTRY_PATH;
  process.env.IDEASEEK_REGISTRY_PATH = registry;
  try {
    await registerProject(root, name);
  } finally {
    if (previous === undefined) delete process.env.IDEASEEK_REGISTRY_PATH;
    else process.env.IDEASEEK_REGISTRY_PATH = previous;
  }
  return registry;
}

interface OpenPayload {
  kind: string;
  name?: string;
  root?: string;
  summary?: { mode: string; project: string; permissions: string[] };
}

describe('ideaseek open (project selection)', () => {
  it('previews a switch with the summary and completes with --confirm', async () => {
    const alpha = await makeProjectDir('alpha');
    const beta = await makeProjectDir('beta');

    const preview = await runCli(alpha, ['open', beta, '--json']);
    expect(preview.code).toBe(0);
    const payload = JSON.parse(preview.stdout) as OpenPayload;
    expect(payload.kind).toBe('switch-target');
    expect(payload.name).toBe('beta');
    expect(payload.summary?.project).toBe('beta');
    expect(payload.summary?.permissions.length).toBeGreaterThan(2);

    const human = await runCli(alpha, ['open', beta]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('switch target : beta');
    expect(human.stdout).toContain('session mode : research');
    expect(human.stdout).toContain('read-only inputs');
    expect(human.stdout).toContain('--confirm');

    const confirmed = await runCli(alpha, ['open', beta, '--confirm', '--json']);
    expect(confirmed.code).toBe(0);
    expect(JSON.parse(confirmed.stdout) as OpenPayload).toMatchObject({
      kind: 'project',
      root: beta,
    });
  });

  it('resolves registered project names (exact and fuzzy)', async () => {
    const alpha = await makeProjectDir('alpha');
    const beta = await makeProjectDir('beta-lab');
    const registry = await registerIsolated(beta, 'beta-lab');
    const env = { IDEASEEK_REGISTRY_PATH: registry };

    const exact = await runCli(alpha, ['open', 'beta-lab', '--confirm', '--json'], env);
    expect(exact.code).toBe(0);
    expect(JSON.parse(exact.stdout) as OpenPayload).toMatchObject({
      kind: 'project',
      root: beta,
    });

    const fuzzy = await runCli(alpha, ['open', 'beta', '--json'], env);
    expect(fuzzy.code).toBe(0);
    expect(JSON.parse(fuzzy.stdout) as OpenPayload).toMatchObject({ kind: 'switch-target' });

    const unknown = await runCli(alpha, ['open', 'ghost', '--json'], env);
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain('no project or document matches');
  });

  it('overview lists the summary, registered projects and documents', async () => {
    const alpha = await makeProjectDir('alpha');
    await mkdir(join(alpha, 'knowledge'), { recursive: true });
    await writeFile(join(alpha, 'knowledge', 'note.md'), '# note\n', 'utf8');
    const beta = await makeProjectDir('beta');
    const registry = await registerIsolated(beta, 'beta');

    const shown = await runCli(alpha, ['open'], { IDEASEEK_REGISTRY_PATH: registry });
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain('session mode : research');
    expect(shown.stdout).toContain('registered project(s)');
    expect(shown.stdout).toContain('beta');
    expect(shown.stdout).toContain('knowledge/note.md');
  });

  it('falls back to documents and reports a combined not-found error', async () => {
    const alpha = await makeProjectDir('alpha');
    await mkdir(join(alpha, 'knowledge'), { recursive: true });
    await writeFile(join(alpha, 'knowledge', 'note.md'), '# note\nfirst line\n', 'utf8');

    const doc = await runCli(alpha, ['open', 'note']);
    expect(doc.code).toBe(0);
    expect(doc.stdout).toContain('first line');

    const missing = await runCli(alpha, ['open', 'nothing-here']);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('no project or document matches');
  });

  it('opens a project from a directory that is not a project', async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), 'ideaseek-noproj-'));
    const beta = await makeProjectDir('beta');
    const result = await runCli(elsewhere, ['open', beta, '--confirm', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout) as OpenPayload).toMatchObject({ kind: 'project' });
  });

  it('bare open from a non-project directory lists the registry instead of failing', async () => {
    // The door back into research work has to be findable from a general
    // coding session; this used to answer NOT_INITIALIZED, which left the user
    // with no way to discover their own projects.
    const elsewhere = await mkdtemp(join(tmpdir(), 'ideaseek-noproj-overview-'));
    const beta = await makeProjectDir('beta');
    const registry = await registerIsolated(beta, 'beta');

    const shown = await runCli(elsewhere, ['open'], { IDEASEEK_REGISTRY_PATH: registry });
    expect(shown.code).toBe(0);
    expect(shown.stdout).not.toContain('NOT_INITIALIZED');
    expect(shown.stdout).toContain('registered project(s)');
    expect(shown.stdout).toContain('beta');
    expect(shown.stdout).toContain('/open <name|path> --confirm');

    // A registry outlives temp and test projects; dead records are counted,
    // not listed, so the real work stays findable.
    const ghost = await makeProjectDir('ghost');
    const previous = process.env.IDEASEEK_REGISTRY_PATH;
    process.env.IDEASEEK_REGISTRY_PATH = registry;
    try {
      await registerProject(ghost, 'ghost');
    } finally {
      if (previous === undefined) delete process.env.IDEASEEK_REGISTRY_PATH;
      else process.env.IDEASEEK_REGISTRY_PATH = previous;
    }
    await rm(ghost, { recursive: true, force: true });

    const withStale = await runCli(elsewhere, ['open'], { IDEASEEK_REGISTRY_PATH: registry });
    expect(withStale.stdout).toContain('beta');
    expect(withStale.stdout).not.toContain('ghost');
    expect(withStale.stdout).toContain('1 record(s) point at missing directories and are hidden');
    const staleJson = await runCli(elsewhere, ['open', '--json'], {
      IDEASEEK_REGISTRY_PATH: registry,
    });
    expect((JSON.parse(staleJson.stdout) as { hiddenStale: number }).hiddenStale).toBe(1);

    const json = await runCli(elsewhere, ['open', '--json'], {
      IDEASEEK_REGISTRY_PATH: registry,
    });
    expect(json.code).toBe(0);
    const payload = JSON.parse(json.stdout) as OpenPayload & { current: unknown };
    expect(payload.kind).toBe('projects');
    expect(payload.current).toBeNull();

    // An empty registry is a hint, not a wall.
    const empty = await runCli(elsewhere, ['open'], {
      IDEASEEK_REGISTRY_PATH: join(elsewhere, 'no-registry.json'),
    });
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain('ideaseek init');
  });

  it('--project overrides the working directory for any command', async () => {
    const alpha = await makeProjectDir('alpha');
    const elsewhere = await mkdtemp(join(tmpdir(), 'ideaseek-noproj-'));

    const before = await runCli(elsewhere, ['--project', alpha, 'status', '--json']);
    expect(before.code).toBe(0);
    expect(JSON.parse(before.stdout)).toMatchObject({ project: 'alpha' });

    // Works after the subcommand too (docs/USER_GUIDE: status --project …).
    const after = await runCli(elsewhere, ['status', '--project', alpha, '--json']);
    expect(after.code).toBe(0);
    expect(JSON.parse(after.stdout)).toMatchObject({ project: 'alpha' });

    const missing = await runCli(elsewhere, ['--project', join(elsewhere, 'nope'), 'status']);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('--project path not found');
  });
});
