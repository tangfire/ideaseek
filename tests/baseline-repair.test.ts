import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  classifyChange,
  classifyRepairFailure,
  executeRepair,
  isEnvironmentFile,
  isGeneratedPath,
  parseEntryCommand,
  parsePorcelainPaths,
  planFix,
  redactSecrets,
  venvEnv,
  type ExecuteRepairInput,
} from '../src/comparison/repair.js';
import type { RepairRecord } from '../src/comparison/types.js';
import { CLI_BIN, makeProjectDir } from './helpers.js';
import { spawn } from 'node:child_process';

describe('classifyRepairFailure', () => {
  it('maps common failure signatures to the taxonomy', () => {
    expect(
      classifyRepairFailure("ModuleNotFoundError: No module named 'torch'", 1, false).kind,
    ).toBe('missing-dependency');
    expect(classifyRepairFailure("ImportError: cannot import name 'x'", 1, false).kind).toBe(
      'missing-dependency',
    );
    expect(classifyRepairFailure('command not found: pip', 127, false).kind).toBe(
      'missing-dependency',
    );
    expect(classifyRepairFailure("FileNotFoundError: [Errno 2] 'data.csv'", 1, false).kind).toBe(
      'path-error',
    );
    expect(
      classifyRepairFailure('  File "a.py", line 3\nSyntaxError: invalid syntax', 1, false).kind,
    ).toBe('syntax-error');
    expect(classifyRepairFailure('Permission denied: /models', 1, false).kind).toBe(
      'permission-error',
    );
    expect(classifyRepairFailure('CUDA out of memory', 1, false).kind).toBe('device-error');
    expect(classifyRepairFailure('', -1, true).kind).toBe('timeout');
    expect(classifyRepairFailure('something odd happened', 3, false).kind).toBe('unknown');
  });

  it('picks the first matching line as the summary', () => {
    const failure = classifyRepairFailure(
      'starting run\nModuleNotFoundError: No module named "foo"\nstack...',
      1,
      false,
    );
    expect(failure.summary).toContain('ModuleNotFoundError');
    expect(failure.summary).not.toContain('stack');
  });
});

describe('redactSecrets', () => {
  it('strips common credential shapes', () => {
    const raw = 'using sk-abc123def456 token Bearer eyJhbGciOi.abc api_key=supersecret123';
    const clean = redactSecrets(raw);
    expect(clean).not.toContain('sk-abc123def456');
    expect(clean).not.toContain('supersecret123');
    expect(clean).not.toContain('eyJhbGciOi.abc');
    expect(clean).toContain('sk-***');
  });
});

describe('parseEntryCommand', () => {
  it('splits plain commands', () => {
    expect(parseEntryCommand('python train.py --epochs 1')).toEqual([
      'python',
      'train.py',
      '--epochs',
      '1',
    ]);
  });

  it('keeps quoted segments intact', () => {
    expect(parseEntryCommand(`python -c "import time; time.sleep(1)"`)).toEqual([
      'python',
      '-c',
      'import time; time.sleep(1)',
    ]);
    expect(parseEntryCommand(`python -c 'print("hi")'`)).toEqual(['python', '-c', 'print("hi")']);
  });

  it('returns empty for blank input', () => {
    expect(parseEntryCommand('   ')).toEqual([]);
  });
});

