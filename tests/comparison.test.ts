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
import {
  buildCandidates,
  classifyLicense,
  extractRepoUrls,
  normalizeRepoUrl,
} from '../src/comparison/discover.js';
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

  it('register → import without url walks legal hops with history', async () => {
    const registered = await runCli(project, [
      'comparison',
      'register',
      'fedprox',
      '--repo',
      fixture,
      '--paper',
      'paper-9',
      '--json',
    ]);
    expect(registered.code).toBe(0);
    const regPayload = JSON.parse(registered.stdout) as { status: string };
    expect(regPayload.status).toBe('candidate');

    // Import without a url falls back to the registered repo.
    const imported = await runCli(project, ['comparison', 'import', 'fedprox', '--json']);
    expect(imported.code).toBe(0);
    const impPayload = JSON.parse(imported.stdout) as {
      status: string;
      licenseKind: string;
    };
    expect(impPayload.status).toBe('source-resolved');
    expect(impPayload.licenseKind).toBe('permissive');

    const yaml = await readFile(join(project, 'comparisons', 'fedprox', 'method.yaml'), 'utf8');
    expect(yaml).toContain('paper-9');
    expect(yaml).toContain('candidate');
    expect(yaml).toContain('accepted');
    // Duplicate registration is refused.
    const again = await runCli(project, ['comparison', 'register', 'fedprox', '--repo', fixture]);
    expect(again.code).not.toBe(0);
    expect(again.stderr).toContain('already registered');
  }, 60_000);

  it('discover reports empty corpus without crashing', async () => {
    const discovered = await runCli(project, ['comparison', 'discover', '--json']);
    expect(discovered.code).toBe(0);
    const payload = JSON.parse(discovered.stdout) as {
      mentionCount: number;
      candidates: unknown[];
    };
    expect(payload.mentionCount).toBe(0);
    expect(payload.candidates).toEqual([]);
    const file = await readFile(join(project, 'knowledge', 'comparison-candidates.json'), 'utf8');
    expect(JSON.parse(file)).toMatchObject({ mentionCount: 0 });
  }, 60_000);
});

describe('extractRepoUrls / normalizeRepoUrl', () => {
  it('normalizes scheme, www, .git suffix and deep paths', () => {
    expect(normalizeRepoUrl('https://github.com/facebookresearch/fedlab.git')).toBe(
      'https://github.com/facebookresearch/fedlab',
    );
    expect(normalizeRepoUrl('www.github.com/org/repo/tree/main/src')).toBe(
      'https://github.com/org/repo',
    );
    expect(normalizeRepoUrl('github.com/org/repo')).toBe('https://github.com/org/repo');
    expect(normalizeRepoUrl('https://gitlab.com/org/repo.git/')).toBe(
      'https://gitlab.com/org/repo',
    );
  });

  it('rejects reserved owners and non-repo paths', () => {
    expect(normalizeRepoUrl('https://github.com/topics/federated')).toBeNull();
    expect(normalizeRepoUrl('https://github.com/settings/tokens')).toBeNull();
    expect(normalizeRepoUrl('not a url at all')).toBeNull();
  });

  it('extracts unique urls in order and skips trailing punctuation', () => {
    const text =
      'Code at https://github.com/a/b, also github.com/c/d. See github.com/a/b again and https://github.com/topics/x.';
    expect(extractRepoUrls(text)).toEqual(['https://github.com/a/b', 'https://github.com/c/d']);
  });
});

describe('classifyLicense', () => {
  it('classifies common license heads', () => {
    expect(classifyLicense('MIT License\n\nPermission is hereby granted')).toBe('permissive');
    expect(classifyLicense('Apache License Version 2.0')).toBe('permissive');
    expect(classifyLicense('GNU GENERAL PUBLIC LICENSE Version 3')).toBe('copyleft');
    expect(classifyLicense('GNU AFFERO GENERAL PUBLIC LICENSE Version 3')).toBe('copyleft');
    expect(classifyLicense('GNU LESSER GENERAL PUBLIC LICENSE Version 3')).toBe('weak-copyleft');
    expect(classifyLicense('Mozilla Public License Version 2.0')).toBe('weak-copyleft');
    expect(classifyLicense('All rights reserved.')).toBe('unknown');
    expect(classifyLicense(null)).toBe('none');
  });
});

