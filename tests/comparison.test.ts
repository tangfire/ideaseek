import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertTransition,
  validateComparisonMethod,
  type ComparisonMethod,
} from '../src/comparison/types.js';
import { importComparisonRepo, upstreamHeadIntact } from '../src/comparison/importer.js';
import type { ProjectRuntime } from '../src/workflow/runtime.js';
import { CLI_BIN, makeProjectDir, openRuntime } from './helpers.js';
import { spawn } from 'node:child_process';

function validMethod(overrides: Partial<ComparisonMethod> = {}): ComparisonMethod {
  return {
    methodId: 'fedavg',
    paperRefs: ['paper-1'],
    required: true,
    sourceKind: 'official-code',
    status: 'candidate',
    notes: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('validateComparisonMethod', () => {
  it('accepts a complete method', () => {
    const result = validateComparisonMethod(validMethod());
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it('rejects bad ids, missing arrays and unknown statuses', () => {
    const result = validateComparisonMethod(
      validMethod({ methodId: 'Bad_ID', status: 'nope' as never, notes: undefined as never }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('kebab-case');
    expect(result.errors.join(' ')).toContain('valid comparison status');
    expect(result.errors.join(' ')).toContain('notes must be an array');
  });

  it('requires statusReason for excluded/blocked/partial', () => {
    const excluded = validateComparisonMethod(validMethod({ status: 'excluded' }));
    expect(excluded.ok).toBe(false);
    expect(excluded.errors.join(' ')).toContain('statusReason');

    const withReason = validateComparisonMethod(
      validMethod({ status: 'excluded', statusReason: 'user chose a different baseline' }),
    );
    expect(withReason.ok).toBe(true);
  });

  it('requires repo.url when repo is present', () => {
    const result = validateComparisonMethod(
      validMethod({ repo: { url: undefined as never, commit: 'abc' } }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('repo.url');
  });
});

describe('assertTransition', () => {
  it('walks the legal happy path', () => {
    expect(() => assertTransition('candidate', 'accepted', undefined)).not.toThrow();
    expect(() => assertTransition('accepted', 'source-resolved', undefined)).not.toThrow();
    expect(() => assertTransition('source-resolved', 'implemented', undefined)).not.toThrow();
    expect(() => assertTransition('implemented', 'smoke-tested', undefined)).not.toThrow();
    expect(() => assertTransition('smoke-tested', 'evaluated', undefined)).not.toThrow();
    expect(() => assertTransition('evaluated', 'validated', undefined)).not.toThrow();
  });

  it('rejects illegal jumps', () => {
    expect(() => assertTransition('candidate', 'validated', undefined)).toThrowError(
      /illegal comparison transition/,
    );
    expect(() => assertTransition('validated', 'repairing', undefined)).toThrowError(
      /illegal comparison transition/,
    );
    expect(() => assertTransition('excluded', 'accepted', undefined)).toThrowError(
      /illegal comparison transition/,
    );
  });

  it('demands a reason for excluded/blocked/partial', () => {
    expect(() => assertTransition('candidate', 'excluded', undefined)).toThrowError(
      /requires --reason/,
    );
    expect(() => assertTransition('candidate', 'excluded', '   ')).toThrowError(
      /requires --reason/,
    );
    expect(() => assertTransition('candidate', 'excluded', 'dup of fedavg')).not.toThrow();
    expect(() => assertTransition('implemented', 'blocked', 'missing deps')).not.toThrow();
  });
});

describe('comparison registry (migration v6)', () => {
  let runtime: ProjectRuntime;
  let dir: string;

  beforeEach(async () => {
    dir = await makeProjectDir();
    runtime = await openRuntime(dir);
  });

  afterEach(async () => {
    await runtime.close();
  });

  it('upserts, reads back and lists with the required filter', async () => {
    const now = Date.now();
    await runtime.db.upsertComparison({
      methodId: 'fedavg',
      status: 'source-resolved',
      required: true,
      record: validMethod({ methodId: 'fedavg', status: 'source-resolved' }) as unknown as Record<
        string,
        unknown
      >,
      updatedAt: now,
    });
    await runtime.db.upsertComparison({
      methodId: 'fedproto',
      status: 'candidate',
      required: false,
      record: validMethod({ methodId: 'fedproto', required: false }) as unknown as Record<
        string,
        unknown
      >,
      updatedAt: now,
    });

    const fedavg = await runtime.db.getComparison('fedavg');
    expect(fedavg?.status).toBe('source-resolved');
    expect(fedavg?.required).toBe(true);

    expect(await runtime.db.listComparisons()).toHaveLength(2);
    const required = await runtime.db.listComparisons({ required: true });
    expect(required.map((m) => m.methodId)).toEqual(['fedavg']);
    expect(await runtime.db.getComparison('missing')).toBeNull();
  });

  it('transitions append history and persist status/reason', async () => {
    await runtime.db.upsertComparison({
      methodId: 'fedavg',
      status: 'candidate',
      required: true,
      record: validMethod() as unknown as Record<string, unknown>,
      updatedAt: 1,
    });
    const after = await runtime.db.transitionComparison('fedavg', 'accepted');
    expect(after.status).toBe('accepted');
    const history = (after.record.history ?? []) as { from: string; to: string }[];
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ from: 'candidate', to: 'accepted', reason: null });

    const excluded = await runtime.db.transitionComparison(
      'fedavg',
      'excluded',
      'superseded by fedprox',
    );
    expect(excluded.status).toBe('excluded');
    expect(excluded.record.statusReason).toBe('superseded by fedprox');
    expect((excluded.record.history as unknown[]).length).toBe(2);
  });

  it('rejects illegal transitions and missing reasons', async () => {
    await runtime.db.upsertComparison({
      methodId: 'fedavg',
      status: 'candidate',
      required: true,
      record: validMethod() as unknown as Record<string, unknown>,
      updatedAt: 1,
    });
    await expect(runtime.db.transitionComparison('fedavg', 'validated')).rejects.toThrow(
      /illegal comparison transition/,
    );
    await expect(runtime.db.transitionComparison('fedavg', 'excluded')).rejects.toThrow(
      /requires --reason/,
    );
    await expect(runtime.db.transitionComparison('ghost', 'accepted')).rejects.toThrow(/not found/);
  });
});

/** Creates a local git repo that can be cloned anonymously as a fixture. */
async function makeLocalGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ideaseek-comp-fixture-'));
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: 'fixture',
        GIT_AUTHOR_EMAIL: 'fixture@test',
        GIT_COMMITTER_NAME: 'fixture',
        GIT_COMMITTER_EMAIL: 'fixture@test',
      },
      encoding: 'utf8',
    });
  git(['init']);
  await writeFile(join(dir, 'README.md'), '# fixture baseline\n', 'utf8');
  await writeFile(join(dir, 'LICENSE'), 'MIT License\n\nPermission is hereby granted.\n', 'utf8');
  await writeFile(join(dir, 'run.py'), 'print("ok")\n', 'utf8');
  git(['add', '.']);
  git(['commit', '-m', 'fixture']);
  return dir;
}

describe('importComparisonRepo', () => {
  let fixture: string;
  let project: string;

  beforeEach(async () => {
    fixture = await makeLocalGitRepo();
    project = await makeProjectDir();
  });

  it('clones into upstream, links a worktree and records commit/license', async () => {
    const result = await importComparisonRepo(project, {
      methodDir: 'comparisons/fedavg',
      url: fixture,
    });
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.license).toContain('MIT License');

    const head = await readFile(join(result.upstreamDir, 'README.md'), 'utf8');
    expect(head).toContain('fixture baseline');
    expect(await upstreamHeadIntact(result.upstreamDir, result.commit)).toBe(true);

    // Edits go to the worktree; upstream must stay clean.
    await writeFile(join(result.worktreeDir, 'run.py'), 'print("edited")\n', 'utf8');
    expect(await upstreamHeadIntact(result.upstreamDir, result.commit)).toBe(true);
    const upstreamPy = await readFile(join(result.upstreamDir, 'run.py'), 'utf8');
    expect(upstreamPy).toContain('print("ok")');
  });

  it('refuses to overwrite an existing upstream (idempotency guard)', async () => {
    await importComparisonRepo(project, { methodDir: 'comparisons/fedavg', url: fixture });
    await expect(
      importComparisonRepo(project, { methodDir: 'comparisons/fedavg', url: fixture }),
    ).rejects.toThrow(/upstream already exists/);
  });

  it('fails with a network/clone error on an unreachable url', async () => {
    await expect(
      importComparisonRepo(project, {
        methodDir: 'comparisons/ghost',
        url: join(project, 'does-not-exist.git'),
      }),
    ).rejects.toThrow(/anonymous clone failed/);
  });
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[], timeoutMs = 30_000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, IDEASEEK_CLI: '1' },
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
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

describe('ideaseek comparison CLI end-to-end', () => {
  let fixture: string;
  let project: string;

  beforeEach(async () => {
    fixture = await makeLocalGitRepo();
    project = await mkdtemp(join(tmpdir(), 'ideaseek-comp-e2e-'));
    const init = await runCli(project, ['init']);
    expect(init.code).toBe(0);
  }, 60_000);

  it('import → list → set-status gate → smoke → yaml export', async () => {
    const imported = await runCli(project, [
      'comparison',
      'import',
      'fedavg',
      fixture,
      '--paper',
      'paper-1',
      '--json',
    ]);
    expect(imported.code).toBe(0);
    const payload = JSON.parse(imported.stdout) as {
      methodId: string;
      status: string;
      commit: string;
      license: string | null;
    };
    expect(payload).toMatchObject({ methodId: 'fedavg', status: 'source-resolved' });
    expect(payload.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(payload.license).toContain('MIT');

    const listed = await runCli(project, ['comparison', 'list', '--json']);
    expect(listed.code).toBe(0);
    const listPayload = JSON.parse(listed.stdout) as { methods: { methodId: string }[] };
    expect(listPayload.methods.map((m) => m.methodId)).toEqual(['fedavg']);

    // excluded requires a reason (no silent skips of required methods).
    const noReason = await runCli(project, ['comparison', 'set-status', 'fedavg', 'excluded']);
    expect(noReason.code).not.toBe(0);
    expect(noReason.stderr).toContain('requires --reason');

    const illegal = await runCli(project, ['comparison', 'set-status', 'fedavg', 'validated']);
    expect(illegal.code).not.toBe(0);
    expect(illegal.stderr).toContain('illegal comparison transition');

    // Smoke evidence from a fresh source-resolved import is recorded without
    // an illegal source-resolved → smoke-tested jump.
    const earlySmoke = await runCli(project, ['comparison', 'smoke', 'fedavg', '--json']);
    expect(earlySmoke.code).toBe(0);
    const earlyPayload = JSON.parse(earlySmoke.stdout) as { passed: boolean; status: string };
    expect(earlyPayload.passed).toBe(true);
    expect(earlyPayload.status).toBe('source-resolved');

    const implemented = await runCli(project, [
      'comparison',
      'set-status',
      'fedavg',
      'implemented',
      '--json',
    ]);
    expect(implemented.code).toBe(0);

    const smoke = await runCli(project, ['comparison', 'smoke', 'fedavg', '--json']);
    expect(smoke.code).toBe(0);
    const smokePayload = JSON.parse(smoke.stdout) as {
      passed: boolean;
      status: string;
      logPath: string;
    };
    expect(smokePayload.passed).toBe(true);
    expect(smokePayload.status).toBe('smoke-tested');

    const yaml = await readFile(join(project, 'comparisons', 'fedavg', 'method.yaml'), 'utf8');
    expect(yaml).toContain('methodId: fedavg');
    expect(yaml).toContain('smoke-tested');

    // upstream stays clean after smoke ran inside the worktree.
    const doc = await readFile(
      join(project, 'comparisons', 'fedavg', 'upstream', 'run.py'),
      'utf8',
    );
    expect(doc).toContain('print("ok")');
  }, 60_000);

  it('rejects unknown method ids and bad source kinds', async () => {
    const ghost = await runCli(project, ['comparison', 'set-status', 'ghost', 'accepted']);
    expect(ghost.code).not.toBe(0);
    expect(ghost.stderr).toContain('not found');

    const badSource = await runCli(project, [
      'comparison',
      'import',
      'bad-src',
      fixture,
      '--source',
      'plagiarized',
    ]);
    expect(badSource.code).not.toBe(0);
    expect(badSource.stderr).toContain('--source must be');
  }, 60_000);
});