describe('change classification', () => {
  it('parses porcelain paths including renames', () => {
    expect(parsePorcelainPaths(' M a.py\n?? b/c.py\nR  old.py -> new.py\n')).toEqual([
      'a.py',
      'b/c.py',
      'new.py',
    ]);
  });

  it('filters generated artifacts', () => {
    expect(isGeneratedPath('.venv/')).toBe(true);
    expect(isGeneratedPath('src/__pycache__/x.pyc')).toBe(true);
    expect(isGeneratedPath('node_modules/pkg/index.js')).toBe(true);
    expect(isGeneratedPath('train.py')).toBe(false);
  });

  it('recognizes environment files', () => {
    expect(isEnvironmentFile('requirements.txt')).toBe(true);
    expect(isEnvironmentFile('env/requirements-dev.txt')).toBe(true);
    expect(isEnvironmentFile('pyproject.toml')).toBe(true);
    expect(isEnvironmentFile('setup.py')).toBe(true);
    expect(isEnvironmentFile('train.py')).toBe(false);
    expect(isEnvironmentFile('src/config.yaml')).toBe(false);
  });

  it('classifies none / environment / code-review', () => {
    expect(classifyChange([])).toBe('none');
    expect(classifyChange(['.venv/', '__pycache__/'])).toBe('none');
    expect(classifyChange(['requirements.txt', 'pyproject.toml'])).toBe('environment');
    expect(classifyChange(['requirements.txt', 'train.py'])).toBe('code-review');
    expect(classifyChange(['src/data/loader.py'])).toBe('code-review');
  });
});

describe('planFix', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ideaseek-repair-fix-'));
  });

  it('plans venv-install only for missing-dependency with requirements and no venv', async () => {
    await writeFile(join(dir, 'requirements.txt'), '', 'utf8');
    const plan = await planFix({ kind: 'missing-dependency', summary: 'x' }, dir);
    expect(plan.kind).toBe('venv-install');
  });

  it('refuses without a requirements file or when a venv already exists', async () => {
    expect((await planFix({ kind: 'missing-dependency', summary: 'x' }, dir)).kind).toBe('none');
    await writeFile(join(dir, 'requirements.txt'), '', 'utf8');
    await mkdir(join(dir, '.venv'));
    expect((await planFix({ kind: 'missing-dependency', summary: 'x' }, dir)).kind).toBe('none');
  });

  it('never plans automated fixes for other failure kinds', async () => {
    await writeFile(join(dir, 'requirements.txt'), '', 'utf8');
    expect((await planFix({ kind: 'syntax-error', summary: 'x' }, dir)).kind).toBe('none');
    expect((await planFix({ kind: 'timeout', summary: 'x' }, dir)).kind).toBe('none');
  });
});