describe('buildCandidates', () => {
  it('groups mentions per repo with paper provenance and counts', () => {
    const candidates = buildCandidates([
      { paperKey: 'p2', source: 'papers/b.pdf', page: 3, url: 'https://github.com/x/y' },
      { paperKey: 'p1', source: 'papers/a.pdf', page: 1, url: 'https://github.com/x/y' },
      { paperKey: 'p1', source: 'papers/a.pdf', page: 5, url: 'https://github.com/x/y' },
      { paperKey: 'p1', source: 'papers/a.pdf', page: 2, url: 'https://github.com/m/n' },
    ]);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      repoUrl: 'https://github.com/x/y',
      mentions: 3,
      paperRefs: ['p1', 'p2'],
    });
    expect(candidates[0]!.pages.p1).toEqual([1, 5]);
    expect(candidates[1]!.repoUrl).toBe('https://github.com/m/n');
  });
});

describe('findRepoUrlMentions (DB)', () => {
  let runtime: ProjectRuntime;
  let dir: string;

  beforeEach(async () => {
    dir = await makeProjectDir();
    runtime = await openRuntime(dir);
  });

  afterEach(async () => {
    await runtime.close();
  });

  it('finds normalized repo urls in indexed paper pages', async () => {
    await runtime.db.replacePaperIndex({
      paperKey: 'sha256:aaa',
      source: 'papers/fed.pdf',
      parser: 'pdf',
      pageCount: 2,
      indexedAt: 1,
      pages: [
        { page: 1, text: 'We build on FedAvg; code at https://github.com/google/fedavg.' },
        { page: 2, text: 'Baseline: github.com/facebookresearch/fedlab and github.com/topics/ml' },
      ],
    });
    const mentions = await runtime.db.findRepoUrlMentions();
    expect(mentions.map((m) => m.url).sort()).toEqual([
      'https://github.com/facebookresearch/fedlab',
      'https://github.com/google/fedavg',
    ]);
    expect(mentions.find((m) => m.url.includes('fedavg'))).toMatchObject({
      paperKey: 'sha256:aaa',
      page: 1,
      source: 'papers/fed.pdf',
    });

    // Empty corpus → no mentions.
    await runtime.db.removePaperIndex('sha256:aaa');
    expect(await runtime.db.findRepoUrlMentions()).toEqual([]);
  });
});