describe('executeRepair', () => {
  let projectRoot: string;
  let worktree: string;
  let saved: RepairRecord | null;

  const store = {
    load: async () => saved,
    save: async (record: RepairRecord) => {
      saved = JSON.parse(JSON.stringify(record)) as RepairRecord;
    },
  };

  beforeEach(async () => {
    projectRoot = await makeProjectDir();
    worktree = await mkdtemp(join(tmpdir(), 'ideaseek-repair-wt-'));
    saved = null;
  });

  function input(overrides: Partial<ExecuteRepairInput> = {}): ExecuteRepairInput {
    return {
      projectRoot,
      methodId: 'fedavg',
      worktreeDir: worktree,
      entry: ['python', '-c', 'import module_that_does_not_exist_zz'],
      maxRounds: 3,
      timeoutMs: 30_000,
      store,
      ...overrides,
    };
  }

  it('uses the environment PATH key spelling that actually exists', () => {
    // `{ ...process.env, Path }` over an existing `PATH` yields two entries
    // and the child keeps the original, silently skipping the venv the
    // repair just installed.
    const env = venvEnv(worktree);
    const keys = Object.keys(env);
    expect(keys).toHaveLength(1);
    const actual = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH');
    if (actual) expect(keys[0]).toBe(actual);
    const value = env[keys[0]!] ?? '';
    expect(value.split(process.platform === 'win32' ? ';' : ':')[0]).toContain('.venv');
    // The inherited search path is preserved, not replaced.
    if (actual) expect(value).toContain(process.env[actual]!.slice(-12));
  });

  it('names the missing harness when inference is unavailable', async () => {
    // The first wiring of dependency inference silently no-op'd because the
    // command opened a runtime with no harness, so a repository without a
    // requirements file reported only "no requirements file" and looked
    // unsurvivable. The diagnosis has to say which piece is absent.
    const result = await executeRepair(input());
    const attempt = result.record.attempts[0]!;
    expect(attempt.fixApplied).toBe('none');
    expect(result.outcome).toBe('blocked-no-fix');
    const log = await readFile(join(projectRoot, attempt.logPath), 'utf8').catch(() => '');
    expect(log + (result.lastFailure?.summary ?? '')).toContain('No module named');
  });

  it('stops after one round when no fix applies (no blind retries)', async () => {
    const result = await executeRepair(input());
    expect(result.outcome).toBe('blocked-no-fix');
    expect(result.record.attempts).toHaveLength(1);
    expect(result.record.attempts[0]!.failureKind).toBe('missing-dependency');
    expect(result.record.attempts[0]!.fixApplied).toBe('none');
    expect(saved?.outcome).toBe('blocked-no-fix');
  });

  it('resumes an in-progress record at the next round (crash recovery)', async () => {
    saved = {
      methodId: 'fedavg',
      budget: { maxRounds: 3, timeoutMs: 30_000 },
      startedAt: 1,
      updatedAt: 1,
      outcome: 'in-progress',
      attempts: [
        {
          round: 1,
          at: 1,
          durationMs: 1,
          command: ['python'],
          exitCode: 1,
          timedOut: false,
          failureKind: 'missing-dependency',
          fixApplied: 'none',
          logPath: '.research/logs/repair-fedavg-r1.log',
        },
      ],
    };
    const result = await executeRepair(input());
    // Next attempt continues numbering; terminal outcome reset does not apply.
    expect(result.record.attempts.map((a) => a.round)).toEqual([1, 2]);
    expect(result.outcome).toBe('blocked-no-fix');
  });

  it('starts a fresh session when the stored record is already terminal', async () => {
    saved = {
      methodId: 'fedavg',
      budget: { maxRounds: 3, timeoutMs: 30_000 },
      startedAt: 1,
      updatedAt: 1,
      outcome: 'passed',
      attempts: [
        {
          round: 1,
          at: 1,
          durationMs: 1,
          command: ['python'],
          exitCode: 0,
          timedOut: false,
          fixApplied: 'none',
          logPath: '.research/logs/repair-fedavg-r1.log',
        },
      ],
    };
    const result = await executeRepair(input({ entry: ['python', '--version'] }));
    expect(result.outcome).toBe('passed');
    expect(result.record.attempts).toHaveLength(1);
    expect(result.record.attempts[0]!.round).toBe(1);
  });

  it('classifies timeouts and stops with diagnosis', async () => {
    const result = await executeRepair(
      input({
        entry: ['python', '-c', 'import time; time.sleep(30)'],
        timeoutMs: 500,
      }),
    );
    expect(result.outcome).toBe('blocked-no-fix');
    expect(result.record.attempts[0]!.timedOut).toBe(true);
    expect(result.record.attempts[0]!.failureKind).toBe('timeout');
  }, 20_000);

  it('stops at the round budget after applying a fix', async () => {
    await writeFile(join(worktree, 'requirements.txt'), '', 'utf8');
    const result = await executeRepair(input({ maxRounds: 1 }));
    // Round 1 fails → venv-install applied → round 2 would exceed budget.
    expect(result.record.attempts).toHaveLength(1);
    expect(result.record.attempts[0]!.fixApplied).toBe('venv-install');
    expect(result.record.attempts[0]!.fixOk).toBe(true);
    expect(result.outcome).toBe('blocked-budget');
    // The fix created the venv inside the worktree (isolation surface).
    const venvInfo = await stat(join(worktree, '.venv')).catch(() => null);
    expect(venvInfo?.isDirectory()).toBe(true);
  }, 120_000);

  it('rejects empty entries and out-of-range budgets', async () => {
    await expect(executeRepair(input({ entry: [] }))).rejects.toThrow(/entry command is empty/);
    await expect(executeRepair(input({ maxRounds: 0 }))).rejects.toThrow(/between 1 and 10/);
    await expect(executeRepair(input({ maxRounds: 99 }))).rejects.toThrow(/between 1 and 10/);
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

/** Local git fixture (same shape as comparison.test.ts). */
async function makeLocalGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ideaseek-repair-fixture-'));
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
  await writeFile(join(dir, 'README.md'), '# fixture\n', 'utf8');
  await writeFile(join(dir, 'run.py'), 'print("ok")\n', 'utf8');
  git(['add', '.']);
  git(['commit', '-m', 'fixture']);
  return dir;
}

describe('ideaseek baseline repair CLI end-to-end', () => {
  let project: string;
  let fixture: string;

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'ideaseek-repair-e2e-'));
    const init = await runCli(project, ['init']);
    expect(init.code).toBe(0);
    fixture = await makeLocalGitRepo();
  }, 60_000);

  /** register → accepted → source-resolved → implemented (no clone needed). */
  async function registerImplemented(id: string): Promise<void> {
    const reg = await runCli(project, ['comparison', 'register', id]);
    expect(reg.code).toBe(0);
    for (const status of ['accepted', 'source-resolved', 'implemented']) {
      const step = await runCli(project, ['comparison', 'set-status', id, status]);
      expect(step.code).toBe(0);
    }
    await mkdir(join(project, 'comparisons', id, 'worktree'), { recursive: true });
  }

  it('passes with no diff and advances to smoke-tested', async () => {
    await registerImplemented('fedavg');
    const repair = await runCli(project, [
      'baseline',
      'repair',
      '--method',
      'fedavg',
      '--entry',
      'python --version',
      '--json',
    ]);
    expect(repair.code).toBe(0);
    const payload = JSON.parse(repair.stdout) as {
      outcome: string;
      status: string;
      requiresConfirmation: boolean;
    };
    expect(payload).toMatchObject({
      outcome: 'smoke-tested',
      status: 'smoke-tested',
      requiresConfirmation: false,
    });

    const yaml = await readFile(join(project, 'comparisons', 'fedavg', 'method.yaml'), 'utf8');
    expect(yaml).toContain('repair:');
    expect(yaml).toContain('smoke-tested');
    const history = await runCli(project, ['comparison', 'list', '--json']);
    expect(history.code).toBe(0);
  }, 60_000);

  it('blocks after a single undiagnosable-fix round (no blind retries)', async () => {
    await registerImplemented('fedavg');
    const repair = await runCli(project, [
      'baseline',
      'repair',
      '--method',
      'fedavg',
      '--entry',
      'python -c "import module_that_does_not_exist_zz"',
      '--json',
    ]);
    expect(repair.code).toBe(1);
    const payload = JSON.parse(repair.stdout) as {
      outcome: string;
      status: string;
      attempts: number;
      lastFailureKind: string;
    };
    expect(payload).toMatchObject({
      outcome: 'blocked',
      status: 'blocked',
      attempts: 1,
      lastFailureKind: 'missing-dependency',
    });

    // repair.json persisted per round; log written and redacted.
    const record = JSON.parse(
      await readFile(join(project, 'comparisons', 'fedavg', 'repair.json'), 'utf8'),
    ) as RepairRecord;
    expect(record.attempts).toHaveLength(1);
    const log = await readFile(join(project, record.attempts[0]!.logPath), 'utf8');
    expect(log).toContain('ModuleNotFoundError');

    // Status graph: repairing → blocked with a reason (no silent skips).
    const listed = await runCli(project, ['comparison', 'list', '--json']);
    const methods = (JSON.parse(listed.stdout) as { methods: { status: string }[] }).methods;
    expect(methods[0]!.status).toBe('blocked');
  }, 60_000);

  it('applies a venv fix when requirements exist, then blocks with 2 rounds', async () => {
    await registerImplemented('fedavg');
    // Empty requirements file: venv creation + pip install run offline.
    await writeFile(
      join(project, 'comparisons', 'fedavg', 'worktree', 'requirements.txt'),
      '',
      'utf8',
    );
    const repair = await runCli(
      project,
      [
        'baseline',
        'repair',
        '--method',
        'fedavg',
        '--entry',
        'python -c "import module_that_does_not_exist_zz"',
        '--rounds',
        '3',
        '--json',
      ],
      180_000,
    );
    expect(repair.code).toBe(1);
    const payload = JSON.parse(repair.stdout) as {
      outcome: string;
      attempts: number;
      repairOutcome: string;
    };
    expect(payload.outcome).toBe('blocked');
    // r1 fails → venv-install; r2 fails with venv present → no fix → stop.
    expect(payload.attempts).toBe(2);
    expect(payload.repairOutcome).toBe('blocked-no-fix');

    const record = JSON.parse(
      await readFile(join(project, 'comparisons', 'fedavg', 'repair.json'), 'utf8'),
    ) as RepairRecord;
    expect(record.attempts[0]!.fixApplied).toBe('venv-install');
    expect(record.attempts[0]!.fixOk).toBe(true);

    // Isolation: venv and requirements live in the worktree, not upstream.
    await expect(
      readFile(join(project, 'comparisons', 'fedavg', 'upstream', 'requirements.txt'), 'utf8'),
    ).rejects.toThrow();
    const upstreamVenv = await readFile(
      join(project, 'comparisons', 'fedavg', 'upstream', '.venv'),
      'utf8',
    ).catch(() => 'absent');
    expect(upstreamVenv).toBe('absent');
  }, 240_000);

  it('gates code diffs behind user confirmation instead of auto-accepting', async () => {
    const imported = await runCli(project, ['comparison', 'import', 'fedavg', fixture, '--json']);
    expect(imported.code).toBe(0);
    const setImpl = await runCli(project, ['comparison', 'set-status', 'fedavg', 'implemented']);
    expect(setImpl.code).toBe(0);

    const repair = await runCli(project, [
      'baseline',
      'repair',
      '--method',
      'fedavg',
      '--entry',
      `python -c "open('patched_by_repair.py','w').write('ok')"`,
      '--json',
    ]);
    expect(repair.code).toBe(0);
    const payload = JSON.parse(repair.stdout) as {
      outcome: string;
      status: string;
      requiresConfirmation: boolean;
      changedFiles: string[];
    };
    expect(payload).toMatchObject({
      outcome: 'confirmation-required',
      requiresConfirmation: true,
    });
    expect(payload.status).toBe('repairing'); // NOT auto-advanced
    expect(payload.changedFiles).toContain('patched_by_repair.py');

    // Upstream untouched; the change stays in the worktree.
    const upstreamRun = await readFile(
      join(project, 'comparisons', 'fedavg', 'upstream', 'run.py'),
      'utf8',
    );
    expect(upstreamRun).toContain('print("ok")');
    await expect(
      readFile(join(project, 'comparisons', 'fedavg', 'upstream', 'patched_by_repair.py'), 'utf8'),
    ).rejects.toThrow();

    // The suggested next command is graph-legal.
    const accept = await runCli(project, [
      'comparison',
      'set-status',
      'fedavg',
      'smoke-tested',
      '--reason',
      'user accepted code revision',
    ]);
    expect(accept.code).toBe(0);
  }, 60_000);

  it('times out a hanging entry and records the diagnosis', async () => {
    await registerImplemented('fedavg');
    const repair = await runCli(
      project,
      [
        'baseline',
        'repair',
        '--method',
        'fedavg',
        '--entry',
        'python -c "import time; time.sleep(30)"',
        '--timeout',
        '500',
        '--json',
      ],
      30_000,
    );
    expect(repair.code).toBe(1);
    const payload = JSON.parse(repair.stdout) as {
      lastFailureKind: string;
      attempts: number;
    };
    expect(payload.lastFailureKind).toBe('timeout');
    expect(payload.attempts).toBe(1);
  }, 60_000);

  it('rejects repair from non-implementable statuses and unknown methods', async () => {
    const reg = await runCli(project, ['comparison', 'register', 'fedproto']);
    expect(reg.code).toBe(0);
    const early = await runCli(project, [
      'baseline',
      'repair',
      '--method',
      'fedproto',
      '--entry',
      'python --version',
    ]);
    expect(early.code).not.toBe(0);
    expect(early.stderr).toContain('set-status fedproto implemented');

    const ghost = await runCli(project, ['baseline', 'repair', '--method', 'ghost']);
    expect(ghost.code).not.toBe(0);
    expect(ghost.stderr).toContain('not found');
  }, 60_000);
});