describe('ideaseek comparison gate', () => {
  let project: string;

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'ideaseek-gate-e2e-'));
    const init = await runCli(project, ['init']);
    expect(init.code).toBe(0);
  }, 60_000);

  async function registerWithStatus(id: string, statuses: string[]): Promise<void> {
    const reg = await runCli(project, ['comparison', 'register', id]);
    expect(reg.code).toBe(0);
    for (const status of statuses) {
      const step = await runCli(project, ['comparison', 'set-status', id, status]);
      expect(step.code, `${id} → ${status}: ${step.stderr}`).toBe(0);
    }
  }

  it('blocks with no required methods, fails on pending, passes after smoke-tested', async () => {
    // No methods at all → the gate refuses to vouch for an empty set (it
    // used to note-and-pass, letting handoff reach a paper with zero
    // baselines registered).
    const empty = await runCli(project, ['comparison', 'gate', '--json']);
    expect(empty.code, empty.stdout + empty.stderr).toBe(2);
    const emptyPayload = JSON.parse(empty.stdout) as {
      ok: boolean;
      blocking: { methodId: string; hint: string }[];
      note?: string;
    };
    expect(emptyPayload.ok).toBe(false);
    expect(emptyPayload.note).toBe('no required comparisons registered');
    expect(emptyPayload.blocking[0]).toMatchObject({ methodId: '(none)' });
    expect(emptyPayload.blocking[0]!.hint).toContain('ideaseek comparison discover');

    // Registered but not runnable → blocking (exit 2).
    await registerWithStatus('fedavg', ['accepted', 'source-resolved']);
    const pending = await runCli(project, ['comparison', 'gate', '--json']);
    expect(pending.code).toBe(2);
    const pendingPayload = JSON.parse(pending.stdout) as {
      ok: boolean;
      blocking: { methodId: string; status: string }[];
    };
    expect(pendingPayload.ok).toBe(false);
    expect(pendingPayload.blocking[0]).toMatchObject({
      methodId: 'fedavg',
      status: 'source-resolved',
    });

    // Advance to smoke-tested (implemented hop needs no worktree for status).
    const impl = await runCli(project, ['comparison', 'set-status', 'fedavg', 'implemented']);
    expect(impl.code).toBe(0);
    const smoke = await runCli(project, ['comparison', 'set-status', 'fedavg', 'smoke-tested']);
    expect(smoke.code).toBe(0);

    const passing = await runCli(project, ['comparison', 'gate']);
    expect(passing.code).toBe(0);
    expect(passing.stdout).toContain('gate PASSED');
    expect(passing.stdout).toContain('PASS  fedavg');
  }, 60_000);

  it('records reasoned exclusions as SKIP and ignores reference-only methods', async () => {
    await registerWithStatus('fedavg', ['accepted', 'source-resolved']);
    const excluded = await runCli(project, [
      'comparison',
      'set-status',
      'fedavg',
      'excluded',
      '--reason',
      'license forbids use',
      '--confirm', // guided-mode confirmation for a required-method exclusion
    ]);
    expect(excluded.code).toBe(0);

    // Reference-only method in a non-passing state must not block the gate.
    const ref = await runCli(project, ['comparison', 'register', 'fedproto', '--reference-only']);
    expect(ref.code).toBe(0);

    const gate = await runCli(project, ['comparison', 'gate', '--json']);
    // Carried with the output, because this assertion failed once in a full
    // parallel run and passed in isolation — and with a bare `toBe(0)` the
    // failure said nothing about WHY the gate was not ok. A flake that cannot
    // explain itself is only ever fixed by luck.
    expect(gate.code, `stdout=${gate.stdout} stderr=${gate.stderr}`).toBe(0);
    const payload = JSON.parse(gate.stdout) as {
      ok: boolean;
      skipped: { methodId: string; reason: string | null }[];
      passed: unknown[];
      blocking: unknown[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.skipped).toEqual([{ methodId: 'fedavg', reason: 'license forbids use' }]);
    expect(payload.passed).toEqual([]);
    expect(payload.blocking).toEqual([]);

    const plain = await runCli(project, ['comparison', 'gate']);
    expect(plain.stdout).toContain('SKIP  fedavg  excluded (license forbids use)');
  }, 60_000);

  it('accepts a covering experiment result as a runnable result', async () => {
    await registerWithStatus('fedavg', ['accepted', 'source-resolved']);

    const spec = {
      specId: 'exp-fedavg-gate',
      version: 1,
      idea: null,
      comparisonIds: ['fedavg'],
      codeCommit: null,
      dataSnapshotId: 'sha256:deadbeef',
      sliceIds: ['slice-smoke-1'],
      environment: {},
      command: ['python', 'train.py'],
      metrics: [{ name: 'accuracy', direction: 'higher' }],
      seeds: [42],
      resources: {},
      budget: {},
      protocolId: null,
      createdAt: 1,
    };
    const specPath = join(project, 'gate-spec.json');
    await writeFile(specPath, JSON.stringify(spec), 'utf8');
    const recorded = await runCli(project, ['experiment', 'spec', specPath]);
    expect(recorded.code).toBe(0);

    const result = {
      specId: 'exp-fedavg-gate',
      status: 'succeeded',
      logRefs: [],
      artifactRefs: [],
      metrics: [{ name: 'accuracy', value: 0.9 }],
      resourcesUsed: {},
      failure: null,
      startedAt: 1,
      finishedAt: 2,
    };
    const resultPath = join(project, 'gate-result.json');
    await writeFile(resultPath, JSON.stringify(result), 'utf8');
    const attached = await runCli(project, ['experiment', 'result', resultPath]);
    expect(attached.code).toBe(0);

    const gate = await runCli(project, ['comparison', 'gate', '--json']);
    expect(gate.code).toBe(0);
    const payload = JSON.parse(gate.stdout) as {
      ok: boolean;
      passed: { methodId: string; via: string }[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.passed).toEqual([
      { methodId: 'fedavg', status: 'source-resolved', via: 'experiment' },
    ]);
  }, 60_000);

  it('blocks on a required method without a result and prints the next command', async () => {
    await registerWithStatus('fedavg', ['accepted', 'source-resolved', 'implemented']);
    const blocked = await runCli(project, [
      'comparison',
      'set-status',
      'fedavg',
      'blocked',
      '--reason',
      'missing dataset adapter',
    ]);
    expect(blocked.code).toBe(0);

    const gate = await runCli(project, ['comparison', 'gate']);
    expect(gate.code).toBe(2);
    expect(gate.stdout).toContain('FAIL  fedavg  blocked');
    expect(gate.stdout).toContain('set-status fedavg excluded');
    expect(gate.stdout).toContain('gate FAILED');

    const json = await runCli(project, ['comparison', 'gate', '--json']);
    expect(json.code).toBe(2);
    const payload = JSON.parse(json.stdout) as { ok: boolean; blocking: unknown[] };
    expect(payload.ok).toBe(false);
    expect(payload.blocking).toHaveLength(1);
  }, 60_000);
});
